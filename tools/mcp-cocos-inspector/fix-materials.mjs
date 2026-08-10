#!/usr/bin/env node
/**
 * 自研后处理：规范化 cc-reverse 产出的 .mtl
 * - 去掉 `[ { cc.Material } ]` 数组壳，改为编辑器源格式单对象
 * - 压缩 UUID → 标准 UUID（保留 @subId）
 * - `_techIdx` 转 number；补 `__expectedType__`
 * - `.mtl.meta` 强制 importer: material
 *
 * 用法:
 *   node fix-materials.mjs <工程assets根> [--dry-run]
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
  console.error('用法: node fix-materials.mjs <工程assets根> [--dry-run]');
  process.exit(1);
}
const assetsRoot = path.resolve(assetsRootArg);
if (!fs.existsSync(assetsRoot)) {
  console.error(`不存在: ${assetsRoot}`);
  process.exit(1);
}

const COMPRESSED_RE = /^[0-9A-Za-z+/=]{20,}$/;
const FULL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} raw
 */
function decodeUuidMaybe(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const [base, sub] = raw.split('@');
  let full = base;
  if (!FULL_UUID_RE.test(base) && COMPRESSED_RE.test(base)) {
    try {
      full = uuidUtils.decodeUuid(base);
    } catch {
      full = base;
    }
  }
  return sub ? `${full}@${sub}` : full;
}

/**
 * @param {any} node
 * @param {string} [expectedType]
 */
function normalizeUuidRef(node, expectedType) {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.__uuid__ === 'string') {
    const next = { __uuid__: decodeUuidMaybe(node.__uuid__) };
    if (expectedType) next.__expectedType__ = expectedType;
    else if (node.__expectedType__) next.__expectedType__ = node.__expectedType__;
    return next;
  }
  return node;
}

/**
 * @param {object} mat
 */
function normalizeMaterial(mat) {
  const out = { ...mat };
  if (!out.__type__) out.__type__ = 'cc.Material';
  if (out._objFlags == null) out._objFlags = 0;
  if (out._native == null) out._native = '';

  if (out._techIdx == null || out._techIdx === '') {
    out._techIdx = 0;
  } else {
    const n = Number(out._techIdx);
    out._techIdx = Number.isFinite(n) ? n : 0;
  }

  if (out._effectAsset) {
    out._effectAsset = normalizeUuidRef(out._effectAsset, 'cc.EffectAsset');
  }

  if (Array.isArray(out._props)) {
    out._props = out._props.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const np = { ...p };
      for (const [k, v] of Object.entries(np)) {
        if (v && typeof v === 'object' && typeof v.__uuid__ === 'string') {
          let expected;
          if (/spriteFrame/i.test(k)) expected = 'cc.SpriteFrame';
          else if (/texture|Texture|mainTexture/i.test(k)) expected = 'cc.Texture2D';
          np[k] = normalizeUuidRef(v, expected);
        }
      }
      return np;
    });
  }

  return out;
}

/**
 * @param {string} dir
 * @param {string[]} acc
 */
function collectMtl(dir, acc = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) collectMtl(f, acc);
    else if (e.name.endsWith('.mtl') && !e.name.endsWith('.mtl.meta')) acc.push(f);
  }
  return acc;
}

const files = collectMtl(assetsRoot);
const report = {
  dryRun,
  total: files.length,
  rewritten: 0,
  metaFixed: 0,
  skipped: 0,
  errors: [],
  items: [],
};

for (const mtlPath of files) {
  const rel = path.relative(assetsRoot, mtlPath).replace(/\\/g, '/');
  try {
    const raw = JSON.parse(fs.readFileSync(mtlPath, 'utf8'));
    const matObj = Array.isArray(raw) ? raw[0] : raw;
    if (!matObj || matObj.__type__ !== 'cc.Material') {
      report.skipped++;
      report.errors.push({ rel, error: '非 cc.Material' });
      continue;
    }
    const normalized = normalizeMaterial(matObj);
    const wasArray = Array.isArray(raw);
    const after = `${JSON.stringify(normalized, null, 2)}\n`;
    const contentChanged =
      wasArray || JSON.stringify(matObj) !== JSON.stringify(normalized);

    const metaPath = `${mtlPath}.meta`;
    let meta;
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } else {
      meta = {
        ver: '1.0.21',
        importer: 'material',
        imported: false,
        uuid: require('crypto').randomUUID(),
        files: [],
        subMetas: {},
        userData: {},
      };
    }
    const metaChanged =
      meta.importer !== 'material' ||
      meta.ver !== '1.0.21' ||
      meta.imported === true ||
      !Array.isArray(meta.files) ||
      meta.files.length > 0;

    meta.importer = 'material';
    meta.ver = '1.0.21';
    meta.imported = false;
    if (!meta.subMetas) meta.subMetas = {};
    if (!meta.userData) meta.userData = {};
    meta.files = [];

    if (!dryRun) {
      if (contentChanged) {
        fs.writeFileSync(mtlPath, after);
        report.rewritten++;
      }
      fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
      if (metaChanged) report.metaFixed++;
    } else {
      if (contentChanged) report.rewritten++;
      if (metaChanged) report.metaFixed++;
    }

    report.items.push({
      rel,
      wasArray,
      effect: normalized._effectAsset?.__uuid__ || null,
      techIdx: normalized._techIdx,
    });
  } catch (e) {
    report.skipped++;
    report.errors.push({ rel, error: e.message });
  }
}

console.log(
  JSON.stringify(
    {
      dryRun: report.dryRun,
      total: report.total,
      rewritten: report.rewritten,
      metaFixed: report.metaFixed,
      skipped: report.skipped,
      errorCount: report.errors.length,
      errors: report.errors,
      sample: report.items.slice(0, 12),
    },
    null,
    2
  )
);
