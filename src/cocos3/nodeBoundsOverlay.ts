import { collectMeshOverlay, type OverlayEdge } from './nodeBounds3d';
import { findNodeById, getNodeId, getSceneRoot } from './sceneTree';

export interface BoundsOverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
  color: string;
}

export interface NodeBoundsOverlayState {
  nodeId: string;
  nodeName: string;
  boxes: BoundsOverlayBox[];
  edges?: OverlayEdge[];
}

let overlayRoot: HTMLDivElement | null = null;
let rafId = 0;
let activeNodeId: string | null = null;
let activePathSuffix: string | null = null;
let showFrameInner = true;

const getGameCanvas = (): HTMLCanvasElement | null => {
  const ccg = window.cc as {
    game?: { canvas?: HTMLCanvasElement };
  };
  return (
    ccg.game?.canvas ??
    (document.getElementById('GameCanvas') as HTMLCanvasElement | null) ??
    document.querySelector('canvas')
  );
};

const normalizePath = (path: string): string =>
  path
    .replace(/^main\s*›\s*Canvas\s*›\s*/i, '')
    .replace(/\s*›\s*/g, '/')
    .replace(/^\/+/, '');

/** 按路径后缀查找节点，如 SymbolView/0/symbolSprite */
export const findNodeByPathSuffix = (suffix: string): cc.Node | null => {
  const scene = getSceneRoot();
  if (!scene) return null;
  const target = normalizePath(suffix);
  const walk = (node: cc.Node, parts: string[]): cc.Node | null => {
    const path = parts.join('/');
    if (path === target || path.endsWith(`/${target}`) || path.endsWith(target)) {
      return node;
    }
    for (const child of node.children ?? []) {
      if (!child) continue;
      const hit = walk(child, [...parts, child.name || '']);
      if (hit) return hit;
    }
    return null;
  };
  return walk(scene, [scene.name || 'main']);
};

type CamLike = {
  worldToScreen?: (
    pos: { x: number; y: number; z?: number },
    out?: { x: number; y: number; z: number }
  ) => { x: number; y: number; z: number };
  screenToWorld?: (
    pos: { x: number; y: number; z?: number },
    out?: { x: number; y: number; z: number }
  ) => { x: number; y: number; z: number };
  camera?: { window?: { width?: number; height?: number } };
  _camera?: { window?: { width?: number; height?: number } };
  projection?: number;
  _projection?: number;
};

const isCameraClass = (cn: string): boolean =>
  cn === 'cc.Camera' || cn === 'Camera';

const getCameraOnNode = (node: cc.Node): CamLike | null => {
  const Camera = (window.cc as { Camera?: unknown }).Camera;
  if (Camera && typeof node.getComponent === 'function') {
    try {
      const hit = node.getComponent(Camera as never);
      if (hit) return hit as CamLike;
    } catch {
      /* 试玩页可能无 cc.Camera 导出 */
    }
  }
  const comps =
    (node as cc.Node & { _components?: unknown[] })._components ?? [];
  return (
    (comps.find((c) => {
      const rec = c as {
        __classname__?: string;
        constructor?: { name?: string };
      };
      const cn = rec.__classname__ ?? rec.constructor?.name ?? '';
      return isCameraClass(cn);
    }) as CamLike | undefined) ?? null
  );
};

const scoreCamera = (node: cc.Node, cam: CamLike): number => {
  let score = 1;
  const name = (node.name || '').toLowerCase();
  const parent = (node.parent?.name || '').toLowerCase();
  if (name === 'uicamera') score += 100;
  if (name.includes('ui') && name.includes('camera')) score += 40;
  if (name === 'canvas' || parent === 'canvas') score += 50;
  const proj = cam.projection ?? cam._projection;
  if (proj === 0) score += 20;
  return score;
};

