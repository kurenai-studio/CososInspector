import {
  findNodeById,
  getNodeName,
  getSceneRoot,
  type Cc2Node,
} from './sceneTree';

export interface Cc2FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cc2SpriteExtractResult {
  nodeId: string;
  nodeName: string;
  frameName: string;
  rect: Cc2FrameRect;
  isRotated: boolean;
  textureSize: { w: number; h: number };
  /** 展开旋转后的逻辑宽高 */
  frameSize: { w: number; h: number };
  canvas: HTMLCanvasElement;
  imageData: ImageData;
  method: string;
}

type TexLike = {
  width?: number;
  height?: number;
  getHtmlElementObj?: () => CanvasImageSource | null;
  getImpl?: () => { getHtmlElementObj?: () => CanvasImageSource | null };
  _image?: CanvasImageSource | { _data?: CanvasImageSource };
  _nativeAsset?: CanvasImageSource;
};

type FrameLike = {
  name?: string;
  _name?: string;
  getRect?: () => { x: number; y: number; width: number; height: number };
  getTexture?: () => TexLike | null;
  getOffset?: () => { x?: number; y?: number } | null;
  getOriginalSize?: () => { width?: number; height?: number } | null;
  isRotated?: (() => boolean) | boolean;
  _rect?: { x?: number; y?: number; width?: number; height?: number };
  _rotated?: boolean;
  _texture?: TexLike | null;
  _offset?: { x?: number; y?: number };
  offset?: { x?: number; y?: number };
  _originalSize?: { width?: number; height?: number };
  originalSize?: { width?: number; height?: number };
};

/**
 * 2.x SizeMode：CUSTOM=0 TRIMMED=1 RAW=2
 * 3.x SizeMode：TRIMMED=0 RAW=1 CUSTOM=2
 * 快照统一写 3.x 枚举，便于 scene-to-creator 直接消费。
 */
export const mapCc2SizeModeToCc3 = (mode: number): number => {
  if (mode === 0) return 2; // CUSTOM
  if (mode === 1) return 0; // TRIMMED
  if (mode === 2) return 1; // RAW
  return 0;
};

const resolveOffset = (frame: FrameLike): { x: number; y: number } => {
  try {
    if (typeof frame.getOffset === 'function') {
      const o = frame.getOffset();
      if (o) return { x: o.x ?? 0, y: o.y ?? 0 };
    }
  } catch {
    /* ignore */
  }
  const o = frame.offset ?? frame._offset;
  return { x: o?.x ?? 0, y: o?.y ?? 0 };
};

const resolveOriginalSize = (
  frame: FrameLike,
  fallback: { w: number; h: number }
): { w: number; h: number } => {
  try {
    if (typeof frame.getOriginalSize === 'function') {
      const s = frame.getOriginalSize();
      if (s && (s.width ?? 0) > 0 && (s.height ?? 0) > 0) {
        return { w: Math.floor(s.width!), h: Math.floor(s.height!) };
      }
    }
  } catch {
    /* ignore */
  }
  const s = frame.originalSize ?? frame._originalSize;
  if (s && (s.width ?? 0) > 0 && (s.height ?? 0) > 0) {
    return { w: Math.floor(s.width!), h: Math.floor(s.height!) };
  }
  return fallback;
};

type SpriteComp = {
  enabled?: boolean;
  _enabled?: boolean;
  sizeMode?: number;
  _sizeMode?: number;
  spriteFrame?: FrameLike | null;
  _spriteFrame?: FrameLike | null;
};

const isSpriteClass = (cn: string): boolean =>
  cn === 'cc.Sprite' || cn.endsWith('.Sprite') || cn === 'Sprite';

