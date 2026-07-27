/**
 * Cocos Creator 2.x 场景快照（字段对齐 3.x SceneSnapshot，供 MCP / 复刻）
 */
import { collectNodeInspectorData } from './nodeInspector';
import {
  getNodeActive,
  getNodeChildren,
  getNodeId,
  getNodeName,
  getSceneRoot,
  buildTreeInfo,
  type Cc2Node,
} from './sceneTree';
import {
  collectSpriteFrameMeta,
  nodeHasSprite,
} from './spriteExtract';
import type {
  SceneComponentSnapshot,
  SceneNodeSnapshot,
  SceneSnapshot,
  SceneSnapshotOptions,
  SceneSpriteFrameSnapshot,
} from '../cocos3/sceneSnapshot';
import type { TreeNodeInfo } from '../cocos3/sceneTree';

export type { SceneSnapshot, SceneSnapshotOptions };

/** 根→目标路径（与 3.x / 磁盘补丁一致，用 › 连接） */
export const buildNodePath = (root: Cc2Node, targetId: string): string => {
  const parts: string[] = [];
  const walk = (node: Cc2Node, acc: string[]): boolean => {
    const id = getNodeId(node);
    const next = [...acc, getNodeName(node)];
    if (id === targetId) {
      parts.push(...next);
      return true;
    }
    for (const child of getNodeChildren(node)) {
      if (walk(child, next)) return true;
    }
    return false;
  };
  walk(root, []);
  return parts.join(' › ');
};

const collectTransform = (node: Cc2Node): SceneNodeSnapshot['transform'] => ({
  position: { x: node.x ?? 0, y: node.y ?? 0, z: 0 },
  scale: { x: node.scaleX ?? 1, y: node.scaleY ?? 1, z: 1 },
  euler: {
    x: 0,
    y: 0,
    z: typeof node.angle === 'number' ? node.angle : (node.rotation ?? 0),
  },
});

const collectUiTransform = (
  node: Cc2Node
): SceneNodeSnapshot['uiTransform'] | undefined => {
  let width = node.width ?? 0;
  let height = node.height ?? 0;
  try {
    if (typeof node.getContentSize === 'function') {
      const s = node.getContentSize();
      width = s.width;
      height = s.height;
    }
  } catch {
    /* ignore */
  }
  if (width <= 0 && height <= 0) return undefined;
  return {
    contentSize: { width, height },
    anchorPoint: {
      x: node.anchorX ?? 0.5,
      y: node.anchorY ?? 0.5,
    },
  };
};

const collectSpriteFrameSnapshot = (
  nodeId: string
): SceneSpriteFrameSnapshot | undefined => {
  try {
    const meta = collectSpriteFrameMeta(nodeId);
    if (!meta) return undefined;
    return {
      frameName: meta.frameName,
      frameRect: { ...meta.rect },
      offset: { ...meta.offset },
      originalSize: { w: meta.originalSize.w, h: meta.originalSize.h },
      displaySize: { w: meta.frameSize.w, h: meta.frameSize.h },
      textureSize: { ...meta.textureSize },
      sizeMode: meta.sizeMode,
      isRotated: meta.isRotated,
    };
  } catch (e) {
    console.warn(
      `[sceneSnapshot:2.x] spriteFrame(${nodeId}) 采集失败`,
      e instanceof Error ? e.message : e
    );
    return undefined;
  }
};

