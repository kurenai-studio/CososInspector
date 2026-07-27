import {
  beginReplacementPackExport,
  exportReplacementPackZipData,
  exportReplacementPackToShare,
  readReplacementPackFile,
} from './replacementExport';
import { listReplacementPairs } from './replacementStore';
import {
  exportSceneSnapshot,
  getSceneTreeLite,
  type SceneSnapshot,
} from './sceneSnapshot';
import {
  getPauseState,
  pauseGame as pauseGameImpl,
  resumeGame as resumeGameImpl,
  togglePause as togglePauseImpl,
  type PauseMode,
  type PauseState,
} from './gamePause';
import { findNodeById, getSceneRoot, setNodeActive } from './sceneTree';
import {
  exportSpritePngBase64,
  type SpriteExportPath,
} from './spriteDownload';
import {
  collectSpriteInspectData,
  enrichSpriteInspectData,
  type SpriteInspectData,
} from './spriteInspector';
import { collectSpriteList, type SpriteListItem } from './spriteList';
import {
  replaceSpriteWithImageBase64,
  revertSpriteFrame,
} from './spriteReplace';
import {
  debugNodeBoundsByPath,
  hideNodeBoundsOverlay,
  showNodeBoundsByPath,
  showNodeBoundsOverlay,
} from './nodeBoundsOverlay';
import { uploadPngBase64ToShare } from './shareUpload';
import {
  clearTextureExtractLogs,
  getTextureExtractLogs,
  type TextureExtractLogEntry,
} from './textureExtractLog';
import { clearTexturePixelCache } from './textureExtract';
import { readVisibleSpriteFromScreen } from './textureWebGL';

export interface SerializableSpriteDetail {
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
  /** 实际导出使用的路径（engine 对齐 / legacy 图集裁切） */
  usedPath?: 'engine' | 'legacy';
  /** 引擎对齐路径的方法与错误（便于脚本诊断两路差异） */
  engineExtractMethod?: string;
  engineExtractError?: string | null;
  hasEnginePixels?: boolean;
}

function toDetail(
  nodeId: string,
  data: SpriteInspectData,
  usedPath?: 'engine' | 'legacy'
): SerializableSpriteDetail {
  return {
    nodeId,
    nodeName: data.nodeName,
    frameName: data.frameName,
    enabled: data.enabled,
    type: data.type,
    sizeMode: data.sizeMode,
    textureSize: data.textureSize,
    frameRect: data.frameRect,
    displaySize: data.displaySize,
    offset: data.offset,
    originalSize: data.originalSize,
    isRotated: data.isRotated,
    // 默认沿用 legacy 字段；导出时用 usedPath 覆写为实际方法
    extractMethod:
      usedPath === 'engine'
        ? data.engineExtractMethod || 'engine-trim'
        : data.extractMethod,
    extractError:
      usedPath === 'engine' ? data.engineExtractError : data.extractError,
    hasPixels: !!data.pixels,
    usedPath,
    engineExtractMethod: data.engineExtractMethod,
    engineExtractError: data.engineExtractError,
    hasEnginePixels: !!data.enginePixels,
  };
}

async function captureCanvasPng(
  canvas: HTMLCanvasElement
): Promise<
  | { ok: true; base64: string; width: number; height: number }
  | { ok: false; error: string }
