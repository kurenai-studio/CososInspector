/**
 * Cocos 3.x 鼠标拾取：capture 拦截点击，世界盒 → 屏幕命中最深/最小节点
 */
import { isInspectorEventTarget } from '../engine/pickDownloadToolbar';
import {
  clientToWorld,
  hideNodeBoundsOverlay,
  showNodeBoundsOverlay,
} from './nodeBoundsOverlay';
import { getNodeId, getSceneRoot } from './sceneTree';

let active = false;
let onPickCb: ((nodeId: string) => void) | null = null;
let hoverId: string | null = null;

type UiLike = {
  getBoundingBoxToWorld?: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

const getUiTransform = (node: cc.Node): UiLike | null => {
  const UITransform = (window.cc as { UITransform?: unknown }).UITransform;
  if (UITransform && typeof node.getComponent === 'function') {
    try {
      const hit = node.getComponent(UITransform as never);
      if (hit) return hit as UiLike;
    } catch {
      /* 试玩页可能无 cc.UITransform */
    }
  }
  const comps =
    (node as cc.Node & { _components?: unknown[] })._components ?? [];
  return (
    (comps.find((c) => {
      const cn =
        (c as { __classname__?: string }).__classname__ ??
        (c as { constructor?: { name?: string } }).constructor?.name ??
        '';
      return /UITransform/.test(cn);
    }) as UiLike | undefined) ?? null
  );
};

const isNodeVisible = (node: cc.Node): boolean => {
  const hier = (node as { activeInHierarchy?: boolean }).activeInHierarchy;
  if (hier === false) return false;
  return node.active !== false;
};

const getWorldBox = (
  node: cc.Node
): { x: number; y: number; width: number; height: number } | null => {
  const ui = getUiTransform(node);
  if (!ui?.getBoundingBoxToWorld) return null;
  try {
    const bbox = ui.getBoundingBoxToWorld();
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) return null;
    return bbox;
  } catch {
    return null;
  }
};

const containsWorld = (
  box: { x: number; y: number; width: number; height: number },
  x: number,
  y: number
): boolean =>
  x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;

type Hit = { node: cc.Node; area: number; depth: number };

const collectHits = (
  node: cc.Node,
  x: number,
  y: number,
  depth: number,
  hits: Hit[]
): void => {
  if (!isNodeVisible(node)) return;
  const box = getWorldBox(node);
  if (box && containsWorld(box, x, y)) {
    hits.push({ node, area: box.width * box.height, depth });
  }
  for (const child of node.children ?? []) {
    if (!child) continue;
    collectHits(child, x, y, depth + 1, hits);
  }
};

const hitTest = (clientX: number, clientY: number): cc.Node | null => {
  const scene = getSceneRoot();
  const world = clientToWorld(clientX, clientY);
  if (!scene || !world) return null;
  const hits: Hit[] = [];
  collectHits(scene, world.x, world.y, 0, hits);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.area - b.area || b.depth - a.depth);
  return hits[0].node;
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
  if (id) showNodeBoundsOverlay(id, { showFrameInner: false });
  else hideNodeBoundsOverlay();
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
  hideNodeBoundsOverlay();
};

export const isPickModeActive = (): boolean => active;