/** 查找 UI 相机：3.8 常挂在 Canvas 上，不限节点名 UICamera */
const findUICamera = (): CamLike | null => {
  const scene = getSceneRoot();
  if (!scene) return null;
  const found: { cam: CamLike; score: number }[] = [];
  const walk = (node: cc.Node): void => {
    const cam = getCameraOnNode(node);
    if (cam) found.push({ cam, score: scoreCamera(node, cam) });
    for (const child of node.children ?? []) {
      if (child) walk(child);
    }
  };
  walk(scene);
  found.sort((a, b) => b.score - a.score);
  if (found[0]) return found[0].cam;

  const main = (
    window.cc as { Camera?: { main?: CamLike; mainCamera?: CamLike } }
  ).Camera;
  return main?.main ?? main?.mainCamera ?? null;
};

const getCameraWindowSize = (cam: CamLike): { w: number; h: number } => {
  const win = cam.camera?.window ?? cam._camera?.window;
  const w = Number(win?.width ?? 0);
  const h = Number(win?.height ?? 0);
  if (w > 1 && h > 1) return { w, h };
  const vs = (
    window.cc as {
      view?: {
        getVisibleSizeInPixel?: () => { width: number; height: number };
      };
    }
  ).view?.getVisibleSizeInPixel?.();
  if (vs && vs.width > 1 && vs.height > 1) {
    return { w: vs.width, h: vs.height };
  }
  const canvas = getGameCanvas();
  return { w: canvas?.width || 1, h: canvas?.height || 1 };
};

const getVec3Ctor = (): (new (
  x?: number,
  y?: number,
  z?: number
) => { x: number; y: number; z: number }) | null =>
  ((window.cc as Record<string, unknown>).Vec3 as new (
    x?: number,
    y?: number,
    z?: number
  ) => { x: number; y: number; z: number }) ?? null;

const worldPointToClient = (
  x: number,
  y: number,
  z = 0
): { x: number; y: number } | null => {
  const canvas = getGameCanvas();
  if (!canvas) return null;
  const cr = canvas.getBoundingClientRect();
  if (cr.width <= 0 || cr.height <= 0) return null;

  const Vec3 = getVec3Ctor();
  const cam = findUICamera();
  if (cam?.worldToScreen && Vec3) {
    const out = new Vec3();
    cam.worldToScreen(new Vec3(x, y, z), out);
    const win = getCameraWindowSize(cam);
    // window 像素、原点左下 → 按 window 归一化到 CSS，避免再乘 DPR
    return {
      x: cr.left + (out.x / win.w) * cr.width,
      y: cr.top + (1 - out.y / win.h) * cr.height,
    };
  }

  const vs = (
    window.cc as {
      view?: { getVisibleSize?: () => { width: number; height: number } };
    }
  ).view?.getVisibleSize?.();
  if (vs && vs.width > 0 && vs.height > 0) {
    return {
      x: cr.left + (x / vs.width) * cr.width,
      y: cr.top + (1 - y / vs.height) * cr.height,
    };
  }
  return {
    x: cr.left + (x / canvas.width) * cr.width,
    y: cr.top + (1 - y / canvas.height) * cr.height,
  };
};

/** 页面坐标 → UI 世界坐标（拾取用） */
export const clientToWorld = (
  clientX: number,
  clientY: number
): { x: number; y: number; z: number } | null => {
  const canvas = getGameCanvas();
  if (!canvas) return null;
  const cr = canvas.getBoundingClientRect();
  if (cr.width <= 0 || cr.height <= 0) return null;

  const u = (clientX - cr.left) / cr.width;
  const v = (clientY - cr.top) / cr.height;
  const Vec3 = getVec3Ctor();
  const cam = findUICamera();
  if (cam?.screenToWorld && Vec3) {
    const win = getCameraWindowSize(cam);
    const screen = new Vec3(u * win.w, (1 - v) * win.h, 0);
    const out = new Vec3();
    cam.screenToWorld(screen, out);
    return { x: out.x, y: out.y, z: out.z };
  }

  const vs = (
    window.cc as {
      view?: { getVisibleSize?: () => { width: number; height: number } };
    }
  ).view?.getVisibleSize?.();
  if (vs && vs.width > 0 && vs.height > 0) {
    return { x: u * vs.width, y: (1 - v) * vs.height, z: 0 };
  }
  return { x: u * canvas.width, y: (1 - v) * canvas.height, z: 0 };
};

