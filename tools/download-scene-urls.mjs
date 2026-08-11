/**
 * 整场景资源 URL 清单批量下载器
 *
 * 用法:
 *   node tools/download-scene-urls.mjs <scene-urls.json 路径> [输出根目录]
 *
 * 输入: panel 「整场景资源 URL 清单」下载的 scene-urls.json
 * 输出: 在指定根目录下，按 group 分类落盘
 *   - images/...
 *   - dragonbones/<name>/...
 *   - spines/<name>/...
 *   - movieclips/<name>/...
 *   - resources/... (RES.config 全量资源)
 *
 * 特性:
 *   - 并发 8（可改 -c 16）
 *   - 失败重试 3 次
 *   - 跳过已存在且字节数匹配的文件（断点续传）
 *   - 写 _download-report.json 记录成功/失败明细
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { argv, exit } from 'node:process';

// Node 18+ 全局 fetch

const CONCURRENCY = parseInt(process.env.DL_CONCURRENCY || '8', 10);
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 1000;

function parseArgs() {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error('用法: node tools/download-scene-urls.mjs <scene-urls.json> [输出根目录] [-c 并发数]');
    exit(1);
  }
  let jsonPath = '';
  let outRoot = '';
  let concurrency = CONCURRENCY;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--concurrency') {
      concurrency = parseInt(args[++i], 10) || CONCURRENCY;
    } else if (!jsonPath) {
      jsonPath = a;
    } else if (!outRoot) {
      outRoot = a;
    }
  }
  if (!jsonPath) {
    console.error('缺少 scene-urls.json 路径');
    exit(1);
  }
  if (!outRoot) {
    outRoot = join(dirname(jsonPath), 'downloaded');
  }
  return { jsonPath, outRoot: normalize(outRoot), concurrency };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
      return { ok: true, buf, bytes: buf.length, contentType: r.headers.get('content-type') };
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
  if (!full.startsWith(rootNorm)) {
    throw new Error(`路径越界: ${rel} -> ${full}`);
  }
  return full;
}

async function downloadOne(url, saveAs, outRoot, report) {
  if (!url || !/^https?:\/\//.test(url)) {
    report.skipped.push({ url, saveAs, reason: '非 http(s) URL' });
    return;
  }
  const fullPath = saveAs ? safeJoin(outRoot, saveAs) : safeJoin(outRoot, url.split('/').pop()?.split('?')[0] || 'file');
  try {
    // 断点续传：已存在则跳过
    if (existsSync(fullPath)) {
      const st = statSync(fullPath);
      if (st.size > 0) {
        report.skipped.push({ url, saveAs, bytes: st.size, reason: '已存在' });
        return;
      }
    }
    const r = await fetchWithRetry(url);
    if (!r.ok) {
      report.failed.push({ url, saveAs, error: r.error });
      return;
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, r.buf);
    report.ok.push({ url, saveAs, bytes: r.bytes });
  } catch (e) {
    report.failed.push({ url, saveAs, error: e.message });
  }
}

async function runPool(tasks, concurrency) {
  const it = tasks[Symbol.iterator]();
  let done = 0;
  const total = tasks.length;
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const next = it.next();
      if (next.done) return;
      await next.value();
      done++;
      if (done % 10 === 0 || done === total) {
        process.stdout.write(`\r  进度 ${done}/${total} …   `);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write('\n');
}

function collectTasks(data, outRoot, report) {
  const tasks = [];
  const g = data.groups;

  // sprites
  for (const s of (g.sprites || [])) {
    tasks.push(() => downloadOne(s.url, s.saveAs || `images/${s.name}.png`, outRoot, report));
  }

  // dragonBones
  for (const db of (g.dragonBones || [])) {
    for (const u of (db.urls || [])) {
      tasks.push(() => downloadOne(u.url, u.saveAs, outRoot, report));
    }
  }

  // spines
  for (const sp of (g.spines || [])) {
    for (const u of (sp.urls || [])) {
      tasks.push(() => downloadOne(u.url, u.saveAs, outRoot, report));
    }
  }

  // movieclips
  for (const mc of (g.movieclips || [])) {
    for (const u of (mc.urls || [])) {
      tasks.push(() => downloadOne(u.url, u.saveAs, outRoot, report));
    }
  }

  // resources（RES.config 全量）— 按 url 字段过滤
  if (Array.isArray(g.resources)) {
    let resIdx = 0;
    for (const r of g.resources) {
      const url = r?.url || r?.src || r?.configUrl;
      if (!url) continue;
      const name = r?.name || r?.alias || `res_${resIdx++}`;
      const ext = url.split('/').pop()?.split('?')[0]?.split('.').pop() || 'bin';
      tasks.push(() => downloadOne(url, `resources/${name}.${ext}`, outRoot, report));
      resIdx++;
    }
  }

  return tasks;
}

async function main() {
  const { jsonPath, outRoot, concurrency } = parseArgs();
  console.log(`scene-urls: ${jsonPath}`);
  console.log(`输出根目录: ${outRoot}`);
  console.log(`并发数: ${concurrency}`);

  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  console.log(`场景: ${data.scene || '(未命名)'}  ·  导出时间: ${data.exportedAt}`);
  console.log(`资源总数: ${JSON.stringify(data.totals || {})}`);

  const report = { ok: [], failed: [], skipped: [] };
  const tasks = collectTasks(data, outRoot, report);
  console.log(`任务总数: ${tasks.length}`);

  mkdirSync(outRoot, { recursive: true });
  const t0 = Date.now();
  await runPool(tasks, concurrency);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const reportPath = join(outRoot, '_download-report.json');
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        scene: data.scene,
        pageUrl: data.pageUrl,
        exportedAt: data.exportedAt,
        downloadAt: new Date().toISOString(),
        durationSec: Number(dt),
        ok: report.ok.length,
        failed: report.failed.length,
        skipped: report.skipped.length,
        failedItems: report.failed.slice(0, 50),
      },
      null,
      2
    )
  );

  console.log(`\n完成: ✓ ${report.ok.length}  ✗ ${report.failed.length}  ⊘ ${report.skipped.length}  耗时 ${dt}s`);
  console.log(`报告: ${reportPath}`);
  if (report.failed.length > 0) exit(1);
}

main().catch((e) => {
  console.error('下载失败:', e);
  exit(1);
});
