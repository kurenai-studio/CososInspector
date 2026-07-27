import type { AtlasFrameRect, TextureRuntime } from './textureExtract';

export type WebGLExtractMethod = 'webgl-fbo' | 'device-copy';

let lastDebugLog: string[] = [];

export function getTextureExtractDebugLog(): string[] {
  return [...lastDebugLog];
}

function logStep(msg: string): void {
  lastDebugLog.push(msg);
  if (lastDebugLog.length > 12) lastDebugLog.shift();
}

export function clearTextureExtractDebugLog(): void {
  lastDebugLog = [];
}

export function getGameGl(): WebGLRenderingContext | null {
  const ccg = window.cc as {
    game?: { canvas?: HTMLCanvasElement };
  };
  const canvas =
    ccg.game?.canvas ??
    (document.getElementById('GameCanvas') as HTMLCanvasElement | null) ??
    document.querySelector('canvas');
  if (!canvas) return null;
  return (
    (canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
    }) as WebGLRenderingContext | null) ??
    canvas.getContext('webgl', { preserveDrawingBuffer: true })
  );
}

function resolveGlTexture(tex: TextureRuntime): WebGLTexture | null {
  const t = tex as Record<string, unknown>;
  const chains: unknown[] = [
    typeof t.getGFXTexture === 'function' ? (t.getGFXTexture as () => unknown)() : null,
    t._getGFXTexture,
    t._gfxTexture,
    t.gpuTexture,
    (t._texture as Record<string, unknown> | undefined)?._gfxTexture,
  ];

  for (const gfx of chains) {
    if (!gfx || typeof gfx !== 'object') continue;
    const g = gfx as Record<string, unknown>;
    const glTex = g.glTexture ?? g._glTexture;
    if (glTex instanceof WebGLTexture) return glTex;
    const gpu = g.gpuTexture as Record<string, unknown> | undefined;
    if (gpu?.glTexture instanceof WebGLTexture) {
      return gpu.glTexture as WebGLTexture;
    }
  }
  return null;
}

function cropAtlasFromFullRgba(
  pixels: Uint8Array,
  texW: number,
  texH: number,
  rect: AtlasFrameRect,
  yFromBottom: boolean
): ImageData | null {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  let any = false;
  for (let row = 0; row < rect.h; row++) {
    for (let col = 0; col < rect.w; col++) {
      const srcY = yFromBottom ? texH - rect.y - rect.h + row : rect.y + row;
      const srcX = rect.x + col;
      if (srcX < 0 || srcY < 0 || srcX >= texW || srcY >= texH) continue;
      const si = (srcY * texW + srcX) * 4;
      const di = (row * rect.w + col) * 4;
      out[di] = pixels[si];
      out[di + 1] = pixels[si + 1];
      out[di + 2] = pixels[si + 2];
      out[di + 3] = pixels[si + 3];
      if (out[di + 3] > 0 || out[di] > 0) any = true;
    }
  }
  if (!any) return null;
  return new ImageData(out, rect.w, rect.h);
}

/** 不透明像素占比（用于 Y 原点 / 双裁择优） */
function opaqueCoverage(img: ImageData | null): number {
  if (!img) return 0;
  const d = img.data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i]! > 8) opaque += 1;
  }
  return opaque / (img.width * img.height);
}

/**
 * 顶左优先；仅当顶左裁切近空时再试底原点。
 * 注意：两侧裁的是图集不同区域，不能用覆盖率互比（否则会误选密实 UI 碎片）。
 */
function pickCropByYOrigin(
  pixels: Uint8Array,
  texW: number,
  texH: number,
  rect: AtlasFrameRect
): ImageData | null {
  const top = cropAtlasFromFullRgba(pixels, texW, texH, rect, false);
  if (opaqueCoverage(top) > 0.01) return top;
  const bottom = cropAtlasFromFullRgba(pixels, texW, texH, rect, true);
  if (opaqueCoverage(bottom) > 0) return bottom;
  return top ?? bottom;
}

/** WebGL readPixels 为底原点，翻成顶左后再按 Cocos rect 裁切 */
function flipRgbaVertical(buf: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(buf.length);
  for (let row = 0; row < h; row++) {
    const srcRow = h - 1 - row;
    const srcOff = srcRow * w * 4;
    const dstOff = row * w * 4;
    out.set(buf.subarray(srcOff, srcOff + w * 4), dstOff);
  }
  return out;
}

