import { collectNodeInspectorData } from './renderableInspector';
import { collectSpriteInspectData } from './spriteInspector';
import {
  buildNodePath,
  buildTreeInfo,
  getNodeId,
  getSceneRoot,
  type TreeNodeInfo,
} from './sceneTree';

export interface SceneSpriteFrameSnapshot {
  frameName: string;
  frameRect: { x: number; y: number; w: number; h: number };
  offset: { x: number; y: number };
  originalSize: { w: number; h: number };
  displaySize: { w: number; h: number };
  textureSize: { w: number; h: number };
  sizeMode: number;
  isRotated: boolean;
}

export interface SceneComponentSnapshot {
  typeName: string;
  shortName: string;
  enabled: boolean;
  rows: Array<{ label: string; value: string }>;
  flags: {
    isSprite: boolean;
    isSpine: boolean;
    isBmfont?: boolean;
    isCustom: boolean;
    spineIndex: number;
    bmfontIndex?: number;
  };
}

export interface SceneNodeSnapshot {
  id: string;
  name: string;
  active: boolean;
  path: string;
  transform: {
    position: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    euler: { x: number; y: number; z: number };
  };
  uiTransform?: {
    contentSize: { width: number; height: number };
    anchorPoint: { x: number; y: number };
  };
  /** Sprite 帧元数据（rect/offset/originalSize，供场景重建） */
  spriteFrame?: SceneSpriteFrameSnapshot;
  componentTypes: string[];
  components: SceneComponentSnapshot[];
  children: SceneNodeSnapshot[];
}

export interface SceneSnapshot {
  version: 1;
  exportedAt: string;
  pageUrl: string;
  engineVersion: string;
  /** 引擎大系：2.x / 3.x（可选，旧快照可能缺失） */
  engineFamily?: '2' | '3';
  /** Canvas 设计分辨率（2.x 优先从此字段读取） */
  designResolution?: { width: number; height: number };
  sceneName: string;
  stats: {
    nodeCount: number;
    spriteCount: number;
    spineCount: number;
    labelCount: number;
    truncated: boolean;
  };
  root: SceneNodeSnapshot;
}

export interface SceneSnapshotOptions {
  maxNodes?: number;
  includeComponents?: boolean;
}

const readVec3 = (v: unknown): { x: number; y: number; z: number } => {
  const o = v as { x?: number; y?: number; z?: number };
  return { x: o?.x ?? 0, y: o?.y ?? 0, z: o?.z ?? 0 };
};

const collectTransform = (node: cc.Node): SceneNodeSnapshot['transform'] => {
  const n = node as cc.Node & {
    position?: unknown;
    scale?: unknown;
    eulerAngles?: unknown;
    rotation?: unknown;
  };
  return {
    position: readVec3(n.position),
    scale: readVec3(n.scale),
    euler: readVec3(n.eulerAngles ?? n.rotation),
  };
};

const collectUiTransform = (
  node: cc.Node
): SceneNodeSnapshot['uiTransform'] | undefined => {
  const n = node as cc.Node & { _components?: unknown[] };
  const tryFromComp = (comp: unknown): SceneNodeSnapshot['uiTransform'] | undefined => {
    const rec = comp as {
      __classname__?: string;
      constructor?: { name?: string };
      contentSize?: { width?: number; height?: number };
      anchorPoint?: { x?: number; y?: number };
    };
    const typeName = rec.__classname__ ?? rec.constructor?.name ?? '';
    if (!/UITransform/.test(typeName)) return undefined;
    const w = rec.contentSize?.width ?? 0;
    const h = rec.contentSize?.height ?? 0;
    if (w <= 0 && h <= 0) return undefined;
    return {
      contentSize: { width: w, height: h },
      anchorPoint: {
        x: rec.anchorPoint?.x ?? 0.5,
        y: rec.anchorPoint?.y ?? 0.5,
      },
    };
  };

  if (Array.isArray(n._components)) {
    for (const comp of n._components) {
      const ui = tryFromComp(comp);
      if (ui) return ui;
    }
  }

  const UITransform = (window.cc as { UITransform?: unknown }).UITransform;
  if (UITransform && typeof node.getComponent === 'function') {
    try {
      const ui = node.getComponent(UITransform as never);
      return tryFromComp(ui);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const collectSpriteFrameSnapshot = (
  nodeId: string
): SceneSpriteFrameSnapshot | undefined => {
  try {
    const data = collectSpriteInspectData(nodeId);
    if (!data) return undefined;
    const sizeMode = parseInt(String(data.sizeMode ?? ''), 10);
    return {
      frameName: data.frameName,
      frameRect: { ...data.frameRect },
      offset: { ...data.offset },
      originalSize: { ...data.originalSize },
      displaySize: { ...data.displaySize },
      textureSize: { ...data.textureSize },
      sizeMode: Number.isFinite(sizeMode) ? sizeMode : 0,
      isRotated: data.isRotated,
    };
  } catch (e) {
    console.warn(
      `[sceneSnapshot] spriteFrame(${nodeId}) 采集失败`,
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
  node: cc.Node,
  sceneRoot: cc.Node,
  state: { count: number; maxNodes: number; includeComponents: boolean }
): SceneNodeSnapshot | null => {
  if (state.count >= state.maxNodes) return null;
  state.count += 1;

  const id = getNodeId(node);
  const inspector = state.includeComponents ? collectNodeInspectorData(id) : null;
  const components: SceneComponentSnapshot[] = (inspector?.components ?? []).map(
    (c) => ({
      typeName: c.typeName,
      shortName: c.shortName,
      enabled: c.enabled,
      rows: c.rows,
      flags: {
        isSprite: c.isSprite,
        isSpine: c.isSpine,
        isBmfont: c.isBmfont,
        isCustom: c.isCustom,
        spineIndex: c.spineIndex,
        bmfontIndex: c.bmfontIndex,
      },
    })
  );

  const hasSprite = components.some((c) => c.flags.isSprite);
  const spriteFrame =
    state.includeComponents && hasSprite
      ? collectSpriteFrameSnapshot(id)
      : undefined;

  const children: SceneNodeSnapshot[] = [];
  for (const child of node.children ?? []) {
    if (!child) continue;
    if (state.count >= state.maxNodes) break;
    const snap = buildNodeSnapshot(child, sceneRoot, state);
    if (snap) children.push(snap);
  }

  return {
    id,
    name: node.name || '(unnamed)',
    active: node.active !== false,
    path: buildNodePath(sceneRoot, id) || node.name || id,
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

  const statsBase = { nodeCount: 0, spriteCount: 0, spineCount: 0, labelCount: 0 };
  countStats(root, statsBase);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    engineVersion: String(window.cc?.ENGINE_VERSION ?? '3.x'),
    engineFamily: '3',
    sceneName: scene.name || 'Scene',
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
