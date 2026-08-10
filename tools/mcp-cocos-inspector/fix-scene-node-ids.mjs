#!/usr/bin/env node
/**
 * 自研后处理：修复场景/Prefab 节点 _id 与资源 UUID 冲突。
 *
 * cc-reverse 偶发把 Prefab 实例根节点的 _id 写成场景/资源 meta UUID，
 * 导致编辑器层级面板「跳过重复 UUID」+ Maximum call stack，树不渲染。
 *
 * 用法:
 *   node fix-scene-node-ids.mjs <工程>/assets [--dry-run] [--glob *.fire,*.scene,*.prefab]
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
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
const globIdx = args.indexOf('--glob');
const globArg =
  globIdx >= 0 ? args[globIdx + 1] : '*.fire,*.scene,*.prefab';
const assetsRootArg = args.find(
  (a, i) => !a.startsWith('-') && !(globIdx >= 0 && i === globIdx + 1)
);

if (!assetsRootArg) {
  console.error(
    '用法: node fix-scene-node-ids.mjs <工程>/assets [--dry-run] ' +
      '[--glob *.fire,*.scene,*.prefab]'
  );
  process.exit(1);
}

const assetsRoot = path.resolve(assetsRootArg);
if (!fs.existsSync(assetsRoot)) {
  console.error('assets 不存在:', assetsRoot);
  process.exit(1);
}

const exts = new Set(
  globArg
    .split(',')
    .map((s) => s.trim().replace(/^\*/, '').toLowerCase())
    .filter(Boolean)
);

const walkFiles = (dir, out = []) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'library' || ent.name === 'temp' || ent.name === 'node_modules') {
        continue;
      }
      walkFiles(full, out);
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    if (exts.has(ext)) out.push(full);
  }
  return out;
};

const readAssetUuid = (assetPath) => {
  const metaPath = `${assetPath}.meta`;
  if (!fs.existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return typeof meta.uuid === 'string' ? meta.uuid : null;
  } catch {
    return null;
  }
};

const newNodeId = (used) => {
  for (let i = 0; i < 32; i++) {
    const id = uuidUtils.compress_uuid(randomUUID());
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error('无法生成唯一节点 _id');
};

const fixFile = (assetPath) => {
  const assetUuid = readAssetUuid(assetPath);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(assetPath, 'utf8'));
  } catch (e) {
    return { path: assetPath, error: String(e) };
  }
  if (!Array.isArray(data)) {
    return { path: assetPath, skipped: 'not-array' };
  }

  const used = new Set();
  if (assetUuid) used.add(assetUuid);

  let changed = 0;
  const reasons = [];

  for (let i = 0; i < data.length; i++) {
    const obj = data[i];
    if (!obj || typeof obj !== 'object') continue;
    const t = obj.__type__;
    if (t !== 'cc.Node' && t !== 'cc.Scene') continue;

    const old = typeof obj._id === 'string' ? obj._id : '';
    let need = false;
    let why = '';

    if (!old) {
      continue;
    }
    if (assetUuid && old === assetUuid) {
      need = true;
      why = 'equals-asset-uuid';
    } else if (used.has(old)) {
      need = true;
      why = 'duplicate';
    }

    if (!need) {
      used.add(old);
      continue;
    }

    // PrefabInstance 根若 _id === SceneAsset UUID，Creator 刷新会写回撞车并打挂层级树。
    // 赋唯一压缩 UUID（勿留空）：空 _id 在部分实例上会被重新填成资源 UUID。
    const next = newNodeId(used);
    obj._id = next;
    changed += 1;
    reasons.push({
      index: i,
      name: obj._name || t,
      from: old,
      to: next,
      why,
    });
  }

  if (changed > 0 && !dryRun) {
    fs.writeFileSync(assetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  return {
    path: path.relative(assetsRoot, assetPath).replace(/\\/g, '/'),
    assetUuid,
    changed,
    reasons,
  };
};

const files = walkFiles(assetsRoot);
const results = files.map(fixFile);
const touched = results.filter((r) => r.changed > 0);
const errors = results.filter((r) => r.error);

console.log(
  JSON.stringify(
    {
      assetsRoot,
      dryRun,
      scanned: files.length,
      touched: touched.length,
      totalChanged: touched.reduce((a, r) => a + r.changed, 0),
      errors: errors.length,
      samples: touched.slice(0, 20),
      errorSamples: errors.slice(0, 5),
    },
    null,
    2
  )
);
