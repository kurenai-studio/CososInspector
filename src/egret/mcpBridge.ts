/**
 * Egret MCP 桥接（MVP）
 * 与 Cocos 共用 window.__cocosInspectorApi / postMessage 协议
 *
 * 核心方法对齐 MCP server（tools/mcp-cocos-inspector/index.mjs）：
 *   getPageInfo / 暂停四件 / setNodeActive / listSprites / getSceneTree /
 *   downloadTexture / captureGameScreenshot / evalPage
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
import { extractNodeTextureToPng } from './textureExtract';
import { getEgretCanvas, getEgretVersion } from './runtime';

export type EgretTextureDownloadResult =
  | {
      ok: true;
      delivery: 'inline';
      base64: string;
      width: number;
      height: number;
      filename: string;
      detail: { extractMethod: string };
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
    return {
      ok: true,
      delivery: 'inline',
      base64: extracted.base64,
      width: extracted.width,
      height: extracted.height,
      filename: `${name}_${nodeId}.png`,
      detail: { extractMethod: extracted.method },
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
