/** 3.x 相机查找 + 世界/屏幕换算（UI 与 3D 场景相机分开） */

export type CamLike = {
  worldToScreen?: (
    pos: { x: number; y: number; z?: number },
    out?: { x: number; y: number; z: number }
  ) => { x: number; y: number; z: number };
  screenToWorld?: (
    pos: { x: number; y: number; z?: number },
    out?: { x: number; y: number; z: number }
  ) => { x: number; y: number; z: number };
  screenPointToRay?: (
    x: number,
    y: number,
    out?: unknown
  ) => {
    o?: { x: number; y: number; z: number };
    d?: { x: number; y: number; z: number };
    origin?: { x: number; y: number; z: number };
    direction?: { x: number; y: number; z: number };
  };
  camera?: { window?: { width?: number; height?: number } };
  _camera?: { window?: { width?: number; height?: number } };
  projection?: number;
  _projection?: number;
};

export type Ray3 = {
  origin: { x: number; y: number; z: number };
  dir: { x: number; y: number; z: number };
};

export const getGameCanvas = (): HTMLCanvasElement | null => {
  const ccg = window.cc as { game?: { canvas?: HTMLCanvasElement } };
  return (
    ccg.game?.canvas ??
    (document.getElementById('GameCanvas') as HTMLCanvasElement | null) ??
    document.querySelector('canvas')
  );
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

const listCameras = (): { node: cc.Node; cam: CamLike }[] => {
  const scene = (
    window.cc as { director?: { getScene?: () => cc.Node | null } }
  ).director?.getScene?.();
  if (!scene) return [];
  const found: { node: cc.Node; cam: CamLike }[] = [];
  const walk = (node: cc.Node): void => {
    const cam = getCameraOnNode(node);
    if (cam) found.push({ node, cam });
    for (const child of node.children ?? []) {
      if (child) walk(child);
    }
  };
  walk(scene);
  return found;
};

const scoreUiCamera = (node: cc.Node, cam: CamLike): number => {
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

const scoreSceneCamera = (node: cc.Node, cam: CamLike): number => {
  let score = 1;
  const name = (node.name || '').toLowerCase();
  const parent = (node.parent?.name || '').toLowerCase();
  if (name === 'uicamera') score -= 100;
  if (name.includes('ui') && name.includes('camera')) score -= 40;
  if (name === 'canvas' || parent === 'canvas') score -= 50;
  const proj = cam.projection ?? cam._projection;
  if (proj === 1) score += 60;
  if (proj === 0) score -= 20;
  if (name.includes('main')) score += 15;
  return score;
};

const pickMainCamera = (): CamLike | null => {
  const main = (
    window.cc as { Camera?: { main?: CamLike; mainCamera?: CamLike } }
  ).Camera;
  return main?.main ?? main?.mainCamera ?? null;
};

/** UI / ortho 相机（Canvas 上的 cc.Camera） */
export const findUICamera = (): CamLike | null => {
  const found = listCameras()
    .map((it) => ({ ...it, score: scoreUiCamera(it.node, it.cam) }))
    .sort((a, b) => b.score - a.score);
  return found[0]?.cam ?? pickMainCamera();
};

/** 3D / 透视相机；全是 UI 相机时返回 null */
export const findSceneCamera = (): CamLike | null => {
  const found = listCameras()
    .map((it) => ({ ...it, score: scoreSceneCamera(it.node, it.cam) }))
    .sort((a, b) => b.score - a.score);
  if (found[0] && found[0].score > 0) return found[0].cam;
  return null;
};

export const getCameraWindowSize = (cam: CamLike): { w: number; h: number } => {
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

export const getVec3Ctor = (): (new (
  x?: number,
  y?: number,
  z?: number
) => { x: number; y: number; z: number }) | null =>
  ((window.cc as Record<string, unknown>).Vec3 as new (
    x?: number,
    y?: number,
    z?: number
  ) => { x: number; y: number; z: number }) ?? null;

const projectWithCam = (
  cam: CamLike | null,
  x: number,
  y: number,
  z: number
): { x: number; y: number } | null => {
  const canvas = getGameCanvas();
  if (!canvas) return null;
  const cr = canvas.getBoundingClientRect();
  if (cr.width <= 0 || cr.height <= 0) return null;
  const Vec3 = getVec3Ctor();
  if (!cam?.worldToScreen || !Vec3) return null;
  const out = new Vec3();
  cam.worldToScreen(new Vec3(x, y, z), out);
  const win = getCameraWindowSize(cam);
  return {
    x: cr.left + (out.x / win.w) * cr.width,
    y: cr.top + (1 - out.y / win.h) * cr.height,
  };
};

export const worldPointToClient = (
  x: number,
  y: number,
  z = 0
): { x: number; y: number } | null => {
  const hit = projectWithCam(findUICamera(), x, y, z);
  if (hit) return hit;
  const canvas = getGameCanvas();
  if (!canvas) return null;
  const cr = canvas.getBoundingClientRect();
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

/** 3D 世界点 → CSS；无场景相机则 null */
export const worldPointToClient3d = (
  x: number,
  y: number,
  z: number
): { x: number; y: number } | null =>
  projectWithCam(findSceneCamera(), x, y, z);

/** 页面坐标 → UI 世界坐标 */
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

const normalize = (v: { x: number; y: number; z: number }): typeof v => {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-8) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
};

/** 页面坐标 → 3D 射线（场景相机，原点左下 window 像素） */
export const clientToRay = (
  clientX: number,
  clientY: number
): Ray3 | null => {
  const canvas = getGameCanvas();
  const cam = findSceneCamera();
  if (!canvas || !cam) return null;
  const cr = canvas.getBoundingClientRect();
  if (cr.width <= 0 || cr.height <= 0) return null;

  const u = (clientX - cr.left) / cr.width;
  const v = (clientY - cr.top) / cr.height;
  const win = getCameraWindowSize(cam);
  const sx = u * win.w;
  const sy = (1 - v) * win.h;

  try {
    if (typeof cam.screenPointToRay === 'function') {
      const ray = cam.screenPointToRay(sx, sy);
      const o = ray?.o ?? ray?.origin;
      const d = ray?.d ?? ray?.direction;
      if (o && d) {
        return {
          origin: { x: o.x, y: o.y, z: o.z },
          dir: normalize({ x: d.x, y: d.y, z: d.z }),
        };
      }
    }
  } catch {
    /* 试玩页可能裁掉 Ray */
  }

  const Vec3 = getVec3Ctor();
  if (!cam.screenToWorld || !Vec3) return null;
  const near = new Vec3();
  const far = new Vec3();
  cam.screenToWorld(new Vec3(sx, sy, 0), near);
  cam.screenToWorld(new Vec3(sx, sy, 1), far);
  return {
    origin: { x: near.x, y: near.y, z: near.z },
    dir: normalize({
      x: far.x - near.x,
      y: far.y - near.y,
      z: far.z - near.z,
    }),
  };
};
