import { bakeSpriteFrameViaEngine } from './textureBake';
import { findNodeById, getSceneRoot } from './sceneTree';
import { logTextureExtract } from './textureExtractLog';
import type { ExtractPathTrace } from './textureExtractTrace';
import {
  createPathTrace,
  measureOpaqueBBox,
  snapshotFrameCalc,
  traceFinish,
  traceStep,
} from './textureExtractTrace';
import {
  clearTextureExtractDebugLog,
  extractAtlasViaWebGL,
  getTextureExtractDebugLog,
} from './textureWebGL';

/** 图集帧在纹理上的像素区域（左上原点，与 SpriteFrame.rect 一致） */
export interface AtlasFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ExtractMethod =
  | 'dom-atlas'
  | 'url-atlas'
  | 'buffer-atlas'
  | 'readPixels-region'
  | 'readPixels-full'
  | 'engine-bake'
  | 'webgl-fbo'
  | 'device-copy'
  | 'engine-trim';

export interface TextureExtractResult {
  imageData: ImageData;
  method: ExtractMethod;
}

export type TextureRuntime = {
  width?: number;
  height?: number;
  uuid?: string;
  _uuid?: string;
  getId?: () => string;
  readPixels?: (
    x?: number,
    y?: number,
    w?: number,
    h?: number,
    buffer?: ArrayBufferView
  ) => Promise<ArrayBufferView | null>;
  image?: ImageAssetRuntime;
  _nativeAsset?: unknown;
  _nativeUrl?: string;
  nativeUrl?: string;
};

export type ImageAssetRuntime = {
  data?: unknown;
  _data?: unknown;
  htmlElement?: CanvasImageSource;
  _nativeAsset?: unknown;
  nativeAsset?: { url?: string };
  nativeUrl?: string;
  _nativeUrl?: string;
  url?: string;
  _uuid?: string;
  uuid?: string;
  width?: number;
  height?: number;
  _mipmaps?: Array<{ data?: ArrayBufferView; width?: number; height?: number }>;
} & Record<string, unknown>;

export type SpriteFrameRuntime = {
  rect?: { x?: number; y?: number; width?: number; height?: number };
  uv?: number[];
  texture?: TextureRuntime;
  _texture?: TextureRuntime;
  isRotated?: boolean;
  _rotated?: boolean;
  width?: number;
  height?: number;
  originalSize?: { width?: number; height?: number; x?: number; y?: number };
  _originalSize?: { width?: number; height?: number };
  _original?: { _textureSource?: { _nativeAsset?: unknown } };
};

const pixelCache = new Map<string, TextureExtractResult>();
const pendingReads = new Map<string, Promise<TextureExtractResult | null>>();
const urlImageCache = new Map<string, HTMLImageElement>();

export function getAtlasCacheKey(
  texture: TextureRuntime,
  rect: AtlasFrameRect
): string {
  // uuid 可能是空串，不能用 ??（空串会跳过 getId）
  const id =
    texture.uuid ||
    texture._uuid ||
    texture.getId?.() ||
    `tex${texture.width ?? 0}x${texture.height ?? 0}`;
  return `v2_${id}_${rect.x}_${rect.y}_${rect.w}_${rect.h}`;
}

export function resolveFrameRect(
  frame: SpriteFrameRuntime,
  texW: number,
  texH: number
): AtlasFrameRect {
  const r = frame.rect;
  if (r && (r.width ?? 0) > 0 && (r.height ?? 0) > 0) {
    let w = Math.round(r.width ?? 0);
    let h = Math.round(r.height ?? 0);
    let x = Math.round(r.x ?? 0);
    let y = Math.round(r.y ?? 0);

    return { x, y, w, h };
  }

  const uv = frame.uv;
  if (uv && uv.length >= 4 && texW > 0 && texH > 0) {
    let minU = 1;
    let minV = 1;
    let maxU = 0;
    let maxV = 0;
    for (let i = 0; i + 1 < uv.length; i += 2) {
      minU = Math.min(minU, uv[i]);
      minV = Math.min(minV, uv[i + 1]);
      maxU = Math.max(maxU, uv[i]);
      maxV = Math.max(maxV, uv[i + 1]);
    }
    return {
      x: Math.round(minU * texW),
      y: Math.round(minV * texH),
      w: Math.round((maxU - minU) * texW),
      h: Math.round((maxV - minV) * texH),
    };
  }

  return { x: 0, y: 0, w: texW, h: texH };
}

