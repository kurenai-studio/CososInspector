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

/** 从组件行解析 Label（中英标签） */
export const parseLabelFromNode = (ch) => {
  const lab = (ch.components || []).find(
    (c) => /Label/.test(c.typeName || '') && !/RichText/.test(c.typeName || '')
  );
  if (!lab?.rows?.length) return null;
  const textRow = findCompRow(lab.rows, '文本', 'string', 'string');
  const fontRow = findCompRow(lab.rows, '字号', 'fontSize');
  const lineRow = findCompRow(lab.rows, '行高', 'lineHeight');
  const colorRow = findCompRow(lab.rows, '颜色', 'color');
  const overflowRow = findCompRow(lab.rows, '溢出', 'overflow');
  let text = String(textRow?.value ?? '');
  if (text === '(空)') text = '';
  if (text.endsWith('…')) {
    // 截断文本无法完整还原，仍写入可见前缀
    text = text.slice(0, -1);
  }
  const fontSize = parseFloat(String(fontRow?.value ?? ''));
  const lineHeight = parseFloat(String(lineRow?.value ?? ''));
  const overflow = parseInt(String(overflowRow?.value ?? ''), 10);
  let color = null;
  if (colorRow?.value && colorRow.value !== '-') {
    const m = String(colorRow.value).match(
      /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d+))?/
    );
    if (m) {
      color = {
        r: +m[1],
        g: +m[2],
        b: +m[3],
        a: m[4] != null ? +m[4] : 255,
      };
    }
  }
  return {
    string: text,
    fontSize: Number.isFinite(fontSize) ? fontSize : null,
    lineHeight: Number.isFinite(lineHeight) ? lineHeight : null,
    overflow: Number.isFinite(overflow) ? overflow : null,
    color,
  };
};

/** Widget 对齐边距（「-」表示未启用该边） */
export const parseWidgetFromNode = (ch) => {
  const w = (ch.components || []).find((c) => /Widget/.test(c.typeName || ''));
  if (!w?.rows?.length) return null;
  const edge = (labels) => {
    const row = findCompRow(w.rows, ...labels);
    if (!row || row.value === '-' || row.value == null) {
      return { enabled: false, value: 0 };
    }
    const v = parseFloat(String(row.value));
    return { enabled: true, value: Number.isFinite(v) ? v : 0 };
  };
  return {
    left: edge(['左', 'left']),
    right: edge(['右', 'right']),
    top: edge(['上', 'top']),
    bottom: edge(['下', 'bottom']),
    alignHCenter:
      findCompRow(w.rows, '水平居中')?.value === '是' ||
      findCompRow(w.rows, 'isAlignHorizontalCenter')?.value === 'true',
    alignVCenter:
      findCompRow(w.rows, '垂直居中')?.value === '是' ||
      findCompRow(w.rows, 'isAlignVerticalCenter')?.value === 'true',
  };
};

export const parseSpineFromNode = (ch) => {
  const sp = (ch.components || []).find(
    (c) =>
      c.flags?.isSpine ||
      (/Spine|Skeleton/.test(c.typeName || '') && !/Sprite/.test(c.typeName || ''))
  );
  if (!sp) return null;
  const animRow = findCompRow(sp.rows, '动画', 'animation', 'defaultAnimation');
  const skelRow = findCompRow(sp.rows, '骨架', 'skeletonData');
  return {
    animation: animRow?.value && animRow.value !== '-' ? String(animRow.value) : '',
    skeletonName:
      skelRow?.value && skelRow.value !== '-' ? String(skelRow.value) : '',
  };
};
