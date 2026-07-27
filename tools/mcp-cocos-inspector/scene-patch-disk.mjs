import fs from 'fs';

/** Creator 3.x scene 磁盘格式：资源引用 */
export function spriteFrameRef(uuid) {
  return {
    __uuid__: uuid,
    __expectedType__: 'cc.SpriteFrame',
  };
}

function indexScene(scene) {
  const byId = new Map();
  scene.forEach((obj, idx) => {
    byId.set(idx, obj);
    if (obj.__id__ != null) byId.set(obj.__id__, obj);
  });
  return byId;
}

/**
 * 将内存 set-property 未落盘的 SpriteFrame 引用写入 .scene 文件
 * @param {string} sceneAbs
 * @param {Array<{ nodeUuid: string, sfUuid: string }>} bindings
 */
export function patchSpriteFramesOnDisk(sceneAbs, bindings) {
  if (!bindings?.length) return { patched: 0 };
  const scene = JSON.parse(fs.readFileSync(sceneAbs, 'utf8'));
  const byId = indexScene(scene);
  const nodeByUuid = new Map();
  for (const obj of scene) {
    if (obj.__type__ === 'cc.Node' && obj._id) {
      nodeByUuid.set(obj._id, obj);
    }
  }

  let patched = 0;
  let sizeModePatched = 0;
  for (const b of bindings) {
    const node = nodeByUuid.get(b.nodeUuid);
    if (!node?._components) continue;
    for (const cref of node._components) {
      const comp = byId.get(cref.__id__);
      if (comp?.__type__ === 'cc.Sprite') {
        if (b.sfUuid) {
          comp._spriteFrame = spriteFrameRef(b.sfUuid);
          patched += 1;
        }
        if (b.sizeMode != null && Number.isFinite(b.sizeMode)) {
          comp._sizeMode = b.sizeMode;
          sizeModePatched += 1;
        }
      }
    }
  }

  fs.writeFileSync(sceneAbs, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
  return { patched, sizeModePatched };
}

/** 补丁 UITransform contentSize（set-property 可能未落盘） */
export function patchUiSizesOnDisk(sceneAbs, bindings) {
  if (!bindings?.length) return { patched: 0, missingUi: 0 };
  const scene = JSON.parse(fs.readFileSync(sceneAbs, 'utf8'));
  const byId = indexScene(scene);
  const nodeByUuid = new Map();
  for (const obj of scene) {
    if (obj.__type__ === 'cc.Node' && obj._id) {
      nodeByUuid.set(obj._id, obj);
    }
  }

  let patched = 0;
  let missingUi = 0;
  for (const b of bindings) {
    if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) continue;
    const node = nodeByUuid.get(b.nodeUuid);
    if (!node) continue;
    if (!node._components) node._components = [];

    let uiComp = null;
    let uiCompIdx = -1;
    for (const cref of node._components) {
      const comp = byId.get(cref.__id__);
      if (comp?.__type__ === 'cc.UITransform') {
        uiComp = comp;
        uiCompIdx = cref.__id__;
        break;
      }
    }

    // 容器节点重建时可能没有 UITransform，按快照尺寸补上
    if (!uiComp) {
      const nodeIdx = scene.indexOf(node);
      uiCompIdx = scene.length;
      uiComp = {
        __type__: 'cc.UITransform',
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeIdx },
        _enabled: true,
        __prefab: null,
        _contentSize: {
          __type__: 'cc.Size',
          width: b.width,
          height: b.height,
        },
        _anchorPoint: {
          __type__: 'cc.Vec2',
          x: Number.isFinite(b.anchorX) ? b.anchorX : 0.5,
          y: Number.isFinite(b.anchorY) ? b.anchorY : 0.5,
        },
        _id: '',
      };
      scene.push(uiComp);
      byId.set(uiCompIdx, uiComp);
      node._components.unshift({ __id__: uiCompIdx });
      missingUi += 1;
    } else {
      uiComp._contentSize = {
        __type__: 'cc.Size',
        width: b.width,
        height: b.height,
      };
      if (Number.isFinite(b.anchorX) && Number.isFinite(b.anchorY)) {
        uiComp._anchorPoint = {
          __type__: 'cc.Vec2',
          x: b.anchorX,
          y: b.anchorY,
        };
      }
    }
    patched += 1;
  }

  fs.writeFileSync(sceneAbs, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
  return { patched, missingUi };
}

