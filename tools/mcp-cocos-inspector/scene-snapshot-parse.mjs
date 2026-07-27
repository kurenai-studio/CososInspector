/**
 * 从快照节点解析 UITransform 尺寸（允许 0 宽/高，如 0×56、0×0）
 * 兼容 2.x（path 用 /、英文组件行）与 3.x（›、中文行）
 */

/** 统一 path 分隔符为 ` › `，兼容 `/` 与乱码 › */
export const normalizeScenePath = (p) =>
  String(p ?? '')
    .replace(/\s*鈥\?\s*/g, ' › ')
    .replace(/\s*鈥\uFFFD\s*/g, ' › ')
    .replace(/\s*[›>／/]\s*/g, ' › ')
    .replace(/\s*›\s*/g, ' › ')
    .trim();

/** 快照 path ↔ Creator 场景 path 候选（去 main/game_scene 等根前缀） */
export const scenePathCandidates = (p) => {
  if (!p) return [];
  const out = new Set();
  const add = (s) => {
    const t = normalizeScenePath(s);
    if (t) out.add(t);
  };
  add(p);
  let s = normalizeScenePath(p).replace(/^main › /i, '');
  add(s);
  s = s.replace(/^game_scene › /i, '');
  add(s);
  // 再剥一层场景根（Creator 重建后根常是 GameLayer，不再含 game_scene）
  const m = s.match(/^[^›]+ › (.+)$/);
  if (m) add(m[1]);
  return [...out];
};

export const lookupPathMap = (pathMap, p) => {
  if (!pathMap) return null;
  for (const k of scenePathCandidates(p)) {
    if (pathMap.has(k)) return pathMap.get(k);
  }
  return null;
};

/** 组件行：中英标签双认 */
export const findCompRow = (rows, ...labels) => {
  if (!rows?.length) return undefined;
  const set = new Set(labels.map((l) => String(l).toLowerCase()));
  return rows.find((r) => set.has(String(r.label ?? '').toLowerCase()));
};

export const parseSizePair = (value) => {
  const m = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { width: +m[1], height: +m[2] };
};

export const isValidUiSize = (width, height) =>
  Number.isFinite(width) && Number.isFinite(height);

export const parseUiFromSnapshotNode = (ch) => {
  const ut = ch.uiTransform?.contentSize;
  if (ut && isValidUiSize(ut.width, ut.height)) {
    return {
      contentSize: { width: ut.width, height: ut.height },
      anchorPoint: ch.uiTransform.anchorPoint,
    };
  }

  const uiComp = (ch.components || []).find((c) => /UITransform/.test(c.typeName || ''));
  const sizeRow = findCompRow(uiComp?.rows, '内容尺寸', 'size', 'contentSize');
  const size = parseSizePair(sizeRow?.value);
  if (size && isValidUiSize(size.width, size.height)) {
    const anchorRow = findCompRow(uiComp.rows, '锚点', 'anchor', 'anchorPoint');
    let ax = 0.5;
    let ay = 0.5;
    if (anchorRow?.value) {
      const p = String(anchorRow.value)
        .split(',')
        .map((s) => parseFloat(s.trim()));
      if (p.length >= 2) {
        ax = p[0];
        ay = p[1];
      }
    }
    return { contentSize: size, anchorPoint: { x: ax, y: ay } };
  }

  const sp = (ch.components || []).find((c) => c.flags?.isSprite);
  const sizeModeRow = findCompRow(sp?.rows, '尺寸模式', 'sizeMode');
  const sizeMode = parseInt(String(sizeModeRow?.value ?? ''), 10);
  // CUSTOM(2) 必须用 UITransform，不能用图集纹理尺寸
  if (sp?.rows && sizeMode !== 2) {
    const texRow = findCompRow(sp.rows, '纹理', '贴图', 'texture', 'spriteFrame');
    const texSize = parseSizePair(texRow?.value);
    if (texSize && isValidUiSize(texSize.width, texSize.height)) {
      return { contentSize: texSize, anchorPoint: { x: 0.5, y: 0.5 } };
    }
  }

  return null;
};

export const parseSpriteSizeMode = (ch) => {
  const sf = ch.spriteFrame?.sizeMode;
  if (sf != null && Number.isFinite(sf)) return sf;

  const sp = (ch.components || []).find((c) => c.flags?.isSprite);
  const row = findCompRow(sp?.rows, '尺寸模式', 'sizeMode');
  const v = parseInt(String(row?.value ?? ''), 10);
  return Number.isFinite(v) ? v : null;
};

/** 从快照节点或 downloadTexture detail 归一化 spriteFrame 元数据 */
export const normalizeSpriteFrameMeta = (ch, detail) => {
  const sf = ch?.spriteFrame;
  const src = detail ?? sf;
  if (!src?.originalSize || !src?.frameRect) return null;
  const sizeModeRaw = src.sizeMode ?? sf?.sizeMode;
  const sizeMode = parseInt(String(sizeModeRaw ?? ''), 10);
  return {
    frameName: src.frameName ?? sf?.frameName ?? '',
    frameRect: { ...src.frameRect },
    offset: { ...(src.offset ?? sf?.offset ?? { x: 0, y: 0 }) },
    originalSize: { ...src.originalSize },
    displaySize: { ...(src.displaySize ?? sf?.displaySize ?? src.originalSize) },
    sizeMode: Number.isFinite(sizeMode) ? sizeMode : 0,
    isRotated: !!(src.isRotated ?? sf?.isRotated),
  };
};

export const indexSnapshotNodes = (root) => {
  const byId = {};
  const walk = (n) => {
    byId[n.id] = n;
    for (const ch of n.children || []) walk(ch);
  };
  walk(root);
  return byId;
};

export const collectUiSizeBindings = (snapshotRoot, pathMap) => {
  const bindings = [];
  const walk = (node) => {
    const nodeUuid = lookupPathMap(pathMap, node.path);
    const ui = parseUiFromSnapshotNode(node);
    if (nodeUuid && ui?.contentSize && isValidUiSize(ui.contentSize.width, ui.contentSize.height)) {
      bindings.push({
        nodeUuid,
        width: ui.contentSize.width,
        height: ui.contentSize.height,
        anchorX: ui.anchorPoint?.x,
        anchorY: ui.anchorPoint?.y,
      });
    }
    for (const ch of node.children || []) walk(ch);
  };
  walk(snapshotRoot);
  return bindings;
};
