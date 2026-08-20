/**
 * Egret 显示对象树：stage → $children 递归
 *
 * 约定与参考插件一致：
 *   - 子节点读内部数组 $children（2.x/5.x 通用）
 *   - 过滤其它检视工具注入的遮罩节点（$*INSPECT*MASK* 等），避免污染树
 */
import { getEgretStage, type EgretDisplayObject } from './runtime';
import type { TreeNodeInfo } from '../cocos3/sceneTree';

const idMap = new WeakMap<object, string>();
let idSeq = 0;

/** 其它检视插件注入的遮罩/辅助节点名（需从树中过滤） */
const OVERLAY_NAMES = new Set([
  '$H5_COPILOT_MASK',
  '$GAME_INSPECT_MASK',
  '$LarkMetricMask',
  '$EgretInspectMask',
  '$egretInspectMask',
  '$EGRET_INSPECT_MASK',
]);

function isOverlayNode(node: EgretDisplayObject): boolean {
  const name = node.name;
  if (!name || typeof name !== 'string') return false;
  if (OVERLAY_NAMES.has(name)) return true;
  if (!name.startsWith('$')) return false;
  const up = name.toUpperCase();
  return up.includes('INSPECT') && (up.includes('MASK') || up.includes('METRIC'));
}

export function getDisplayId(node: EgretDisplayObject): string {
  const key = node as object;
  let id = idMap.get(key);
  if (!id) {
    idSeq += 1;
    id = `egret-${idSeq}`;
    idMap.set(key, id);
  }
  return id;
}

export function getDisplayName(node: EgretDisplayObject): string {
  if (node.name) return String(node.name);
  const ctor = node.constructor?.name;
  return ctor && ctor !== 'Object' ? ctor : '(unnamed)';
}

export function getDisplayChildren(node: EgretDisplayObject): EgretDisplayObject[] {
  const kids = node.$children;
  if (!Array.isArray(kids)) return [];
  return kids.filter((c) => !!c && !isOverlayNode(c));
}

export function isDisplayVisible(node: EgretDisplayObject): boolean {
  return node.visible !== false;
}

export function findDisplayById(
  root: EgretDisplayObject,
  id: string
): EgretDisplayObject | null {
  if (getDisplayId(root) === id) return root;
  for (const child of getDisplayChildren(root)) {
    const hit = findDisplayById(child, id);
    if (hit) return hit;
  }
  return null;
}

/** 从舞台根到目标节点的名称路径，如 Stage › Main › btnStart */
export function buildNodePath(root: EgretDisplayObject, targetId: string): string {
  const names: string[] = [];
  const walk = (node: EgretDisplayObject): boolean => {
    names.push(getDisplayName(node));
    if (getDisplayId(node) === targetId) return true;
    for (const child of getDisplayChildren(node)) {
      if (walk(child)) return true;
    }
    names.pop();
    return false;
  };
  if (walk(root)) return names.join(' › ');
  return '';
}

function isBitmapLike(node: EgretDisplayObject): boolean {
  if (node.texture || node.$texture) return true;
  const n = node.constructor?.name || '';
  return /Bitmap|MovieClip/i.test(n);
}

function textureHint(node: EgretDisplayObject): string {
  const t = node.texture ?? node.$texture;
  if (!t) return 'texture';
  const w = t.$bitmapWidth ?? t.textureWidth ?? t.$textureWidth ?? 0;
  const h = t.$bitmapHeight ?? t.textureHeight ?? t.$textureHeight ?? 0;
  return w && h ? `${w}×${h}` : 'texture';
}

export function buildTreeInfo(
  root: EgretDisplayObject,
  expanded?: Set<string>,
  depth = 0
): TreeNodeInfo {
  const id = getDisplayId(root);
  const kids = getDisplayChildren(root);
  // 未展开：不递归整树（EUI 组件树节点可能很多）
  const shouldExpand = !expanded || depth === 0 || expanded.has(id);

  const children = shouldExpand
    ? kids
        .slice()
        .sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b)))
        .map((c) => buildTreeInfo(c, expanded, depth + 1))
    : kids.map((c) => ({
        id: getDisplayId(c),
        name: getDisplayName(c),
        active: isDisplayVisible(c),
        children: [] as TreeNodeInfo[],
        hasSprite: isBitmapLike(c),
      }));

  return {
    id,
    name: getDisplayName(root),
    active: isDisplayVisible(root),
    children,
    hasSprite: isBitmapLike(root),
    spriteHint: isBitmapLike(root) ? textureHint(root) : undefined,
  };
}

export function setNodeActive(nodeId: string, active: boolean): boolean {
  try {
    const root = getEgretStage();
    if (!root) return false;
    const node = findDisplayById(root, nodeId);
    if (!node || node === root) return false;
    node.visible = active;
    return true;
  } catch (e) {
    console.error(
      `[Egret Inspector] setNodeActive 失败 id=${nodeId} active=${active}`,
      e
    );
    return false;
  }
}

export function hashTree(node: TreeNodeInfo): string {
  const parts: string[] = [
    node.id,
    node.name,
    node.active ? '1' : '0',
    String(node.children.length),
  ];
  for (const child of node.children) parts.push(hashTree(child));
  return parts.join('|');
}

export function getSceneRoot(): EgretDisplayObject | null {
  return getEgretStage();
}

/** 通用遍历：对每个非遮罩节点回调；用于骨骼模块复用 */
export function walkDisplayTree(
  root: EgretDisplayObject,
  cb: (node: EgretDisplayObject) => void
): void {
  const visit = (node: EgretDisplayObject | null | undefined): void => {
    if (!node) return;
    cb(node);
    const kids = getDisplayChildren(node);
    for (const c of kids) visit(c);
  };
  visit(root);
}

/** 计算从 root 到 targetId 的节点 id 路径（不含 root 自身），用于自动展开 */
export function getPathToNode(
  root: EgretDisplayObject,
  targetId: string
): string[] | null {
  const path: string[] = [];
  const walk = (node: EgretDisplayObject): boolean => {
    if (getDisplayId(node) === targetId) return true;
    const kids = getDisplayChildren(node);
    for (const c of kids) {
      path.push(getDisplayId(c));
      if (walk(c)) return true;
      path.pop();
    }
    return false;
  };
  for (const c of getDisplayChildren(root)) {
    path.push(getDisplayId(c));
    if (walk(c)) return path;
    path.pop();
  }
  return null;
}

export function getSceneTreeLite(): {
  engineFamily: 'egret';
  rootId: string;
  rootName: string;
  tree: TreeNodeInfo | null;
  stageSize: { w: number; h: number };
} {
  const root = getEgretStage();
  return {
    engineFamily: 'egret',
    rootId: root ? getDisplayId(root) : '',
    rootName: root ? getDisplayName(root) : '',
    tree: root ? buildTreeInfo(root) : null,
    stageSize: {
      w: Number(root?.stageWidth ?? 0),
      h: Number(root?.stageHeight ?? 0),
    },
  };
}
