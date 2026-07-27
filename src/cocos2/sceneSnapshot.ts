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

/** 根→目标路径（用 / 连接名称） */
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
  return parts.join('/');
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
      offset: { x: 0, y: 0 },
      originalSize: { w: meta.frameSize.w, h: meta.frameSize.h },
      displaySize: { w: meta.frameSize.w, h: meta.frameSize.h },
      textureSize: { ...meta.textureSize },
      sizeMode: 0,
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

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    engineVersion: String(window.cc?.ENGINE_VERSION ?? '2.x'),
    engineFamily: '2',
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
