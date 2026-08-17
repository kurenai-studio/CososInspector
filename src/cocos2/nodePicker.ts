/**
 * Cocos 2.x 鼠标拾取：getBoundingBoxToWorld → 屏幕盒，取最小/最深命中
 */
import { isInspectorEventTarget } from '../engine/pickDownloadToolbar';
import {
  findNodeById,
  getNodeActive,
  getNodeChildren,
  getNodeId,
  getNodeName,
  getSceneRoot,
  type Cc2Node,
} from './sceneTree';

let active = false;
let onPickCb: ((nodeId: string) => void) | null = null;
let hoverId: string | null = null;
let overlayRoot: HTMLDivElement | null = null;

type WorldBox = { x: number; y: number; width: number; height: number };

type NodeHit = Cc2Node & {
  getBoundingBoxToWorld?: () => WorldBox;
  activeInHierarchy?: boolean;
  _activeInHierarchy?: boolean;
};

const getGameCanvas = (): HTMLCanvasElement | null => {
  const ccg = window.cc as { game?: { canvas?: HTMLCanvasElement } };
  return (
    ccg.game?.canvas ??
    (document.getElementById('GameCanvas') as HTMLCanvasElement | null) ??
    document.querySelector('canvas')
  );
};

const worldPointToClient = (
  wx: number,
  wy: number
): { x: number; y: number } | null => {
  const canvas = getGameCanvas();
  if (!canvas) return null;
  const cr = canvas.getBoundingClientRect();
  const ccg = window.cc as {
    view?: {
      getViewportRect?: () => WorldBox;
      getScaleX?: () => number;
      getScaleY?: () => number;
      getVisibleSize?: () => { width: number; height: number };
    };
  };
  const view = ccg.view;
  const cssSx = cr.width / canvas.width;
  const cssSy = cr.height / canvas.height;
  const scaleX = view?.getScaleX?.() ?? 1;
  const scaleY = view?.getScaleY?.() ?? 1;
  const vp = view?.getViewportRect?.();
  if (vp) {
    const cx = vp.x + wx * scaleX;
    const cy = vp.y + wy * scaleY;
    return {
      x: cr.left + cx * cssSx,
      y: cr.top + (canvas.height - cy) * cssSy,
    };
  }
  const vs = view?.getVisibleSize?.();
  if (vs && vs.width > 0 && vs.height > 0) {
    return {
      x: cr.left + wx * (cr.width / vs.width),
      y: cr.top + (vs.height - wy) * (cr.height / vs.height),
    };
  }
  return {
    x: cr.left + wx * cssSx,
    y: cr.top + (canvas.height - wy) * cssSy,
  };
};

const worldRectToScreenCss = (
  box: WorldBox
): { left: number; top: number; width: number; height: number } | null => {
  if (box.width <= 0 || box.height <= 0) return null;
  const bl = worldPointToClient(box.x, box.y);
  const tr = worldPointToClient(box.x + box.width, box.y + box.height);
  if (!bl || !tr) return null;
  const left = Math.min(bl.x, tr.x);
  const top = Math.min(bl.y, tr.y);
  return {
    left,
    top,
    width: Math.max(Math.abs(tr.x - bl.x), 1),
    height: Math.max(Math.abs(tr.y - bl.y), 1),
  };
};

const isNodeVisible = (node: NodeHit): boolean => {
  const hier = node.activeInHierarchy ?? node._activeInHierarchy;
  if (hier === false) return false;
  return getNodeActive(node);
};

const getScreenRect = (
  node: NodeHit
): { left: number; top: number; width: number; height: number } | null => {
  if (typeof node.getBoundingBoxToWorld !== 'function') return null;
  try {
    const box = node.getBoundingBoxToWorld();
    if (!box) return null;
    return worldRectToScreenCss(box);
  } catch {
    return null;
  }
};

const containsCss = (
  css: { left: number; top: number; width: number; height: number },
  x: number,
  y: number
): boolean =>
  x >= css.left &&
  x <= css.left + css.width &&
  y >= css.top &&
  y <= css.top + css.height;

type Hit = { node: NodeHit; area: number; depth: number };

