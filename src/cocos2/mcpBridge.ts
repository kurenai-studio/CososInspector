/**
 * Cocos Creator 2.x MCP 桥接（P2 子集）
 * 与 3.x 共用 window.__cocosInspectorApi / postMessage 协议
 */
import { uploadPngBase64ToShare } from '../cocos3/shareUpload';
import {
  getPauseState,
  pauseGame as pauseGameImpl,
  resumeGame as resumeGameImpl,
  togglePause as togglePauseImpl,
  type PauseState,
} from './gamePause';
import {
  exportSceneSnapshot,
  getSceneTreeLite,
  buildNodePath,
  type SceneSnapshot,
} from './sceneSnapshot';
import {
  findNodeById,
  getNodeActive,
  getNodeChildren,
  getNodeId,
  getNodeName,
  getSceneRoot,
  setNodeActive,
  type Cc2Node,
} from './sceneTree';
import {
  collectSpriteFrameMeta,
  extractSpriteFrame,
  nodeHasSprite,
} from './spriteExtract';

export interface Cc2SpriteListItem {
  id: string;
  name: string;
  path: string;
  frameName: string;
  enabled: boolean;
  active: boolean;
  searchText: string;
}

export interface Cc2SerializableSpriteDetail {
  nodeId: string;
  nodeName: string;
  frameName: string;
  enabled: boolean;
  type: string;
  sizeMode: string;
  textureSize: { w: number; h: number };
  frameRect: { x: number; y: number; w: number; h: number };
  displaySize: { w: number; h: number };
  offset: { x: number; y: number };
  originalSize: { w: number; h: number };
  isRotated: boolean;
  extractMethod: string;
  extractError: string | null;
  hasPixels: boolean;
  usedPath?: 'engine' | 'legacy';
}

export type TextureDownloadDelivery = 'share' | 'inline';

export type TextureDownloadResult =
  | {
      ok: true;
      delivery: 'share';
      sharePath: string;
      shareUrl: string;
      width: number;
      height: number;
      filename: string;
      detail: Cc2SerializableSpriteDetail;
    }
  | {
      ok: true;
      delivery: 'inline';
      base64: string;
      width: number;
      height: number;
      filename: string;
      detail: Cc2SerializableSpriteDetail;
    }
  | { ok: false; error: string };

/** MCP 侧期望的 PauseState 兼容字段 */
const toMcpPauseState = (): PauseState & {
  mode: 'director';
  gamePaused: boolean;
} => {
  const s = getPauseState();
  return {
    ...s,
    mode: 'director',
    gamePaused: s.paused,
  };
};

const collectSpriteList = (scene: Cc2Node): Cc2SpriteListItem[] => {
  const items: Cc2SpriteListItem[] = [];
  const walk = (node: Cc2Node): void => {
    if (nodeHasSprite(node)) {
      const id = getNodeId(node);
      const meta = collectSpriteFrameMeta(id);
      const path = buildNodePath(scene, id);
      const frameName = meta?.frameName ?? '(sprite)';
      const name = getNodeName(node);
      items.push({
        id,
        name,
        path,
        frameName,
        enabled: meta?.enabled ?? true,
        active: getNodeActive(node),
        searchText: `${name} ${path} ${frameName}`.toLowerCase(),
      });
    }
    for (const child of [...getNodeChildren(node)].sort((a, b) =>
      getNodeName(a).localeCompare(getNodeName(b))
    )) {
      walk(child);
    }
  };
  walk(scene);
  return items;
};

const detailFromExtract = (
  nodeId: string,
  nodeName: string,
  meta: NonNullable<ReturnType<typeof collectSpriteFrameMeta>>,
  hasPixels: boolean,
  method: string,
  extractError: string | null
): Cc2SerializableSpriteDetail => ({
  nodeId,
  nodeName,
  frameName: meta.frameName,
  enabled: meta.enabled,
  type: 'cc.Sprite',
  sizeMode: '',
  textureSize: meta.textureSize,
  frameRect: { ...meta.rect },
  displaySize: { w: meta.frameSize.w, h: meta.frameSize.h },
  offset: { x: 0, y: 0 },
  originalSize: { w: meta.frameSize.w, h: meta.frameSize.h },
  isRotated: meta.isRotated,
  extractMethod: method,
  extractError,
  hasPixels,
  usedPath: 'legacy',
});