export function getSpriteComponent(node: Cc2Node): SpriteComp | null {
  try {
    const Sprite = (window.cc as { Sprite?: { new (): unknown } } | undefined)
      ?.Sprite;
    if (Sprite && typeof node.getComponents === 'function') {
      // getComponent 在 2.x 上更常见
      const n = node as Cc2Node & {
        getComponent?: (c: unknown) => unknown;
      };
      if (typeof n.getComponent === 'function') {
        const comp = n.getComponent(Sprite) as SpriteComp | null;
        if (comp) return comp;
      }
    }
  } catch {
    /* ignore */
  }

  const comps = node._components ?? [];
  return (
    (comps.find((c) => {
      const cn =
        (c as { __classname__?: string }).__classname__ ??
        (c as { constructor?: { name?: string } }).constructor?.name ??
        '';
      return isSpriteClass(cn);
    }) as SpriteComp) ?? null
  );
}

export function nodeHasSprite(node: Cc2Node): boolean {
  const comp = getSpriteComponent(node);
  return !!(comp?.spriteFrame || comp?._spriteFrame);
}

function resolveFrame(comp: SpriteComp): FrameLike | null {
  return comp.spriteFrame ?? comp._spriteFrame ?? null;
}

function resolveRect(frame: FrameLike): Cc2FrameRect | null {
  try {
    if (typeof frame.getRect === 'function') {
      const r = frame.getRect();
      return {
        x: Math.floor(r.x),
        y: Math.floor(r.y),
        w: Math.floor(r.width),
        h: Math.floor(r.height),
      };
    }
  } catch {
    /* ignore */
  }
  const r = frame._rect;
  if (!r) return null;
  return {
    x: Math.floor(r.x ?? 0),
    y: Math.floor(r.y ?? 0),
    w: Math.floor(r.width ?? 0),
    h: Math.floor(r.height ?? 0),
  };
}

function resolveRotated(frame: FrameLike): boolean {
  if (typeof frame.isRotated === 'function') {
    try {
      return !!frame.isRotated();
    } catch {
      /* ignore */
    }
  }
  if (typeof frame.isRotated === 'boolean') return frame.isRotated;
  return !!frame._rotated;
}

