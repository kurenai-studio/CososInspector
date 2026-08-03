/**
 * PixiJS 运行时定位：Application / stage / canvas
 * 兼容无 window.PIXI 的打包页（仅有 Application 闭包 / 嵌套挂载）
 */

export type PixiDisplayObject = {
  name?: string;
  visible?: boolean;
  children?: PixiDisplayObject[];
  parent?: PixiDisplayObject | null;
  texture?: PixiTextureLike;
  tint?: number;
  alpha?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scale?: { x?: number; y?: number };
  constructor?: { name?: string };
  destroy?: (options?: unknown) => void;
};

export type PixiTextureLike = {
  label?: string;
  textureCacheIds?: string[];
  baseTexture?: {
    label?: string;
    textureCacheIds?: string[];
    width?: number;
    height?: number;
    resource?: { url?: string; src?: string };
  };
  width?: number;
  height?: number;
  frame?: { x: number; y: number; width: number; height: number };
};

export type PixiApplicationLike = {
  stage?: PixiDisplayObject;
  ticker?: { stop?: () => void; start?: () => void; started?: boolean };
  renderer?: {
    width?: number;
    height?: number;
    extract?: {
      canvas?: (target?: unknown) => HTMLCanvasElement;
      base64?: (target?: unknown) => string;
    };
    view?: HTMLCanvasElement | OffscreenCanvas;
    canvas?: HTMLCanvasElement;
  };
  view?: HTMLCanvasElement | OffscreenCanvas;
  canvas?: HTMLCanvasElement;
};

declare global {
  interface Window {
    PIXI?: {
      VERSION?: string;
      Application?: unknown;
      utils?: { TextureCache?: Record<string, unknown> };
    };
    __PIXI_APP__?: PixiApplicationLike;
    __PIXI_STAGE__?: PixiDisplayObject;
    __cocosInspectorPixiHint?: boolean;
    __cocosInspectorWebGL?: boolean;
    __cocosInspectorPixiApps?: PixiApplicationLike[];
    __cocosInspectorScanDone?: boolean;
    __cocosInspectorStealDone?: boolean;
    __cocosInspectorWebpackRequire?: unknown;
  }
}

const APP_KEYS = [
  '__PIXI_APP__',
  'app',
  'game',
  'application',
  'pixiApp',
  'pixi',
  '__app',
  'slot',
  'Game',
  'PIXI_APP',
];

function looksLikeStage(v: unknown): v is PixiDisplayObject {
  if (!v || typeof v !== 'object') return false;
  const s = v as PixiDisplayObject;
  return Array.isArray(s.children);
}

function looksLikeApp(v: unknown): v is PixiApplicationLike {
  if (!v || typeof v !== 'object') return false;
  const a = v as PixiApplicationLike;
  if (!looksLikeStage(a.stage)) return false;
  // SlotMill 截获实例可能缺 ticker 字段，有 renderer/view/canvas/render 任一即可
  return !!(
    a.renderer ||
    a.view ||
    a.canvas ||
    a.ticker ||
    typeof (a as { render?: unknown }).render === 'function'
  );
}

function appFromValue(v: unknown): PixiApplicationLike | null {
  if (looksLikeApp(v)) return v;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const nestKey of ['app', 'application', 'pixiApp', 'pixi', 'game']) {
    if (looksLikeApp(o[nestKey])) return o[nestKey] as PixiApplicationLike;
  }
  return null;
}

