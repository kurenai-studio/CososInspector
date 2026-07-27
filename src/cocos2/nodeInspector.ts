import {
  findNodeById,
  getNodeId,
  getNodeName,
  getSceneRoot,
  type Cc2Node,
} from './sceneTree';
import { mapCc2SizeModeToCc3 } from './spriteExtract';

export interface InspectRow {
  label: string;
  value: string;
}

export interface ComponentInspectInfo {
  typeName: string;
  shortName: string;
  enabled: boolean;
  rows: InspectRow[];
  isSprite: boolean;
  isSpine: boolean;
  isBmfont: boolean;
  spineIndex: number;
  bmfontIndex: number;
}

export interface NodeInspectorData {
  nodeId: string;
  nodeName: string;
  position: string;
  size: string;
  anchor: string;
  opacity: string;
  scale: string;
  hasSprite: boolean;
  components: ComponentInspectInfo[];
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const getComponentName = (comp: unknown): string => {
  const rec = comp as {
    __classname__?: string;
    constructor?: { name?: string };
  };
  return rec.__classname__ ?? rec.constructor?.name ?? 'Component';
};

const shortTypeName = (full: string): string => {
  const base = full.replace(/^cc\./, '');
  const parts = base.split('.');
  return parts[parts.length - 1] ?? base;
};

const fmt = (n: number | undefined, digits = 2): string => {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toFixed(digits);
};

const readNodeSize = (node: Cc2Node): string => {
  try {
    if (typeof node.getContentSize === 'function') {
      const s = node.getContentSize();
      return `${Math.round(s.width)}×${Math.round(s.height)}`;
    }
  } catch {
    /* ignore */
  }
  if (node.width != null || node.height != null) {
    return `${Math.round(node.width ?? 0)}×${Math.round(node.height ?? 0)}`;
  }
  return '-';
};

const listComponents = (node: Cc2Node): unknown[] => {
  try {
    if (typeof node.getComponents === 'function') {
      const ccComp = (window.cc as { Component?: unknown } | undefined)?.Component;
      const list = node.getComponents(ccComp);
      if (Array.isArray(list)) return list.filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  return (node._components ?? []).filter(Boolean);
};

const inspectComponent = (comp: unknown): ComponentInspectInfo => {
  const typeName = getComponentName(comp);
  const shortName = shortTypeName(typeName);
  const c = comp as Record<string, unknown> & { enabled?: boolean; _enabled?: boolean };
  const enabled =
    typeof c.enabled === 'boolean'
      ? c.enabled
      : typeof c._enabled === 'boolean'
        ? c._enabled
        : true;

  const rows: InspectRow[] = [];
  const push = (label: string, value: unknown) => {
    if (value == null) return;
    if (typeof value === 'object') return;
    rows.push({ label, value: String(value) });
  };

  // 常见 2.x 可渲染组件字段（中文标签对齐 3.x 解析器）
  const isSprite = /Sprite/i.test(shortName) && !/Spine|Skeleton/i.test(shortName);
  if (isSprite) {
    const frame = (c._spriteFrame ?? c.spriteFrame) as
      | { name?: string; _name?: string }
      | null
      | undefined;
    const rawMode = c.sizeMode ?? c._sizeMode;
    const sizeMode3 =
      typeof rawMode === 'number' ? mapCc2SizeModeToCc3(rawMode) : rawMode;
    push('贴图', frame?.name || frame?._name || '(frame)');
    push('类型', c.type ?? c._type);
    push('尺寸模式', sizeMode3);
    push('spriteFrame', frame?.name || frame?._name || '(frame)');
    push('sizeMode', sizeMode3);
  }
  if (/Label/i.test(shortName) && !/RichText/i.test(shortName)) {
    const text = String(c.string ?? c._string ?? '');
    // 快照需完整文本；面板渲染侧再截断
    push('文本', text || '(空)');
    push('字号', c.fontSize ?? c._fontSize);
    push('行高', c.lineHeight ?? c._lineHeight);
    const col = c.color ?? c._color;
    if (col && typeof col === 'object') {
      const o = col as { r?: number; g?: number; b?: number; a?: number };
      push(
        '颜色',
        `${o.r ?? 255},${o.g ?? 255},${o.b ?? 255},${o.a ?? 255}`
      );
    }
    push('溢出', c.overflow ?? c._overflow ?? c.Overflow);
    push('水平对齐', c.horizontalAlign ?? c._N$horizontalAlign);
    push('垂直对齐', c.verticalAlign ?? c._N$verticalAlign);
  }
  if (/RichText/i.test(shortName)) {
    const text = String(c.string ?? c._string ?? '');
    push('文本', text || '(空)');
    push('字号', c.fontSize ?? c._fontSize);
  }
  if (/Mask/i.test(shortName)) {
    push('类型', c._type ?? c.type ?? 0);
  }
  if (/Canvas/i.test(shortName)) {
    const dr = (c.designResolution ?? c._designResolution) as
      | { width?: number; height?: number }
      | undefined;
    if (dr) {
      push('设计分辨率', `${Math.round(dr.width ?? 0)}×${Math.round(dr.height ?? 0)}`);
    }
  }
  if (/Spine|Skeleton/i.test(shortName) && !/Sprite/i.test(shortName)) {
    const data = c._skeletonData ?? c.skeletonData;
    const dataName =
      data && typeof data === 'object'
        ? String(
            (data as { name?: string; _name?: string }).name ||
              (data as { _name?: string })._name ||
              '(skeleton)'
          )
        : '-';
    push('骨架', dataName);
    push('动画', c.animation ?? c.defaultAnimation ?? c._animation ?? '-');
  }
  if (/Widget/i.test(shortName)) {
    const alignFlags = Number(c.alignFlags ?? c._alignFlags ?? 0);
    const isLeft =
      typeof c.isAlignLeft === 'boolean'
        ? c.isAlignLeft
        : !!(alignFlags & 8);
    const isRight =
      typeof c.isAlignRight === 'boolean'
        ? c.isAlignRight
        : !!(alignFlags & 32);
    const isTop =
      typeof c.isAlignTop === 'boolean'
        ? c.isAlignTop
        : !!(alignFlags & 1);
    const isBottom =
      typeof c.isAlignBottom === 'boolean'
        ? c.isAlignBottom
        : !!(alignFlags & 4);
    push('对齐', c.alignMode ?? c._alignMode ?? '-');
    push('左', isLeft ? (c.left ?? c._left ?? 0) : '-');
    push('右', isRight ? (c.right ?? c._right ?? 0) : '-');
    push('上', isTop ? (c.top ?? c._top ?? 0) : '-');
    push('下', isBottom ? (c.bottom ?? c._bottom ?? 0) : '-');
    push('水平居中', c.isAlignHorizontalCenter ? '是' : '否');
    push('垂直居中', c.isAlignVerticalCenter ? '是' : '否');
  }

  if (rows.length === 0) {
    rows.push({ label: 'type', value: typeName });
  }

  const isSpine =
    /Spine|Skeleton/i.test(shortName) && !/Sprite|SkeletonData/i.test(shortName);
  const isBmfont = (() => {
    if (!/Label/i.test(shortName) || /RichText/i.test(shortName)) return false;
    const font = (c.font ?? c._font) as
      | { fntConfig?: unknown; _fntConfig?: unknown; __classname__?: string }
      | null
      | undefined;
    if (!font) return false;
    return !!(
      font.fntConfig ||
      font._fntConfig ||
      /BitmapFont/i.test(font.__classname__ ?? '')
    );
  })();

  return {
    typeName,
    shortName,
    enabled,
    rows,
    isSprite,
    isSpine,
    isBmfont,
    spineIndex: 0,
    bmfontIndex: 0,
  };
};

export function collectNodeInspectorData(
  nodeId: string | null
): NodeInspectorData | null {
  if (!nodeId) return null;
  const scene = getSceneRoot();
  if (!scene) return null;
  const node = findNodeById(scene, nodeId);
  if (!node) return null;

  const components = listComponents(node).map(inspectComponent);
  let spineIdx = 0;
  let bmfontIdx = 0;
  for (const c of components) {
    if (c.isSpine) {
      c.spineIndex = spineIdx;
      spineIdx += 1;
    }
    if (c.isBmfont) {
      c.bmfontIndex = bmfontIdx;
      bmfontIdx += 1;
    }
  }

  return {
    nodeId: getNodeId(node),
    nodeName: getNodeName(node),
    position: `${fmt(node.x)}, ${fmt(node.y)}`,
    size: readNodeSize(node),
    anchor: `${fmt(node.anchorX)}, ${fmt(node.anchorY)}`,
    opacity: node.opacity != null ? String(Math.round(node.opacity)) : '-',
    scale: `${fmt(node.scaleX)}, ${fmt(node.scaleY)}`,
    hasSprite: components.some((c) => c.isSprite),
    components,
  };
}

export function hashNodeInspectorData(data: NodeInspectorData | null): string {
  if (!data) return '';
  return [
    data.nodeId,
    data.position,
    data.size,
    data.anchor,
    data.opacity,
    data.scale,
    data.components
      .map((c) => `${c.shortName}:${c.enabled}:${c.rows.map((r) => r.value).join(',')}`)
      .join(';'),
  ].join('|');
}

export function renderNodeInspectorHtml(data: NodeInspectorData | null): string {
  if (!data) {
    return '<div class="node-inspector-empty">选中节点以查看 Inspector</div>';
  }

  const nodeBlock = `<section class="insp-comp-block">
    <header class="insp-comp-header">
      <span class="insp-comp-name">Node (2.x)</span>
    </header>
    <div class="insp-comp-body">
      <div class="insp-row"><span class="insp-label">位置</span><span class="insp-value">${escapeHtml(data.position)}</span></div>
      <div class="insp-row"><span class="insp-label">尺寸</span><span class="insp-value">${escapeHtml(data.size)}</span></div>
      <div class="insp-row"><span class="insp-label">锚点</span><span class="insp-value">${escapeHtml(data.anchor)}</span></div>
      <div class="insp-row"><span class="insp-label">缩放</span><span class="insp-value">${escapeHtml(data.scale)}</span></div>
      <div class="insp-row"><span class="insp-label">透明度</span><span class="insp-value">${escapeHtml(data.opacity)}</span></div>
    </div>
  </section>`;

  if (data.components.length === 0) {
    return `<div class="node-inspector-scroll">${nodeBlock}<div class="node-inspector-empty">当前节点无组件</div></div>`;
  }

  const blocks = data.components
    .map((comp) => {
      const rows = comp.rows
        .map((r) => {
          let display = r.value;
          if (r.label === '文本' && display.length > 48) {
            display = `${display.slice(0, 48)}…`;
          }
          return `<div class="insp-row"><span class="insp-label">${escapeHtml(
            r.label
          )}</span><span class="insp-value">${escapeHtml(display)}</span></div>`;
        })
        .join('');
      const stateBadge = comp.enabled
        ? '<span class="insp-badge insp-badge-on">启用</span>'
        : '<span class="insp-badge insp-badge-off">禁用</span>';
      const exportBtns = [
        comp.isSpine
          ? `<button type="button" class="insp-export-spine-btn" data-spine-idx="${comp.spineIndex}" title="导出 Spine zip">导出 Spine</button>`
          : '',
        comp.isBmfont
          ? `<button type="button" class="insp-export-bmfont-btn" data-bmfont-idx="${comp.bmfontIndex}" title="导出 BMFont zip">导出 BMFont</button>`
          : '',
      ]
        .filter(Boolean)
        .join('');
      const preview = comp.isSprite
        ? `<div class="insp-sprite-preview-2x" data-sprite-preview-2x>
            <div class="insp-sprite-preview-toolbar">
              <button type="button" class="sprite-download-btn-2x" title="下载裁切后 PNG">下载 PNG</button>
              <span class="insp-sprite-preview-meta">加载中…</span>
            </div>
            <canvas class="insp-sprite-canvas-2x" width="1" height="1"></canvas>
          </div>`
        : '';
      return `<section class="insp-comp-block">
        <header class="insp-comp-header">
          <span class="insp-comp-name">${escapeHtml(comp.shortName)}</span>
          <span class="insp-comp-actions">${exportBtns}${stateBadge}</span>
        </header>
        <div class="insp-comp-body">${rows}${preview}</div>
      </section>`;
    })
    .join('');

  return `<div class="node-inspector-scroll">${nodeBlock}${blocks}</div>`;
}

export function createNodeInspectorElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'node-inspector-panel';
  el.innerHTML = `
    <div class="node-inspector-title">Inspector</div>
    <div class="node-inspector-body">
      <div class="node-inspector-empty">选中节点以查看 Inspector</div>
    </div>
  `;
  return el;
}
