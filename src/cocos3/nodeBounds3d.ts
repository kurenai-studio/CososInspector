/**
 * Cocos 3.x Mesh AABB：线框高亮 + 射线拾取
 * 试玩页若裁掉 geometry，用 slab 求交，不依赖 cc.geometry
 */
import { clientToRay, worldPointToClient3d } from './cameraProject';

export type MeshOverlayBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  label: string;
};

export type OverlayEdge = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  label?: string;
};

export type Aabb3 = {
  center: { x: number; y: number; z: number };
  half: { x: number; y: number; z: number };
};

type MeshLike = {
  model?: {
    worldBounds?: AabbRaw;
    worldBound?: AabbRaw;
  };
  _model?: { worldBounds?: AabbRaw };
  enabled?: boolean;
};

type AabbRaw = {
  center?: { x?: number; y?: number; z?: number };
  halfExtents?: { x?: number; y?: number; z?: number };
  halfExtent?: { x?: number; y?: number; z?: number };
};

const MESH_NAME = /^(cc\.)?(Skinned)?MeshRenderer$/;

const classNameOf = (c: unknown): string => {
  const rec = c as {
    __classname__?: string;
    constructor?: { name?: string };
  };
  return rec.__classname__ ?? rec.constructor?.name ?? '';
};

const getMeshRenderer = (node: cc.Node): MeshLike | null => {
  const ccg = window.cc as {
    MeshRenderer?: unknown;
    SkinnedMeshRenderer?: unknown;
  };
  if (typeof node.getComponent === 'function') {
    for (const Ctor of [ccg.MeshRenderer, ccg.SkinnedMeshRenderer]) {
      if (!Ctor) continue;
      try {
        const hit = node.getComponent(Ctor as never);
        if (hit) return hit as MeshLike;
      } catch {
        /* 试玩页可能无导出 */
      }
    }
  }
  const comps =
    (node as cc.Node & { _components?: unknown[] })._components ?? [];
  return (
    (comps.find((c) => MESH_NAME.test(classNameOf(c))) as MeshLike | undefined) ??
    null
  );
};

export const nodeHasMesh = (node: cc.Node): boolean => !!getMeshRenderer(node);

export const getMeshWorldAabb = (node: cc.Node): Aabb3 | null => {
  try {
    const mr = getMeshRenderer(node);
    if (!mr || mr.enabled === false) return null;
    const raw =
      mr.model?.worldBounds ?? mr.model?.worldBound ?? mr._model?.worldBounds;
    const c = raw?.center;
    const h = raw?.halfExtents ?? raw?.halfExtent;
    if (!c || !h) return null;
    const hx = Number(h.x ?? 0);
    const hy = Number(h.y ?? 0);
    const hz = Number(h.z ?? 0);
    if (hx <= 0 && hy <= 0 && hz <= 0) return null;
    return {
      center: { x: Number(c.x ?? 0), y: Number(c.y ?? 0), z: Number(c.z ?? 0) },
      half: { x: hx, y: hy, z: hz },
    };
  } catch (error) {
    const id = (node as { uuid?: string }).uuid ?? '';
    console.warn(
      `[3D包围盒] ${node.name || '(unnamed)'}(${id}) 读取失败`,
      error
    );
    return null;
  }
};

const aabbCorners = (box: Aabb3): { x: number; y: number; z: number }[] => {
  const { center: c, half: h } = box;
  const out: { x: number; y: number; z: number }[] = [];
  for (const sz of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        out.push({
          x: c.x + sx * h.x,
          y: c.y + sy * h.y,
          z: c.z + sz * h.z,
        });
      }
    }
  }
  return out;
};

const AABB_EDGES: [number, number][] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

const MESH_COLOR = '#40c4ff';

export const collectMeshOverlay = (
  node: cc.Node
): { boxes: MeshOverlayBox[]; edges: OverlayEdge[] } => {
  const boxes: BoundsOverlayBox[] = [];
  const edges: OverlayEdge[] = [];
  const aabb = getMeshWorldAabb(node);
  if (!aabb) return { boxes, edges };

  const corners = aabbCorners(aabb);
  const label =
    `AABB ${aabb.half.x * 2 | 0}×${aabb.half.y * 2 | 0}×` +
    `${aabb.half.z * 2 | 0}`;
  for (const [a, b] of AABB_EDGES) {
    const p1 = worldPointToClient3d(corners[a].x, corners[a].y, corners[a].z);
    const p2 = worldPointToClient3d(corners[b].x, corners[b].y, corners[b].z);
    if (!p1 || !p2) continue;
    edges.push({
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      color: MESH_COLOR,
      label: edges.length === 0 ? label : undefined,
    });
  }
  return { boxes, edges };
};

/** 射线 vs AABB（slab），命中返回 t>=0 */
export const rayAabbT = (
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  box: Aabb3
): number | null => {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes = ['x', 'y', 'z'] as const;
  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    const min = box.center[axis] - box.half[axis];
    const max = box.center[axis] + box.half[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < min || o > max) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min - o) * inv;
    let t2 = (max - o) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
};

export type MeshHit = { node: cc.Node; t: number };

const isNodeVisible = (node: cc.Node): boolean => {
  const hier = (node as { activeInHierarchy?: boolean }).activeInHierarchy;
  if (hier === false) return false;
  return node.active !== false;
};

const collectMeshHits = (
  node: cc.Node,
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  hits: MeshHit[]
): void => {
  if (!isNodeVisible(node)) return;
  const box = getMeshWorldAabb(node);
  if (box) {
    const t = rayAabbT(origin, dir, box);
    if (t != null) hits.push({ node, t });
  }
  for (const child of node.children ?? []) {
    if (child) collectMeshHits(child, origin, dir, hits);
  }
};

/** 页面点击 → 最近的 Mesh 节点 */
export const pickMeshNode = (
  root: cc.Node,
  clientX: number,
  clientY: number
): MeshHit | null => {
  const ray = clientToRay(clientX, clientY);
  if (!ray) return null;
  const hits: MeshHit[] = [];
  collectMeshHits(root, ray.origin, ray.dir, hits);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.t - b.t);
  return hits[0];
};
