import {
  findPixiApplication,
  getPixiStage,
  type PixiDisplayObject,
} from './runtime';
import type { TreeNodeInfo } from '../cocos3/sceneTree';

const idMap = new WeakMap<object, string>();
let idSeq = 0;

export function getDisplayId(node: PixiDisplayObject): string {
  const key = node as object;
  let id = idMap.get(key);
  if (!id) {
    idSeq += 1;
    id = `pixi-${idSeq}`;
    idMap.set(key, id);
  }
  return id;
}

export function getDisplayName(node: PixiDisplayObject): string {
  if (node.name) return String(node.name);
  const ctor = node.constructor?.name;
  return ctor && ctor !== 'Object' ? ctor : '(unnamed)';
}

export function getDisplayChildren(node: PixiDisplayObject): PixiDisplayObject[] {
  const kids = node.children;
  if (!Array.isArray(kids)) return [];
  return kids.filter(Boolean) as PixiDisplayObject[];
}

export function isDisplayVisible(node: PixiDisplayObject): boolean {
  return node.visible !== false;
}

export function findDisplayById(
  root: PixiDisplayObject,
  id: string
): PixiDisplayObject | null {
  if (getDisplayId(root) === id) return root;
  for (const child of getDisplayChildren(root)) {
    const hit = findDisplayById(child, id);
    if (hit) return hit;
  }
  return null;
}

export function buildNodePath(root: PixiDisplayObject, targetId: string): string {
  const names: string[] = [];
  const walk = (node: PixiDisplayObject): boolean => {
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

function isSpriteLike(node: PixiDisplayObject): boolean {
  if (node.texture) return true;
  const n = node.constructor?.name || '';
  return /Sprite|AnimatedSprite|Mesh|TilingSprite|NineSlice/i.test(n);
}

export function buildTreeInfo(
  root: PixiDisplayObject,
  expanded?: Set<string>,
  depth = 0
): TreeNodeInfo {
  const id = getDisplayId(root);
  const kids = getDisplayChildren(root);
  // 未展开：不递归整树（SlotMill 节点极多）
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
        hasSprite: isSpriteLike(c),
      }));

  return {
    id,
    name: getDisplayName(root),
    active: isDisplayVisible(root),
    children,
    hasSprite: isSpriteLike(root),
    spriteHint: isSpriteLike(root) ? textureHint(root) : undefined,
  };
}

function textureHint(node: PixiDisplayObject): string {
  const t = node.texture;
  const id =
    t?.label ||
    t?.textureCacheIds?.[0] ||
    t?.baseTexture?.label ||
    t?.baseTexture?.textureCacheIds?.[0] ||
    t?.baseTexture?.resource?.url ||
    t?.baseTexture?.resource?.src ||
    '';
  const w = t?.width ?? t?.baseTexture?.width;
  const h = t?.height ?? t?.baseTexture?.height;
  if (id && w && h) return `${id} ${w}×${h}`;
  if (w && h) return `${w}×${h}`;
  return id || 'texture';
}

export function setNodeActive(nodeId: string, active: boolean): boolean {
  try {
    const root = getPixiStage();
    if (!root) return false;
    const node = findDisplayById(root, nodeId);
    if (!node || node === root) return false;
    node.visible = active;
    return true;
  } catch (e) {
    console.error(
      `[Pixi Inspector] setNodeActive 失败 id=${nodeId} active=${active}`,
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

export function getSceneRoot(): PixiDisplayObject | null {
  return getPixiStage();
}

export function getSceneTreeLite(): {
  engineFamily: 'pixi';
  rootId: string;
  rootName: string;
  tree: TreeNodeInfo | null;
  appFound: boolean;
} {
  const app = findPixiApplication();
  const root = getPixiStage();
  return {
    engineFamily: 'pixi',
    rootId: root ? getDisplayId(root) : '',
    rootName: root ? getDisplayName(root) : '',
    tree: root ? buildTreeInfo(root) : null,
    appFound: !!app,
  };
}