function readViaWebGLFbo(
  gl: WebGLRenderingContext,
  glTex: WebGLTexture,
  texW: number,
  texH: number,
  rect: AtlasFrameRect
): ImageData | null {
  const fb = gl.createFramebuffer();
  if (!fb) return null;

  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      glTex,
      0
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      logStep(`webgl-fbo: incomplete ${status}`);
      return null;
    }

    const full = new Uint8Array(texW * texH * 4);
    gl.readPixels(0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, full);
    // readPixels 底原点 → 翻成顶左，再按 Cocos frame.rect 裁切
    const topDown = flipRgbaVertical(full, texW, texH);
    return cropAtlasFromFullRgba(topDown, texW, texH, rect, false);
  } catch (e) {
    logStep(`webgl-fbo: ${e}`);
    return null;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
  }
}

function readViaDeviceCopy(
  texture: TextureRuntime,
  texW: number,
  texH: number,
  rect: AtlasFrameRect
): ImageData | null {
  const ccg = window.cc as {
    director?: { root?: { device?: DeviceLike } };
  };
  const device = ccg.director?.root?.device;
  if (!device?.copyTextureToBuffers) return null;

  const gfxTex =
    typeof (texture as { getGFXTexture?: () => unknown }).getGFXTexture ===
    'function'
      ? (texture as { getGFXTexture: () => unknown }).getGFXTexture()
      : null;
  if (!gfxTex) return null;

  try {
    const fullBuf = new Uint8Array(texW * texH * 4);
    device.copyTextureToBuffers(
      gfxTex,
      [fullBuf],
      [{ x: 0, y: 0, width: texW, height: texH }]
    );
    // WebGL 后端 copy 多为底原点，与 readPixels 一致：先翻成顶左再裁
    const topDown = flipRgbaVertical(fullBuf, texW, texH);
    const flipped = cropAtlasFromFullRgba(topDown, texW, texH, rect, false);
    if (opaqueCoverage(flipped) > 0.01) return flipped;
    // 少数顶左设备：回退未翻转
    return cropAtlasFromFullRgba(fullBuf, texW, texH, rect, false);
  } catch (e) {
    logStep(`device-copy: ${e}`);
    return null;
  }
}

