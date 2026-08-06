/**
 * Egret 纹理提取：texture.$bitmapData + 图集区域 → PNG
 *
 * Egret Texture 关键内部字段（2.x/5.x 通用）：
 *   $bitmapData        源位图（HTMLImageElement / HTMLCanvasElement / ImageBitmap）
 *   $bitmapX/Y/W/H     该纹理在源位图（图集）中的区域
 *   $offsetX/Y         trim 偏移；$textureWidth/Height 为裁剪后逻辑尺寸
 *
 * 提取策略：按图集区域裁剪出子图（还原贴图所需），不做 trim 还原。
 * 跨域污染（canvas tainted）时 toDataURL 会抛错，向上返回明确错误。
 */
import type { EgretDisplayObject, EgretTextureLike } from './runtime';

export interface EgretTextureExtractResult {
  ok: true;
  base64: string;
  width: number;
  height: number;
  /** 提取来源说明（调试用） */
  method: string;
}

export type EgretTextureExtract =
  | EgretTextureExtractResult
  | { ok: false; error: string };

export function getNodeTexture(node: EgretDisplayObject): EgretTextureLike | null {
  return node.texture ?? node.$texture ?? null;
}

function getBitmapData(
  t: EgretTextureLike
): HTMLImageElement | HTMLCanvasElement | ImageBitmap | null {
  return t.$bitmapData ?? t._bitmapData ?? null;
}

type BitmapDataSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

function sourceSize(data: BitmapDataSource): { w: number; h: number } {
  if (data instanceof HTMLImageElement) {
    return { w: data.naturalWidth || data.width, h: data.naturalHeight || data.height };
  }
  if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) {
    return { w: data.width, h: data.height };
  }
  const c = data as HTMLCanvasElement;
  return { w: c.width, h: c.height };
}

/** 将单个 Egret Texture 提取为 PNG base64（按图集区域裁剪） */
export function extractTextureToPng(t: EgretTextureLike): EgretTextureExtract {
  try {
    const data = getBitmapData(t);
    if (!data) {
      return { ok: false, error: 'texture.$bitmapData 为空（可能已被引擎释放）' };
    }

    const src = sourceSize(data);
    const regionW = Number(t.$bitmapWidth ?? t.textureWidth ?? t.$textureWidth ?? src.w);
    const regionH = Number(t.$bitmapHeight ?? t.textureHeight ?? t.$textureHeight ?? src.h);
    const sx = Number(t.$bitmapX ?? 0);
    const sy = Number(t.$bitmapY ?? 0);

    if (!(regionW > 0) || !(regionH > 0)) {
      return { ok: false, error: `纹理尺寸非法 ${regionW}×${regionH}` };
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(regionW));
    canvas.height = Math.max(1, Math.round(regionH));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: '无法创建 2d context' };

    // drawImage 的 source rect 越界时部分浏览器会整体失败，做边界钳制
    const cw = Math.min(regionW, src.w - sx);
    const ch = Math.min(regionH, src.h - sy);
    if (cw <= 0 || ch <= 0) {
      return { ok: false, error: `图集区域越界 (${sx},${sy},${regionW},${regionH}) / 源 ${src.w}×${src.h}` };
    }

    ctx.drawImage(data as CanvasImageSource, sx, sy, cw, ch, 0, 0, cw, ch);

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    return {
      ok: true,
      base64,
      width: canvas.width,
      height: canvas.height,
      method: cw < regionW || ch < regionH ? 'canvas-clamped' : 'canvas-crop',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/tainted|cross-origin|insecure/i.test(msg)) {
      return { ok: false, error: `跨域纹理无法读取（canvas tainted）: ${msg}` };
    }
    return { ok: false, error: msg };
  }
}

/** 从显示对象（Bitmap/MovieClip）提取纹理 PNG */
export function extractNodeTextureToPng(node: EgretDisplayObject): EgretTextureExtract {
  const t = getNodeTexture(node);
  if (!t) return { ok: false, error: '节点无 texture（非 Bitmap/MovieClip）' };
  return extractTextureToPng(t);
}
