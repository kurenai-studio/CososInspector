/**
 * 与 Cocos SpriteFrame 提交 draw 语义对齐的纹理重建：
 * pack rect 裁切 → 旋转展开 → originalSize 画布 + trim 偏移
 */

import { logTextureExtract } from './textureExtractLog';
import type { SpriteFrameRuntime, TextureExtractResult } from './textureExtract';
import { resolveDisplaySize, resolveFrameRect } from './textureExtract';
import { bakeSpriteFrameViaEngine } from './textureBake';
import type { ExtractPathTrace } from './textureExtractTrace';
import {
  createPathTrace,
  measureOpaqueBBox,
  snapshotFrameCalc,
  traceFinish,
  traceStep,
} from './textureExtractTrace';
import { findNodeById, getSceneRoot } from './sceneTree';
import {
  cropAtlasRegion,
  extractAtlasViaWebGL,
  readFullAtlasImageData,
} from './textureWebGL';

const resolveLogCtx = (
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

const readOffset = (frame: SpriteFrameRuntime): { x: number; y: number } => {
  const o = frame.offset as { x?: number; y?: number } | undefined;
  return { x: o?.x ?? 0, y: o?.y ?? 0 };
};

const opaqueCoverage = (img: ImageData): number => {
  const box = measureOpaqueBBox(img);
  return box?.coverage ?? 0;
};

const unrotateCw = (img: ImageData, lw: number, lh: number): ImageData => {
  const pw = img.width;
  const ph = img.height;
  const out = new Uint8ClampedArray(lw * lh * 4);
  for (let py = 0; py < ph; py += 1) {
    for (let px = 0; px < pw; px += 1) {
      const si = (py * pw + px) * 4;
      const lx = py;
      const ly = pw - 1 - px;
      const di = (ly * lw + lx) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return new ImageData(out, lw, lh);
};

const unrotateCcw = (img: ImageData, lw: number, lh: number): ImageData => {
  const pw = img.width;
  const ph = img.height;
  const out = new Uint8ClampedArray(lw * lh * 4);
  for (let py = 0; py < ph; py += 1) {
    for (let px = 0; px < pw; px += 1) {
      const si = (py * pw + px) * 4;
      const lx = ph - 1 - py;
      const ly = px;
      const di = (ly * lw + lx) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return new ImageData(out, lw, lh);
};

const resolveRotatedWithTrace = (
  packed: ImageData,
  fw: number,
  fh: number
): { image: ImageData; picked: 'cw' | 'ccw'; cwCoverage: number; ccwCoverage: number } => {
  const cw = unrotateCw(packed, fw, fh);
  const ccw = unrotateCcw(packed, fw, fh);
  const cwCoverage = opaqueCoverage(cw);
  const ccwCoverage = opaqueCoverage(ccw);
  // TexturePacker/Cocos isRotated：图集内顺时针 90° 存放。
  // unrotateCw() 与常见 TP 还原一致；coverage 对文字帧几乎相同，旧逻辑平局默认
  // ccw 会导致整帧倒立（jpbar_major 已实证）。固定走 cw，不再用 coverage 选型。
  const picked: 'cw' | 'ccw' = 'cw';
  return {
    image: cw,
    picked,
    cwCoverage,
    ccwCoverage,
  };
};

const compositeOnOriginal = (
  frameImg: ImageData,
  ow: number,
  oh: number,
  trimX: number,
  trimY: number
): ImageData => {
  const out = new Uint8ClampedArray(ow * oh * 4);
  const fd = frameImg.data;
  const fw = frameImg.width;
  const fh = frameImg.height;
  for (let y = 0; y < fh; y += 1) {
    for (let x = 0; x < fw; x += 1) {
      const dstX = trimX + x;
      const dstY = trimY + y;
      if (dstX < 0 || dstY < 0 || dstX >= ow || dstY >= oh) continue;
      const si = (y * fw + x) * 4;
      const di = (dstY * ow + dstX) * 4;
      out[di] = fd[si];
      out[di + 1] = fd[si + 1];
      out[di + 2] = fd[si + 2];
      out[di + 3] = fd[si + 3];
    }
  }
  return new ImageData(out, ow, oh);
};

export const extractEngineAlignedFramePixels = async (
  frame: SpriteFrameRuntime,
  texSize: { w: number; h: number },
  nodeId?: string | null,
  traceOut?: ExtractPathTrace
): Promise<TextureExtractResult | null> => {
  const texture = frame.texture ?? frame._texture;
  if (!texture) return null;

  const texW = Math.floor(texture.width ?? texSize.w);
  const texH = Math.floor(texture.height ?? texSize.h);
  const rect = resolveFrameRect(frame, texW, texH);
  if (rect.w <= 0 || rect.h <= 0) return null;

  const logCtx = resolveLogCtx(nodeId, frame);
  const calcMeta = snapshotFrameCalc(frame, texW, texH);
  const trace = traceOut ?? createPathTrace('engine', calcMeta);
  const isRotatedFlag = calcMeta.isRotated;
  const offset = readOffset(frame);
  const fw = rect.w;
  const fh = rect.h;
  const ow = calcMeta.originalSize.w;
  const oh = calcMeta.originalSize.h;
  const trimX = Math.round((ow - fw) / 2 + offset.x);
  const trimY = Math.round((oh - fh) / 2 - offset.y);
  const atlasRect = { x: rect.x, y: rect.y, w: fw, h: fh };
  // 以 UV 实际占位为准：RSG 常把未旋转竖长帧误标 isRotated（bg_front UV=864×1800
  // 却 flag=true）。UV≈逻辑尺寸→直裁；UV≈交换尺寸→真旋转再 unrotate。
  const approxEq = (a: number, b: number, tol = 2.5) => Math.abs(a - b) <= tol;
  let uvAtlas: { w: number; h: number } | null = null;
  let actualRotated = isRotatedFlag;
  const uv = calcMeta.uv;
  if (uv && uv.length >= 8 && texW > 0 && texH > 0) {
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
    const uvW = (maxU - minU) * texW;
    const uvH = (maxV - minV) * texH;
    uvAtlas = { w: uvW, h: uvH };
    const matchLogical = approxEq(uvW, fw) && approxEq(uvH, fh);
    const matchPacked = approxEq(uvW, fh) && approxEq(uvH, fw);
    if (matchPacked && !matchLogical) actualRotated = true;
    else if (matchLogical && !matchPacked) actualRotated = false;
  }
  const packedRect = actualRotated
    ? { x: rect.x, y: rect.y, w: fh, h: fw }
    : atlasRect;
  // 真旋转但 packed 越界时退回直裁（如误标竖长帧放不进窄图集）
  const packedFits =
    packedRect.x >= 0 &&
    packedRect.y >= 0 &&
    packedRect.x + packedRect.w <= texW + 0.5 &&
    packedRect.y + packedRect.h <= texH + 0.5;
  const effectiveRotated = !!(actualRotated && packedFits);
  const cropTarget = effectiveRotated ? packedRect : atlasRect;

  traceStep(logCtx, trace, 'meta', {
    ...calcMeta,
    fw,
    fh,
    trimX,
    trimY,
    trimFormula: {
      trimX: `(ow-fw)/2+ox = (${ow}-${fw})/2+${offset.x}`,
      trimY: `(oh-fh)/2-oy = (${oh}-${fh})/2-${offset.y}`,
    },
    atlasRect,
    packedRect,
    effectiveRotated,
    packedFits,
    actualRotated,
    isRotatedFlag,
    uvAtlas,
  });

  logTextureExtract(logCtx, '引擎对齐：开始', {
    method: 'engine-trim',
    frameRect: rect,
    pixelSize: { w: ow, h: oh },
    detail: {
      isRotated: isRotatedFlag,
      actualRotated,
      effectiveRotated,
      packedFits,
      uvAtlas,
      fw,
      fh,
      trimX,
      trimY,
      offset,
      packedRect,
      cropTarget,
    },
  });

  try {
    // 大图集：优先 rect 区域 GPU 拷贝（已验证可还原压缩图集符号），失败再 bake
    const largeAtlas = texW * texH >= 1024 * 1024;
    let framePixels: ImageData | null = null;
    let cropMode: 'atlas-direct' | 'packed-unrotate' | 'engine-bake' =
      'atlas-direct';

    framePixels =
      extractAtlasViaWebGL(texture, cropTarget)?.imageData ?? null;

    if (!framePixels && !largeAtlas) {
      const atlas = readFullAtlasImageData(texture, texW, texH);
      if (atlas) {
        traceStep(logCtx, trace, 'read-atlas', { texW, texH }, {
          pixelSize: { w: atlas.width, h: atlas.height },
        });
        framePixels = cropAtlasRegion(atlas.data, texW, texH, cropTarget);
      }
    }

    if (!framePixels) {
      const baked = await bakeSpriteFrameViaEngine(frame, { w: ow, h: oh });
      if (baked && baked.width > 0 && baked.height > 0) {
        cropMode = 'engine-bake';
        traceStep(
          logCtx,
          trace,
          'bake-fallback',
          { ow, oh },
          {
            pixelSize: { w: baked.width, h: baked.height },
            opaque: measureOpaqueBBox(baked),
          }
        );
        traceFinish(logCtx, trace, 'engine-bake', baked);
        logTextureExtract(logCtx, '引擎对齐：bake 兜底成功', {
          method: 'engine-bake',
          pixelSize: { w: baked.width, h: baked.height },
        });
        return { imageData: baked, method: 'engine-bake' };
      }
      traceFinish(logCtx, trace, 'failed-read-atlas', null);
      logTextureExtract(logCtx, '引擎对齐：区域拷贝与 bake 均失败', {
        level: 'error',
        method: 'engine-trim',
      });
      return null;
    }

    if (effectiveRotated) {
      cropMode = 'packed-unrotate';
      traceStep(
        logCtx,
        trace,
        'crop-packed',
        { packedRect: cropTarget },
        {
          pixelSize: { w: framePixels.width, h: framePixels.height },
          opaque: measureOpaqueBBox(framePixels),
        }
      );
      const unr = resolveRotatedWithTrace(framePixels, fw, fh);
      framePixels = unr.image;
      traceStep(
        logCtx,
        trace,
        'unrotate',
        { fw, fh, packedSize: { w: cropTarget.w, h: cropTarget.h } },
        {
          picked: unr.picked,
          cwCoverage: unr.cwCoverage,
          ccwCoverage: unr.ccwCoverage,
          pixelSize: { w: framePixels.width, h: framePixels.height },
          opaque: measureOpaqueBBox(framePixels),
        }
      );
    } else {
      traceStep(
        logCtx,
        trace,
        'crop-atlas',
        { atlasRect, isRotatedFlag, actualRotated },
        {
          pixelSize: { w: framePixels.width, h: framePixels.height },
          opaque: measureOpaqueBBox(framePixels),
        }
      );
    }

    const canvas = compositeOnOriginal(framePixels, ow, oh, trimX, trimY);
    traceStep(
      logCtx,
      trace,
      'composite',
      { ow, oh, trimX, trimY, framePixels: { w: framePixels.width, h: framePixels.height } },
      {
        pixelSize: { w: canvas.width, h: canvas.height },
        opaque: measureOpaqueBBox(canvas),
      }
    );

    traceFinish(logCtx, trace, 'engine-trim', canvas);
    logTextureExtract(logCtx, '引擎对齐：成功', {
      method: 'engine-trim',
      pixelSize: { w: canvas.width, h: canvas.height },
      detail: {
        framePixels: { w: framePixels.width, h: framePixels.height },
        cropMode,
        isRotated: isRotatedFlag,
        actualRotated,
        effectiveRotated,
      },
    });

    return { imageData: canvas, method: 'engine-trim' };
  } catch (e) {
    traceFinish(logCtx, trace, 'failed-exception', null);
    logTextureExtract(logCtx, '引擎对齐：异常', {
      level: 'error',
      method: 'engine-trim',
      detail: { error: e instanceof Error ? e.message : String(e) },
    });
    return null;
  }
};
