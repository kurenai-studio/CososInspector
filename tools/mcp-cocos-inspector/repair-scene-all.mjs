#!/usr/bin/env node
/**
 * 一键修复场景显示：UITransform 尺寸 + SpriteFrame + sizeMode + Mask + UICamera
 * 注意：补丁后请关闭场景选「不保存」再重新打开，避免 Creator 内存覆盖磁盘
 */
import fs from 'fs';
import path from 'path';
import {
  buildPathToNodeUuidMap,
  patchCanvasCameraOnDisk,
  patchMasksOnDisk,
  patchSpriteFramesOnDisk,
  patchUiSizesOnDisk,
  resetAllSpriteMetaFromManifest,
} from './scene-patch-disk.mjs';
import {
  collectUiSizeBindings,
  indexSnapshotNodes,
  parseSpriteSizeMode,
} from './scene-snapshot-parse.mjs';

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

const collectMaskTargets = (snapshotRoot, pathMap) => {
  const targets = [];
  const walk = (n) => {
    const maskComp = (n.components || []).find((c) => /Mask/.test(c.typeName || ''));
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
          });
          break;
        }
      }
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(snapshotRoot);
  return targets;
};

const sfUuidFromMeta = (rel) => {
  const metaPath = path.join(PROJECT, `${rel}.meta`);
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  return meta.subMetas?.f9941?.uuid ?? null;
};

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const snapById = indexSnapshotNodes(snapshot.root);
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).manifest;
const sceneAbs = path.join(PROJECT, SCENE_REL);
const sceneUrl = `db://${SCENE_REL.replace(/\\/g, '/')}`;
const pathMap = buildPathToNodeUuidMap(sceneAbs);

const spriteBindings = [];
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
  spriteBindings.push({ nodeId, nodeUuid, sfUuid, sizeMode, path: entry.nodePath });
}

const uiBindings = collectUiSizeBindings(snapshot.root, pathMap);
const maskTargets = collectMaskTargets(snapshot.root, pathMap);

console.error(`[repair-all] UITransform ${uiBindings.length} Sprite ${spriteBindings.length} Mask ${maskTargets.length}`);

const metaReset = resetAllSpriteMetaFromManifest(PROJECT, manifest);
console.error('[repair-all] .meta 重置', metaReset);

const uiPatch = patchUiSizesOnDisk(sceneAbs, uiBindings);
const sfPatch = patchSpriteFramesOnDisk(sceneAbs, spriteBindings);
const maskPatch = patchMasksOnDisk(sceneAbs, maskTargets);
const camPatch = patchCanvasCameraOnDisk(sceneAbs, 720);

console.error('[repair-all] 请在 Creator 中：关闭场景(不保存) → 重新打开，以加载磁盘补丁');

const scene = JSON.parse(fs.readFileSync(sceneAbs, 'utf8'));
let spBound = 0;
let symbolCustom = 0;
let symbolTotal = 0;
for (const o of scene) {
  if (o.__type__ === 'cc.Sprite' && o._spriteFrame) spBound += 1;
}
const byId = new Map();
scene.forEach((o, i) => {
  byId.set(i, o);
  if (o._id != null) byId.set(o._id, o);
});
for (const n of scene) {
  if (n.__type__ !== 'cc.Node' || n._name !== 'symbolSprite') continue;
  symbolTotal += 1;
  for (const cref of n._components || []) {
    const c = byId.get(cref.__id__);
    if (c?.__type__ === 'cc.Sprite' && c._sizeMode === 2) symbolCustom += 1;
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      uiPatch,
      sfPatch,
      maskPatch,
      camPatch,
      spBound,
      symbolSprite: { total: symbolTotal, customSizeMode: symbolCustom },
    },
    null,
    2
  )
);
