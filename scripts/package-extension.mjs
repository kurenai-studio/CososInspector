/**
 * 打 Chrome Web Store 用扩展包（不含 MCP / tools / 源码）
 *
 *   node scripts/package-extension.mjs
 *   → release/cocos-inspector-<version>-store.zip
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const staging = join(root, 'release', 'staging');
const outDir = join(root, 'release');
const zipName = `cocos-inspector-${version}-store.zip`;
const zipPath = join(outDir, zipName);

function fail(msg) {
  console.error('[package]', msg);
  process.exit(1);
}

function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walkFiles(abs, base, out);
    else out.push(relative(base, abs).replace(/\\/g, '/'));
  }
  return out;
}

async function zipDir(srcDir, destZip) {
  // 优先 JSZip（已在依赖中）
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const rel of walkFiles(srcDir)) {
    if (rel.endsWith('.map')) continue;
    zip.file(rel, readFileSync(join(srcDir, rel)));
  }
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  writeFileSync(destZip, buf);
}

// 1) 生产构建（无 sourcemap）
const build = spawnSync(
  process.execPath,
  [join(root, 'scripts/build.mjs'), '--minify', '--no-sourcemap'],
  { cwd: root, stdio: 'inherit' }
);
if (build.status !== 0) fail('build failed');

const manifestSrc = join(root, 'manifest.json');
const iconsSrc = join(root, 'icons');
const distSrc = join(root, 'dist');
if (!existsSync(manifestSrc)) fail('missing manifest.json');
if (!existsSync(join(iconsSrc, 'icon128.png'))) fail('missing icons/icon128.png');
if (!existsSync(join(distSrc, 'background.js'))) fail('missing dist/, run build first');

// 2) 暂存干净目录
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(outDir, { recursive: true });

cpSync(manifestSrc, join(staging, 'manifest.json'));
cpSync(iconsSrc, join(staging, 'icons'), { recursive: true });
cpSync(distSrc, join(staging, 'dist'), { recursive: true });

// 去掉 sourcemap / 主图标源文件（商店不需要 master）
for (const rel of walkFiles(staging)) {
  const abs = join(staging, rel);
  if (rel.endsWith('.map') || rel === 'icons/icon-master.png') {
    rmSync(abs, { force: true });
  }
}

const man = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'));
if (man.version !== version) {
  fail(`manifest.version (${man.version}) != package.json (${version})`);
}
if (!man.icons?.['128']) fail('manifest missing icons.128');

await zipDir(staging, zipPath);
rmSync(staging, { recursive: true, force: true });

const sizeMb = (statSync(zipPath).size / (1024 * 1024)).toFixed(2);
console.log(`[package] OK → ${zipPath} (${sizeMb} MB)`);
console.log('[package] 上传: https://chrome.google.com/webstore/devconsole');
console.log('[package] 材料: docs/chrome-web-store.md');