> {
  try {
    const url = canvas.toDataURL('image/png');
    if (!url || url.length < 32) {
      return { ok: false, error: 'canvas.toDataURL 失败（需 preserveDrawingBuffer 或 WebGL 支持）' };
    }
    return {
      ok: true,
      base64: url.split(',')[1]!,
      width: canvas.width,
      height: canvas.height,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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
      detail: SerializableSpriteDetail;
    }
  | {
      ok: true;
      delivery: 'inline';
      base64: string;
      width: number;
      height: number;
      filename: string;
      detail: SerializableSpriteDetail;
    }
  | { ok: false; error: string };

async function buildTextureDownload(
  nodeId: string,
  options?: {
    delivery?: TextureDownloadDelivery;
    wsPort?: number;
    /** 导出路径：engine（引擎对齐，默认优先）/ legacy / auto */
    path?: SpriteExportPath;
  }
): Promise<TextureDownloadResult> {
  // 避免脏缓存（空 uuid 碰撞 / 旧错误 bake）污染本次导出
  clearTexturePixelCache();
  const base = collectSpriteInspectData(nodeId);
  if (!base) return { ok: false, error: '节点无 Sprite' };
  const requested = options?.path ?? 'auto';

  // 单路径只算所需，避免大图双回读卡顿/超时；auto 先只跑 engine，失败再补 legacy
  let enriched: SpriteInspectData;
  let png: ReturnType<typeof exportSpritePngBase64>;
  if (requested === 'legacy') {
    enriched = await enrichSpriteInspectData(base, nodeId, 'legacy');
    png = exportSpritePngBase64(enriched, { path: 'legacy' });
  } else if (requested === 'engine') {
    enriched = await enrichSpriteInspectData(base, nodeId, 'engine');
    png = exportSpritePngBase64(enriched, { path: 'engine' });
  } else {
    enriched = await enrichSpriteInspectData(base, nodeId, 'engine');
    png = exportSpritePngBase64(enriched, { path: 'engine' });
    if (!png.ok) {
      // engine 失败，补跑 legacy 兜底
      enriched = await enrichSpriteInspectData(base, nodeId, 'legacy');
      png = exportSpritePngBase64(enriched, { path: 'legacy' });
    }
  }
  if (!png.ok) return { ok: false, error: png.error };

  const delivery = options?.delivery ?? 'share';
  const detail = toDetail(nodeId, enriched, png.usedPath);

  if (delivery === 'inline') {
    return {
      ok: true,
      delivery: 'inline',
      base64: png.base64,
      width: png.width,
      height: png.height,
      filename: png.filename,
      detail,
    };
  }

  const uploaded = await uploadPngBase64ToShare(
    png.base64,
    png.filename,
    options?.wsPort ?? 17373
  );
  if (!uploaded.ok) {
    return { ok: false, error: uploaded.error };
  }

  return {
    ok: true,
    delivery: 'share',
    sharePath: uploaded.sharePath,
    shareUrl: uploaded.shareUrl,
    width: png.width,
    height: png.height,
    filename: png.filename,
    detail,
  };
}

/** 供 Chrome CDP / MCP 调用的页面 API */
export const cocosInspectorMcpApi = {
  version: 1 as const,

  getPageInfo(): {
    pageUrl: string;
    engineVersion: string;
    sceneName: string;
    hasCocos: boolean;
    paused: boolean;
    pause: PauseState;
  } {
    const scene = getSceneRoot();
    const pause = getPauseState();
    return {
      pageUrl: window.location.href,
      engineVersion: String(window.cc?.ENGINE_VERSION ?? '3.x'),
      sceneName: scene?.name ?? '',
      hasCocos: !!window.cc,
      paused: pause.paused,
      pause,
    };
  },

  pauseGame(
    mode?: PauseMode
  ): { ok: true; state: PauseState } | { ok: false; error: string } {
    return pauseGameImpl(mode ?? 'director');
  },

  resumeGame(): { ok: true; state: PauseState } | { ok: false; error: string } {
    return resumeGameImpl();
  },

  togglePause(
    mode?: PauseMode
  ): { ok: true; state: PauseState } | { ok: false; error: string } {
    return togglePauseImpl(mode);
  },

  getPauseState(): PauseState {
    return getPauseState();
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

  listSprites(): SpriteListItem[] {
    const scene = getSceneRoot();
    if (!scene) return [];
    return collectSpriteList(scene);
  },

  showNodeBounds(
    nodeId: string,
    options?: { showFrameInner?: boolean }
  ): { ok: true; nodeId: string; nodeName: string } | { ok: false; error: string } {
    return showNodeBoundsOverlay(nodeId, options);
  },

  showNodeBoundsByPath(
    pathSuffix: string,
    options?: { showFrameInner?: boolean }
  ):
    | { ok: true; nodeId: string; nodeName: string; path: string }
    | { ok: false; error: string } {
    return showNodeBoundsByPath(pathSuffix, options);
  },

  hideNodeBounds(): { ok: true } {
    return hideNodeBoundsOverlay();
  },

  debugNodeBounds(pathSuffix: string) {
    return debugNodeBoundsByPath(pathSuffix);
  },

  /** 开发用：在试玩页执行表达式（仅 MCP/脚本） */
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
    | { ok: true; detail: SerializableSpriteDetail }
    | { ok: false; error: string }
  > {
    const base = collectSpriteInspectData(nodeId);
    if (!base) return { ok: false, error: '节点无 Sprite 或场景未就绪' };
    const enriched = await enrichSpriteInspectData(base, nodeId);
    return { ok: true, detail: toDetail(nodeId, enriched) };
  },

  async downloadTexture(
    nodeId: string,
    options?: {
      delivery?: TextureDownloadDelivery;
      wsPort?: number;
      /** 导出路径：engine（引擎对齐，默认优先）/ legacy / auto */
      path?: SpriteExportPath;
      /** @deprecated 已回退 pre-trim 读纹理，忽略 mode/preferScreen */
      mode?: string;
      preferScreen?: boolean;
      allowScreenFallback?: boolean;
    }
  ): Promise<TextureDownloadResult> {
    return buildTextureDownload(nodeId, options);
  },

  getTextureExtractLogs(options?: {
    limit?: number;
    since?: number;
    nodeUUID?: string;
  }): { ok: true; logs: TextureExtractLogEntry[]; count: number } {
    const logs = getTextureExtractLogs(options);
    return { ok: true, logs, count: logs.length };
  },

  clearTextureExtractLogs(): { ok: true; cleared: number } {
    const { cleared } = clearTextureExtractLogs();
    return { ok: true, cleared };
  },

  clearTexturePixelCache(): { ok: true } {
    clearTexturePixelCache();
    return { ok: true };
  },

  async replaceTexture(
    nodeId: string,
    imageBase64: string,
    options?: { mime?: string; filename?: string }
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return replaceSpriteWithImageBase64(nodeId, imageBase64, options);
  },

  /**
   * 从桥接 HTTP 共享目录拉取图片再替换（WebSocket 只传相对路径，如 in/xxx.png）
   */
  async replaceTextureFromShare(
    nodeId: string,
    shareRelPath: string,
    options?: {
      mime?: string;
      filename?: string;
      /** 默认 http://127.0.0.1:17374 */
      shareBaseUrl?: string;
    }
  ): Promise<
    | { ok: true; sharePath: string; shareUrl: string }
    | { ok: false; error: string }
  > {
    const base = (options?.shareBaseUrl ?? 'http://127.0.0.1:17374').replace(
      /\/$/,
      ''
    );
    const rel = shareRelPath.replace(/^\//, '');
    const url = `${base}/${rel}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return { ok: false, error: `拉取共享文件失败 ${res.status}: ${url}` };
      }
      const blob = await res.blob();
      const mime = options?.mime ?? blob.type ?? 'image/png';
      const filename =
        options?.filename ?? rel.split('/').pop() ?? 'share-upload.png';
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      const b64 = btoa(bin);
      const applied = await replaceSpriteWithImageBase64(nodeId, b64, {
        mime,
        filename,
      });
      if (!applied.ok) return applied;
      return { ok: true, sharePath: rel, shareUrl: url };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },

  revertTexture(
    nodeId: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return revertSpriteFrame(nodeId);
  },

  async listReplacements(): Promise<
    Array<{
      id: string;
      nodeId: string;
      nodeName: string;
      nodePath: string;
      frameName: string;
      fileName: string;
      width: number;
      height: number;
    }>
  > {
    const pairs = await listReplacementPairs();
    return pairs.map((p) => ({
      id: p.id,
      nodeId: p.nodeId,
      nodeName: p.nodeName,
      nodePath: p.nodePath,
      frameName: p.original.frameName,
      fileName: p.replacement.fileName,
      width: p.replacement.width,
      height: p.replacement.height,
    }));
  },

  /** 替换包 zip（base64），结构同面板「导出 zip」 */
  exportReplacementPack() {
    return exportReplacementPackZipData();
  },

  /** @deprecated 请用 exportReplacementPack（zip） */
  exportReplacementPackLegacy() {
    return exportReplacementPackZipData();
  },

  beginReplacementPackExport() {
    return beginReplacementPackExport();
  },

  readReplacementPackFile(relativePath: string) {
    return readReplacementPackFile(relativePath);
  },

  exportReplacementPackToShare(shareBaseUrl?: string) {
    return exportReplacementPackToShare(shareBaseUrl);
  },

  /** 游戏主 Canvas 截图（整屏游戏区） */
  async captureGameScreenshot(): Promise<
    | { ok: true; base64: string; width: number; height: number; kind: 'game-canvas' }
    | { ok: false; error: string }
  > {
    const ccg = window.cc as { game?: { canvas?: HTMLCanvasElement } };
    const canvas =
      ccg.game?.canvas ??
      (document.getElementById('GameCanvas') as HTMLCanvasElement | null);
    if (!canvas) return { ok: false, error: '未找到 GameCanvas' };
    const shot = await captureCanvasPng(canvas);
    if (!shot.ok) return shot;
    return { ...shot, kind: 'game-canvas' };
  },

  /** 节点在世界空间的可视区域（优先 GPU 读屏，适合单控件） */
  async captureNodeScreenshot(
    nodeId: string,
    maxSize = 512
  ): Promise<
    | {
        ok: true;
        base64: string;
        width: number;
        height: number;
        kind: 'node-screen';
      }
    | { ok: false; error: string }
  > {
    const scene = getSceneRoot();
    if (!scene) return { ok: false, error: '场景未就绪' };
    const node = findNodeById(scene, nodeId);
    if (!node) return { ok: false, error: '节点不存在' };

    const inspect = collectSpriteInspectData(nodeId);
    const w = Math.min(maxSize, inspect?.displaySize.w ?? maxSize);
    const h = Math.min(maxSize, inspect?.displaySize.h ?? maxSize);
    const pixels = readVisibleSpriteFromScreen(node, w, h);
    if (!pixels) {
      return {
        ok: false,
        error: '节点截屏失败（可能被遮挡或不在可视区域）',
      };
    }

    const c = document.createElement('canvas');
    c.width = pixels.width;
    c.height = pixels.height;
    c.getContext('2d')!.putImageData(pixels, 0, 0);
    const url = c.toDataURL('image/png');
    return {
      ok: true,
      base64: url.split(',')[1]!,
      width: pixels.width,
      height: pixels.height,
      kind: 'node-screen',
    };
  },
};

export type CocosInspectorMcpApi = typeof cocosInspectorMcpApi;

export function installMcpBridge(): void {
  const win = window as Window & { __cocosInspectorApi?: CocosInspectorMcpApi };
  win.__cocosInspectorApi = cocosInspectorMcpApi;

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
      const fn = api[method as keyof CocosInspectorMcpApi];
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
}
