/**
 * Egret 运行时定位：stage / canvas / 版本
 *
 * 参考 H5 Game AI Inspector 的 resolveEgretStage：
 *   1) egret.sys.$TempStage（5.x WebGL 渲染入口）
 *   2) egret.MainContext.instance.stage（2.x / 兼容）
 * window.egret + 可解析 stage 即为强证据，无需 Pixi 那样的探针/开关。
 */

export type EgretDisplayObject = {
  name?: string;
  /** eui 组件的 ExmlId（皮肤 skinParts 注入） */
  id?: string;
  parent?: EgretDisplayObject | null;
  /** Egret 内部子节点数组（2.x/5.x 均为 $children） */
  $children?: EgretDisplayObject[];
  visible?: boolean;
  alpha?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  /** Bitmap / MovieClip 等持有的纹理 */
  texture?: EgretTextureLike;
  $texture?: EgretTextureLike;
  constructor?: { name?: string };
  /** 仅 stage 有 */
  stageWidth?: number;
  stageHeight?: number;
};

export type EgretTextureLike = {
  /** 源位图：HTMLImageElement / HTMLCanvasElement / ImageBitmap */
  $bitmapData?: HTMLImageElement | HTMLCanvasElement | ImageBitmap | null;
  _bitmapData?: HTMLImageElement | HTMLCanvasElement | ImageBitmap | null;
  /** 图集中区域（subimage） */
  $bitmapX?: number;
  $bitmapY?: number;
  $bitmapWidth?: number;
  $bitmapHeight?: number;
  /** 裁剪偏移（trim） */
  $offsetX?: number;
  $offsetY?: number;
  /** 逻辑显示尺寸（裁剪后） */
  $textureWidth?: number;
  $textureHeight?: number;
  textureWidth?: number;
  textureHeight?: number;
  sourceWidth?: number;
  sourceHeight?: number;
};

declare global {
  interface Window {
    egret?: {
      Capabilities?: { engineVersion?: string };
      sys?: { $TempStage?: EgretDisplayObject };
      MainContext?: { instance?: { stage?: EgretDisplayObject } };
      ticker?: EgretTickerLike;
      Ticker?: { getInstance?: () => EgretTickerLike | null };
      Stage?: unknown;
      Bitmap?: unknown;
      MovieClip?: unknown;
      TextField?: unknown;
      DisplayObject?: unknown;
    };
  }
}

export type EgretTickerLike = {
  pause?: () => void;
  resume?: () => void;
  $paused?: boolean;
  $pauseCount?: number;
  isPaused?: boolean;
  showFPS?: (on: boolean) => void;
};

/** 解析 Egret stage；未就绪返回 null */
export function getEgretStage(): EgretDisplayObject | null {
  const eg = window.egret;
  if (!eg) return null;
  try {
    const temp = eg.sys?.$TempStage;
    if (temp) return temp;
  } catch {
    /* ignore */
  }
  try {
    const stage = eg.MainContext?.instance?.stage;
    if (stage) return stage;
  } catch {
    /* ignore */
  }
  return null;
}

/** window.egret 存在且 stage 可解析 → 认定为 Egret */
export function hasEgretEngine(): boolean {
  return !!window.egret && !!getEgretStage();
}

export function getEgretVersion(): string {
  try {
    return String(window.egret?.Capabilities?.engineVersion ?? 'egret');
  } catch {
    return 'egret';
  }
}

/** 渲染 canvas：stage.$canvas 优先，退回 .egret-player canvas */
export function getEgretCanvas(): HTMLCanvasElement | null {
  try {
    const stage = getEgretStage() as (EgretDisplayObject & {
      $canvas?: HTMLCanvasElement;
    }) | null;
    if (stage?.$canvas) return stage.$canvas;
    const inPlayer = document.querySelector(
      '.egret-player canvas'
    ) as HTMLCanvasElement | null;
    if (inPlayer) return inPlayer;
    const all = document.querySelectorAll('canvas');
    return (all[all.length - 1] as HTMLCanvasElement) || null;
  } catch {
    return null;
  }
}

export function getEgretTicker(): EgretTickerLike | null {
  const eg = window.egret;
  if (!eg) return null;
  try {
    if (eg.ticker) return eg.ticker;
    if (typeof eg.Ticker?.getInstance === 'function') {
      return eg.Ticker.getInstance();
    }
  } catch {
    /* ignore */
  }
  return null;
}
