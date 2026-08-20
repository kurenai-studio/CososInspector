/**
 * Egret 节点边界框 overlay（picker hover 时用）
 * 参考 cocos3/nodeBoundsOverlay.ts 的 DOM overlay 思路
 */
import { getEgretCanvas, type EgretDisplayObject } from './runtime';

let overlayRoot: HTMLDivElement | null = null;
let rafId = 0;
let activeNodeId: string | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlayRoot && document.body.contains(overlayRoot)) return overlayRoot;
  overlayRoot = document.createElement('div');
  overlayRoot.style.cssText =
    'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:999999;';
  document.body.appendChild(overlayRoot);
  return overlayRoot;
}

/** Egret 节点屏幕矩形
 * 坐标换算：$getTransformedBounds(stage) 返回 stage 坐标系（逻辑像素）下的矩形，
 * canvas CSS 大小 / stage 像素 = stage→CSS 缩放比（picker screenToStage 的逆运算）。
 * 不能用 $canvasScaleX/Y（那是 devicePixelRatio，不是 stage→CSS）。
 */
function getNodeScreenRect(node: EgretDisplayObject): { left: number; top: number; w: number; h: number } | null {
  const canvas = getEgretCanvas();
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const stage = getStageOf(node);
  if (!stage) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyNode = node as any;
  const getBounds = anyNode.$getTransformedBounds;
  if (typeof getBounds !== 'function') return null;
  const stageW = Number(stage.stageWidth) || rect.width;
  const stageH = Number(stage.stageHeight) || rect.height;
  if (!stageW || !stageH) return null;
  try {
    const b = getBounds.call(node, stage);
    // stage 坐标 → CSS 像素：乘 CSS/Stage 比例（兼容 canvas CSS 大小 ≠ stage 大小 + devicePixelRatio）
    const scaleX = rect.width / stageW;
    const scaleY = rect.height / stageH;
    return {
      left: rect.left + b.x * scaleX,
      top: rect.top + b.y * scaleY,
      w: b.width * scaleX,
      h: b.height * scaleY,
    };
  } catch {
    return null;
  }
}

function getStageOf(node: EgretDisplayObject): EgretDisplayObject | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyNode = node as any;
  if (anyNode.$stage) return anyNode.$stage;
  if (anyNode.stage) return anyNode.stage;
  const eg = (window as { egret?: { sys?: { $TempStage?: EgretDisplayObject } } }).egret;
  return eg?.sys?.$TempStage ?? null;
}

export function showNodeBounds(nodeId: string, node: EgretDisplayObject | null): void {
  const root = ensureOverlay();
  if (!node) {
    hideNodeBounds();
    return;
  }
  activeNodeId = nodeId;
  const draw = () => {
    if (activeNodeId !== nodeId) return;
    const rect = getNodeScreenRect(node);
    root.innerHTML = '';
    if (!rect) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.w}px;height:${rect.h}px;border:2px solid #ff4757;background:rgba(255,71,87,0.15);box-sizing:border-box;`;
    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute;left:-2px;top:-20px;background:#ff4757;color:#fff;font:12px monospace;padding:2px 6px;border-radius:2px;white-space:nowrap;';
    label.textContent = `${node.name || node.constructor?.name || ''} (${nodeId})`;
    box.appendChild(label);
    root.appendChild(box);
    rafId = requestAnimationFrame(draw);
  };
  draw();
}

export function hideNodeBounds(): void {
  activeNodeId = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (overlayRoot) overlayRoot.innerHTML = '';
}

export function disposeOverlay(): void {
  hideNodeBounds();
  if (overlayRoot) {
    overlayRoot.remove();
    overlayRoot = null;
  }
}