function scanObjectShallow(
  root: unknown,
  depth: number,
  seen: Set<object>
): PixiApplicationLike | null {
  if (!root || typeof root !== 'object') return null;
  if (seen.has(root as object)) return null;
  seen.add(root as object);

  const hit = appFromValue(root);
  if (hit) return hit;
  if (depth <= 0) return null;

  try {
    const keys = Object.keys(root as object).slice(0, 80);
    for (const key of keys) {
      try {
        const child = (root as Record<string, unknown>)[key];
        const found = scanObjectShallow(child, depth - 1, seen);
        if (found) return found;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function findAppMatchingCanvas(
  canvas: HTMLCanvasElement
): PixiApplicationLike | null {
  const seen = new Set<object>();
  const match = (app: PixiApplicationLike | null): boolean => {
    if (!app) return false;
    const view =
      app.canvas ||
      (app.view instanceof HTMLCanvasElement ? app.view : null) ||
      app.renderer?.canvas ||
      (app.renderer?.view instanceof HTMLCanvasElement
        ? app.renderer.view
        : null);
    return view === canvas;
  };

  for (const key of APP_KEYS) {
    try {
      const v = (window as unknown as Record<string, unknown>)[key];
      const app = appFromValue(v) || scanObjectShallow(v, 2, seen);
      if (match(app)) return app;
    } catch {
      /* ignore */
    }
  }

  for (const key of Object.getOwnPropertyNames(window).slice(0, 400)) {
    try {
      const v = (window as unknown as Record<string, unknown>)[key];
      const app = appFromValue(v);
      if (match(app)) return app;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 在 window / canvas / 捕获列表上查找 Pixi Application */
export function findPixiApplication(): PixiApplicationLike | null {
  try {
    // 热路径：已截获则直接返回，禁止再扫 window/webpack
    const cached = window.__PIXI_APP__;
    if (cached && looksLikeStage(cached.stage)) return cached;

    const captured = window.__cocosInspectorPixiApps;
    if (Array.isArray(captured)) {
      for (let i = captured.length - 1; i >= 0; i--) {
        if (looksLikeApp(captured[i])) {
          window.__PIXI_APP__ = captured[i];
          return captured[i]!;
        }
      }
    }

    for (const key of APP_KEYS) {
      const v = (window as unknown as Record<string, unknown>)[key];
      const app = appFromValue(v);
      if (app) {
        window.__PIXI_APP__ = app;
        return app;
      }
    }

    // 仅尚未截获时做一次重扫描
    if (!window.__cocosInspectorScanDone) {
      const fromWebpack = scanWebpackForApp();
      if (fromWebpack) return fromWebpack;
    }

    const canvasApp = document.querySelector('canvas') as
      | (HTMLCanvasElement & { __PIXI_APP__?: PixiApplicationLike })
      | null;
    if (looksLikeApp(canvasApp?.__PIXI_APP__)) {
      window.__PIXI_APP__ = canvasApp!.__PIXI_APP__!;
      return canvasApp!.__PIXI_APP__!;
    }

    if (looksLikeStage(window.__PIXI_STAGE__)) {
      return { stage: window.__PIXI_STAGE__ };
    }
  } catch (e) {
    console.error('[Pixi Inspector] findPixiApplication 失败', e);
  }
  return null;
}

function scanWebpackForApp(): PixiApplicationLike | null {
  try {
    // SlotMill：先偷 webpack5 require（chunk runtime 第 3 参）
    let req = (
      window as unknown as {
        __webpack_require__?: WebpackRequire;
        __cocosInspectorWebpackRequire?: WebpackRequire;
      }
    ).__cocosInspectorWebpackRequire ||
      (
        window as unknown as { __webpack_require__?: WebpackRequire }
      ).__webpack_require__;

    if (typeof req !== 'function') {
      req = stealWebpackRequire() ?? undefined;
    }
    if (typeof req !== 'function') return null;

    const factories = req.m;
    if (factories) {
      const ids = Object.keys(factories);
      const limit = Math.min(ids.length, 2000);
      for (let i = 0; i < limit; i++) {
        try {
          const exp = req(ids[i]);
          const hit = extractAppFromExports(exp);
          if (hit) {
            window.__PIXI_APP__ = hit;
            return hit;
          }
        } catch {
          /* ignore */
        }
      }
    }

    const cache = req.c;
    if (cache) {
      const seen = new Set<object>();
      for (const id of Object.keys(cache)) {
        const exp = cache[id]?.exports;
        const hit =
          appFromValue(exp) ||
          extractAppFromExports(exp) ||
          scanObjectShallow(exp, 2, seen);
        if (hit) {
          window.__PIXI_APP__ = hit;
          return hit;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

type WebpackRequire = ((id: string) => unknown) & {
  c?: Record<string, { exports?: unknown }>;
  m?: Record<string, unknown>;
};

function stealWebpackRequire(): WebpackRequire | null {
  try {
    const existing = (
      window as unknown as { __webpack_require__?: WebpackRequire }
    ).__webpack_require__;
    if (typeof existing === 'function' && (existing.m || existing.c)) {
      return existing;
    }
    for (const key of Object.getOwnPropertyNames(window)) {
      if (!key.startsWith('webpackChunk') && !key.startsWith('webpackJsonp')) {
        continue;
      }
      const chunk = (window as unknown as Record<string, unknown>)[key];
      if (!Array.isArray(chunk)) continue;
      let got: WebpackRequire | null = null;
      chunk.push([
        [`__cocos_insp_rt_${Date.now()}`],
        {},
        (req: WebpackRequire) => {
          got = req;
          (window as unknown as { __webpack_require__?: WebpackRequire })
            .__webpack_require__ = req;
          (
            window as unknown as {
              __cocosInspectorWebpackRequire?: WebpackRequire;
            }
          ).__cocosInspectorWebpackRequire = req;
        },
      ]);
      if (typeof got === 'function') return got;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractAppFromExports(exp: unknown): PixiApplicationLike | null {
  if (!exp || typeof exp !== 'object') return null;
  const o = exp as Record<string, unknown>;

  // Pixi 库 → 打原型钩子（截已创建实例）
  if (
    typeof o.Application === 'function' &&
    (typeof o.Container === 'function' || typeof o.Sprite === 'function')
  ) {
    patchApplicationPrototypeLive(
      o.Application as { prototype?: { render?: (...a: unknown[]) => unknown } }
    );
  }

  const nested = o.pixiApp;
  if (looksLikeApp(nested)) return nested;
  if (looksLikeApp(exp)) return exp as PixiApplicationLike;

  for (const v of Object.values(o).slice(0, 40)) {
    if (!v || typeof v !== 'object') continue;
    const vo = v as Record<string, unknown>;
    if (looksLikeApp(vo.pixiApp)) return vo.pixiApp as PixiApplicationLike;
    if (looksLikeApp(v)) return v as PixiApplicationLike;
  }
  return null;
}

function patchApplicationPrototypeLive(Application: {
  prototype?: { render?: ((...a: unknown[]) => unknown) & { __cocosInspLive?: boolean } };
}): void {
  try {
    const proto = Application?.prototype;
    if (!proto?.render || proto.render.__cocosInspLive) return;
    const orig = proto.render;
    proto.render = function (this: PixiApplicationLike, ...args: unknown[]) {
      try {
        if (looksLikeStage(this?.stage)) {
          window.__PIXI_APP__ = this;
          window.__PIXI_STAGE__ = this.stage;
          const list = (window.__cocosInspectorPixiApps =
            window.__cocosInspectorPixiApps || []);
          if (list.indexOf(this) < 0) list.push(this);
        }
      } catch {
        /* ignore */
      }
      return orig.apply(this, args);
    };
    proto.render.__cocosInspLive = true;
  } catch {
    /* ignore */
  }
}

/** 已知 Pixi 试玩宿主（避免误伤全网；SlotMill 等无全局 PIXI） */
const KNOWN_PIXI_HOST_RE = /(^|\.)slotmill\.com$/i;

/** 软信号：必须有 Pixi 证据，禁止「任意 canvas/WebGL」误判 */
export function hasPixiSoftSignal(): boolean {
  try {
    const apps = window.__cocosInspectorPixiApps;
    if (Array.isArray(apps) && apps.some((a) => looksLikeApp(a))) return true;

    if (window.PIXI) return true;
    if (looksLikeApp(window.__PIXI_APP__)) return true;
    if (looksLikeStage(window.__PIXI_STAGE__)) return true;
    if (findPixiApplication()) return true;

    if (window.__cocosInspectorPixiHint === true) return true;
    if (
      (window as Window & { __cocosInspectorPixiLib?: boolean })
        .__cocosInspectorPixiLib
    ) {
      return true;
    }
    if (
      (window as Window & { __cocosInspectorPixiHost?: boolean })
        .__cocosInspectorPixiHost ||
      KNOWN_PIXI_HOST_RE.test(location.hostname)
    ) {
      return true;
    }

    const entries = performance.getEntriesByType('resource');
    for (const e of entries) {
      if (/pixi\.js|pixijs|@pixi\//i.test(e.name)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** @deprecated 勿再用于引擎族判定（会把任意站点当 Pixi） */
export function hasLikelyGameCanvas(): boolean {
  try {
    const list = document.querySelectorAll('canvas');
    for (let i = 0; i < list.length; i++) {
      const c = list[i] as HTMLCanvasElement;
      const w = c.width || c.clientWidth;
      const h = c.height || c.clientHeight;
      if (w >= 200 && h >= 200) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 尽早挂钩 console，捕获「PixiJS Deprecation」等日志。
 * 打包页常无 window.PIXI，但运行时会打出 Pixi 警告。
 */
export function installPixiConsoleHint(): void {
  if ((window as Window & { __cocosInspectorPixiHook?: boolean })
    .__cocosInspectorPixiHook) {
    return;
  }
  (window as Window & { __cocosInspectorPixiHook?: boolean })
    .__cocosInspectorPixiHook = true;

  const mark = (args: unknown[]): void => {
    try {
      for (const a of args) {
        const s = typeof a === 'string' ? a : String(a);
        if (/PixiJS|pixi\.js|@pixi\//i.test(s)) {
          window.__cocosInspectorPixiHint = true;
          return;
        }
      }
    } catch {
      /* ignore */
    }
  };

  for (const method of ['warn', 'log', 'error', 'info'] as const) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      mark(args);
      return orig(...args);
    };
  }
}

export function getPixiStage(): PixiDisplayObject | null {
  return findPixiApplication()?.stage ?? window.__PIXI_STAGE__ ?? null;
}

export function getPixiVersion(): string {
  return String(window.PIXI?.VERSION ?? 'pixi');
}

export function getPixiCanvas(): HTMLCanvasElement | null {
  const app = findPixiApplication();
  if (app) {
    const view =
      app.canvas ||
      (app.view instanceof HTMLCanvasElement ? app.view : null) ||
      app.renderer?.canvas ||
      (app.renderer?.view instanceof HTMLCanvasElement
        ? app.renderer.view
        : null);
    if (view) return view;
  }
  const canvases = document.querySelectorAll('canvas');
  return (canvases[canvases.length - 1] as HTMLCanvasElement) || null;
}
