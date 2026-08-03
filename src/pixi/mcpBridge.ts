/**
 * PixiJS MCP 桥接（MVP）
 * 与 Cocos 共用 window.__cocosInspectorApi / postMessage 协议
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
  findPixiApplication,
  getPixiCanvas,
  getPixiVersion,
} from './runtime';

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

export const pixiInspectorMcpApi = {
  version: 1 as const,
  engineFamily: 'pixi' as const,

  getPageInfo(): {
    pageUrl: string;
    engineVersion: string;
    engineFamily: 'pixi';
    sceneName: string;
    hasCocos: boolean;
    hasPixi: boolean;
    paused: boolean;
    pause: PauseState;
  } {
    const root = getSceneRoot();
    const pause = getPauseState();
    return {
      pageUrl: window.location.href,
      engineVersion: getPixiVersion(),
      engineFamily: 'pixi',
      sceneName: root ? getDisplayName(root) : '',
      hasCocos: false,
      hasPixi: !!window.PIXI || !!findPixiApplication(),
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

  async captureGameScreenshot(): Promise<
    | { ok: true; base64: string; width: number; height: number }
    | { ok: false; error: string }
  > {
    try {
      const app = findPixiApplication();
      const extract = app?.renderer?.extract;
      if (extract?.canvas && app?.stage) {
        const c = extract.canvas(app.stage);
        return canvasToPngBase64(c);
      }
      if (typeof extract?.base64 === 'function' && app?.stage) {
        const dataUrl = extract.base64(app.stage);
        const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
        const canvas = getPixiCanvas();
        return {
          ok: true,
          base64,
          width: canvas?.width ?? 0,
          height: canvas?.height ?? 0,
        };
      }
      const canvas = getPixiCanvas();
      if (!canvas) return { ok: false, error: '未找到 Pixi canvas' };
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

export type PixiInspectorMcpApi = typeof pixiInspectorMcpApi;

export function installMcpBridge(): void {
  const win = window as Window & {
    __cocosInspectorApi?: PixiInspectorMcpApi;
  };
  win.__cocosInspectorApi = pixiInspectorMcpApi;

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
      const fn = api[method as keyof PixiInspectorMcpApi];
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

  console.log('[MCP桥接:pixi] __cocosInspectorApi 已安装（MVP）');
}
