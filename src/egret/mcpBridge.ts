/**
 * Egret MCP 桥接（MVP）
 * 与 Cocos 共用 window.__cocosInspectorApi / postMessage 协议
 *
 * 核心方法对齐 MCP server（tools/mcp-cocos-inspector/index.mjs）：
 *   getPageInfo / 暂停四件 / setNodeActive / listSprites / getSceneTree /
 *   downloadTexture / listResources / downloadResource /
 *   captureGameScreenshot / evalPage
 */
import {
  getPauseState,
  pauseGame as pauseGameImpl,
  resumeGame as resumeGameImpl,
  togglePause as togglePauseImpl,
  type PauseState,
} from './gamePause';
import {
  findDisplayById,
  getDisplayName,
  getSceneRoot,
  getSceneTreeLite,
  setNodeActive,
} from './sceneTree';
import { collectSpriteList } from './sprites';
import {
  extractNodeTextureToPng,
  extractWholeSourceToPng,
  getTextureSourceUrl,
  getNodeTexture,
} from './textureExtract';
import {
  collectResourceList,
  downloadResource,
  resolveResourceUrl as resolveResourceUrlPublic,
  type EgretResourceDownload,
  type EgretResourceList,
} from './resources';
import { getEgretCanvas, getEgretVersion } from './runtime';
import type { EgretDisplayObject } from './runtime';
import { listDragonBones, exportDragonBones } from './dragonBonesExport';
import { listSpines, exportSpine } from './spineExport';
import { exportSceneAssets } from './sceneAssetsExport';
import type { SkeletonExportResult } from './skeletonCommon';

export type EgretTextureDownloadResult =
  | {
      ok: true;
      delivery: 'inline';
      base64: string;
      width: number;
      height: number;
      filename: string;
      detail: { extractMethod: string; sourceUrl?: string | null };
    }
  | { ok: false; error: string };

