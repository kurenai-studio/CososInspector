import {
  findNodeById,
  getNodeId,
  getNodeName,
  getSceneRoot,
  type Cc2Node,
} from './sceneTree';

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

  // 常见 2.x 可渲染组件字段
  const isSprite = /Sprite/i.test(shortName) && !/Spine|Skeleton/i.test(shortName);
  if (isSprite) {
    const frame = (c._spriteFrame ?? c.spriteFrame) as
      | { name?: string; _name?: string }
      | null
      | undefined;
    push('spriteFrame', frame?.name || frame?._name || '(frame)');
    push('type', c.type ?? c._type);
    push('sizeMode', c.sizeMode ?? c._sizeMode);
  }
  if (/Label/i.test(shortName)) {
    push('string', c.string ?? c._string);
    push('fontSize', c.fontSize ?? c._fontSize);
    push('lineHeight', c.lineHeight ?? c._lineHeight);
  }
  if (/Widget/i.test(shortName)) {
    push('isAlignTop', c.isAlignTop ?? c._alignFlags);
  }

  if (rows.length === 0) {
    rows.push({ label: 'type', value: typeName });
  }

  return { typeName, shortName, enabled, rows, isSprite };
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
        .map(
          (r) =>
            `<div class="insp-row"><span class="insp-label">${escapeHtml(
              r.label
            )}</span><span class="insp-value">${escapeHtml(r.value)}</span></div>`
        )
        .join('');
      const stateBadge = comp.enabled
        ? '<span class="insp-badge insp-badge-on">启用</span>'
        : '<span class="insp-badge insp-badge-off">禁用</span>';
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
          <span class="insp-comp-actions">${stateBadge}</span>
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
