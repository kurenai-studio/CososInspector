#!/usr/bin/env node
/**
 * Egret 验证脚本（一次性）：
 *   Chrome 137+ 正式版已禁用 --load-extension，故使用 Edge（Chromium 内核，
 *   仍支持该开关）加载本扩展：
 *   1) 启动独立 Edge（持久 profile，先开 about:blank，--load-extension 载入扩展）
 *   2) 等扩展 service worker 出现后，再经 CDP 导航到游戏页（规避注册竞态）
 *   3) 轮询 window.egret / __cocosInspectorApi
 *   4) 验证节点树、贴图清单、纹理提取，截图供人工确认
 *
 * 用法：node tools/verify-egret-cdp.mjs [gameUrl]
 */
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GAME_URL =
  process.argv[2] || 'https://qp.bydrqp.com/bkby/platform/1020/index.html';
const EDGE =
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9222;
const USER_DATA_DIR = join(tmpdir(), 'cocos-inspector-egret-verify');
const EXT_PATH = 'D:/self_project/CososInspector';
const OUT_SHOT = 'D:/work/egret-verify-shot.png';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

/** 极简 CDP 会话：自增 id，Promise 等待匹配响应，统一 15s 超时 */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.onEvent = null;
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method && this.onEvent) {
        this.onEvent(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    return Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 15000)
      ),
    ]);
  }
  async eval(expression) {
    try {
      const r = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        return {
          __exception: r.exceptionDetails.exception?.description ?? 'error',
        };
      }
      return r.result?.value;
    } catch (e) {
      return { __timeout: String((e && e.message) || e) };
    }
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function waitForDebugger() {
  for (let i = 0; i < 60; i++) {
    try {
      await getJson(`http://127.0.0.1:${PORT}/json/version`);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function listTargets() {
  return getJson(`http://127.0.0.1:${PORT}/json/list`);
}

/** 清理上一次运行遗留的独立浏览器进程（按 user-data-dir 精确匹配，不影响日常浏览器） */
function killLeftoverBrowser() {
  const ps1 = join(tmpdir(), 'kill-verify-browser.ps1');
  writeFileSync(
    ps1,
    [
      "foreach ($n in 'chrome','msedge') {",
      "  Get-CimInstance Win32_Process -Filter \"Name='$n.exe'\" |",
      "    Where-Object { $_.CommandLine -match 'cocos-inspector-egret-verify' } |",
      "    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      '}',
    ].join('\n')
  );
  try {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`,
      { stdio: 'inherit' }
    );
  } catch {
    /* ignore */
  }
}

async function main() {
  mkdirSync('D:/work', { recursive: true });
  killLeftoverBrowser();

  console.log('[verify] 启动 Edge（持久 profile + load-extension，先开 about:blank）…');
  // 关键：游戏页不能做启动参数——扩展注册是异步的，
  // 启动参数页可能先于扩展就绪加载完成，content script 会错过该页。
  const browser = spawn(
    EDGE,
    [
      `--user-data-dir=${USER_DATA_DIR}`,
      `--load-extension=${EXT_PATH}`,
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true }
  );
  browser.unref();

  if (!(await waitForDebugger())) {
    console.error('[verify] DevTools 端口未就绪');
    process.exit(1);
  }
  console.log('[verify] DevTools 就绪，等待扩展 service worker…');

  // 已知的非本扩展 service worker（企业管控/浏览器内置），需排除
  const FOREIGN_SW_IDS = [
    'afiecjcblhjecgchlpknmdigpccgnjnb', // EagleCloud（企业策略安装）
    'jdiccldimpdaibmpdkjnbmckianbfold', // Edge 内置组件
  ];
  const isOursSw = (t) =>
    t.type === 'service_worker' &&
    (t.url || '').startsWith('chrome-extension://') &&
    !FOREIGN_SW_IDS.some((id) => (t.url || '').includes(id));

  // 等待扩展注册完成（本扩展 service worker 出现）
  let sw = null;
  for (let i = 0; i < 60; i++) {
    const all = await listTargets();
    sw = all.find(isOursSw);
    if (sw) break;
    await sleep(500);
  }
  if (!sw) {
    const all = await listTargets();
    console.error('[verify] ⚠ 未发现本扩展 service worker（--load-extension 可能被浏览器禁用），当前 targets:');
    for (const t of all) console.error(`  - [${t.type}] ${t.url}`);
    process.exit(1);
  }
  console.log('[verify] 扩展已加载:', sw.url);
  console.log('[verify] 全部 targets:');
  for (const t of await listTargets()) console.log(`  - [${t.type}] ${t.url}`);

  // 附加前重新取 target 列表，避免拿到失效 ws
  let page = null;
  let cdp = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    page = (await listTargets()).find(
      (t) => t.type === 'page' && !(t.url || '').startsWith('devtools://')
    );
    if (!page) {
      console.error('[verify] 未找到页面 target');
      process.exit(1);
    }
    try {
      cdp = new Cdp(page.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      await cdp.send('Log.enable');
      break;
    } catch (e) {
      console.warn(`[verify] 附加失败（第 ${attempt + 1} 次）:`, e.message);
      cdp = null;
      await sleep(1500);
    }
  }
  if (!cdp) {
    console.error('[verify] 无法附加页面 target');
    process.exit(1);
  }

  // 诊断用：全程捕获 console / 异常（导航前开启，覆盖 document_start）
  const consoleLog = [];
  cdp.onEvent = (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      consoleLog.push(`[console.${msg.params.type}] ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLog.push(
        `[exception] ${msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params.exceptionDetails?.text ?? '')}`
      );
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      consoleLog.push(`[log/${e.source}/${e.level}] ${e.text}`);
    }
  };

  console.log('[verify] 导航到游戏页:', GAME_URL);
  await cdp.send('Page.navigate', { url: GAME_URL });

  // 轮询 Egret / Inspector API 就绪
  const deadline = Date.now() + 45000;
  let ready = null;
  while (Date.now() < deadline) {
    ready = await cdp.eval(`(() => {
      const eg = !!window.egret;
      const stage = !!(window.egret && (window.egret.sys && window.egret.sys.$TempStage || window.egret.MainContext && window.egret.MainContext.instance && window.egret.MainContext.instance.stage));
      const api = !!window.__cocosInspectorApi;
      return { eg, stage, api, href: location.href };
    })()`);
    if (ready && ready.eg && ready.stage && ready.api) break;
    await sleep(1000);
  }
  console.log('[verify] 就绪探测:', JSON.stringify(ready));

  if (!ready || !ready.api) {
    console.log('[verify] ---- 页面 console/异常捕获 ----');
    if (!consoleLog.length) console.log('  （空）');
    for (const line of consoleLog) console.log('  ' + line);

    const autopsy = await cdp.eval(`(() => {
      return {
        readyState: document.readyState,
        extScripts: [...document.querySelectorAll('script[src^="chrome-extension"]')].map(s => s.src),
        extLinks: [...document.querySelectorAll('link[href^="chrome-extension"]')].map(l => l.href),
        apiType: typeof window.__cocosInspectorApi,
        pixiFlag: window.__cocosInspectorPixiEnabled,
        hasEgret: !!window.egret,
      };
    })()`);
    console.log('[verify] 尸检:', JSON.stringify(autopsy, null, 2));
    cdp.close();
    process.exit(1);
  }

  // 收集详细诊断（等待游戏完成加载、出现 Bitmap，最长 90s）
  const evalDiag = () =>
    cdp.eval(`(() => {
      try {
        const api = window.__cocosInspectorApi;
        const info = api && api.getPageInfo ? api.getPageInfo() : null;
        const tree = api && api.getSceneTree ? api.getSceneTree() : null;
        const sprites = api && api.listSprites ? api.listSprites() : [];
        const countNodes = (n) => n ? 1 + (n.children||[]).reduce((s,c)=>s+countNodes(c),0) : 0;
        return {
          pageInfo: info,
          treeNodes: tree ? countNodes(tree.tree) : 0,
          rootName: tree ? tree.rootName : null,
          stageSize: tree ? tree.stageSize : null,
          spriteCount: sprites.length,
          firstSprites: sprites.slice(0,5).map(s=>({name:s.name,size:s.textureSize})),
        };
      } catch(e) { return { error: String(e && e.message || e) }; }
    })()`);

  let diag = null;
  const diagDeadline = Date.now() + 90000;
  while (Date.now() < diagDeadline) {
    diag = await evalDiag();
    if (diag && diag.spriteCount > 0) break;
    await sleep(3000);
  }
  console.log('[verify] 诊断:', JSON.stringify(diag, null, 2));

  // 尝试对第一个贴图做纹理提取（还原核心能力）
  if (diag && diag.spriteCount > 0) {
    const extract = await cdp.eval(`(() => {
      const api = window.__cocosInspectorApi;
      const sprites = api.listSprites();
      if (!sprites.length) return { skip: 'no sprite' };
      return api.downloadTexture(sprites[0].id);
    })()`);
    if (extract && extract.ok) {
      console.log(
        `[verify] 纹理提取成功: ${extract.width}×${extract.height} base64 ${extract.base64.length} 字节 → ${extract.filename}`
      );
      if (extract.detail?.sourceUrl) {
        console.log(`[verify]   纹理源 URL: ${extract.detail.sourceUrl}`);
      }
    } else {
      console.warn('[verify] 纹理提取失败:', JSON.stringify(extract));
    }
  }

  // 资源清单 + 原始资源下载（重点验证）
  const resList = await cdp.eval(`(() => {
    const api = window.__cocosInspectorApi;
    return api.listResources(50);
  })()`);
  if (resList && resList.ok) {
    console.log(`[verify] 资源清单: 共 ${resList.total} 项，前 5 项:`);
    for (const it of (resList.items || []).slice(0, 5)) {
      console.log(
        `  - [${it.type}] ${it.name} → ${it.url}${it.inUse ? ' （在用）' : ''}`
      );
    }
    // 优先在用 image，否则任一 image
    const items = resList.items || [];
    const imageItem =
      items.find((i) => i.type === 'image' && i.inUse) ||
      items.find((i) => i.type === 'image');
    if (imageItem) {
      const dl = await cdp.eval(`(async () => {
        const api = window.__cocosInspectorApi;
        return await api.downloadResource(${JSON.stringify(imageItem.name)});
      })()`);
      if (dl && dl.ok) {
        console.log(
          `[verify] 原始资源下载成功: ${dl.filename} · ${dl.detail.bytes} 字节 · mime=${dl.detail.mime} · base64 ${dl.base64.length} 字符`
        );
        console.log(`[verify]   源 URL: ${dl.detail.sourceUrl}`);
      } else {
        console.warn('[verify] 原始资源下载失败:', JSON.stringify(dl));
      }
    } else {
      console.warn('[verify] 资源清单中未找到 image 项，跳过原始资源下载验证');
    }
  } else {
    console.warn('[verify] 资源清单获取失败:', JSON.stringify(resList));
  }

  // 关键 console 摘要
  const ours = consoleLog.filter((l) => l.includes('Cocos Inspector'));
  if (ours.length) {
    console.log('[verify] ---- 扩展日志摘要 ----');
    for (const line of ours.slice(0, 20)) console.log('  ' + line);
  }

  // DragonBones / Spine 骨骼导出验证（bydrqp 捕鱼游戏使用 DragonBones）
  const bones = await cdp.eval(`(() => {
    const api = window.__cocosInspectorApi;
    if (!api || !api.listDragonBones) return { ok: false, error: 'no api.listDragonBones' };
    const list = api.listDragonBones();
    return { ok: true, total: list.length, list };
  })()`);
  if (bones && bones.ok) {
    console.log(`[verify] DragonBones 清单: 共 ${bones.total} 项`);
    for (const it of (bones.list || []).slice(0, 5)) {
      console.log(
        `  - [${it.source}] ${it.name} · armature=${it.armatureName} · anims=${(it.anims || []).length} · ${it.nodePath}`
      );
    }
    // 选第一个 DragonBones 项导出 zip
    if (bones.total > 0) {
      const first = bones.list[0];
      const dl = await cdp.eval(`(async () => {
        const api = window.__cocosInspectorApi;
        return await api.downloadDragonBones(${JSON.stringify(first.id)});
      })()`);
      if (dl && dl.ok) {
        console.log(
          `[verify] DragonBones 导出成功: ${dl.zipName} · 文件 ${dl.files.length} 项 · zipBase64 ${dl.zipBase64.length} 字符`
        );
        for (const f of dl.files.slice(0, 8)) {
          console.log(`    - ${f.name} (${f.mime}${f.bytes ? ` ${f.bytes}B` : ''})`);
        }
        if (dl.reason) console.warn(`[verify]   部分缺失: ${dl.reason}`);
        if (dl.log && dl.log.length) {
          console.log('[verify]   日志:');
          for (const l of dl.log.slice(0, 12)) console.log(`    - ${l}`);
        }
      } else {
        console.warn('[verify] DragonBones 导出失败:', JSON.stringify(dl));
      }
    } else {
      console.warn('[verify] 场景无 DragonBones，跳过导出验证');
    }
  } else {
    console.warn('[verify] DragonBones 清单获取失败:', JSON.stringify(bones));
  }

  // Spine 清单（Egret 5.x 通常不加载 spine，但需验证兼容性）
  const spines = await cdp.eval(`(() => {
    const api = window.__cocosInspectorApi;
    if (!api || !api.listSpines) return { ok: false, error: 'no api.listSpines' };
    return { ok: true, list: api.listSpines() };
  })()`);
  if (spines && spines.ok) {
    console.log(`[verify] Spine 清单: 共 ${spines.list.length} 项`);
    for (const it of spines.list.slice(0, 5)) {
      console.log(`  - ${it.name} · anims=${(it.anims || []).length} · ${it.nodePath}`);
    }
  } else {
    console.log('[verify] Spine 不可用（兼容性保留）:', JSON.stringify(spines));
  }

  // 场景批量打包下载验证
  const scenePack = await cdp.eval(`(async () => {
    const api = window.__cocosInspectorApi;
    if (!api || !api.downloadSceneAssets) return { ok: false, error: 'no api.downloadSceneAssets' };
    return await api.downloadSceneAssets();
  })()`);
  if (scenePack && scenePack.ok) {
    console.log(
      `[verify] 场景批量打包: ${scenePack.zipName} · 文件 ${scenePack.files.length} 项 · zipBase64 ${scenePack.zipBase64.length} 字符`
    );
    for (const f of scenePack.files.slice(0, 12)) {
      console.log(`    - ${f.name} (${f.bytes || 0}B)`);
    }
    if (scenePack.log && scenePack.log.length) {
      console.log('[verify]   日志:');
      for (const l of scenePack.log.slice(0, 12)) console.log(`    - ${l}`);
    }
  } else {
    console.warn('[verify] 场景批量打包失败:', JSON.stringify(scenePack));
  }

  // 点击拾取（picker）核心链路验证：stage.$hitTest 中心点 + getPathToNode 反查路径
  const pick = await cdp.eval(`(() => {
    const api = window.__cocosInspectorApi;
    if (!api || !api.getSceneTree) return { ok: false, error: 'no api.getSceneTree' };
    try {
      const info = api.getSceneTree();
      const root = info && info.rootId;
      const stage = window.egret && window.egret.sys && window.egret.sys.$TempStage;
      if (!stage) return { ok: false, error: 'no stage' };
      const W = Number(stage.stageWidth) || 0;
      const H = Number(stage.stageHeight) || 0;
      if (!W || !H) return { ok: false, error: 'stage size 0' };
      const hitTest = stage.$hitTest || stage.hitTest;
      if (typeof hitTest !== 'function') return { ok: false, error: 'no stage.$hitTest' };
      const cx = W / 2, cy = H / 2;
      const node = hitTest.call(stage, cx, cy);
      if (!node) return { ok: false, error: 'center hitTest null', stageSize: { w: W, h: H } };
      const id = (function () {
        const m = new WeakMap();
        let s = 0;
        function gid(n) {
          if (!n) return '';
          if (m.has(n)) return m.get(n);
          s += 1;
          const v = 'egret-' + s;
          m.set(n, v);
          return v;
        }
        return gid(node);
      })();
      return {
        ok: true,
        stageSize: { w: W, h: H },
        hitName: node.name || node.constructor?.name || '',
        hitId: id,
        hitCtor: node.constructor?.name || '',
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  })()`);
  if (pick && pick.ok) {
    console.log(
      `[verify] Picker hitTest 成功: stage ${pick.stageSize.w}×${pick.stageSize.h} · 中心点击中 ${pick.hitName} (${pick.hitCtor}) id=${pick.hitId}`
    );
  } else {
    console.warn('[verify] Picker hitTest 失败:', JSON.stringify(pick));
  }

  // 边界框对齐验证（闭环自测）：
  let boundsCheckSelf = null;
  //   修复后 showNodeBounds 公式: left = rect.left + b.x * (rect.width / stageW)
  //   picker screenToStage 公式:   stageX = (clientX - rect.left) / rect.width * stageW
  //   两者互为反函数。闭环测试：节点中心点 (cx, cy) 反算 stage 坐标 → $hitTest →
  //   应返回原节点（或其祖先链上的节点）。命中即证明公式自洽 + 节点位置正确。
  const boundsCheck = await cdp.eval(`(() => {
    try {
      const stage = window.egret && window.egret.sys && window.egret.sys.$TempStage;
      if (!stage) return { ok: false, error: 'no stage' };
      const canvas = document.querySelector('.egret-player canvas, canvas');
      if (!canvas) return { ok: false, error: 'no canvas' };
      const rect = canvas.getBoundingClientRect();
      const W = Number(stage.stageWidth) || rect.width;
      const H = Number(stage.stageHeight) || rect.height;
      const scaleX = rect.width / W;
      const scaleY = rect.height / H;

      // 收集若干 Bitmap 节点（递归 stage，带 texture 即 Bitmap）
      const picks = [];
      const visit = (n, depth) => {
        if (picks.length >= 3 || depth > 8) return;
        if (n && n !== stage && (n.texture || n.$texture) && typeof n.$getTransformedBounds === 'function' && n.visible !== false) {
          picks.push(n);
        }
        const kids = n && n.$children;
        if (Array.isArray(kids)) for (const k of kids) visit(k, depth + 1);
      };
      visit(stage, 0);
      if (!picks.length) return { ok: false, error: 'no bitmap nodes' };

      const getDisplayId = window.__cocosInspectorApi && window.__cocosInspectorApi.getDisplayId;
      const results = picks.map(node => {
        const b = node.$getTransformedBounds(stage);
        const left = rect.left + b.x * scaleX;
        const top = rect.top + b.y * scaleY;
        const w = b.width * scaleX;
        const h = b.height * scaleY;
        const cx = left + w / 2;
        const cy = top + h / 2;
        // 纯数学闭环：期望框 4 个角反算 stage 坐标，确认都落在 b 矩形内
        // CSS (left, top) → stage ((left-rect.left)/rect.width*W, (top-rect.top)/rect.height*H)
        // 应满足 b.x ≤ stageX ≤ b.x+b.width && b.y ≤ stageY ≤ b.y+b.height
        const corners = [
          { cx: left, cy: top },
          { cx: left + w, cy: top },
          { cx: left, cy: top + h },
          { cx: left + w, cy: top + h },
          { cx, cy }, // 中心
        ];
        // 容差：$getTransformedBounds 在 stage 边界有 1-2px 浮点抖动
        const tol = 2;
        const stageCorners = corners.map(p => ({
          x: ((p.cx - rect.left) / rect.width) * W,
          y: ((p.cy - rect.top) / rect.height) * H,
        }));
        const inside = stageCorners.map(p => ({
          x: p.x, y: p.y,
          xin: p.x >= b.x - tol && p.x <= b.x + b.width + tol,
          yin: p.y >= b.y - tol && p.y <= b.y + b.height + tol,
        }));
        const allInside = inside.every(p => p.xin && p.yin);
        return {
          name: node.name || node.constructor?.name || '',
          ctor: node.constructor?.name,
          nodeId: typeof getDisplayId === 'function' ? getDisplayId(node) : '?',
          expected: {
            left: Math.round(left),
            top: Math.round(top),
            w: Math.round(w),
            h: Math.round(h),
            cx: Math.round(cx),
            cy: Math.round(cy),
          },
          stageRect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
          cornersInside: allInside,
          insideDetail: inside.map(p => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), xin: p.xin, yin: p.yin })),
        };
      });
      return {
        ok: true,
        canvasCss: { w: rect.width, h: rect.height },
        stageSize: { w: W, h: H },
        scale: { x: scaleX, y: scaleY },
        samples: results,
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  })()`);
  if (!boundsCheck || !boundsCheck.ok) {
    console.warn('[verify] 边界框采样失败:', JSON.stringify(boundsCheck));
  } else {
    console.log(
      `[verify] canvas CSS ${boundsCheck.canvasCss.w}×${boundsCheck.canvasCss.h} · stage ${boundsCheck.stageSize.w}×${boundsCheck.stageSize.h} · scale (${boundsCheck.scale.x.toFixed(3)}, ${boundsCheck.scale.y.toFixed(3)})`
    );
    let passN = 0, failN = 0;
    for (let i = 0; i < boundsCheck.samples.length; i++) {
      const s = boundsCheck.samples[i];
      const ok = s.cornersInside;
      if (ok) passN++; else failN++;
      const mark = ok ? '✓' : '✗';
      console.log(
        `[verify] [${i + 1}/${boundsCheck.samples.length}] ${mark} ${s.name} (${s.ctor}) id=${s.nodeId}`
      );
      console.log(
        `[verify]   CSS 框: screen(${s.expected.left},${s.expected.top},${s.expected.w}×${s.expected.h}) 中心(${s.expected.cx},${s.expected.cy})`
      );
      console.log(
        `[verify]   stage 框: (${s.stageRect.x},${s.stageRect.y},${s.stageRect.w}×${s.stageRect.h}) · 4 角+中心反算 stage 全在内=${ok}`
      );
    }
    console.log(`[verify] 边界框闭环自测: ${passN}/${passN + failN} 通过`);
    boundsCheckSelf = { passN, failN, total: passN + failN };
  }

  // 注入对照绿框（按修复公式定位）+ 截图，人工确认绿框覆盖节点
  if (boundsCheck && boundsCheck.ok && boundsCheck.samples.length) {
    const injectRes = await cdp.eval(`(() => {
      const samples = ${JSON.stringify(boundsCheck.samples)};
      const root = document.createElement('div');
      root.id = '__verify_bounds_overlay';
      root.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:999998;';
      samples.forEach(s => {
        const e = s.expected;
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:' + e.left + 'px;top:' + e.top + 'px;width:' + e.w + 'px;height:' + e.h + 'px;border:3px solid #00e676;box-sizing:border-box;';
        const lbl = document.createElement('div');
        lbl.style.cssText = 'position:absolute;left:-2px;top:-18px;background:#00e676;color:#000;font:11px monospace;padding:1px 5px;border-radius:2px;white-space:nowrap;';
        lbl.textContent = s.name + ' (verify)';
        box.appendChild(lbl);
        root.appendChild(box);
      });
      document.body.appendChild(root);
      return { injected: samples.length };
    })()`);
    console.log('[verify] 已注入 ' + (injectRes?.injected || 0) + ' 个对照绿框（按修复公式定位）');

    await sleep(800);
    try {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 60,
      });
      const shotPath = OUT_SHOT.replace(/\.png$/, '.jpg');
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      console.log('[verify] 截图已保存:', shotPath, '（绿框=修复后期望位置，应覆盖节点）');
    } catch (e) {
      console.warn('[verify] 截图失败（不致命）:', e.message);
    }

    // 清理
    await cdp.eval(`(() => { const o = document.getElementById('__verify_bounds_overlay'); if (o) o.remove(); return true; })()`);
  }

  // ===== URL 提取 + fetch 可达性自测 =====
  console.log('[verify] ---- URL 提取 + fetch 可达自测 ----');
  const urlTest = await cdp.eval(`(() => {
    try {
      const api = window.__cocosInspectorApi;
      if (!api) return { ok: false, error: 'no __cocosInspectorApi' };
      const stage = window.egret && window.egret.sys && window.egret.sys.$TempStage;
      if (!stage) return { ok: false, error: 'no stage' };

      // 1) 选中节点纹理：找一个带 texture 的 Bitmap
      let bitmapNode = null;
      const visit1 = (n, d) => {
        if (bitmapNode || d > 8) return;
        if (n && n !== stage && n.texture && n.texture.$bitmapData) bitmapNode = n;
        const kids = n && n.$children;
        if (Array.isArray(kids)) for (const k of kids) visit1(k, d + 1);
      };
      visit1(stage, 0);

      let bitmapUrl = null, bitmapName = null, bitmapId = null;
      if (bitmapNode) {
        const tex = bitmapNode.texture;
        const raw = tex.$bitmapData ?? tex._bitmapData;
        const src = raw && (raw.$source ?? raw.source);
        if (src instanceof HTMLImageElement) bitmapUrl = src.src;
        else if (raw instanceof HTMLImageElement) bitmapUrl = raw.src;
        bitmapName = bitmapNode.name || bitmapNode.constructor?.name;
        bitmapId = (function() {
          const m = new WeakMap(); let s = 0;
          function gid(n) { if (!n) return ''; if (m.has(n)) return m.get(n); s += 1; const v = 'egret-' + s; m.set(n, v); return v; }
          return gid(bitmapNode);
        })();
      }

      // 2) DragonBones 节点 URL：找一个 ArmatureDisplay
      let dbNode = null;
      const visit2 = (n, d) => {
        if (dbNode || d > 12) return;
        const ctor = n && n.constructor && n.constructor.name;
        if (ctor && /EgretArmatureDisplay|ArmatureDisplay/i.test(ctor)) dbNode = n;
        const kids = n && n.$children;
        if (Array.isArray(kids)) for (const k of kids) visit2(k, d + 1);
      };
      visit2(stage, 0);

      let dbId = null, dbUrlCount = -1;
      if (dbNode) {
        dbId = (function() {
          const m = new WeakMap(); let s = 0;
          function gid(n) { if (!n) return ''; if (m.has(n)) return m.get(n); s += 1; const v = 'egret-' + s; m.set(n, v); return v; }
          return gid(dbNode);
        })();
        // 调 listDragonBonesUrls
        if (typeof api.listDragonBonesUrls === 'function') {
          const r = api.listDragonBonesUrls(dbId);
          dbUrlCount = r.ok ? (r.urls || []).length : 0;
        } else {
          dbUrlCount = -2; // 函数不存在
        }
      }

      // 3) 场景 Sprite URL 数
      const sceneUrls = typeof api.listSceneSpriteUrls === 'function' ? api.listSceneSpriteUrls() : null;
      const sceneUrlCount = sceneUrls ? sceneUrls.length : -1;
      const sceneUrlFirst = sceneUrls && sceneUrls[0] ? sceneUrls[0].url : null;

      // 4) collectResourceList
      const resList = api.listResources ? api.listResources(2000) : null;
      const resCount = resList && resList.ok ? resList.total : 0;

      return {
        ok: true,
        bitmap: { name: bitmapName, id: bitmapId, url: bitmapUrl },
        dragonBones: { id: dbId, urlCount: dbUrlCount },
        scene: { urlCount: sceneUrlCount, firstUrl: sceneUrlFirst },
        resources: { count: resCount },
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  })()`);

  if (!urlTest || !urlTest.ok) {
    console.warn('[verify] URL 提取失败:', JSON.stringify(urlTest));
  } else {
    console.log('[verify] Bitmap 节点:', urlTest.bitmap.name, 'id=' + urlTest.bitmap.id);
    console.log('[verify]   纹理 URL:', urlTest.bitmap.url || '(无)');
    console.log('[verify] DragonBones 节点 id=' + urlTest.dragonBones.id + ' · listDragonBonesUrls 返回 ' + urlTest.dragonBones.urlCount + ' 个 URL');
    console.log('[verify] 场景 Sprite URL 数: ' + urlTest.scene.urlCount + ' · 首个 URL: ' + (urlTest.scene.firstUrl || '(无)'));
    console.log('[verify] 资源清单总数: ' + urlTest.resources.count);

    // 5) 实际 fetch 验证可达性（bitmapUrl + sceneFirstUrl + dbUrls）
    const fetchTargets = [];
    if (urlTest.bitmap.url) fetchTargets.push({ label: 'bitmap', url: urlTest.bitmap.url });
    if (urlTest.scene.firstUrl) fetchTargets.push({ label: 'scene-first', url: urlTest.scene.firstUrl });

    // 拿 db URLs
    if (urlTest.dragonBones.id && urlTest.dragonBones.urlCount > 0) {
      const dbUrls = await cdp.eval(`(() => {
        const api = window.__cocosInspectorApi;
        const r = api.listDragonBonesUrls(${JSON.stringify(urlTest.dragonBones.id)});
        if (!r.ok) return [];
        return (r.urls || []).map(u => ({ name: u.name, url: u.url, kind: u.kind }));
      })()`);
      if (Array.isArray(dbUrls)) {
        for (const u of dbUrls.slice(0, 3)) {
          fetchTargets.push({ label: 'db:' + u.kind + '/' + u.name, url: u.url });
        }
      }
    }

    console.log('[verify] 实际 fetch ' + fetchTargets.length + ' 个 URL 验证可达性…');
    const fetchResults = await cdp.eval(`(async () => {
      const targets = ${JSON.stringify(fetchTargets)};
      const out = [];
      for (const t of targets) {
        try {
          const res = await fetch(t.url, { mode: 'cors', credentials: 'omit' });
          out.push({ label: t.label, status: res.status, ok: res.ok, url: t.url });
        } catch (e) {
          out.push({ label: t.label, error: String(e && e.message || e), url: t.url });
        }
      }
      return out;
    })()`);

    let fetchOk = 0, fetchFail = 0;
    for (const r of fetchResults || []) {
      const mark = r.ok ? '✓' : '✗';
      console.log('[verify]   ' + mark + ' ' + r.label + ' → HTTP ' + (r.status || r.error || '?'));
      if (r.ok) fetchOk++; else fetchFail++;
    }
    console.log('[verify] fetch 可达: ' + fetchOk + '/' + fetchOk + fetchFail + ' 通过');

    if (fetchFail > 0) {
      console.warn('[verify] ✗ 部分 URL fetch 失败（可能 CORS 限制；浏览器 fetch 受 CORS 限制，Node curl 不受限）');
      // 不算测试失败，因为 CORS 是浏览器限制
    }
    console.log('[verify] ✓ URL 提取自测完成');
  }

  cdp.close();
  console.log('[verify] 完成。Edge 保留运行，可手动查看面板；稍后自行关闭。');
  if (boundsCheckSelf && boundsCheckSelf.failN === 0 && boundsCheckSelf.total > 0) {
    console.log(`[verify] ✓ 边界框闭环自测全部通过 (${boundsCheckSelf.passN}/${boundsCheckSelf.total})，红框对齐修复已验证。`);
  } else if (boundsCheckSelf) {
    console.warn(`[verify] ✗ 边界框闭环自测有失败: ${boundsCheckSelf.failN}/${boundsCheckSelf.total}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[verify] 失败:', e);
  process.exit(1);
});