function canvasToPngBase64(
  canvas: HTMLCanvasElement
): { ok: true; base64: string; width: number; height: number } | { ok: false; error: string } {
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    return {
      ok: true,
      base64,
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

/** 在显示列表中查找第一个纹理源 URL 等于指定值的节点 */
function findNodeBySourceUrl(
  root: EgretDisplayObject,
  url: string
): EgretDisplayObject | null {
  const walk = (node: EgretDisplayObject): EgretDisplayObject | null => {
    const u = getTextureSourceUrl(getNodeTexture(node));
    if (u && u === url) return node;
    const kids = node.$children;
    if (Array.isArray(kids)) {
      for (const c of kids) {
        if (c) {
          const hit = walk(c);
          if (hit) return hit;
        }
      }
    }
    return null;
  };
  return walk(root);
}

export const egretInspectorMcpApi = {
  version: 1 as const,
  engineFamily: 'egret' as const,

  getPageInfo(): {
    pageUrl: string;
    engineVersion: string;
    engineFamily: 'egret';
    sceneName: string;
    hasCocos: boolean;
    hasEgret: boolean;
    paused: boolean;
    pause: PauseState;
  } {
    const root = getSceneRoot();
    const pause = getPauseState();
    return {
      pageUrl: window.location.href,
      engineVersion: getEgretVersion(),
      engineFamily: 'egret',
      sceneName: root ? getDisplayName(root) : '',
      hasCocos: false,
      hasEgret: !!window.egret,
      paused: pause.paused,
      pause,
    };
  },

  pauseGame() {
    return pauseGameImpl();
  },

  resumeGame() {
    return resumeGameImpl();
  },

  togglePause() {
    return togglePauseImpl();
  },

  getPauseState(): PauseState {
    return getPauseState();
  },

  setNodeActive(
    nodeId: string,
    active: boolean
  ): { ok: true } | { ok: false; error: string } {
    const root = getSceneRoot();
    if (!root) return { ok: false, error: 'stage 未就绪' };
    const node = findDisplayById(root, nodeId);
    if (!node) return { ok: false, error: `未找到节点 ${nodeId}` };
    if (node === root) return { ok: false, error: '不能修改 stage 根 visible' };
    const ok = setNodeActive(nodeId, active);
    if (!ok) return { ok: false, error: '设置 visible 失败' };
    return { ok: true };
  },

  listSprites() {
    return collectSpriteList();
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

  async downloadTexture(nodeId: string): Promise<EgretTextureDownloadResult> {
    const root = getSceneRoot();
    if (!root) return { ok: false, error: 'stage 未就绪' };
    const node = findDisplayById(root, nodeId);
    if (!node) return { ok: false, error: `未找到节点 ${nodeId}` };

    const name = getDisplayName(node).replace(/[^\w一-龥.-]/g, '_');
    const extracted = extractNodeTextureToPng(node);
    if (!extracted.ok) return { ok: false, error: extracted.error };
    const sourceUrl = getTextureSourceUrl(getNodeTexture(node));
    return {
      ok: true,
      delivery: 'inline',
      base64: extracted.base64,
      width: extracted.width,
      height: extracted.height,
      filename: `${name}_${nodeId}.png`,
      detail: { extractMethod: extracted.method, sourceUrl: sourceUrl ?? null },
    };
  },

  /** 列出 RES 清单中的资源（含运行时已加载但未在 alias 的图源 URL） */
  listResources(limit?: number) {
    return collectResourceList(limit);
  },

  /**
   * 下载原始资源文件字节。
   * 优先 RES.config 路径解析 + 页内 fetch；fetch 失败时若指向图片且节点存在，
   * 回退到从已解码 HTMLImageElement 绘制整张源图（参考插件 le()/ce() 思路）。
   */
  async downloadResource(
    nameOrUrl: string,
    opts?: { nodeId?: string }
  ): Promise<EgretResourceDownload> {
    const direct = await downloadResource(nameOrUrl);
    if (direct.ok) return direct;

    // fetch 失败：尝试从指定节点（或第一个引用该 URL 的节点）回退到 canvas 整图导出
    const url = resolveResourceUrlPublic(nameOrUrl);
    if (!url) return direct;
    const root = getSceneRoot();
    if (!root) return direct;
    const target = opts?.nodeId
      ? findDisplayById(root, opts.nodeId)
      : findNodeBySourceUrl(root, url);
    if (!target) return direct;
    const t = getNodeTexture(target);
    if (!t) return direct;
    const whole = extractWholeSourceToPng(t);
    if (!whole.ok) return { ok: false, error: `${direct.error}（回退 canvas 也失败: ${whole.error}）` };
    const fallbackName = url.split('/').pop()?.split('?')[0] || 'resource.png';
    return {
      ok: true,
      delivery: 'inline',
      base64: whole.base64,
      filename: fallbackName.replace(/\.(webp|jpg|jpeg|gif|bmp)$/i, '.png'),
      detail: {
        sourceUrl: url,
        bytes: Math.round(whole.base64.length * 0.75),
        mime: 'image/png',
      },
    };
  },

  async captureGameScreenshot(): Promise<
    | { ok: true; base64: string; width: number; height: number }
    | { ok: false; error: string }
  > {
    try {
      const canvas = getEgretCanvas();
      if (!canvas) return { ok: false, error: '未找到 Egret canvas' };
      return canvasToPngBase64(canvas);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },

  async screenshot() {
    return this.captureGameScreenshot();
  },

  /** 列出场景与缓存中的 DragonBones 资源 */
  listDragonBones() {
    return listDragonBones();
  },

  /** 导出指定 DragonBones 资源为 zip（base64 inline） */
  async downloadDragonBones(id: string): Promise<SkeletonExportResult> {
    return exportDragonBones(id);
  },

  /** 列出场景中的 Spine 资源 */
  listSpines() {
    return listSpines();
  },

  /** 导出指定 Spine 资源为 zip（base64 inline） */
  async downloadSpine(id: string): Promise<SkeletonExportResult> {
    return exportSpine(id);
  },

  /** 批量打包下载当前场景用到的所有图片和龙骨/Spine */
  async downloadSceneAssets(): Promise<SkeletonExportResult> {
    return exportSceneAssets();
  },
};

export type EgretInspectorMcpApi = typeof egretInspectorMcpApi;

export function installMcpBridge(): void {
  const win = window as Window & {
    __cocosInspectorApi?: EgretInspectorMcpApi;
  };
  win.__cocosInspectorApi = egretInspectorMcpApi;

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
      const fn = api[method as keyof EgretInspectorMcpApi];
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

  console.log('[MCP桥接:egret] __cocosInspectorApi 已安装（MVP）');
}