/** UITransform 世界包围盒 → 页面 CSS 像素 */
export const worldRectToScreenCss = (bbox: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { left: number; top: number; width: number; height: number } | null => {
  if (bbox.width <= 0 || bbox.height <= 0) return null;

  const bl = worldPointToClient(bbox.x, bbox.y, 0);
  const tr = worldPointToClient(bbox.x + bbox.width, bbox.y + bbox.height, 0);
  if (!bl || !tr) return null;

  const left = Math.min(bl.x, tr.x);
  const top = Math.min(bl.y, tr.y);
  const width = Math.max(Math.abs(tr.x - bl.x), 1);
  const height = Math.max(Math.abs(tr.y - bl.y), 1);
  return { left, top, width, height };
};

const getCompByClassPattern = (
  node: cc.Node,
  pattern: RegExp,
  ccCtor?: unknown
): unknown | null => {
  if (ccCtor && typeof node.getComponent === 'function') {
    try {
      const hit = node.getComponent(ccCtor as never);
      if (hit) return hit;
    } catch {
      /* 试玩页可能无 cc.UITransform 等导出 */
    }
  }
  const comps = (node as cc.Node & { _components?: unknown[] })._components ?? [];
  return (
    comps.find((c) => {
      const cn =
        (c as { __classname__?: string }).__classname__ ??
        (c as { constructor?: { name?: string } }).constructor?.name ??
        '';
      return pattern.test(cn);
    }) ?? null
  );
};

const getUiTransform = (node: cc.Node): UiLike | null =>
  getCompByClassPattern(node, /UITransform/, (window.cc as { UITransform?: unknown }).UITransform) as UiLike | null;

const getSprite = (node: cc.Node): SpriteLike | null =>
  getCompByClassPattern(node, /Sprite/, (window.cc as { Sprite?: unknown }).Sprite) as SpriteLike | null;

type UiLike = {
  contentSize?: { width?: number; height?: number };
  anchorPoint?: { x?: number; y?: number };
  getBoundingBoxToWorld?: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  convertToWorldSpaceAR?: (v: { x: number; y: number; z?: number }) => {
    x: number;
    y: number;
    z?: number;
  };
};

type SpriteLike = {
  spriteFrame?: {
    rect?: { x?: number; y?: number; width?: number; height?: number };
    originalSize?: { width?: number; height?: number; x?: number; y?: number };
    offset?: { x?: number; y?: number };
  };
};

const readVec2 = (v?: { x?: number; y?: number } | null) => ({
  x: v?.x ?? 0,
  y: v?.y ?? 0,
});

const collectOverlayVisuals = (
  node: cc.Node
): { boxes: BoundsOverlayBox[]; edges: OverlayEdge[] } => {
  const boxes: BoundsOverlayBox[] = [];
  const mesh = collectMeshOverlay(node);
  boxes.push(...mesh.boxes);
  const ui = getUiTransform(node);
  if (!ui?.getBoundingBoxToWorld) {
    return { boxes, edges: mesh.edges };
  }

  const uiBbox = ui.getBoundingBoxToWorld();
  const uiCss = worldRectToScreenCss(uiBbox);
  const cw = ui.contentSize?.width ?? uiBbox.width;
  const ch = ui.contentSize?.height ?? uiBbox.height;
  if (uiCss) {
    boxes.push({
      ...uiCss,
      color: '#ff2222',
      label: `UITransform ${Math.round(cw)}×${Math.round(ch)}`,
    });
  }

  if (!showFrameInner || !ui.convertToWorldSpaceAR) {
    return { boxes, edges: mesh.edges };
  }

  const sp = getSprite(node);
  const frame = sp?.spriteFrame;
  const rect = frame?.rect;
  const os = frame?.originalSize;
  if (!rect?.width || !rect?.height || !os) {
    return { boxes, edges: mesh.edges };
  }

  const ow = Math.round(os.width ?? (os as { x?: number }).x ?? cw);
  const oh = Math.round(os.height ?? (os as { y?: number }).y ?? ch);
  const fw = Math.round(rect.width ?? 0);
  const fh = Math.round(rect.height ?? 0);
  const offset = readVec2(frame.offset);
  const anchor = readVec2(ui.anchorPoint);
  const trimX = Math.round((ow - fw) / 2 + offset.x);
  const trimY = Math.round((oh - fh) / 2 - offset.y);

  const localLeft = -cw * anchor.x + trimX;
  const localBottom = -ch * anchor.y + trimY;
  const corners = [
    { x: localLeft, y: localBottom },
    { x: localLeft + fw, y: localBottom },
    { x: localLeft + fw, y: localBottom + fh },
    { x: localLeft, y: localBottom + fh },
  ];

  const worldPts = corners.map((p) => ui.convertToWorldSpaceAR!({ x: p.x, y: p.y, z: 0 }));
  const xs = worldPts.map((p) => p.x);
  const ys = worldPts.map((p) => p.y);
  const innerBbox = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  const innerCss = worldRectToScreenCss(innerBbox);
  if (innerCss) {
    boxes.push({
      ...innerCss,
      color: '#00e676',
      label: `frame ${fw}×${fh}`,
    });
  }

  return { boxes, edges: mesh.edges };
};

const ensureOverlayRoot = (): HTMLDivElement => {
  if (overlayRoot?.isConnected) return overlayRoot;
  overlayRoot = document.createElement('div');
  overlayRoot.id = 'cocos-inspector-bounds-overlay';
  overlayRoot.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:2147483646',
    'overflow:hidden',
  ].join(';');
  document.body.appendChild(overlayRoot);
  return overlayRoot;
};

