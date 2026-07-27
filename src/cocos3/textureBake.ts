import type { AtlasFrameRect } from './textureExtract';

/** 通过引擎 RenderTexture 渲染 SpriteFrame（可解码压缩图集） */
export async function bakeSpriteFrameViaEngine(
  spriteFrame: object,
  outputSize: { w: number; h: number }
): Promise<ImageData | null> {
  const ccg = window.cc as Record<string, unknown>;
  const RenderTexture = ccg.RenderTexture as RenderTextureCtor | undefined;
  const Camera = ccg.Camera as CameraCtor | undefined;
  const Node = ccg.Node as NodeCtor | undefined;
  const Sprite = ccg.Sprite as SpriteCtor | undefined;
  const UITransform = ccg.UITransform as UITransformCtor | undefined;
  const director = ccg.director as DirectorLike | undefined;
  const game = ccg.game as GameLike | undefined;
  const gfx = ccg.gfx as { ClearFlagBit?: { COLOR: number } } | undefined;
  const Color = ccg.Color as ColorCtor | undefined;

  if (!RenderTexture || !Camera || !Node || !Sprite || !director) {
    return null;
  }

  const w = Math.max(1, Math.min(512, Math.floor(outputSize.w)));
  const h = Math.max(1, Math.min(512, Math.floor(outputSize.h)));

  const sf = spriteFrame as {
    width?: number;
    height?: number;
    originalSize?: { width?: number; height?: number };
  };
  const ow = Math.floor(sf.originalSize?.width ?? sf.width ?? outputSize.w);
  const oh = Math.floor(sf.originalSize?.height ?? sf.height ?? outputSize.h);

  let root: NodeInstance | null = null;

  try {
    const rt = new RenderTexture();
    rt.reset({ width: w, height: h });

    root = new Node('__CocosInspector_Capture__') as NodeInstance;

    const camNode = new Node('__CocosInspector_Cam__') as NodeInstance;
    const cam = camNode.addComponent(Camera) as CameraInstance;

    const ProjectionType = (Camera as unknown as { ProjectionType?: { ORTHO: number } })
      .ProjectionType;
    const ClearFlag = (Camera as unknown as { ClearFlag?: { COLOR: number } }).ClearFlag;

    cam.targetTexture = rt;
    cam.projection = ProjectionType?.ORTHO ?? 0;
    cam.orthoHeight = Math.max(h / 2, 1);
    cam.near = 0.01;
    cam.far = 2000;
    cam.priority = 65535;
    cam.visibility = 0xffffffff;
    cam.clearFlags = ClearFlag?.COLOR ?? gfx?.ClearFlagBit?.COLOR ?? 7;
    if (Color) {
      cam.clearColor = new Color(0, 0, 0, 0);
    }

    const spNode = new Node('__CocosInspector_Sp__') as NodeInstance;
    spNode.layer = 1 << 25;
    const sp = spNode.addComponent(Sprite) as SpriteInstance;
    sp.spriteFrame = spriteFrame as never;
    sp.enabled = true;

    if (UITransform) {
      const ui = spNode.addComponent(UITransform) as UITransformInstance;
      ui.setContentSize(ow, oh);
    }

    camNode.setPosition(0, 0, 500);
    spNode.setPosition(0, 0, 0);
    camNode.parent = root;
    spNode.parent = root;

    const parent = director.getScene?.() ?? director.root;
    if (!parent?.addChild) return null;
    parent.addChild(root);

    await forceEngineRender(director, game, 3);

    let buf: ArrayBufferView | null = null;
    if (typeof rt.readPixels === 'function') {
      const readPromise = Promise.resolve(rt.readPixels(0, 0, w, h));
      const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 5000);
      });
      buf = (await Promise.race([readPromise, timeout])) as ArrayBufferView | null;
    }
    if (!buf && typeof (rt as { readPixelsSync?: () => unknown }).readPixelsSync === 'function') {
      buf = (rt as { readPixelsSync: () => ArrayBufferView }).readPixelsSync();
    }
    if (!buf) return null;

    return bufferToImageDataFlipY(buf, w, h);
  } catch {
    return null;
  } finally {
    try {
      root?.destroy?.();
    } catch {
      /* ignore */
    }
  }
}

async function forceEngineRender(
  director: DirectorLike,
  game: GameLike | undefined,
  frames: number
): Promise<void> {
  for (let i = 0; i < frames; i++) {
    // 不用 rAF：后台标签会被 Chrome 严重节流，导致 bake 卡数十分钟
    await new Promise<void>((r) => setTimeout(r, 0));
    try {
      game?.step?.();
      director.tick?.(0);
      (director.root as { frameMove?: (dt: number) => void })?.frameMove?.(0);
    } catch {
      /* ignore */
    }
  }
}

function bufferToImageDataFlipY(
  buf: ArrayBufferView,
  w: number,
  h: number
): ImageData | null {
  const need = w * h * 4;
  const u8 =
    buf instanceof Uint8Array
      ? buf
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (u8.length < need) return null;

  const out = new Uint8ClampedArray(need);
  for (let row = 0; row < h; row++) {
    const srcRow = h - 1 - row;
    for (let col = 0; col < w; col++) {
      const si = (srcRow * w + col) * 4;
      const di = (row * w + col) * 4;
      out[di] = u8[si];
      out[di + 1] = u8[si + 1];
      out[di + 2] = u8[si + 2];
      out[di + 3] = u8[si + 3];
    }
  }
  return new ImageData(out, w, h);
}

type RenderTextureCtor = new () => {
  reset: (o: { width: number; height: number }) => void;
  readPixels?: (
    x?: number,
    y?: number,
    w?: number,
    h?: number
  ) => Promise<ArrayBufferView | null>;
};

type CameraCtor = new () => CameraInstance;
type NodeCtor = new (name?: string) => NodeInstance;
type SpriteCtor = new () => SpriteInstance;
type UITransformCtor = new () => UITransformInstance;
type ColorCtor = new (r: number, g: number, b: number, a: number) => unknown;

interface DirectorLike {
  getScene?: () => { addChild: (n: unknown) => void };
  root?: { addChild: (n: unknown) => void; frameMove?: (dt: number) => void };
  tick?: (dt: number) => void;
}

interface GameLike {
  step?: () => void;
}

interface NodeInstance {
  layer: number;
  parent: NodeInstance | null;
  addChild: (n: NodeInstance) => void;
  setPosition: (x: number, y: number, z: number) => void;
  setScale: (x: number, y: number, z: number) => void;
  addComponent: <T>(ctor: new () => T) => T;
  destroy?: () => void;
}

interface CameraInstance {
  targetTexture: unknown;
  projection: number;
  orthoHeight: number;
  near: number;
  far: number;
  priority: number;
  clearColor: unknown;
  clearFlags: number;
  visibility: number;
}

interface SpriteInstance {
  spriteFrame: unknown;
  enabled: boolean;
}

interface UITransformInstance {
  setContentSize: (w: number, h: number) => void;
}
