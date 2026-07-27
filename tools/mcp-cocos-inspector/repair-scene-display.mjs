#!/usr/bin/env node
/**
 * 修复显示：Sprite.sizeMode 还原 + Mask 组件磁盘补丁
 */
import fs from 'fs';
import path from 'path';
import {
  buildPathToNodeUuidMap,
  patchMasksOnDisk,
  patchSpriteFramesOnDisk,
} from './scene-patch-disk.mjs';

const BRIDGE = process.env.COCOSMCP_BRIDGE ?? 'http://127.0.0.1:3921';
const PROJECT = process.env.COCOS_PROJECT ?? 'D:/workspace/testAutoCopy';
const SCENE_REL = 'assets/scene/godeebxp_recovered.scene';
const MANIFEST = process.argv[2] ?? 'tmp/godeebxp-texture-manifest.json';
const SNAPSHOT = process.argv[3] ?? 'tmp/godeebxp-scene-snapshot.json';

const execEval = async (code) => {
  const res = await fetch(`${BRIDGE}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'eval', code }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(JSON.stringify(body));
  return body.result;
};

const parseSpriteSizeMode = (ch) => {
  const sp = ch.components?.find((c) => c.flags?.isSprite);
  const row = sp?.rows?.find((r) => r.label === '尺寸模式');
  const v = parseInt(String(row?.value ?? ''), 10);
  return Number.isFinite(v) ? v : null;
};

const indexSnapshot = (root) => {
  const byId = {};
  const walk = (n) => {
    byId[n.id] = n;
    (n.children || []).forEach(walk);
  };
  walk(root);
  return byId;
};

const collectMaskTargets = (root, pathMap) => {
  const targets = [];
  const walk = (n) => {
    const maskComp = n.components?.find((c) => /Mask/.test(c.typeName || ''));
    if (maskComp) {
      const typeRow = maskComp.rows?.find(
        (r) => r.label === '类型' || r.label === 'type' || r.label === '_type'
      );
      const maskType = parseInt(String(typeRow?.value ?? '0'), 10);
      const paths = [n.path?.replace(/^main › /, ''), n.path].filter(Boolean);
      for (const p of paths) {
        if (pathMap.has(p)) {
          targets.push({
            nodeUuid: pathMap.get(p),
            maskType: Number.isFinite(maskType) ? maskType : 0,
            path: p,
          });
          break;
        }
      }
    }
    (n.children || []).forEach(walk);
  };
  walk(root);
  return targets;
};

const sfUuidFromMeta = (rel) => {
  const metaPath = path.join(PROJECT, `${rel}.meta`);
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  return meta.subMetas?.f9941?.uuid ?? null;
};

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const snapById = indexSnapshot(snapshot.root);
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).manifest;
const sceneAbs = path.join(PROJECT, SCENE_REL);
const sceneUrl = `db://${SCENE_REL.replace(/\\/g, '/')}`;
const pathMap = buildPathToNodeUuidMap(sceneAbs);

const bindings = [];
for (const [nodeId, entry] of Object.entries(manifest)) {
  const sfUuid = sfUuidFromMeta(entry.rel);
  if (!sfUuid) continue;
  const candidates = [entry.nodePath?.replace(/^main › /, ''), entry.nodePath];
  let nodeUuid = null;
  for (const k of candidates) {
    if (k && pathMap.has(k)) {
      nodeUuid = pathMap.get(k);
      break;
    }
  }
  if (!nodeUuid) continue;
  const ch = snapById[nodeId];
  const sizeMode = ch ? parseSpriteSizeMode(ch) : null;
  bindings.push({ nodeId, nodeUuid, sfUuid, sizeMode, path: entry.nodePath });
}

const maskTargets = collectMaskTargets(snapshot.root, pathMap);

console.error(`[repair-display] sizeMode 补丁 ${bindings.filter((b) => b.sizeMode != null).length} 个`);
console.error(`[repair-display] Mask 补丁 ${maskTargets.length} 个`);

const sfPatch = patchSpriteFramesOnDisk(sceneAbs, bindings);
const maskPatch = patchMasksOnDisk(sceneAbs, maskTargets);
const camPatch = patchCanvasCameraOnDisk(sceneAbs, 720);

console.error('[repair-display] 请关闭场景(不保存)后重新打开');

const scene = JSON.parse(fs.readFileSync(sceneAbs, 'utf8'));
const byId = new Map();
scene.forEach((o, i) => {
  byId.set(i, o);
  if (o.__id__ != null) byId.set(o.__id__, o);
});

let symbolCustom = 0;
let symbolTotal = 0;
for (const n of scene) {
  if (n.__type__ !== 'cc.Node' || n._name !== 'symbolSprite') continue;
  symbolTotal += 1;
  for (const cref of n._components || []) {
    const c = byId.get(cref.__id__);
    if (c?.__type__ === 'cc.Sprite' && c._sizeMode === 2) symbolCustom += 1;
  }
}

const sv = scene.find((o) => o.__type__ === 'cc.Node' && o._name === 'SymbolView');
const svComps = (sv?._components || []).map((cref) => byId.get(cref.__id__)?.__type__);

console.log(
  JSON.stringify(
    {
      ok: true,
      sfPatch,
      maskPatch,
      symbolSprite: { total: symbolTotal, customSizeMode: symbolCustom },
      symbolViewComponents: svComps,
      maskPaths: maskTargets.map((t) => t.path),
    },
    null,
    2
  )
);