function resolveTexture(frame: FrameLike): TexLike | null {
  try {
    if (typeof frame.getTexture === 'function') {
      const t = frame.getTexture();
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  return frame._texture ?? null;
}

function resolveImageSource(tex: TexLike): CanvasImageSource | null {
  try {
    if (typeof tex.getHtmlElementObj === 'function') {
      const el = tex.getHtmlElementObj();
      if (el) return el;
    }
  } catch {
    /* ignore */
  }
  try {
    const impl = tex.getImpl?.();
    const el = impl?.getHtmlElementObj?.();
    if (el) return el;
  } catch {
    /* ignore */
  }
  const img = tex._image;
  if (img && typeof img === 'object' && '_data' in img) {
    return (img as { _data?: CanvasImageSource })._data ?? null;
  }
  if (img && (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement || img instanceof ImageBitmap)) {
    return img;
  }
  if (tex._nativeAsset) return tex._nativeAsset;
  return null;
}

function waitImage(src: CanvasImageSource): Promise<void> {
  if (src instanceof HTMLImageElement) {
    if (src.complete && src.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      src.addEventListener('load', () => resolve(), { once: true });
      src.addEventListener('error', () => reject(new Error('image load failed')), {
        once: true,
      });
    });
  }
  return Promise.resolve();
}

/**
 * TexturePacker / Cocos 2.x：isRotated 表示图集内顺时针 90° 存放。
 * 导出时逆时针转回逻辑宽高。
 */
function cropFrame(
  src: CanvasImageSource,
  rect: Cc2FrameRect,
  rotated: boolean
): HTMLCanvasElement {
  const outW = rotated ? rect.h : rect.w;
  const outH = rotated ? rect.w : rect.h;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, outW);
  canvas.height = Math.max(1, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2d context');

  if (rotated) {
    ctx.translate(0, outH);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(
      src,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      0,
      0,
      rect.w,
      rect.h
    );
  } else {
    ctx.drawImage(
      src,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      0,
      0,
      rect.w,
      rect.h
    );
  }
  return canvas;
}

/** 仅元数据（不读像素），供场景快照 / listSprites */
export function collectSpriteFrameMeta(nodeId: string): {
  frameName: string;
  rect: Cc2FrameRect;
  isRotated: boolean;
  textureSize: { w: number; h: number };
  frameSize: { w: number; h: number };
  originalSize: { w: number; h: number };
  offset: { x: number; y: number };
  /** 已映射为 3.x SizeMode */
  sizeMode: number;
  enabled: boolean;
} | null {
  const scene = getSceneRoot();
  if (!scene) return null;
  const node = findNodeById(scene, nodeId);
  if (!node) return null;
  const comp = getSpriteComponent(node);
  if (!comp) return null;
  const frame = resolveFrame(comp);
  if (!frame) return null;
  const rect = resolveRect(frame);
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;
  const rotated = resolveRotated(frame);
  const tex = resolveTexture(frame);
  const outW = rotated ? rect.h : rect.w;
  const outH = rotated ? rect.w : rect.h;
  const frameSize = { w: outW, h: outH };
  const rawMode =
    typeof comp.sizeMode === 'number'
      ? comp.sizeMode
      : typeof comp._sizeMode === 'number'
        ? comp._sizeMode
        : 0;
  const enabled =
    typeof comp.enabled === 'boolean'
      ? comp.enabled
      : typeof comp._enabled === 'boolean'
        ? comp._enabled
        : true;
  return {
    frameName: frame.name || frame._name || '(sprite)',
    rect,
    isRotated: rotated,
    textureSize: {
      w: Math.floor(tex?.width ?? 0),
      h: Math.floor(tex?.height ?? 0),
    },
    frameSize,
    originalSize: resolveOriginalSize(frame, frameSize),
    offset: resolveOffset(frame),
    sizeMode: mapCc2SizeModeToCc3(rawMode),
    enabled,
  };
}

export async function extractSpriteFrame(
  nodeId: string
): Promise<Cc2SpriteExtractResult | null> {
  const scene = getSceneRoot();
  if (!scene) return null;
  const node = findNodeById(scene, nodeId);
  if (!node) return null;

  const comp = getSpriteComponent(node);
  if (!comp) return null;
  const frame = resolveFrame(comp);
  if (!frame) return null;

  const rect = resolveRect(frame);
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;

  const tex = resolveTexture(frame);
  if (!tex) return null;

  const src = resolveImageSource(tex);
  if (!src) {
    console.warn(
      `[纹理提取:2.x] ${getNodeName(node)}(${nodeId}) - 无 HTML 图像源`
    );
    return null;
  }

  try {
    await waitImage(src);
  } catch (e) {
    console.error(
      `[纹理提取:2.x] ${getNodeName(node)}(${nodeId}) - 图像未就绪`,
      e
    );
    return null;
  }

  const rotated = resolveRotated(frame);
  const canvas = cropFrame(src, rect, rotated);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const frameName =
    frame.name || frame._name || '(sprite)';
  const texW = Math.floor(tex.width ?? 0);
  const texH = Math.floor(tex.height ?? 0);

  console.log(
    `[纹理提取:2.x] ${getNodeName(node)}(${nodeId}) - ${frameName}` +
      ` rect=${rect.w}x${rect.h}@${rect.x},${rect.y}` +
      ` rotated=${rotated} → ${canvas.width}x${canvas.height}`
  );

  return {
    nodeId,
    nodeName: getNodeName(node),
    frameName,
    rect,
    isRotated: rotated,
    textureSize: { w: texW, h: texH },
    frameSize: { w: canvas.width, h: canvas.height },
    canvas,
    imageData,
    method: rotated ? 'dom-crop-unrotate' : 'dom-crop',
  };
}

export function downloadExtractPng(result: Cc2SpriteExtractResult): void {
  const safe = (s: string) =>
    s.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_') || 'sprite';
  const filename = `${safe(result.nodeName)}_${safe(result.frameName)}.png`;
  const url = result.canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
