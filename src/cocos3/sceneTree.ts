export interface TreeNodeInfo {
  id: string;
  name: string;
  active: boolean;
  children: TreeNodeInfo[];
  /** 是否挂载 Sprite */
  hasSprite?: boolean;
  /** Sprite 贴图/状态摘要 */
  spriteHint?: string;
}

export function getNodeId(node: cc.Node): string {
  return node.uuid || (node as { _id?: string })._id || '';
}

export function findNodeById(root: cc.Node, id: string): cc.Node | null {
  if (getNodeId(root) === id) return root;
  for (const child of root.children ?? []) {
    if (!child) continue;
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

/** 从 root 到 targetId 的节点 id 路径（含目标，不含 root），用于自动展开 */
export function getPathToNode(root: cc.Node, targetId: string): string[] | null {
  if (getNodeId(root) === targetId) return [];
  const path: string[] = [];
  const walk = (node: cc.Node): boolean => {
    if (getNodeId(node) === targetId) return true;
    for (const child of node.children ?? []) {
      if (!child) continue;
      path.push(getNodeId(child));
      if (walk(child)) return true;
      path.pop();
    }
    return false;
  };
  for (const child of root.children ?? []) {
    if (!child) continue;
    path.push(getNodeId(child));
    if (walk(child)) return path;
    path.pop();
  }
  return null;
}

/** 从场景根到目标节点的名称路径，如 Canvas › UI › btn */
export function buildNodePath(root: cc.Node, targetId: string): string {
  const names: string[] = [];
  const walk = (node: cc.Node): boolean => {
    names.push(node.name || '(unnamed)');
    if (getNodeId(node) === targetId) return true;
    for (const child of node.children ?? []) {
      if (!child) continue;
      if (walk(child)) return true;
    }
    names.pop();
    return false;
  };
  if (walk(root)) return names.join(' › ');
  return '';
}

export function buildTreeInfo(root: cc.Node): TreeNodeInfo {
  const children = [...(root.children ?? [])]
    .filter(Boolean)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((child) => buildTreeInfo(child));

  return {
    id: getNodeId(root),
    name: root.name || '(unnamed)',
    active: root.active !== false,
    children,
  };
}

/** 切换节点 active（场景根不可改） */
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
      `[Active编辑] setNodeActive 失败 nodeId=${nodeId} active=${active}`,
      error
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

  for (const child of node.children) {
    parts.push(hashTree(child));
  }

  return parts.join('|');
}

export function getSceneRoot(): cc.Node | null {
  return window.cc?.director?.getScene?.() ?? null;
}