/** 精灵显示尺寸（originalSize，不交换 rect） */
export function resolveDisplaySize(
  frame: SpriteFrameRuntime,
  atlasRect: AtlasFrameRect
): { w: number; h: number } {
  const os = frame.originalSize ?? frame._originalSize;
  if (os) {
    const w = Math.round(os.width ?? (os as { x?: number }).x ?? 0);
    const h = Math.round(os.height ?? (os as { y?: number }).y ?? 0);
    if (w > 0 && h > 0) return { w, h };
  }
  if (frame.width && frame.height) {
    return { w: Math.round(frame.width), h: Math.round(frame.height) };
  }
  return { w: atlasRect.w, h: atlasRect.h };
}

function resolveDomImage(texture?: TextureRuntime | null): CanvasImageSource | null {
  if (!texture) return null;
  const img = texture.image;
  const list: unknown[] = [
    img?.data,
    img?._data,
    img?.htmlElement,
    texture._nativeAsset,
    img?._nativeAsset,
    img?.nativeAsset,
    (img?.nativeAsset as { url?: string })?.url,
  ];
  for (const c of list) {
    if (
      c instanceof HTMLImageElement ||
      c instanceof HTMLCanvasElement ||
      c instanceof ImageBitmap
    ) {
      if (c instanceof HTMLImageElement && !c.complete) continue;
      if (
        c instanceof HTMLImageElement &&
        c.naturalWidth === 0 &&
        c.naturalHeight === 0
      ) {
        continue;
      }
      return c;
    }
  }
  return null;
}

export function collectAssetUrls(
  texture: TextureRuntime,
  imageAsset?: ImageAssetRuntime | null
): string[] {
  const urls = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== 'string' || v.length < 2) return;
    if (v.startsWith('db://') && !v.includes('http')) return;
    urls.add(v);
  };

  const objs: Record<string, unknown>[] = [];
  if (imageAsset) objs.push(imageAsset);
  objs.push(texture as Record<string, unknown>);

  for (const obj of objs) {
    for (const k of [
      'nativeUrl',
      '_nativeUrl',
      'url',
      '_url',
      'file',
      '_file',
      'path',
      '_path',
    ]) {
      add(obj[k]);
    }
    const na = obj.nativeAsset ?? obj._nativeAsset;
    if (na && typeof na === 'object') {
      add((na as { url?: string }).url);
      add((na as { _url?: string })._url);
    }
    if (typeof na === 'string') add(na);
  }

  const uuid = imageAsset?._uuid ?? imageAsset?.uuid ?? texture._uuid ?? texture.uuid;
  const ccg = window.cc as {
    assetManager?: {
      utils?: {
        getUrlWithUuid?: (
          uuid: string,
          opts?: { isNative?: boolean; ext?: string }
        ) => string;
      };
    };
  };
  const getUrl = ccg.assetManager?.utils?.getUrlWithUuid;
  if (uuid && getUrl) {
    try {
      add(getUrl(uuid, { isNative: true }));
      add(getUrl(uuid, { isNative: true, ext: '.png' }));
      add(getUrl(uuid, { isNative: true, ext: '.jpg' }));
      add(getUrl(uuid, { isNative: true, ext: '.webp' }));
    } catch {
      /* ignore */
    }
  }

  return [...urls];
}

function resolveFetchUrl(raw: string): string {
  if (
    raw.startsWith('http://') ||
    raw.startsWith('https://') ||
    raw.startsWith('blob:') ||
    raw.startsWith('data:')
  ) {
    return raw;
  }
  try {
    return new URL(raw, window.location.href).href;
  } catch {
    return raw;
  }
}

