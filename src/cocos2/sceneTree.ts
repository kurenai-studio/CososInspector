import type { TreeNodeInfo } from '../cocos3/sceneTree';

/** Creator 2.x 节点（运行时鸭子类型） */
export type Cc2Node = {
  uuid?: string;
  _id?: string;
  __instanceId?: number;
  name?: string;
  _name?: string;
  active?: boolean;
  _active?: boolean;
  children?: Cc2Node[];
  _children?: Cc2Node[];
  parent?: Cc2Node | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  anchorX?: number;
  anchorY?: number;
  angle?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  opacity?: number;
  color?: { r?: number; g?: number; b?: number; a?: number };
  _components?: unknown[];
  getComponents?: (type?: unknown) => unknown[];
  getComponent?: (type?: unknown) => unknown;
  getContentSize?: () => { width: number; height: number };
};

export function getNodeId(node: Cc2Node): string {
  if (node.uuid) return String(node.uuid);
  if (node._id) return String(node._id);
  if (node.__instanceId != null) return `i${node.__instanceId}`;
  return '';
}

export function getNodeName(node: Cc2Node): string {
  return node.name || node._name || '(unnamed)';
}

export function getNodeActive(node: Cc2Node): boolean {
  if (typeof node.active === 'boolean') return node.active;
  if (typeof node._active === 'boolean') return node._active;
  return true;
}

export function getNodeChildren(node: Cc2Node): Cc2Node[] {
  const list = node.children ?? node._children ?? [];
  return list.filter(Boolean) as Cc2Node[];
}

export function findNodeById(root: Cc2Node, id: string): Cc2Node | null {
  if (getNodeId(root) === id) return root;
  for (const child of getNodeChildren(root)) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

export function buildTreeInfo(root: Cc2Node): TreeNodeInfo {
  const children = [...getNodeChildren(root)]
    .sort((a, b) => getNodeName(a).localeCompare(getNodeName(b)))
    .map((child) => buildTreeInfo(child));

  return {
    id: getNodeId(root),
    name: getNodeName(root),
    active: getNodeActive(root),
    children,
  };
}

export function setNodeActive(nodeId: string, active: boolean): boolean {
  try {
    const scene = getSceneRoot();
    if (!scene) return false;
    const node = findNodeById(scene, nodeId);
    if (!node || node === scene) return false;
    node.active = active;
    return true;
  } catch (error) {
    console.error(
      `[Active编辑:2.x] setNodeActive 失败 nodeId=${nodeId} active=${active}`,
      error
    );
    return false;
  }
}

export function getSceneRoot(): Cc2Node | null {
  try {
    const scene = window.cc?.director?.getScene?.() as Cc2Node | null | undefined;
    return scene ?? null;
  } catch {
    return null;
  }
}

export { hashTree } from '../cocos3/sceneTree';