const renderEdges = (
  root: HTMLElement,
  edges: OverlayEdge[],
  nodeName: string
): void => {
  if (edges.length === 0) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'overflow:visible',
  ].join(';');
  for (const e of edges) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(e.x1));
    line.setAttribute('y1', String(e.y1));
    line.setAttribute('x2', String(e.x2));
    line.setAttribute('y2', String(e.y2));
    line.setAttribute('stroke', e.color);
    line.setAttribute('stroke-width', '2');
    svg.appendChild(line);
    if (e.label) {
      const tag = document.createElement('div');
      tag.textContent = `${nodeName} · ${e.label}`;
      tag.style.cssText = [
        'position:fixed',
        `left:${e.x1}px`,
        `top:${e.y1 - 18}px`,
        `color:${e.color}`,
        'font:12px/1.2 monospace',
        'white-space:nowrap',
        'text-shadow:0 0 4px #000',
        'background:rgba(0,0,0,0.55)',
        'padding:1px 4px',
        'pointer-events:none',
      ].join(';');
      root.appendChild(tag);
    }
  }
  root.appendChild(svg);
};

const renderBoxes = (state: NodeBoundsOverlayState | null): void => {
  const root = ensureOverlayRoot();
  root.replaceChildren();
  if (!state) return;
  if (state.edges?.length) renderEdges(root, state.edges, state.nodeName);
  if (!state.boxes.length) return;

  for (const box of state.boxes) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      `left:${box.left}px`,
      `top:${box.top}px`,
      `width:${box.width}px`,
      `height:${box.height}px`,
      `border:3px solid ${box.color}`,
      `box-shadow:0 0 0 1px rgba(0,0,0,0.85),0 0 12px ${box.color}`,
      'box-sizing:border-box',
      `background:${box.color}22`,
    ].join(';');

    const tag = document.createElement('div');
    tag.textContent = `${state.nodeName} · ${box.label}`;
    tag.style.cssText = [
      'position:absolute',
      'left:0',
      'top:-20px',
      `color:${box.color}`,
      'font:12px/1.2 monospace',
      'white-space:nowrap',
      'text-shadow:0 0 4px #000,0 0 2px #000',
      'background:rgba(0,0,0,0.55)',
      'padding:1px 4px',
      'border-radius:2px',
    ].join(';');
    el.appendChild(tag);
    root.appendChild(el);
  }
};

