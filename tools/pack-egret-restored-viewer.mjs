#!/usr/bin/env node
/**
 * 将 Egret restored 资源 + Explorer 打成便携包并压缩 zip。
 *
 *   node tools/pack-egret-restored-viewer.mjs [restoredDir] [outDir]
 *
 * 默认：
 *   restored → tmp/egret-cdn-clues/qp.bydrqp.com/restored
 *   outDir   → tmp/egret-restored-pack
 *   zip      → tmp/egret-restored-pack.zip
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  statSync,
  createWriteStream,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESTORED = resolve(
  process.argv[2] ||
    join(ROOT, 'tmp/egret-cdn-clues/qp.bydrqp.com/restored')
);
const OUT_DIR = resolve(
  process.argv[3] || join(ROOT, 'tmp/egret-restored-pack')
);
const ZIP_PATH = join(dirname(OUT_DIR), `${basenameSafe(OUT_DIR)}.zip`);
const VIEWER_SRC = join(ROOT, 'tools/egret-restored-viewer.mjs');

const VENDOR_URLS = [
  {
    name: 'pixi.min.js',
    url: 'https://cdn.jsdelivr.net/npm/pixi.js@4.8.9/dist/pixi.min.js',
  },
  {
    name: 'dragonBones.js',
    url: 'https://cdn.jsdelivr.net/npm/dragonbones-pixi@5.6.0/out/dragonBones.js',
  },
];

function basenameSafe(p) {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'egret-restored-pack';
}

function fmtMb(n) {
  return (n / (1024 * 1024)).toFixed(1);
}

async function download(url, dest) {
  console.log(`[pack] download ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function writeStartScripts(dir) {
  writeFileSync(
    join(dir, 'start.bat'),
    [
      '@echo off',
      'cd /d "%~dp0"',
      'where node >nul 2>nul',
      'if errorlevel 1 (',
      '  echo 需要先安装 Node.js: https://nodejs.org/',
      '  pause',
      '  exit /b 1',
      ')',
      'echo 启动 Egret Restored Viewer ...',
      'node start.mjs',
      'pause',
      '',
    ].join('\r\n'),
    'utf8'
  );
  writeFileSync(
    join(dir, 'start.ps1'),
    [
      "Set-Location $PSScriptRoot",
      "if (-not (Get-Command node -ErrorAction SilentlyContinue)) {",
      "  Write-Error '需要先安装 Node.js: https://nodejs.org/'",
      '  exit 1',
      '}',
      "Write-Host '启动 Egret Restored Viewer ...'",
      'node start.mjs',
      '',
    ].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(dir, 'README.md'),
    [
      '# Egret Restored 便携浏览包',
      '',
      '内含还原资源目录 `restored/` 与浏览器脚本 `start.mjs`。',
      '',
      '## 要求',
      '',
      '- 已安装 [Node.js](https://nodejs.org/)（建议 18+）',
      '- 无需 npm install',
      '',
      '## 启动',
      '',
      '```bat',
      'start.bat',
      '```',
      '',
      '或：',
      '',
      '```powershell',
      'node start.mjs',
      'node start.mjs .\\restored 19528',
      '```',
      '',
      '浏览器打开：http://127.0.0.1:19528/',
      '',
      '局域网访问：http://<本机IP>:19528/',
      '',
      '## 内容',
      '',
      '| 路径 | 说明 |',
      '|------|------|',
      '| `start.mjs` | Explorer（原 egret-restored-viewer） |',
      '| `restored/` | 图集 / 散图 / 龙骨 / 字体 / 音频 / configs |',
      '| `vendor/` | 离线 Pixi + DragonBones 运行时 |',
      '',
      '由 CososInspectorNew `tools/pack-egret-restored-viewer.mjs` 生成。',
      '',
    ].join('\n'),
    'utf8'
  );
}

function zipWithTar(srcDir, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  console.log(`[pack] zip → ${zipPath}`);
  const r = spawnSync(
    'tar',
    ['-a', '-c', '-f', zipPath, '-C', srcDir, '.'],
    { stdio: 'inherit', shell: false }
  );
  if (r.status !== 0) {
    throw new Error(`tar zip failed, exit=${r.status}`);
  }
}

async function main() {
  if (!existsSync(RESTORED) || !statSync(RESTORED).isDirectory()) {
    console.error('[pack] restored 不存在:', RESTORED);
    process.exit(1);
  }
  if (!existsSync(VIEWER_SRC)) {
    console.error('[pack] viewer 不存在:', VIEWER_SRC);
    process.exit(1);
  }

  console.log('[pack] restored =', RESTORED);
  console.log('[pack] outDir   =', OUT_DIR);
  console.log('[pack] zip      =', ZIP_PATH);

  if (existsSync(OUT_DIR)) {
    console.log('[pack] 清理旧 outDir …');
    rmSync(OUT_DIR, { recursive: true, force: true });
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const vendorDir = join(OUT_DIR, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  for (const v of VENDOR_URLS) {
    await download(v.url, join(vendorDir, v.name));
  }

  console.log('[pack] copy viewer → start.mjs');
  copyFileSync(VIEWER_SRC, join(OUT_DIR, 'start.mjs'));
  writeStartScripts(OUT_DIR);

  console.log('[pack] copy restored（约 1.4GB，较慢）…');
  const t0 = Date.now();
  cpSync(RESTORED, join(OUT_DIR, 'restored'), { recursive: true });
  console.log(`[pack] restored 复制完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const t1 = Date.now();
  zipWithTar(OUT_DIR, ZIP_PATH);
  const zipSize = statSync(ZIP_PATH).size;
  console.log(
    `[pack] zip 完成 ${((Date.now() - t1) / 1000).toFixed(1)}s · ${fmtMb(zipSize)} MB`
  );
  console.log('[pack] OK');
  console.log(`  目录: ${OUT_DIR}`);
  console.log(`  压缩包: ${ZIP_PATH}`);
  console.log('  解压后运行: start.bat 或 node start.mjs');
}

main().catch((e) => {
  console.error('[pack] failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