async function loadImageFromUrl(url: string): Promise<HTMLImageElement | null> {
  const cached = urlImageCache.get(url);
  if (cached?.complete && cached.naturalWidth > 0) return cached;

  const href = resolveFetchUrl(url);

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (img.naturalWidth > 0) {
        urlImageCache.set(url, img);
        resolve(img);
      } else resolve(null);
    };
    img.onerror = () => resolve(null);
    img.src = href;
  });
}

function bufferToRgba(
  buf: ArrayBufferView,
  w: number,
  h: number
): Uint8ClampedArray | null {
  const need = w * h * 4;
  const u8 =
    buf instanceof Uint8Array
      ? buf
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  if (u8.length === need) {
    return new Uint8ClampedArray(u8.buffer, u8.byteOffset, u8.length);
  }

  if (u8.length === w * h * 3) {
    const out = new Uint8ClampedArray(need);
    for (let i = 0, j = 0; i < u8.length; i += 3, j += 4) {
      out[j] = u8[i];
      out[j + 1] = u8[i + 1];
      out[j + 2] = u8[i + 2];
      out[j + 3] = 255;
    }
    return out;
  }

  if (u8.length > need) {
    return new Uint8ClampedArray(u8.buffer, u8.byteOffset, need);
  }

  return null;
}

function hasVisiblePixels(data: ImageData): boolean {
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0 || d[i] > 0 || d[i + 1] > 0 || d[i + 2] > 0) {
      return true;
    }
  }
  return false;
}

function cropFromFullBuffer(
  buf: ArrayBufferView,
  texW: number,
  texH: number,
  rect: AtlasFrameRect,
  yFromBottom: boolean
): ImageData | null {
  const full = bufferToRgba(buf, texW, texH);
  if (!full) return null;

  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let row = 0; row < rect.h; row++) {
    for (let col = 0; col < rect.w; col++) {
      const srcY = yFromBottom ? texH - rect.y - rect.h + row : rect.y + row;
      const srcX = rect.x + col;
      if (srcX < 0 || srcY < 0 || srcX >= texW || srcY >= texH) continue;
      const si = (srcY * texW + srcX) * 4;
      const di = (row * rect.w + col) * 4;
      out[di] = full[si];
      out[di + 1] = full[si + 1];
      out[di + 2] = full[si + 2];
      out[di + 3] = full[si + 3];
    }
  }
  return new ImageData(out, rect.w, rect.h);
}