const resolveActiveNode = (): cc.Node | null => {
  const scene = getSceneRoot();
  if (!scene) return null;
  if (activeNodeId) {
    return findNodeById(scene, activeNodeId);
  }
  if (activePathSuffix) {
    return findNodeByPathSuffix(activePathSuffix);
  }
  return null;
};

const tick = (): void => {
  rafId = 0;
  if (!activeNodeId && !activePathSuffix) {
    renderBoxes(null);
    return;
  }

  const node = resolveActiveNode();
  if (!node) {
    renderBoxes(null);
    return;
  }

  const nodeId = getNodeId(node);
  const nodeName = node.name || '(unnamed)';
  const visuals = collectOverlayVisuals(node);
  renderBoxes({ nodeId, nodeName, ...visuals });
  rafId = requestAnimationFrame(tick);
};

const scheduleTick = (): void => {
  if (!rafId) rafId = requestAnimationFrame(tick);
};

export const showNodeBoundsOverlay = (
  nodeId: string,
  options?: { showFrameInner?: boolean }
): { ok: true; nodeId: string; nodeName: string } | { ok: false; error: string } => {
  const scene = getSceneRoot();
  if (!scene) return { ok: false, error: '场景未就绪' };
  const node = findNodeById(scene, nodeId);
  if (!node) return { ok: false, error: `未找到节点 ${nodeId}` };

  activeNodeId = nodeId;
  activePathSuffix = null;
  if (options?.showFrameInner != null) showFrameInner = options.showFrameInner;
  renderBoxes({
    nodeId,
    nodeName: node.name || '(unnamed)',
    ...collectOverlayVisuals(node),
  });
  scheduleTick();
  return { ok: true, nodeId, nodeName: node.name || '(unnamed)' };
};

export const showNodeBoundsByPath = (
  pathSuffix: string,
  options?: { showFrameInner?: boolean }
): { ok: true; nodeId: string; nodeName: string; path: string } | { ok: false; error: string } => {
  const node = findNodeByPathSuffix(pathSuffix);
  if (!node) return { ok: false, error: `未找到路径 ${pathSuffix}` };

  activeNodeId = null;
  activePathSuffix = pathSuffix;
  if (options?.showFrameInner != null) showFrameInner = options.showFrameInner;
  renderBoxes({
    nodeId: getNodeId(node),
    nodeName: node.name || '(unnamed)',
    ...collectOverlayVisuals(node),
  });
  scheduleTick();
  return {
    ok: true,
    nodeId: getNodeId(node),
    nodeName: node.name || '(unnamed)',
    path: pathSuffix,
  };
};

export const hideNodeBoundsOverlay = (): { ok: true } => {
  activeNodeId = null;
  activePathSuffix = null;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  renderBoxes(null);
  return { ok: true };
};

export const isNodeBoundsOverlayVisible = (): boolean =>
  !!(activeNodeId || activePathSuffix);

/** 调试：返回屏幕坐标，不依赖肉眼 */
export const debugNodeBoundsByPath = (
  pathSuffix: string
):
  | {
      ok: true;
      nodeId: string;
      nodeName: string;
      boxes: BoundsOverlayBox[];
      canvasRect: DOMRect | null;
    }
  | { ok: false; error: string } => {
  const node = findNodeByPathSuffix(pathSuffix);
  if (!node) return { ok: false, error: `未找到路径 ${pathSuffix}` };
  const canvas = getGameCanvas();
  return {
    ok: true,
    nodeId: getNodeId(node),
    nodeName: node.name || '(unnamed)',
    ...collectOverlayVisuals(node),
    canvasRect: canvas?.getBoundingClientRect() ?? null,
  };
};