/** 从当前屏幕帧缓冲读取节点可视区域（精灵已在画面上时最有效） */
export function readVisibleSpriteFromScreen(
  node: cc.Node,
  outW: number,
  outH: number
): ImageData | null {
  const gl = getGameGl();
  if (!gl) return null;

  const ccg = window.cc as Record<string, unknown>;
  const UITransform = ccg.UITransform as UITransformLike | undefined;
  if (!UITransform || typeof node.getComponent !== 'function') return null;

  const ui = node.getComponent(UITransform) as UITransformLike | null;
  if (!ui?.getBoundingBoxToWorld) return null;

  const bbox = ui.getBoundingBoxToWorld();
  const canvas = gl.canvas as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;

  const view = (ccg.view as { getScaleX?: () => number }) ?? {};
  const scaleX = view.getScaleX?.() ?? 1;
  const scaleY = (view as { getScaleY?: () => number }).getScaleY?.() ?? 1;

  const x = Math.floor(bbox.x * scaleX * dpr);
  const y = Math.floor(bbox.y * scaleY * dpr);
  const w = Math.max(1, Math.floor(bbox.width * scaleX * dpr));
  const h = Math.max(1, Math.floor(bbox.height * scaleY * dpr));

  if (w > 4096 || h > 4096) return null;

  try {
    const buf = new Uint8Array(w * h * 4);
    const glY = canvas.height - y - h;
    gl.readPixels(x, glY, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    const imageData = flipBufferToImageData(buf, w, h);
    if (!imageData) return null;

    return scaleImageData(imageData, outW, outH);
  } catch (e) {
    logStep(`screen-fbo: ${e}`);
    return null;
  }
}

type UITransformLike = {
  getBoundingBoxToWorld: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type DeviceLike = {
  copyTextureToBuffers: (
    texture: unknown,
    buffers: ArrayBufferView[],
    regions: unknown[]
  ) => void;
};

/** Cocos 3.x BufferTextureCopy 区域（仅拷 rect，避免整张 2048 卡死） */
function buildBufferTextureCopyRegion(rect: AtlasFrameRect): unknown {
  return {
    texOffset: { x: rect.x, y: rect.y, z: 0 },
    texExtent: { width: rect.w, height: rect.h, depth: 1 },
    texSubres: { mipLevel: 0, baseArrayLayer: 0, layerCount: 1 },
    buffOffset: 0,
    buffStride: 0,
    buffTexHeight: 0,
  };
}

function readViaDeviceRegionCopy(
  texture: TextureRuntime,
  rect: AtlasFrameRect
): ImageData | null {
  const ccg = window.cc as {
    director?: { root?: { device?: DeviceLike } };
  };
  const device = ccg.director?.root?.device;
  if (!device?.copyTextureToBuffers) return null;

  const gfxTex =
    typeof (texture as { getGFXTexture?: () => unknown }).getGFXTexture ===
    'function'
      ? (texture as { getGFXTexture: () => unknown }).getGFXTexture()
      : null;
  if (!gfxTex || rect.w <= 0 || rect.h <= 0) return null;

  try {
    const buf = new Uint8Array(rect.w * rect.h * 4);
    device.copyTextureToBuffers(gfxTex, [buf], [
      buildBufferTextureCopyRegion(rect),
    ]);
    const raw = new ImageData(new Uint8ClampedArray(buf), rect.w, rect.h);
    const flipped = new ImageData(
      new Uint8ClampedArray(flipRgbaVertical(buf, rect.w, rect.h)),
      rect.w,
      rect.h
    );
    const rawCov = opaqueCoverage(raw);
    const flipCov = opaqueCoverage(flipped);
    if (rawCov <= 0 && flipCov <= 0) return null;
    // 区域 copy 原点因后端而异：覆盖率择优（同一逻辑区域的两种行序）
    return flipCov > rawCov + 0.02 ? flipped : raw;
  } catch (e) {
    logStep(`device-region: ${e}`);
    return null;
  }
}

function flipBufferToImageData(
  buf: Uint8Array,
  w: number,
  h: number
): ImageData | null {
  const out = new Uint8ClampedArray(buf.length);
  for (let row = 0; row < h; row++) {
    const srcRow = h - 1 - row;
    for (let col = 0; col < w; col++) {
      const si = (srcRow * w + col) * 4;
      const di = (row * w + col) * 4;
      out[di] = buf[si];
      out[di + 1] = buf[si + 1];
      out[di + 2] = buf[si + 2];
      out[di + 3] = buf[si + 3];
    }
  }
  return new ImageData(out, w, h);
}

function scaleImageData(src: ImageData, tw: number, th: number): ImageData {
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  const ctx = c.getContext('2d');
  if (!ctx) return src;
  const tmp = document.createElement('canvas');
  tmp.width = src.width;
  tmp.height = src.height;
  tmp.getContext('2d')!.putImageData(src, 0, 0);
  ctx.drawImage(tmp, 0, 0, tw, th);
  return ctx.getImageData(0, 0, tw, th);
}

export function extractAtlasViaWebGL(
  texture: TextureRuntime,
  rect: AtlasFrameRect
): { imageData: ImageData; method: WebGLExtractMethod } | null {
  const texW = Math.floor(texture.width ?? 0);
  const texH = Math.floor(texture.height ?? 0);
  if (texW <= 0 || texH <= 0) return null;

  // 大图集：只拷 rect 区域，禁止整图回读（会卡死/超时）
  const largeAtlas = texW * texH >= 1024 * 1024;
  if (largeAtlas) {
    const region = readViaDeviceRegionCopy(texture, rect);
    if (region) {
      logStep('device-region: ok (large atlas)');
      return { imageData: region, method: 'device-copy' };
    }
    logStep('webgl: large atlas region-copy failed');
    return null;
  }

  const fromDevice = readViaDeviceCopy(texture, texW, texH, rect);
  if (fromDevice) {
    logStep('device-copy: ok');
    return { imageData: fromDevice, method: 'device-copy' };
  }

  // 小图集也可先试区域 copy（更快）
  const region = readViaDeviceRegionCopy(texture, rect);
  if (region) {
    logStep('device-region: ok');
    return { imageData: region, method: 'device-copy' };
  }

  const gl = getGameGl();
  const glTex = resolveGlTexture(texture);
  if (!gl || !glTex) {
    logStep('webgl-fbo: no gl or texture');
    return null;
  }

  const fromFbo = readViaWebGLFbo(gl, glTex, texW, texH, rect);
  if (fromFbo) {
    logStep('webgl-fbo: ok');
    return { imageData: fromFbo, method: 'webgl-fbo' };
  }

  return null;
}

/** 读取整张图集像素（供引擎对齐裁切使用） */
export function readFullAtlasImageData(
  texture: TextureRuntime,
  texW: number,
  texH: number
): ImageData | null {
  if (texW <= 0 || texH <= 0) return null;
  const fullRect: AtlasFrameRect = { x: 0, y: 0, w: texW, h: texH };
  const r = extractAtlasViaWebGL(texture, fullRect);
  return r?.imageData ?? null;
}

/** 从整图集缓冲裁切区域（顶/底原点双裁按覆盖率择优） */
export function cropAtlasRegion(
  pixels: Uint8ClampedArray,
  texW: number,
  texH: number,
  rect: AtlasFrameRect
): ImageData | null {
  return pickCropByYOrigin(pixels, texW, texH, rect);
}