function extractFromDomAtlas(
  source: CanvasImageSource,
  rect: AtlasFrameRect,
  method: ExtractMethod = 'dom-atlas'
): TextureExtractResult | null {
  const w = rect.w;
  const h = rect.h;
  if (w <= 0 || h <= 0) return null;

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  if (!ctx) return null;

  try {
    ctx.drawImage(source, rect.x, rect.y, w, h, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    if (!hasVisiblePixels(imageData)) return null;
    return { imageData, method };
  } catch {
    return null;
  }
}

async function extractViaUrls(
  texture: TextureRuntime,
  rect: AtlasFrameRect
): Promise<TextureExtractResult | null> {
  const urls = collectAssetUrls(texture, texture.image);
  for (const url of urls) {
    const img = await loadImageFromUrl(url);
    if (!img) continue;
    const fullW = img.naturalWidth;
    const fullH = img.naturalHeight;
    if (fullW <= 0 || fullH <= 0) continue;

    const scaled = scaleRectToImage(rect, texture.width ?? fullW, texture.height ?? fullH, fullW, fullH);
    const result = extractFromDomAtlas(img, scaled, 'url-atlas');
    if (result) return result;
  }
  return null;
}

/** 图集 rect 基于纹理尺寸时，映射到真实图片像素尺寸 */
function scaleRectToImage(
  rect: AtlasFrameRect,
  texW: number,
  texH: number,
  imgW: number,
  imgH: number
): AtlasFrameRect {
  if (texW === imgW && texH === imgH) return rect;
  const sx = imgW / (texW || imgW);
  const sy = imgH / (texH || imgH);
  return {
    x: Math.round(rect.x * sx),
    y: Math.round(rect.y * sy),
    w: Math.round(rect.w * sx),
    h: Math.round(rect.h * sy),
  };
}

function extractViaRawBuffer(
  texture: TextureRuntime,
  rect: AtlasFrameRect
): TextureExtractResult | null {
  const img = texture.image;
  const texW = Math.floor(texture.width ?? 0);
  const texH = Math.floor(texture.height ?? 0);
  if (!img || texW <= 0 || texH <= 0) return null;

  const candidates: ArrayBufferView[] = [];
  const push = (v: unknown) => {
    if (v instanceof ArrayBuffer) {
      candidates.push(new Uint8Array(v));
    } else if (ArrayBuffer.isView(v)) {
      candidates.push(v);
    }
  };

  push(img.data);
  push(img._data);
  const mip = img._mipmaps?.[0]?.data;
  if (mip) push(mip);

  for (const buf of candidates) {
    const top = cropFromFullBuffer(buf, texW, texH, rect, false);
    if (top && hasVisiblePixels(top)) {
      return { imageData: top, method: 'buffer-atlas' };
    }
    const bottom = cropFromFullBuffer(buf, texW, texH, rect, true);
    if (bottom && hasVisiblePixels(bottom)) {
      return { imageData: bottom, method: 'buffer-atlas' };
    }
  }

  return null;
}

async function readRegionPixels(
  texture: TextureRuntime,
  rect: AtlasFrameRect,
  texH: number
): Promise<ImageData | null> {
  if (typeof texture.readPixels !== 'function') return null;

  const regions = [
    { x: rect.x, y: rect.y },
    { x: rect.x, y: texH - rect.y - rect.h },
  ];

  for (const region of regions) {
    try {
      const buf = await texture.readPixels(region.x, region.y, rect.w, rect.h);
      if (!buf) continue;
      const rgba = bufferToRgba(buf, rect.w, rect.h);
      if (!rgba) continue;
      const imageData = new ImageData(rgba, rect.w, rect.h);
      if (hasVisiblePixels(imageData)) return imageData;
    } catch {
      /* next */
    }
  }

  return null;
}

async function readFullAndCrop(
  texture: TextureRuntime,
  rect: AtlasFrameRect
): Promise<ImageData | null> {
  if (typeof texture.readPixels !== 'function') return null;

  const texW = Math.floor(texture.width ?? 0);
  const texH = Math.floor(texture.height ?? 0);
  if (texW <= 0 || texH <= 0) return null;

  try {
    const buf = await texture.readPixels(0, 0, texW, texH);
    if (!buf) return null;

    // Cocos Texture2D.readPixels 通常已是顶左；先顶左，近空再试底原点
    const top = cropFromFullBuffer(buf, texW, texH, rect, false);
    if (top && hasVisiblePixels(top)) return top;

    const bottom = cropFromFullBuffer(buf, texW, texH, rect, true);
    if (bottom && hasVisiblePixels(bottom)) return bottom;
  } catch {
    return null;
  }

  return null;
}

const resolveLogContext = (
  nodeId: string | null | undefined,
  frame: SpriteFrameRuntime
): { nodeName: string; nodeUUID: string; frameName: string } => {
  const nodeUUID = nodeId ?? 'unknown';
  let nodeName = 'unknown';
  if (nodeId) {
    const scene = getSceneRoot();
    const node = scene ? findNodeById(scene, nodeId) : null;
    if (node) nodeName = node.name ?? 'unknown';
  }
  const fr = frame as { name?: string; _name?: string };
  const frameName = String(fr.name ?? fr._name ?? 'spriteFrame');
  return { nodeName, nodeUUID, frameName };
};

/**
 * 提取图集帧像素：URL/缓冲/DOM → readPixels → 引擎离屏渲染
 */
export async function extractAtlasFramePixels(
  frame: SpriteFrameRuntime,
  texSize: { w: number; h: number },
  displaySize?: { w: number; h: number },
  nodeId?: string | null,
  traceOut?: ExtractPathTrace
): Promise<TextureExtractResult | null> {
  const texture = frame.texture ?? frame._texture;
  if (!texture) return null;

  const texW = Math.floor(texture.width ?? texSize.w);
  const texH = Math.floor(texture.height ?? texSize.h);
  const rect = resolveFrameRect(frame, texW, texH);
  if (rect.w <= 0 || rect.h <= 0) return null;

  const logCtx = resolveLogContext(nodeId, frame);
  const calcMeta = snapshotFrameCalc(frame, texW, texH, {
    w: displaySize?.w ?? rect.w,
    h: displaySize?.h ?? rect.h,
  });
  const trace = traceOut ?? createPathTrace('legacy', calcMeta);
  traceStep(logCtx, trace, 'meta', {
    ...calcMeta,
    legacyCropRect: rect,
    note: 'legacy 仅裁 frameRect，不旋转展开、不合成 originalSize',
  });

  const cacheKey = `${getAtlasCacheKey(texture, rect)}_${nodeId ?? ''}`;
  const cached = pixelCache.get(cacheKey);
  if (cached) {
    traceStep(logCtx, trace, 'cache-hit', { cacheKey }, {
      method: cached.method,
      pixelSize: { w: cached.imageData.width, h: cached.imageData.height },
    });
    traceFinish(logCtx, trace, cached.method, cached.imageData);
    logTextureExtract(logCtx, '缓存命中', {
      method: cached.method,
      cacheHit: true,
      frameRect: rect,
      pixelSize: {
        w: cached.imageData.width,
        h: cached.imageData.height,
      },
    });
    return cached;
  }

  const pending = pendingReads.get(cacheKey);
  if (pending) return pending;

  const outW = displaySize?.w ?? rect.w;
  const outH = displaySize?.h ?? rect.h;

  const task = (async (): Promise<TextureExtractResult | null> => {
    clearTextureExtractDebugLog();
    logTextureExtract(logCtx, '开始提取', {
      frameRect: rect,
      pixelSize: { w: outW, h: outH },
      detail: { texW, texH, cacheKey },
    });
    await waitFrames(2);

    const finishLegacy = (result: TextureExtractResult): TextureExtractResult => {
      traceStep(
        logCtx,
        trace,
        'crop',
        { cropRect: rect },
        {
          pixelSize: {
            w: result.imageData.width,
            h: result.imageData.height,
          },
          opaque: measureOpaqueBBox(result.imageData),
        }
      );
      traceFinish(logCtx, trace, result.method, result.imageData);
      return result;
    };

    logTextureExtract(logCtx, '尝试 webgl-fbo/device-copy', { method: 'webgl-fbo' });
    // 大图集跳过 GPU 整图回读，直接走后续 bake
    const webgl =
      texW * texH >= 1024 * 1024 ? null : extractAtlasViaWebGL(texture, rect);
    if (webgl) {
      const opaque = measureOpaqueBBox(webgl.imageData);
      traceStep(
        logCtx,
        trace,
        'crop',
        { cropRect: rect, atlasRead: webgl.method },
        {
          pixelSize: {
            w: webgl.imageData.width,
            h: webgl.imageData.height,
          },
          opaque,
        }
      );
      traceStep(logCtx, trace, 'preview-scale', {
        from: { w: webgl.imageData.width, h: webgl.imageData.height },
        to: calcMeta.displaySize,
        note: 'Inspector 左栏按 displaySize 拉伸显示',
      });
      traceFinish(logCtx, trace, webgl.method, webgl.imageData);
      logTextureExtract(logCtx, `${webgl.method} 成功`, {
        method: webgl.method,
        pixelSize: {
          w: webgl.imageData.width,
          h: webgl.imageData.height,
        },
      });
      return { imageData: webgl.imageData, method: webgl.method };
    }

    logTextureExtract(logCtx, '尝试 dom-atlas', { method: 'dom-atlas' });
    const dom = resolveDomImage(texture);
    if (dom) {
      const fromDom = extractFromDomAtlas(dom, rect, 'dom-atlas');
      if (fromDom) {
        logTextureExtract(logCtx, 'dom-atlas 成功', {
          method: 'dom-atlas',
          pixelSize: {
            w: fromDom.imageData.width,
            h: fromDom.imageData.height,
          },
        });
        return finishLegacy(fromDom);
      }
    }

    logTextureExtract(logCtx, '尝试 url-atlas', { method: 'url-atlas' });
    const fromUrl = await extractViaUrls(texture, rect);
    if (fromUrl) {
      logTextureExtract(logCtx, 'url-atlas 成功', {
        method: fromUrl.method,
        pixelSize: {
          w: fromUrl.imageData.width,
          h: fromUrl.imageData.height,
        },
      });
      return finishLegacy(fromUrl);
    }

    logTextureExtract(logCtx, '尝试 buffer-atlas', { method: 'buffer-atlas' });
    const fromBuf = extractViaRawBuffer(texture, rect);
    if (fromBuf) {
      logTextureExtract(logCtx, 'buffer-atlas 成功', {
        method: fromBuf.method,
        pixelSize: {
          w: fromBuf.imageData.width,
          h: fromBuf.imageData.height,
        },
      });
      return finishLegacy(fromBuf);
    }

    logTextureExtract(logCtx, '尝试 readPixels-region', {
      method: 'readPixels-region',
    });
    const region = await readRegionPixels(texture, rect, texH);
    if (region) {
      logTextureExtract(logCtx, 'readPixels-region 成功', {
        method: 'readPixels-region',
        pixelSize: { w: region.width, h: region.height },
      });
      return finishLegacy({ imageData: region, method: 'readPixels-region' });
    }

    logTextureExtract(logCtx, '尝试 readPixels-full', {
      method: 'readPixels-full',
    });
    const full = await readFullAndCrop(texture, rect);
    if (full) {
      logTextureExtract(logCtx, 'readPixels-full 成功', {
        method: 'readPixels-full',
        pixelSize: { w: full.width, h: full.height },
      });
      return finishLegacy({ imageData: full, method: 'readPixels-full' });
    }

    logTextureExtract(logCtx, '尝试 engine-bake', { method: 'engine-bake' });
    const baked = await bakeSpriteFrameViaEngine(frame, { w: outW, h: outH });
    if (baked && hasVisiblePixels(baked)) {
      logTextureExtract(logCtx, 'engine-bake 成功', {
        method: 'engine-bake',
        pixelSize: { w: baked.width, h: baked.height },
      });
      return finishLegacy({ imageData: baked, method: 'engine-bake' });
    }

    logTextureExtract(logCtx, '全部路径失败', {
      level: 'error',
      detail: { steps: getTextureExtractDebugLog() },
    });
    traceFinish(logCtx, trace, 'failed', null);
    return null;
  })();

  pendingReads.set(cacheKey, task);
  try {
    const result = await task;
    if (result) pixelCache.set(cacheKey, result);
    return result;
  } finally {
    pendingReads.delete(cacheKey);
  }
}

function waitFrames(n: number): Promise<void> {
  let left = n;
  return new Promise((resolve) => {
    const step = () => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Spine 等整图纹理导出（与 sprite 帧读取分离） */
export async function extractFullTexturePixels(
  texture: TextureRuntime
): Promise<TextureExtractResult | null> {
  const texW = Math.floor(texture.width ?? 0);
  const texH = Math.floor(texture.height ?? 0);
  if (texW <= 0 || texH <= 0) return null;

  const rect: AtlasFrameRect = { x: 0, y: 0, w: texW, h: texH };
  const webgl = extractAtlasViaWebGL(texture, rect);
  if (webgl?.imageData && hasVisiblePixels(webgl.imageData)) {
    return { imageData: webgl.imageData, method: webgl.method };
  }

  const dom = resolveDomImage(texture);
  if (dom) {
    const fromDom = extractFromDomAtlas(dom, rect, 'dom-atlas');
    if (fromDom) return fromDom;
  }

  const fromUrl = await extractViaUrls(texture, rect);
  if (fromUrl) return fromUrl;

  const fromBuf = extractViaRawBuffer(texture, rect);
  if (fromBuf) return fromBuf;

  const full = await readFullAndCrop(texture, rect);
  if (full) {
    return { imageData: full, method: 'readPixels-full' };
  }

  return null;
}

export function clearTexturePixelCache(): void {
  pixelCache.clear();
  pendingReads.clear();
}

export { getTextureExtractDebugLog };