/**
 * 将 .meta 的 f9941 重置为与 PNG 全图一致（displaySize 导出，无 trim）
 * 避免错误 trim 导致 Creator「Rect exceeds maximum margin」
 */
export function resetSpriteMetaTrimOnDisk(metaAbs, pngAbs) {
  if (!fs.existsSync(metaAbs) || !fs.existsSync(pngAbs)) {
    return { patched: false, reason: 'missing-file' };
  }
  try {
    const buf = fs.readFileSync(pngAbs);
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
      return { patched: false, reason: 'not-png' };
    }
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const meta = JSON.parse(fs.readFileSync(metaAbs, 'utf8'));
    const sub = meta.subMetas?.f9941;
    if (!sub?.userData) return { patched: false, reason: 'no-f9941' };

    sub.userData.width = w;
    sub.userData.height = h;
    sub.userData.rawWidth = w;
    sub.userData.rawHeight = h;
    sub.userData.offsetX = 0;
    sub.userData.offsetY = 0;
    sub.userData.trimX = 0;
    sub.userData.trimY = 0;
    sub.userData.rotated = false;
    // originalCanvas PNG 已是完整画布，禁止 Creator 再 auto-trim
    sub.userData.trimType = 'none';
    delete sub.userData.vertices;

    fs.writeFileSync(metaAbs, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return { patched: true, width: w, height: h };
  } catch (e) {
    return {
      patched: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 批量重置 manifest 纹理 .meta（与 displaySize PNG 对齐） */
export function resetAllSpriteMetaFromManifest(projectRoot, manifest) {
  let patched = 0;
  let skipped = 0;
  for (const entry of Object.values(manifest ?? {})) {
    if (!entry?.rel) {
      skipped += 1;
      continue;
    }
    const rel = entry.rel.replace(/\\/g, '/');
    const pngAbs = `${projectRoot}/${rel}`.replace(/\\/g, '/');
    const metaAbs = `${pngAbs}.meta`;
    const r = resetSpriteMetaTrimOnDisk(metaAbs, pngAbs);
    if (r.patched) patched += 1;
    else skipped += 1;
  }
  return { patched, skipped };
}

/**
 * @deprecated 勿对 displaySize PNG 写图集 trim，会触发 margin 报错
 * @param {string} metaAbs
 * @param {object} sf - frameRect / offset / originalSize / isRotated
 */
export function patchSpriteMetaOnDisk(metaAbs, sf) {
  if (!sf?.originalSize || !sf?.frameRect || !fs.existsSync(metaAbs)) {
    return { patched: false, reason: 'missing-meta-or-spriteFrame' };
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metaAbs, 'utf8'));
    const sub = meta.subMetas?.f9941;
    if (!sub?.userData) return { patched: false, reason: 'no-f9941' };

    const fw = sf.frameRect.w || sub.userData.width;
    const fh = sf.frameRect.h || sub.userData.height;
    const rw = sf.originalSize.w || fw;
    const rh = sf.originalSize.h || fh;
    const ox = sf.offset?.x ?? 0;
    const oy = sf.offset?.y ?? 0;

    sub.userData.width = fw;
    sub.userData.height = fh;
    sub.userData.rawWidth = rw;
    sub.userData.rawHeight = rh;
    sub.userData.offsetX = ox;
    sub.userData.offsetY = oy;
    sub.userData.trimX = 0;
    sub.userData.trimY = 0;
    sub.userData.rotated = !!sf.isRotated;
    sub.userData.trimType = 'custom';

    const halfW = rw / 2;
    const halfH = rh / 2;
    sub.userData.vertices = {
      rawPosition: [
        -halfW + ox, -halfH + oy, 0,
        halfW + ox, -halfH + oy, 0,
        -halfW + ox, halfH + oy, 0,
        halfW + ox, halfH + oy, 0,
      ],
      indexes: [0, 1, 2, 2, 1, 3],
      uv: [0, fh, fw, fh, 0, 0, fw, 0],
      nuv: [0, 0, 1, 0, 0, 1, 1, 1],
      minPos: [-halfW + ox, -halfH + oy, 0],
      maxPos: [halfW + ox, halfH + oy, 0],
    };

    fs.writeFileSync(metaAbs, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return { patched: true, width: fw, height: fh, rawWidth: rw, rawHeight: rh };
  } catch (e) {
    return {
      patched: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 批量补丁 manifest 内纹理 .meta */
export function patchAllSpriteMetaFromManifest(projectRoot, manifest) {
  let patched = 0;
  let skipped = 0;
  for (const entry of Object.values(manifest ?? {})) {
    if (!entry?.rel || !entry.spriteFrame) {
      skipped += 1;
      continue;
    }
    const metaAbs = `${projectRoot}/${entry.rel}.meta`.replace(/\\/g, '/');
    const r = patchSpriteMetaOnDisk(metaAbs, entry.spriteFrame);
    if (r.patched) patched += 1;
    else skipped += 1;
  }
  return { patched, skipped };
}

/**
 * 为快照中带 Mask 的节点补 cc.Graphics + cc.Mask（GRAPHICS_RECT 等）
 * @param {string} sceneAbs
 * @param {Array<{ nodeUuid: string, maskType?: number }>} targets
 */
export function patchMasksOnDisk(sceneAbs, targets) {
  if (!targets?.length) return { patched: 0 };
  const scene = JSON.parse(fs.readFileSync(sceneAbs, 'utf8'));
  const byId = indexScene(scene);
  const nodeByUuid = new Map();
  const nodeIdxByUuid = new Map();
  scene.forEach((obj, idx) => {
    if (obj.__type__ === 'cc.Node' && obj._id) {
      nodeByUuid.set(obj._id, obj);
      nodeIdxByUuid.set(obj._id, idx);
    }
  });

  let patched = 0;
  for (const t of targets) {
    const node = nodeByUuid.get(t.nodeUuid);
    const nodeIdx = nodeIdxByUuid.get(t.nodeUuid);
    if (!node || nodeIdx == null) continue;

    const hasMask = (node._components ?? []).some((cref) => {
      const comp = byId.get(cref.__id__);
      return comp?.__type__ === 'cc.Mask';
    });
    if (hasMask) continue;

    const maskType = t.maskType ?? 0;
    const needsGraphics = maskType === 0 || maskType === 1 || maskType === 2;

    if (needsGraphics) {
      const hasGfx = (node._components ?? []).some((cref) => {
        const comp = byId.get(cref.__id__);
        return comp?.__type__ === 'cc.Graphics';
      });
      if (!hasGfx) {
        const gfxId = scene.length;
        scene.push({
          __type__: 'cc.Graphics',
          _name: '',
          _objFlags: 0,
          __editorExtras__: {},
          node: { __id__: nodeIdx },
          _enabled: true,
          __prefab: null,
          _customMaterial: null,
          _srcBlendFactor: 2,
          _dstBlendFactor: 4,
          _color: { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 },
          _lineWidth: 1,
          _strokeColor: { __type__: 'cc.Color', r: 0, g: 0, b: 0, a: 255 },
          _lineJoin: 2,
          _lineCap: 0,
          _fillColor: { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 0 },
          _miterLimit: 10,
          __id__: gfxId,
        });
        if (!node._components) node._components = [];
        node._components.push({ __id__: gfxId });
      }
    }

    const maskId = scene.length;
    scene.push({
      __type__: 'cc.Mask',
      _name: '',
      _objFlags: 0,
      __editorExtras__: {},
      node: { __id__: nodeIdx },
      _enabled: true,
      __prefab: null,
      _type: maskType,
      _inverted: false,
      _segments: 64,
      _alphaThreshold: 0.1,
      __id__: maskId,
    });
    if (!node._components) node._components = [];
    node._components.push({ __id__: maskId });
    patched += 1;
  }

  fs.writeFileSync(sceneAbs, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
  return { patched };
}

/**
 * 为 UI 相机补 cc.Camera，并挂到 Canvas（或 RSG 的 GameLayer）。
 * 兼容节点名：UICamera / Camera；Canvas / GameLayer（带 cc.Canvas）。
 */
export function patchCanvasCameraOnDisk(
  sceneAbs,
  designHeight = 720,
  designWidth = 1280
) {
  const scene = JSON.parse(fs.readFileSync(sceneAbs, 'utf8'));
  const byId = indexScene(scene);

  const isCamName = (n) => /^(UI)?Camera$/i.test(String(n || ''));
  const isCanvasHostName = (n) => /^(Canvas|GameLayer)$/i.test(String(n || ''));

  let uiCamNode = null;
  let uiCamIdx = -1;
  let canvasNode = null;
  let canvasIdx = -1;

  scene.forEach((obj, idx) => {
    if (obj.__type__ !== 'cc.Node') return;
    if (!uiCamNode && isCamName(obj._name)) {
      uiCamNode = obj;
      uiCamIdx = idx;
    }
    if (!canvasNode && isCanvasHostName(obj._name)) {
      canvasNode = obj;
      canvasIdx = idx;
    }
  });

  // 已有 cc.Canvas 的节点优先作为宿主
  if (!canvasNode) {
    for (let idx = 0; idx < scene.length; idx += 1) {
      const obj = scene[idx];
      if (obj?.__type__ !== 'cc.Canvas' || obj.node?.__id__ == null) continue;
      const host = byId.get(obj.node.__id__);
      if (host?.__type__ === 'cc.Node') {
        canvasNode = host;
        canvasIdx = obj.node.__id__;
        break;
      }
    }
  }

  // Camera 的父节点常是 GameLayer / Canvas
  if (!canvasNode && uiCamNode?._parent?.__id__ != null) {
    const parent = byId.get(uiCamNode._parent.__id__);
    if (parent?.__type__ === 'cc.Node' && parent._name !== 'Scene') {
      canvasNode = parent;
      canvasIdx = uiCamNode._parent.__id__;
    }
  }

  if (!uiCamNode || !canvasNode || uiCamIdx < 0 || canvasIdx < 0) {
    return {
      ok: false,
      error: 'Camera or Canvas/GameLayer not found',
      camName: uiCamNode?._name ?? null,
      canvasName: canvasNode?._name ?? null,
    };
  }

  let camComp = null;
  let camCompIdx = -1;
  for (const cref of uiCamNode._components ?? []) {
    const comp = byId.get(cref.__id__);
    if (comp?.__type__ === 'cc.Camera') {
      camComp = comp;
      camCompIdx = cref.__id__;
    }
  }

  if (!camComp) {
    const newId = scene.length;
    camCompIdx = newId;
    camComp = {
      __type__: 'cc.Camera',
      _name: '',
      _objFlags: 0,
      __editorExtras__: {},
      node: { __id__: uiCamIdx },
      _enabled: true,
      __prefab: null,
      _projection: 0,
      _priority: 0,
      _fov: 45,
      _fovAxis: 0,
      _orthoHeight: designHeight / 2,
      _near: 0,
      _far: 2000,
      _color: { __type__: 'cc.Color', r: 51, g: 51, b: 51, a: 255 },
      _depth: 1,
      _stencil: 0,
      _clearFlags: 7,
      _rect: { __type__: 'cc.Rect', x: 0, y: 0, width: 1, height: 1 },
      _aperture: 19,
      _shutter: 7,
      _iso: 0,
      _screenScale: 1,
      _visibility: 41943040,
      _targetTexture: null,
      _postProcess: null,
      _usePostProcess: false,
      _cameraType: -1,
      _trackingType: 0,
    };
    scene.push(camComp);
    byId.set(newId, camComp);
    if (!uiCamNode._components) uiCamNode._components = [];
    uiCamNode._components.push({ __id__: newId });
    uiCamNode._components = uiCamNode._components.filter((cref) => {
      const comp = byId.get(cref.__id__);
      return comp?.__type__ !== 'cc.UITransform';
    });
  } else {
    camComp._orthoHeight = designHeight / 2;
    camComp._visibility = camComp._visibility || 41943040;
    camComp._projection = 0;
  }

  // Canvas 宿主：补 UITransform + Canvas，并关联相机
  let uiComp = null;
  let canvasComp = null;
  for (const cref of canvasNode._components ?? []) {
    const comp = byId.get(cref.__id__);
    if (comp?.__type__ === 'cc.UITransform') uiComp = comp;
    if (comp?.__type__ === 'cc.Canvas') canvasComp = comp;
  }
  if (!canvasNode._components) canvasNode._components = [];

  if (!uiComp) {
    const id = scene.length;
    uiComp = {
      __type__: 'cc.UITransform',
      _name: '',
      _objFlags: 0,
      __editorExtras__: {},
      node: { __id__: canvasIdx },
      _enabled: true,
      __prefab: null,
      _contentSize: {
        __type__: 'cc.Size',
        width: designWidth,
        height: designHeight,
      },
      _anchorPoint: { __type__: 'cc.Vec2', x: 0.5, y: 0.5 },
      _id: '',
    };
    scene.push(uiComp);
    byId.set(id, uiComp);
    canvasNode._components.unshift({ __id__: id });
  } else {
    uiComp._contentSize = {
      __type__: 'cc.Size',
      width: designWidth,
      height: designHeight,
    };
  }

  if (!canvasComp) {
    const id = scene.length;
    canvasComp = {
      __type__: 'cc.Canvas',
      _name: '',
      _objFlags: 0,
      __editorExtras__: {},
      node: { __id__: canvasIdx },
      _enabled: true,
      __prefab: null,
      _cameraComponent: { __id__: camCompIdx },
      _alignCanvasWithScreen: true,
      _id: '',
    };
    scene.push(canvasComp);
    byId.set(id, canvasComp);
    canvasNode._components.push({ __id__: id });
  } else {
    canvasComp._cameraComponent = { __id__: camCompIdx };
    canvasComp._alignCanvasWithScreen = true;
  }

  // UI 层：Canvas/GameLayer 子树用 UI_2D；Camera 节点本身保持 DEFAULT 亦可
  const UI_2D = 33554432;
  canvasNode._layer = UI_2D;
  const markUiLayer = (nodeIdx) => {
    const node = byId.get(nodeIdx);
    if (!node || node.__type__ !== 'cc.Node') return;
    if (!isCamName(node._name)) node._layer = UI_2D;
    for (const ch of node._children ?? []) markUiLayer(ch.__id__);
  };
  markUiLayer(canvasIdx);

  fs.writeFileSync(sceneAbs, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    camCompId: camCompIdx,
    camName: uiCamNode._name,
    canvasName: canvasNode._name,
    designWidth,
    designHeight,
  };
}

/**
 * 按 manifest 的 nodePath 在 scene 文件里找节点 uuid（_id）
 */
export function buildPathToNodeUuidMap(sceneAbs) {
  const scene = JSON.parse(fs.readFileSync(sceneAbs, 'utf8'));
  const byId = indexScene(scene);

  const root = scene.find((o) => o.__type__ === 'cc.Scene');
  if (!root?._children?.length) return new Map();

  const map = new Map();

  const walk = (node, parts) => {
    const path = parts.join(' › ');
    if (node._id) map.set(path, node._id);
    for (const ch of node._children ?? []) {
      const child = byId.get(ch.__id__);
      if (child) walk(child, [...parts, child._name]);
    }
  };

  for (const ch of root._children) {
    const node = byId.get(ch.__id__);
    if (node?.__type__ === 'cc.Node') walk(node, [node._name]);
  }
  return map;
}

/** 从 manifest + 场景路径映射生成磁盘补丁 bindings */
export function buildBindingsFromManifest(manifest, pathMap, projectRoot) {
  const bindings = [];
  for (const [nodeId, entry] of Object.entries(manifest ?? {})) {
    const rel = entry.rel;
    const metaPath = `${projectRoot}/${rel}.meta`.replace(/\\/g, '/');
    let sfUuid = null;
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        sfUuid = meta.subMetas?.f9941?.uuid ?? null;
      }
    } catch {
      /* ignore */
    }
    if (!sfUuid) continue;

    // 延迟导入避免循环依赖
    // path 候选在调用方用 lookup；这里内联剥前缀
    const raw = entry.nodePath || '';
    const candidates = [
      raw,
      raw.replace(/^main › /i, ''),
      raw.replace(/^main › /i, '').replace(/^game_scene › /i, ''),
      raw.replace(/^game_scene › /i, ''),
    ];
    const m = candidates[2]?.match(/^[^›]+ › (.+)$/);
    if (m) candidates.push(m[1]);
    let nodeUuid = null;
    for (const k of candidates) {
      const key = String(k || '')
        .replace(/\s*›\s*/g, ' › ')
        .trim();
      if (key && pathMap.has(key)) {
        nodeUuid = pathMap.get(key);
        break;
      }
    }
    if (!nodeUuid) continue;
    bindings.push({ nodeId, nodeUuid, sfUuid, path: entry.nodePath });
  }
  return bindings;
}