const collectHits = (
  node: NodeHit,
  x: number,
  y: number,
  depth: number,
  hits: Hit[]
): void => {
  if (!isNodeVisible(node)) return;
  const css = getScreenRect(node);
  if (css && containsCss(css, x, y)) {
    hits.push({ node, area: css.width * css.height, depth });
  }
  for (const child of getNodeChildren(node)) {
    collectHits(child as NodeHit, x, y, depth + 1, hits);
  }
};

const hitTest = (clientX: number, clientY: number): NodeHit | null => {
  const scene = getSceneRoot();
  if (!scene) return null;
  const hits: Hit[] = [];
  collectHits(scene as NodeHit, clientX, clientY, 0, hits);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.area - b.area || b.depth - a.depth);
  return hits[0].node;
};

const ensureOverlay = (): HTMLDivElement => {
  if (overlayRoot?.isConnected) return overlayRoot;
  overlayRoot = document.createElement('div');
  overlayRoot.id = 'cocos-inspector-pick-overlay';
  overlayRoot.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:2147483646',
  ].join(';');
  document.body.appendChild(overlayRoot);
  return overlayRoot;
};

const hideHover = (): void => {
  if (overlayRoot) overlayRoot.replaceChildren();
};

const showHover = (node: NodeHit): void => {
  const css = getScreenRect(node);
  const root = ensureOverlay();
  root.replaceChildren();
  if (!css) return;
  const box = document.createElement('div');
  box.style.cssText = [
    'position:fixed',
    `left:${css.left}px`,
    `top:${css.top}px`,
    `width:${css.width}px`,
    `height:${css.height}px`,
    'border:2px solid #4fc3f7',
    'box-shadow:0 0 0 1px #000,0 0 10px #4fc3f7',
    'box-sizing:border-box',
    'background:rgba(79,195,247,0.12)',
  ].join(';');
  const tag = document.createElement('div');
  tag.textContent = getNodeName(node);
  tag.style.cssText = [
    'position:absolute',
    'left:0',
    'top:-18px',
    'color:#4fc3f7',
    'font:12px/1.2 monospace',
    'white-space:nowrap',
    'background:rgba(0,0,0,0.55)',
    'padding:1px 4px',
  ].join(';');
  box.appendChild(tag);
  root.appendChild(box);
};

const onMouseMove = (ev: MouseEvent): void => {
  if (!active) return;
  if (isInspectorEventTarget(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const node = hitTest(ev.clientX, ev.clientY);
  const id = node ? getNodeId(node) : null;
  if (id === hoverId) return;
  hoverId = id;
  if (node) showHover(node);
  else hideHover();
};

const onMouseDown = (ev: MouseEvent): void => {
  if (!active) return;
  if (isInspectorEventTarget(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const node = hitTest(ev.clientX, ev.clientY);
  if (node && onPickCb) onPickCb(getNodeId(node));
};

const onKeyDown = (ev: KeyboardEvent): void => {
  if (active && ev.key === 'Escape') stopPickMode();
};

export const startPickMode = (onPick: (nodeId: string) => void): void => {
  if (active) return;
  active = true;
  onPickCb = onPick;
  hoverId = null;
  const opts: AddEventListenerOptions = { capture: true, passive: false };
  window.addEventListener('mousemove', onMouseMove, opts);
  window.addEventListener('mousedown', onMouseDown, opts);
  window.addEventListener('keydown', onKeyDown);
  document.body.style.cursor = 'crosshair';
};

export const stopPickMode = (): void => {
  if (!active) return;
  active = false;
  onPickCb = null;
  hoverId = null;
  const cap: EventListenerOptions = { capture: true };
  window.removeEventListener('mousemove', onMouseMove, cap);
  window.removeEventListener('mousedown', onMouseDown, cap);
  window.removeEventListener('keydown', onKeyDown);
  document.body.style.cursor = '';
  hideHover();
  overlayRoot?.remove();
  overlayRoot = null;
};

export const isPickModeActive = (): boolean => active;

/** 供调试：按 id 画一帧包围盒 */
export const debugPickRect = (nodeId: string): boolean => {
  const scene = getSceneRoot();
  if (!scene) return false;
  const node = findNodeById(scene, nodeId) as NodeHit | null;
  if (!node) return false;
  showHover(node);
  return true;
};
