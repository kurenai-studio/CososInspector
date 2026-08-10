#!/usr/bin/env node
/**
 * 将场景/Prefab 中的压缩 UUID 引用展开为标准 UUID。
 * Creator asset-db 只认完整 UUID；cc-reverse 常保留压缩形态导致 SpriteFrame 解绑。
 *
 * 用法:
 *   node expand-compressed-uuids.mjs <工程>/assets [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { uuidUtils } = require(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'node_modules/cc-reverse/src/utils/uuidUtils.js'
  )
);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const assetsRootArg = args.find((a) => !a.startsWith('-'));
if (!assetsRootArg) {
  console.error('用法: node expand-compressed-uuids.mjs <工程>/assets [--dry-run]');
  process.exit(1);
}
const assetsRoot = path.resolve(assetsRootArg);

const expandOne = (u) => {
  if (typeof u !== 'string' || !u) return u;
  const i = u.indexOf('@');
  const base = i >= 0 ? u.slice(0, i) : u;
  const hash = i >= 0 ? u.slice(i) : '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(base)) return u;
  try {
    return `${uuidUtils.decodeUuid(base)}${hash}`;
  } catch {
    return u;
  }
};

const UUID_KEYS = new Set([
  '__uuid__',
  '_spriteFrame',
  '_atlas',
  '_texture',
  '_defaultSpriteFrame',
]);

/**
 * @param {any} obj
 */
function walk(obj, stats) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) walk(item, stats);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__uuid__' && typeof v === 'string') {
      const next = expandOne(v);
      if (next !== v) {
        obj[k] = next;
        stats.changed++;
      }
      continue;
    }
    if (typeof v === 'string' && (k.endsWith('Uuid') || k.endsWith('UUID'))) {
      const next = expandOne(v);
      if (next !== v) {
        obj[k] = next;
        stats.changed++;
      }
      continue;
    }
    walk(v, stats);
  }
}

const files = [];
const collect = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['library', 'temp', 'node_modules', 'scripts'].includes(ent.name)) continue;
      collect(full);
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    if (['.scene', '.fire', '.prefab', '.mtl', '.anim'].includes(ext)) files.push(full);
  }
};
collect(assetsRoot);

let touched = 0;
let totalChanged = 0;
for (const file of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const stats = { changed: 0 };
  walk(data, stats);
  if (stats.changed > 0) {
    touched++;
    totalChanged += stats.changed;
    if (!dryRun) fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

console.log(JSON.stringify({ dryRun, scanned: files.length, touched, totalChanged }, null, 2));