/** 从场景中找 Canvas 的 designResolution（2.x） */
const collectDesignResolution = (
  root: Cc2Node
): { width: number; height: number } | undefined => {
  const readFromComp = (
    comp: unknown
  ): { width: number; height: number } | undefined => {
    const c = comp as {
      __classname__?: string;
      constructor?: { name?: string };
      designResolution?: { width?: number; height?: number };
      _designResolution?: { width?: number; height?: number };
    };
    const cn = c.__classname__ ?? c.constructor?.name ?? '';
    if (!/Canvas/i.test(cn)) return undefined;
    const dr = c.designResolution ?? c._designResolution;
    const w = dr?.width ?? 0;
    const h = dr?.height ?? 0;
    if (w > 0 && h > 0) return { width: w, height: h };
    return undefined;
  };

  const walk = (node: Cc2Node): { width: number; height: number } | undefined => {
    for (const comp of node._components ?? []) {
      const hit = readFromComp(comp);
      if (hit) return hit;
    }
    try {
      const Canvas = (window.cc as { Canvas?: unknown } | undefined)?.Canvas;
      if (Canvas && typeof node.getComponent === 'function') {
        const hit = readFromComp(node.getComponent(Canvas));
        if (hit) return hit;
      }
    } catch {
      /* ignore */
    }
    for (const child of getNodeChildren(node)) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root);
};

const countStats = (
  node: SceneNodeSnapshot,
  acc: Omit<SceneSnapshot['stats'], 'truncated'>
): void => {
  acc.nodeCount += 1;
  for (const c of node.components) {
    if (c.flags.isSprite) acc.spriteCount += 1;
    if (c.flags.isSpine) acc.spineCount += 1;
    if (/Label/.test(c.typeName)) acc.labelCount += 1;
  }
  node.children.forEach((ch) => countStats(ch, acc));
};

const buildNodeSnapshot = (
  node: Cc2Node,
  sceneRoot: Cc2Node,
  state: { count: number; maxNodes: number; includeComponents: boolean }
): SceneNodeSnapshot | null => {
  if (state.count >= state.maxNodes) return null;
  state.count += 1;

  const id = getNodeId(node);
  const inspector = state.includeComponents
    ? collectNodeInspectorData(id)
    : null;
  const components: SceneComponentSnapshot[] = (inspector?.components ?? []).map(
    (c) => ({
      typeName: c.typeName,
      shortName: c.shortName,
      enabled: c.enabled,
      rows: c.rows,
      flags: {
        isSprite: c.isSprite,
        isSpine: /Spine|Skeleton/i.test(c.typeName),
        isCustom: !c.typeName.startsWith('cc.'),
        spineIndex: 0,
      },
    })
  );

  const hasSprite =
    components.some((c) => c.flags.isSprite) || nodeHasSprite(node);
  const spriteFrame =
    state.includeComponents && hasSprite
      ? collectSpriteFrameSnapshot(id)
      : undefined;

  const children: SceneNodeSnapshot[] = [];
  for (const child of getNodeChildren(node)) {
    if (state.count >= state.maxNodes) break;
    const snap = buildNodeSnapshot(child, sceneRoot, state);
    if (snap) children.push(snap);
  }

  return {
    id,
    name: getNodeName(node),
    active: getNodeActive(node),
    path: buildNodePath(sceneRoot, id) || getNodeName(node) || id,
    transform: collectTransform(node),
    uiTransform: collectUiTransform(node),
    spriteFrame,
    componentTypes: components.map((c) => c.typeName),
    components,
    children,
  };
};

export const exportSceneSnapshot = (
  options: SceneSnapshotOptions = {}
): SceneSnapshot | null => {
  const scene = getSceneRoot();
  if (!scene) return null;

  const maxNodes = options.maxNodes ?? 3000;
  const includeComponents = options.includeComponents !== false;
  const state = { count: 0, maxNodes, includeComponents };

  const root = buildNodeSnapshot(scene, scene, state);
  if (!root) return null;

  const statsBase = {
    nodeCount: 0,
    spriteCount: 0,
    spineCount: 0,
    labelCount: 0,
  };
  countStats(root, statsBase);
  const designResolution = collectDesignResolution(scene);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    engineVersion: String(window.cc?.ENGINE_VERSION ?? '2.x'),
    engineFamily: '2',
    designResolution,
    sceneName: getNodeName(scene) || 'Scene',
    stats: {
      ...statsBase,
      truncated: state.count >= maxNodes,
    },
    root,
  };
};

export const getSceneTreeLite = (): TreeNodeInfo | null => {
  const scene = getSceneRoot();
  if (!scene) return null;
  return buildTreeInfo(scene);
};