async function buildTextureDownload(
  nodeId: string,
  options?: {
    delivery?: TextureDownloadDelivery;
    wsPort?: number;
  }
): Promise<TextureDownloadResult> {
  try {
    const extracted = await extractSpriteFrame(nodeId);
    if (!extracted) {
      return { ok: false, error: '节点无 Sprite 或纹理提取失败' };
    }
    const meta = collectSpriteFrameMeta(nodeId);
    if (!meta) return { ok: false, error: '节点无 Sprite 元数据' };

    let base64: string;
    try {
      const url = extracted.canvas.toDataURL('image/png');
      base64 = url.split(',')[1]!;
      if (!base64) return { ok: false, error: 'canvas.toDataURL 失败' };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const safe = (s: string) =>
      s.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_') || 'sprite';
    const filename = `${safe(extracted.nodeName)}_${safe(extracted.frameName)}.png`;
    const detail = detailFromExtract(
      nodeId,
      extracted.nodeName,
      meta,
      true,
      extracted.method,
      null
    );
    const delivery = options?.delivery ?? 'share';

    if (delivery === 'inline') {
      return {
        ok: true,
        delivery: 'inline',
        base64,
        width: extracted.canvas.width,
        height: extracted.canvas.height,
        filename,
        detail,
      };
    }

    const uploaded = await uploadPngBase64ToShare(
      base64,
      filename,
      options?.wsPort ?? 17373
    );
    if (!uploaded.ok) return { ok: false, error: uploaded.error };
    return {
      ok: true,
      delivery: 'share',
      sharePath: uploaded.sharePath,
      shareUrl: uploaded.shareUrl,
      width: extracted.canvas.width,
      height: extracted.canvas.height,
      filename,
      detail,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[MCP:2.x] downloadTexture(${nodeId}) 失败: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** 供 Chrome CDP / MCP 调用的 2.x 页面 API（P2 子集） */
export const cocosInspectorMcpApi2 = {
  version: 1 as const,
  engineFamily: '2' as const,

  getPageInfo(): {
    pageUrl: string;
    engineVersion: string;
    engineFamily: '2';
    sceneName: string;
    hasCocos: boolean;
    paused: boolean;
    pause: ReturnType<typeof toMcpPauseState>;
  } {
    const scene = getSceneRoot();
    const pause = toMcpPauseState();
    return {
      pageUrl: window.location.href,
      engineVersion: String(window.cc?.ENGINE_VERSION ?? '2.x'),
      engineFamily: '2',
      sceneName: scene ? getNodeName(scene) : '',
      hasCocos: !!window.cc,
      paused: pause.paused,
      pause,
    };
  },

  pauseGame(): { ok: true; state: PauseState } | { ok: false; error: string } {
    return pauseGameImpl();
  },

  resumeGame(): { ok: true; state: PauseState } | { ok: false; error: string } {
    return resumeGameImpl();
  },

  togglePause(): { ok: true; state: PauseState } | { ok: false; error: string } {
    return togglePauseImpl();
  },

  getPauseState(): ReturnType<typeof toMcpPauseState> {
    return toMcpPauseState();
  },

  setNodeActive(
    nodeId: string,
    active: boolean
  ): { ok: true } | { ok: false; error: string } {
    const scene = getSceneRoot();
    if (!scene) return { ok: false, error: '场景未就绪' };
    const node = findNodeById(scene, nodeId);
    if (!node) return { ok: false, error: `未找到节点 ${nodeId}` };
    if (node === scene) return { ok: false, error: '不能修改场景根节点 active' };
    const ok = setNodeActive(nodeId, active);
    if (!ok) return { ok: false, error: '设置 active 失败' };
    return { ok: true };
  },

  listSprites(): Cc2SpriteListItem[] {
    const scene = getSceneRoot();
    if (!scene) return [];
    return collectSpriteList(scene);
  },

  evalPage(expr: string): { ok: true; result: unknown } | { ok: false; error: string } {
    try {
      const fn = new Function(`return (${expr});`);
      return { ok: true, result: fn() };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },

  getSceneTree() {
    return getSceneTreeLite();
  },

  exportSceneSnapshot(options?: {
    maxNodes?: number;
    includeComponents?: boolean;
  }): SceneSnapshot | null {
    return exportSceneSnapshot(options);
  },

  async getSpriteDetail(
    nodeId: string
  ): Promise<
    | { ok: true; detail: Cc2SerializableSpriteDetail }
    | { ok: false; error: string }
  > {
    const meta = collectSpriteFrameMeta(nodeId);
    if (!meta) return { ok: false, error: '节点无 Sprite 或场景未就绪' };
    const scene = getSceneRoot();
    const node = scene ? findNodeById(scene, nodeId) : null;
    const nodeName = node ? getNodeName(node) : nodeId;
    try {
      const extracted = await extractSpriteFrame(nodeId);
      return {
        ok: true,
        detail: detailFromExtract(
          nodeId,
          nodeName,
          meta,
          !!extracted,
          extracted?.method ?? 'meta-only',
          extracted ? null : '像素提取失败'
        ),
      };
    } catch (e) {
      return {
        ok: true,
        detail: detailFromExtract(
          nodeId,
          nodeName,
          meta,
          false,
          'meta-only',
          e instanceof Error ? e.message : String(e)
        ),
      };
    }
  },

  async downloadTexture(
    nodeId: string,
    options?: {
      delivery?: TextureDownloadDelivery;
      wsPort?: number;
      path?: string;
      mode?: string;
      preferScreen?: boolean;
      allowScreenFallback?: boolean;
    }
  ): Promise<TextureDownloadResult> {
    return buildTextureDownload(nodeId, {
      delivery: options?.delivery,
      wsPort: options?.wsPort,
    });
  },

  /** 2.x 未实现：保持方法存在避免 MCP 报「未知 API」 */
  showNodeBounds(): { ok: false; error: string } {
    return { ok: false, error: '2.x 暂不支持节点画框' };
  },

  showNodeBoundsByPath(): { ok: false; error: string } {
    return { ok: false, error: '2.x 暂不支持节点画框' };
  },

  hideNodeBounds(): { ok: true } {
    return { ok: true };
  },

  listReplacements(): [] {
    return [];
  },

  async replaceTexture(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: '2.x 暂不支持纹理替换' };
  },

  async revertTexture(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: '2.x 暂不支持纹理还原' };
  },

  async exportReplacementPack(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: '2.x 暂不支持换皮包导出' };
  },

  async screenshot(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: '2.x 暂不支持截图 API' };
  },
};

export type CocosInspectorMcpApi2 = typeof cocosInspectorMcpApi2;

export function installMcpBridge(): void {
  const win = window as Window & {
    __cocosInspectorApi?: CocosInspectorMcpApi2;
  };
  win.__cocosInspectorApi = cocosInspectorMcpApi2;

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.data?.type !== 'cocos-api-call') return;
    const { requestId, method, args } = ev.data as {
      requestId: string;
      method: string;
      args: unknown[];
    };
    const api = win.__cocosInspectorApi;
    try {
      if (!api) {
        window.postMessage(
          {
            type: 'cocos-api-response',
            requestId,
            error: '__cocosInspectorApi 未就绪',
          },
          '*'
        );
        return;
      }
      const fn = api[method as keyof CocosInspectorMcpApi2];
      if (typeof fn !== 'function') {
        window.postMessage(
          {
            type: 'cocos-api-response',
            requestId,
            error: `未知 API: ${method}`,
          },
          '*'
        );
        return;
      }
      const result = await (
        fn as (...p: unknown[]) => Promise<unknown> | unknown
      ).apply(api, args ?? []);
      window.postMessage(
        { type: 'cocos-api-response', requestId, result },
        '*'
      );
    } catch (e) {
      window.postMessage(
        {
          type: 'cocos-api-response',
          requestId,
          error: e instanceof Error ? e.message : String(e),
        },
        '*'
      );
    }
  });

  console.log('[MCP桥接:2.x] __cocosInspectorApi 已安装（P2 子集）');
}
