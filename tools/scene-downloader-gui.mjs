/**
 * 整场景资源下载器 — 本地 Web GUI
 *
 * 启动:
 *   node tools/scene-downloader-gui.mjs
 *   浏览器自动打开 http://localhost:3721
 *
 * 打包成 exe(需先 npm i -D @yao-pkg/pkg):
 *   npx @yao-pkg/pkg tools/scene-downloader-gui.mjs \
 *     --target node20-win-x64 \
 *     --output dist/SceneDownloader.exe
 *
 * 双击 exe 即可使用。
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { argv, platform } from 'node:process';

const PORT = parseInt(process.env.GUI_PORT || '3721', 10);
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 800;

// ───────────────── PowerShell 对话框（Windows 原生） ─────────────────
// 关键：必须用 -STA（Single-Threaded Apartment）模式。
// System.Windows.Forms.*Dialog.ShowDialog() 在 MTA 模式下可能不弹窗或直接返回 Cancel
// （用户报告："点击选择文件,并不会吊起本地的文件系统接口"）
function pickFileViaPowerShell(filterDesc, filterExt) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Filter = '${filterDesc}|${filterExt}'
$dlg.Title = '选择 ${filterDesc}'
if ($dlg.ShowDialog() -eq 'OK') { Write-Output $dlg.FileName }
`.trim();
  const r = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', windowsHide: false });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function pickFolderViaPowerShell() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择下载目录'
$dlg.ShowNewFolderButton = $true
if ($dlg.ShowDialog() -eq 'OK') { Write-Output $dlg.SelectedPath }
`.trim();
  const r = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', windowsHide: false });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function pickFileCrossPlatform(filterDesc, filterExt) {
  if (platform === 'win32') return pickFileViaPowerShell(filterDesc, filterExt);
  // 简易 fallback: 从 argv 接
  return null;
}

function pickFolderCrossPlatform() {
  if (platform === 'win32') return pickFolderViaPowerShell();
  return null;
}

// ───────────────── 下载逻辑（复用 download-scene-urls.mjs） ─────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithRetry(url, retries = MAX_RETRY) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) {
        lastErr = new Error(`HTTP ${r.status}`);
        if (r.status >= 500 && i < retries - 1) { await sleep(RETRY_DELAY_MS); continue; }
        return { ok: false, error: lastErr.message, status: r.status };
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, buf, bytes: buf.length };
    } catch (e) {
      lastErr = e;
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: lastErr?.message || String(lastErr) };
}

function safeJoin(root, rel) {
  const full = normalize(join(root, rel));
  const rootNorm = normalize(root);
  if (!full.startsWith(rootNorm)) throw new Error(`路径越界: ${rel}`);
  return full;
}

function collectTasks(data, outRoot, report) {
  const tasks = [];
  const g = data.groups || {};
  const pushUrlItem = (u, fallbackSaveAs) => {
    if (!u) return;
    const saveAs = u.saveAs || fallbackSaveAs;
    if (u.inlineData) {
      // 内存 rawData inline 项 — 不走 CDN fetch，直接落盘
      tasks.push({ url: u.url || '', saveAs, inline: u.inlineData });
    } else if (u.url) {
      tasks.push({ url: u.url, saveAs });
    }
  };
  for (const s of (g.sprites || [])) pushUrlItem(s, `images/${s.name}.png`);
  for (const db of (g.dragonBones || [])) {
    for (const u of (db.urls || [])) pushUrlItem(u);
  }
  for (const sp of (g.spines || [])) {
    for (const u of (sp.urls || [])) pushUrlItem(u);
  }
  for (const mc of (g.movieclips || [])) {
    for (const u of (mc.urls || [])) pushUrlItem(u);
  }
  if (Array.isArray(g.resources)) {
    let resIdx = 0;
    for (const r of g.resources) {
      const url = r?.url || r?.src || r?.configUrl;
      if (!url) continue;
      const name = r?.name || r?.alias || `res_${resIdx++}`;
      const ext = (url.split('/').pop()?.split('?')[0]?.split('.').pop() || 'bin').toLowerCase();
      const category = categorizeExt(ext);
      tasks.push({ url, saveAs: `resources/${category}/${name}.${ext}` });
      resIdx++;
    }
  }
  return tasks;
}

function categorizeExt(ext) {
  if (/^(mp3|wav|ogg|m4a|aac|flac)$/i.test(ext)) return 'audio';
  if (/^(csv|json|xml|txt|ini|cfg|conf)$/i.test(ext)) return 'data';
  if (/^(png|jpg|jpeg|webp|gif|bmp|tga)$/i.test(ext)) return 'images';
  if (/^(dbbin|skel|atlas|fnt|plist)$/i.test(ext)) return 'skeleton';
  if (/^(mp4|webm|avi|mov)$/i.test(ext)) return 'video';
  if (/^(ttf|otf|woff|woff2)$/i.test(ext)) return 'fonts';
  if (/^(js|mjs|cjs)$/i.test(ext)) return 'scripts';
  return 'other';
}

// ───────────────── 全局状态（单实例下载） ─────────────────
let dlState = null; // { running, total, done, ok, failed, skipped, currentUrl, log }

async function runDownload(jsonPath, outRoot, concurrency, postProcess, onProgress) {
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const tasks = collectTasks(data, outRoot, {});
  mkdirSync(outRoot, { recursive: true });

  dlState = { running: true, total: tasks.length, done: 0, ok: 0, failed: 0, skipped: 0, currentUrl: '', log: [] };
  onProgress({ type: 'start', total: tasks.length, scene: data.scene, totals: data.totals });

  const it = tasks[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const next = it.next();
      if (next.done) return;
      const { url, saveAs, inline } = next.value;
      dlState.currentUrl = url || `(inline) ${saveAs}`;
      try {
        const fullPath = safeJoin(outRoot, saveAs);
        if (existsSync(fullPath) && statSync(fullPath).size > 0) {
          dlState.skipped++;
          dlState.log.push(`⊘ ${saveAs} (已存在)`);
          onProgress({ type: 'skip', saveAs, url });
        } else if (inline) {
          // 内存 rawData inline — 直接落盘，不 fetch CDN
          mkdirSync(dirname(fullPath), { recursive: true });
          let buf;
          if (inline.kind === 'text') {
            buf = Buffer.from(inline.data, 'utf-8');
          } else if (inline.kind === 'base64') {
            buf = Buffer.from(inline.data, 'base64');
          } else {
            throw new Error(`未知 inline.kind: ${inline.kind}`);
          }
          writeFileSync(fullPath, buf);
          dlState.ok++;
          dlState.log.push(`✓ ${saveAs} (inline ${buf.length}B)`);
          onProgress({ type: 'ok', saveAs, url, bytes: buf.length, inline: true });
        } else {
          const r = await fetchWithRetry(url);
          if (!r.ok) {
            dlState.failed++;
            dlState.log.push(`✗ ${saveAs}: ${r.error}`);
            onProgress({ type: 'fail', saveAs, url, error: r.error });
          } else {
            mkdirSync(dirname(fullPath), { recursive: true });
            writeFileSync(fullPath, r.buf);
            dlState.ok++;
            dlState.log.push(`✓ ${saveAs} (${r.bytes}B)`);
            onProgress({ type: 'ok', saveAs, url, bytes: r.bytes });
          }
        }
      } catch (e) {
        dlState.failed++;
        dlState.log.push(`✗ ${saveAs}: ${e.message}`);
        onProgress({ type: 'fail', saveAs, url, error: e.message });
      }
      dlState.done++;
      onProgress({ type: 'progress', done: dlState.done, total: dlState.total, ok: dlState.ok, failed: dlState.failed, skipped: dlState.skipped });
    }
  });
  await Promise.all(workers);

  // 下载阶段完成,通知前端开始后处理
  onProgress({ type: 'done', ok: dlState.ok, failed: dlState.failed, skipped: dlState.skipped, total: dlState.total, reportPath: '' });

  const reportPath = join(outRoot, '_download-report.json');
  const postResult = await runPostProcess(data, outRoot, postProcess, onProgress).catch((e) => {
    onProgress({ type: 'post-progress', phase: '后处理异常', detail: e.message, cls: 'fail', saveAs: '' });
    return null;
  });

  writeFileSync(reportPath, JSON.stringify({
    scene: data.scene,
    pageUrl: data.pageUrl,
    exportedAt: data.exportedAt,
    downloadAt: new Date().toISOString(),
    ok: dlState.ok,
    failed: dlState.failed,
    skipped: dlState.skipped,
    total: dlState.total,
    postProcess: postResult,
    log: dlState.log.slice(-200),
  }, null, 2));

  dlState.running = false;
  onProgress({ type: 'post-done', reportPath, ...(postResult || {}) });
}

// ───────────────── 后处理 ─────────────────
async function runPostProcess(data, outRoot, postProcess, onProgress) {
  const out = {};
  const g = data.groups || {};

  // 1) Sprite 图集裁剪:用 sharp 按 atlas.sprites 区域裁剪 + 输出 Cocos plist + Egret json
  if (postProcess?.spriteAtlas && Array.isArray(g.atlases)) {
    const sharp = (await import('sharp')).default;
    const stats = { ok: 0, fail: 0, total: 0 };
    for (const atlas of g.atlases) {
      const atlasPngPath = safeJoin(outRoot, `images/${atlas.filename}`);
      if (!existsSync(atlasPngPath)) {
        // 尝试按 url 末段找
        const alt = safeJoin(outRoot, `images/${(atlas.url.split('/').pop()?.split('?')[0] || atlas.filename)}`);
        if (existsSync(alt)) {} // 找不到就跳过
      }
      if (!existsSync(atlasPngPath)) {
        onProgress({ type: 'post-progress', phase: '图集裁剪', detail: `图集 ${atlas.filename} 未下载,跳过`, cls: 'fail', saveAs: atlas.filename });
        stats.fail++;
        continue;
      }
      const baseName = atlas.filename.replace(/\.[^.]+$/, '');
      const spriteOutDir = safeJoin(outRoot, `sprites/${baseName}`);
      mkdirSync(spriteOutDir, { recursive: true });

      let sharpImg = null;
      try { sharpImg = sharp(atlasPngPath); } catch (e) {
        onProgress({ type: 'post-progress', phase: '图集裁剪', detail: `打开 ${atlas.filename} 失败: ${e.message}`, cls: 'fail', saveAs: atlas.filename });
        stats.fail++;
        continue;
      }
      const meta = await sharpImg.metadata();
      const atlasW = meta.width || 0;
      const atlasH = meta.height || 0;

      for (const sp of atlas.sprites) {
        stats.total++;
        const outPath = join(spriteOutDir, `${sanitizeName(sp.name)}.png`);
        if (existsSync(outPath) && statSync(outPath).size > 0) {
          stats.ok++;
          continue;
        }
        try {
          // 注意:Egret 的 bitmapX/Y 是相对图集左上角
          const x = Math.max(0, sp.x);
          const y = Math.max(0, sp.y);
          const w = Math.min(sp.w, atlasW - x);
          const h = Math.min(sp.h, atlasH - y);
          if (w <= 0 || h <= 0) {
            stats.fail++;
            onProgress({ type: 'post-progress', phase: '图集裁剪', detail: `${sp.name} 区域越界`, cls: 'fail', saveAs: sp.name });
            continue;
          }
          const buf = await sharp(atlasPngPath)
            .extract({ left: x, top: y, width: w, height: h })
            .png()
            .toBuffer();
          writeFileSync(outPath, buf);
          stats.ok++;
          onProgress({ type: 'post-progress', phase: '图集裁剪', saveAs: `sprites/${baseName}/${sp.name}.png`, bytes: buf.length, cls: 'ok' });
        } catch (e) {
          stats.fail++;
          onProgress({ type: 'post-progress', phase: '图集裁剪', detail: `${sp.name}: ${e.message}`, cls: 'fail', saveAs: sp.name });
        }
      }

      // 输出 Cocos plist + Egret json
      const atlasMetaDir = safeJoin(outRoot, 'atlas-meta');
      mkdirSync(atlasMetaDir, { recursive: true });
      const plistText = buildCocosPlist(baseName, atlas.filename, atlas.sprites, atlasW, atlasH);
      const egretJson = buildEgretJson(atlas.filename, atlas.sprites);
      writeFileSync(join(atlasMetaDir, `${baseName}.plist`), plistText);
      writeFileSync(join(atlasMetaDir, `${baseName}.json`), egretJson);
    }
    out.spriteAtlas = stats;
  }

  // 2) 龙骨工程整理:文件已在 dragonbones/{name}/ 下,补 _project.json 索引 + 完整度判定
  if (postProcess?.dragonBones && Array.isArray(g.dragonBones)) {
    let count = 0;
    let completeCount = 0;
    for (const db of g.dragonBones) {
      const dir = safeJoin(outRoot, `dragonbones/${sanitizeName(db.name, `db_${db.nodeId || ''}`)}`);
      if (!existsSync(dir)) continue;
      const files = (db.urls || []).map((u) => u.name);
      const present = files.filter((n) => existsSync(join(dir, n)));
      // 完整工程标准:至少 1 个 ske 文件 + 1 个 tex.json + 1 个 tex 图
      const hasSke = present.some((n) => /_ske[._]/i.test(n));
      const hasTexJson = present.some((n) => /_tex\.json$/i.test(n));
      const hasTexImg = present.some((n) => /_tex\.(png|webp|jpg)$/i.test(n));
      const complete = hasSke && hasTexJson && hasTexImg;
      writeFileSync(join(dir, '_project.json'), JSON.stringify({
        type: 'dragonBones',
        name: db.name,
        armatureName: db.armatureName,
        nodeId: db.nodeId,
        files,
        present,
        missing: files.filter((n) => !present.includes(n)),
        complete,
        note: complete ? '完整工程:ske+tex.json+tex 图齐全' : '不完整:缺 ske/tex.json/tex 图之一,可能 CDN 改写',
      }, null, 2));
      count++;
      if (complete) completeCount++;
      onProgress({ type: 'post-progress', phase: '龙骨整理', saveAs: `dragonbones/${sanitizeName(db.name, `db_${db.nodeId || ''}`)}/_project.json${complete ? ' (完整)' : ' (不完整)'}`, cls: complete ? 'ok' : 'fail' });
    }
    out.dragonBones = { groups: count, complete: completeCount };
  }

  // 3) Spine 工程整理
  if (postProcess?.spine && Array.isArray(g.spines)) {
    let count = 0;
    let completeCount = 0;
    for (const sp of g.spines) {
      const dir = safeJoin(outRoot, `spines/${sanitizeName(sp.name)}`);
      if (!existsSync(dir)) continue;
      const files = (sp.urls || []).map((u) => u.name);
      const present = files.filter((n) => existsSync(join(dir, n)));
      // Spine 完整:json/skel + atlas + 至少 1 个 png
      const hasSkeleton = present.some((n) => /\.(json|skel)$/i.test(n) && !/\.atlas$/i.test(n));
      const hasAtlas = present.some((n) => /\.atlas$/i.test(n));
      const hasPng = present.some((n) => /\.(png|webp|jpg)$/i.test(n));
      const complete = hasSkeleton && hasAtlas && hasPng;
      writeFileSync(join(dir, '_project.json'), JSON.stringify({
        type: 'spine',
        name: sp.name,
        nodeId: sp.nodeId,
        files,
        present,
        missing: files.filter((n) => !present.includes(n)),
        complete,
      }, null, 2));
      count++;
      if (complete) completeCount++;
      onProgress({ type: 'post-progress', phase: 'Spine 整理', saveAs: `spines/${sanitizeName(sp.name)}/_project.json${complete ? ' (完整)' : ' (不完整)'}`, cls: complete ? 'ok' : 'fail' });
    }
    out.spine = { groups: count, complete: completeCount };
  }

  // 4) MovieClip 重组:已在 movieclips/{name}/ 下,补 _project.json + 完整度
  if (postProcess?.movieclip && Array.isArray(g.movieclips)) {
    let count = 0;
    let completeCount = 0;
    for (const mc of g.movieclips) {
      const dir = safeJoin(outRoot, `movieclips/${sanitizeName(mc.name, `mc_${mc.nodeId || ''}`)}`);
      if (!existsSync(dir)) continue;
      const files = (mc.urls || []).map((u) => u.name);
      const present = files.filter((n) => existsSync(join(dir, n)));
      // MovieClip 完整:所有帧 PNG 都下载到
      const complete = present.length === files.length && files.length > 0;
      writeFileSync(join(dir, '_project.json'), JSON.stringify({
        type: 'movieclip',
        name: mc.name,
        nodeId: mc.nodeId,
        frameCount: mc.frameCount,
        files,
        present,
        missing: files.filter((n) => !present.includes(n)),
        complete,
      }, null, 2));
      count++;
      if (complete) completeCount++;
      onProgress({ type: 'post-progress', phase: 'MovieClip 重组', saveAs: `movieclips/${sanitizeName(mc.name, `mc_${mc.nodeId || ''}`)}/_project.json${complete ? ' (完整)' : ' (不完整)'}`, cls: complete ? 'ok' : 'fail' });
    }
    out.movieclip = { groups: count, complete: completeCount };
  }

  return out;
}

function sanitizeName(name) {
  return (name || '').replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function buildCocosPlist(baseName, atlasFilename, sprites, atlasW, atlasH) {
  const frames = {};
  for (const sp of sprites) {
    frames[sp.name] = {
      frame: `{{${sp.x},${sp.y}},{${sp.w},${sp.h}}}`,
      offset: '{0,0}',
      rotated: false,
      sourceSize: `{${sp.w},${sp.h}}`,
    };
  }
  const plist = {
    frames,
    metadata: {
      textureFileName: atlasFilename,
      size: `{${atlasW},${atlasH}}`,
    },
  };
  // 简易 plist XML 输出（Cocos 5.x plist 格式）
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.keys(frames).map((k) => `  <key>${k}</key>
  <dict>
    <key>frame</key><string>${frames[k].frame}</string>
    <key>offset</key><string>${frames[k].offset}</string>
    <key>rotated</key><${frames[k].rotated ? 'true' : 'false'} />
    <key>sourceSize</key><string>${frames[k].sourceSize}</string>
  </dict>`).join('\n')}
  <key>metadata</key>
  <dict>
    <key>textureFileName</key><string>${atlasFilename}</string>
    <key>size</key><string>{${atlasW},${atlasH}}</string>
  </dict>
</dict>
</plist>`;
}

function buildEgretJson(atlasFilename, sprites) {
  const frames = {};
  for (const sp of sprites) {
    frames[sp.name] = { x: sp.x, y: sp.y, w: sp.w, h: sp.h };
  }
  return JSON.stringify({ file: atlasFilename, frames }, null, 2);
}

// ───────────────── HTTP 服务器 ─────────────────
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>Scene Downloader</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #1a1a1a; color: #eee; font-family: system-ui, sans-serif; padding: 24px; min-height: 100vh; }
  h1 { margin: 0 0 24px; font-size: 20px; color: #fff; }
  .card { background: rgba(36,38,42,0.72); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 20px; max-width: 720px; margin: 0 auto; }
  .row { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; }
  .row label { flex: 0 0 110px; color: #aaa; font-size: 13px; }
  .row .path { flex: 1; padding: 8px 12px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #ddd; font-family: monospace; font-size: 12px; word-break: break-all; min-height: 32px; display: flex; align-items: center; }
  button { padding: 8px 16px; background: #3c8c64; border: 1px solid #50a078; color: #fff; border-radius: 4px; cursor: pointer; font-size: 13px; }
  button:hover { background: #4ca074; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: #444; border-color: #666; }
  button.secondary:hover { background: #555; }
  button.danger { background: #a04c4c; border-color: #c06868; }
  .progress-wrap { margin-top: 12px; }
  .progress-bar { width: 100%; height: 18px; background: rgba(0,0,0,0.4); border-radius: 9px; overflow: hidden; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #3c8c64, #4ca074); transition: width 0.3s; }
  .stats { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: #aaa; }
  .stats span b { color: #fff; }
  .log { margin-top: 16px; max-height: 240px; overflow-y: auto; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; padding: 8px; font-family: monospace; font-size: 11px; color: #ccc; }
  .log .ok { color: #6fdc8f; }
  .log .fail { color: #ff7b7b; }
  .log .skip { color: #888; }
  .status { margin-top: 8px; font-size: 13px; color: #ddd; }
  .hint { color: #888; font-size: 12px; margin-top: 12px; line-height: 1.6; }
  .actions { display: flex; gap: 8px; }
</style>
</head>
<body>
  <div class="card">
    <h1>整场景资源下载器</h1>
    <div class="row">
      <label>JSON 清单</label>
      <div class="path" id="jsonPath">(未选择)</div>
      <div class="actions">
        <input type="file" id="fileJson" accept=".json,application/json" style="display:none" onchange="onJsonPicked(this)" />
        <button class="secondary" onclick="document.getElementById('fileJson').click()">选择 JSON</button>
      </div>
    </div>
    <div class="row">
      <label>下载目录</label>
      <input type="text" id="outDirInput" value="D:/self_project/H5-egret-res/downloaded2" placeholder="可手动输入或粘贴绝对路径" style="flex:1;padding:8px 12px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#fff;font-family:monospace;font-size:12px;min-height:32px" />
      <button class="secondary" onclick="useLastDir()">上次目录</button>
    </div>
    <div class="row">
      <label>并发数</label>
      <input type="number" id="concurrency" value="8" min="1" max="32" style="width:80px;padding:8px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#fff;font-size:13px" />
    </div>
    <div class="row">
      <label>下载后处理</label>
      <div style="flex:1;display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:#ddd">
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="pp-spriteAtlas" checked style="cursor:pointer"> Sprite 图集裁剪</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="pp-dragonBones" checked style="cursor:pointer"> 龙骨工程整理</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="pp-spine" checked style="cursor:pointer"> Spine 工程整理</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="pp-movieclip" checked style="cursor:pointer"> MovieClip 重组</label>
      </div>
    </div>
    <div class="row" style="margin-bottom:0">
      <label></label>
      <div class="actions" style="flex:1;justify-content:flex-end">
        <button id="startBtn" onclick="start()" disabled>开始下载</button>
      </div>
    </div>
    <div class="progress-wrap" id="progressWrap" style="display:none">
      <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
      <div class="stats">
        <span>进度: <b id="stProgress">0/0</b></span>
        <span style="color:#6fdc8f">✓ <b id="stOk">0</b></span>
        <span style="color:#ff7b7b">✗ <b id="stFail">0</b></span>
        <span style="color:#888">⊘ <b id="stSkip">0</b></span>
      </div>
      <div class="status" id="status">准备中…</div>
      <div class="log" id="log"></div>
    </div>
    <div class="hint">
      提示：JSON 清单从 Egret Inspector 面板「整场景资源 URL 清单」下载得到。<br>
      下载完成后会在输出目录生成 _download-report.json。
    </div>
  </div>

<script>
let jsonPath = '';
let outDir = '';

// 默认下载目录：优先 localStorage 记忆，其次内置默认
(function initOutDir() {
  const saved = localStorage.getItem('lastOutDir');
  if (saved) document.getElementById('outDirInput').value = saved;
})();

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// JSON 文件：浏览器原生 input[type=file] → FormData 上传到 Node 端临时保存
async function onJsonPicked(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  document.getElementById('jsonPath').textContent = '上传中: ' + f.name + '…';
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await fetch('/api/upload-json', { method: 'POST', body: fd });
    const j = await r.json();
    if (j.ok) {
      jsonPath = j.path;
      document.getElementById('jsonPath').textContent = j.path + ' (' + f.size + 'B)';
      updateStartBtn();
    } else {
      document.getElementById('jsonPath').textContent = '上传失败: ' + (j.error || '未知错误');
    }
  } catch (e) {
    document.getElementById('jsonPath').textContent = '上传异常: ' + e.message;
  }
  // 重置 input，允许重复选同一个文件
  input.value = '';
}

function useLastDir() {
  const saved = localStorage.getItem('lastOutDir');
  if (saved) {
    document.getElementById('outDirInput').value = saved;
  } else {
    alert('没有上次目录记录，请手动输入或粘贴绝对路径');
  }
}

function updateStartBtn() {
  const dir = document.getElementById('outDirInput').value.trim();
  outDir = dir;
  document.getElementById('startBtn').disabled = !(jsonPath && outDir);
}

// 文本框输入时实时同步 outDir + 启用按钮
document.getElementById('outDirInput').addEventListener('input', updateStartBtn);

async function start() {
  outDir = document.getElementById('outDirInput').value.trim();
  if (!outDir) { alert('请填写下载目录'); return; }
  localStorage.setItem('lastOutDir', outDir);
  const c = parseInt(document.getElementById('concurrency').value, 10) || 8;
  const postProcess = {
    spriteAtlas: document.getElementById('pp-spriteAtlas').checked,
    dragonBones: document.getElementById('pp-dragonBones').checked,
    spine: document.getElementById('pp-spine').checked,
    movieclip: document.getElementById('pp-movieclip').checked,
  };
  document.getElementById('startBtn').disabled = true;
  document.getElementById('progressWrap').style.display = 'block';
  document.getElementById('log').innerHTML = '';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('stProgress').textContent = '0/0';
  document.getElementById('stOk').textContent = '0';
  document.getElementById('stFail').textContent = '0';
  document.getElementById('stSkip').textContent = '0';

  const es = new EventSource('/api/stream?t=' + Date.now());
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    handleEvent(d);
    if (d.type === 'done' || d.type === 'post-done') {
      if (d.type === 'done' && !d.final) return; // 下载完还会跑后处理,不算最终
      es.close();
      document.getElementById('startBtn').disabled = false;
    }
  };
  es.onerror = () => { es.close(); };

  const r = await api('/api/start', { jsonPath, outDir, concurrency: c, postProcess });
  if (!r.ok) {
    document.getElementById('status').textContent = '启动失败: ' + (r.error || '');
    es.close();
    document.getElementById('startBtn').disabled = false;
  }
}

function handleEvent(d) {
  if (d.type === 'start') {
    document.getElementById('status').textContent = '场景: ' + (d.scene || '(未命名)') + ' · 总数 ' + d.total;
    document.getElementById('stProgress').textContent = '0/' + d.total;
  } else if (d.type === 'progress') {
    const pct = d.total > 0 ? (d.done / d.total * 100) : 0;
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('stProgress').textContent = d.done + '/' + d.total;
    document.getElementById('stOk').textContent = d.ok;
    document.getElementById('stFail').textContent = d.failed;
    document.getElementById('stSkip').textContent = d.skipped;
  } else if (d.type === 'done') {
    // 下载完成（后处理未跑），不关闭流，等待后处理事件
    document.getElementById('status').textContent = '下载完成 ✓ ' + d.ok + ' · ✗ ' + d.failed + ' · ⊘ ' + d.skipped + ' · 开始后处理 …';
    appendLog('skip', '── 下载完成,开始后处理 ──');
  } else if (d.type === 'post-done') {
    const parts = [];
    if (d.spriteAtlas) parts.push('图集裁剪 ' + d.spriteAtlas.ok + '/' + d.spriteAtlas.total);
    if (d.dragonBones) parts.push('龙骨 ' + d.dragonBones.complete + '/' + d.dragonBones.groups + ' 完整工程');
    if (d.spine) parts.push('Spine ' + d.spine.complete + '/' + d.spine.groups + ' 完整工程');
    if (d.movieclip) parts.push('MovieClip ' + d.movieclip.complete + '/' + d.movieclip.groups + ' 完整工程');
    document.getElementById('status').textContent = '全部完成 · ' + (parts.join(' · ') || '无后处理') + ' · 报告: ' + d.reportPath;
    appendLog('ok', '── 后处理完成 · 报告 ' + d.reportPath + ' ──');
  } else if (d.type === 'post-progress') {
    document.getElementById('status').textContent = '后处理中: ' + d.phase + ' · ' + (d.detail || '');
    if (d.saveAs) appendLog(d.cls || 'ok', (d.cls === 'fail' ? '✗ ' : '✓ ') + d.saveAs + (d.bytes ? ' (' + d.bytes + 'B)' : ''));
  } else if (d.type === 'ok') {
    appendLog('ok', '✓ ' + d.saveAs + (d.bytes ? ' (' + d.bytes + 'B)' : ''));
  } else if (d.type === 'fail') {
    appendLog('fail', '✗ ' + d.saveAs + ': ' + d.error);
  } else if (d.type === 'skip') {
    appendLog('skip', '⊘ ' + d.saveAs + ' (已存在)');
  }
}

function appendLog(cls, line) {
  const el = document.getElementById('log');
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = line;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  // 限制行数
  while (el.childNodes.length > 500) el.removeChild(el.firstChild);
}
</script>
</body>
</html>`;

// SSE 订阅者列表
const subscribers = new Set();

function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of subscribers) {
    try { res.write(data); } catch {}
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    return;
  }

  // JSON 文件上传：浏览器原生 input[type=file] → FormData → 这里接收保存到 tmp
  // 替代 PowerShell 对话框（用户报告 STA 也不弹窗）
  if (req.method === 'POST' && url.pathname === '/api/upload-json') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const boundary = (req.headers['content-type'] || '').match(/boundary=(.+)/);
        if (!boundary) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'multipart boundary 未找到' }));
          return;
        }
        const buf = Buffer.concat(chunks);
        // 简易 multipart 解析：按 boundary 分块
        const sep = Buffer.from('--' + boundary[1]);
        const parts = [];
        let start = 0;
        while (true) {
          const idx = buf.indexOf(sep, start);
          if (idx < 0) break;
          if (idx > start) parts.push(buf.slice(start, idx));
          start = idx + sep.length;
          // 结束标记
          if (buf.slice(start, start + 2).toString() === '--') break;
          // 跳过 \r\n
          start += 2;
        }
        // 找含 filename= 的 part（实际文件内容）
        let fileBuf = null;
        let filename = 'scene-urls.json';
        for (const p of parts) {
          const s = p.toString();
          const hdrEnd = s.indexOf('\r\n\r\n');
          if (hdrEnd < 0) continue;
          const header = s.slice(0, hdrEnd);
          if (/filename=/.test(header)) {
            const m = header.match(/filename="([^"]+)"/);
            if (m) filename = m[1];
            fileBuf = p.slice(hdrEnd + 4, p.length - 2); // 去尾 \r\n
            break;
          }
        }
        if (!fileBuf) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '未找到文件内容' }));
          return;
        }
        const tmpDir = join(tmpdir(), 'scene-downloader');
        mkdirSync(tmpDir, { recursive: true });
        const outPath = join(tmpDir, `scene-urls-${Date.now()}.json`);
        writeFileSync(outPath, fileBuf);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: outPath, bytes: fileBuf.length }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/pick-json') {
    const p = pickFileCrossPlatform('JSON 文件', '*.json');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(p ? { ok: true, path: p } : { ok: false }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/pick-dir') {
    const p = pickFolderCrossPlatform();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(p ? { ok: true, path: p } : { ok: false }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    let buf = '';
    req.on('data', (c) => buf += c);
    req.on('end', () => {
      try {
        const { jsonPath, outDir, concurrency, postProcess } = JSON.parse(buf);
        if (!jsonPath || !outDir) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '参数缺失' }));
          return;
        }
        if (dlState?.running) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '已有下载在运行' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        runDownload(jsonPath, outDir, concurrency || 8, postProcess || {}, broadcast).catch((e) => {
          broadcast({ type: 'post-done', reportPath: '', error: e.message });
        });
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Scene Downloader GUI 已启动: ${url}`);
  console.log('（关闭此窗口或 Ctrl+C 退出）');
  // 自动打开浏览器
  if (platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', url], { shell: true, stdio: 'ignore' });
  }
});

// 保持进程运行
process.on('uncaughtException', (e) => {
  console.error('未捕获异常:', e);
});
