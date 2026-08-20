/**
 * Egret 鼠标拾取模式
 * 参考 hgjkfcojmobceiihkjifeioioffcmond 1.0.19 的 DomPointerGuard：
 *   - capture 阶段拦截 mousedown/mousemove，避免触发游戏逻辑
 *   - hitTest 找到鼠标下的 Egret DisplayObject
 *   - hover 显示边界框 + click 选中并回传 nodeId
 */
import { getEgretStage, type EgretDisplayObject } from './runtime';
import { getDisplayId } from './sceneTree';
import { showNodeBounds, hideNodeBounds, disposeOverlay } from './nodeBoundsOverlay';

let active = false;
let onPickCb: ((nodeId: string) => void) | null = null;

/** 在 stage 坐标系下 hitTest 找最深节点 */
function hitTestNode(stage: EgretDisplayObject, x: number, y: number): EgretDisplayObject | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyStage = stage as any;
  const hitTest = anyStage.$hitTest ?? anyStage.hitTest;
  if (typeof hitTest !== 'function') return null;
  try {
    return hitTest.call(stage, x, y);
  } catch {
    return null;
  }
}

/** 屏幕坐标 → stage 坐标（考虑 canvas 缩放和 stage 尺寸） */
function screenToStage(clientX: number, clientY: number): { x: number; y: number } | null {
  const canvas = document.querySelector(
    '.egret-player canvas, canvas'
  ) as HTMLCanvasElement | null;
  const c = canvas ?? (document.querySelectorAll('canvas')[0] as HTMLCanvasElement | null);
  if (!c) return null;
  const rect = c.getBoundingClientRect();
  const stage = getEgretStage();
  if (!stage) return null;
  const stageW = Number(stage.stageWidth ?? rect.width);
  const stageH = Number(stage.stageHeight ?? rect.height);
  if (!stageW || !stageH) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * stageW,
    y: ((clientY - rect.top) / rect.height) * stageH,
  };
}

function onMouseMove(ev: MouseEvent): void {
  if (!active) return;
  ev.preventDefault();
  ev.stopPropagation();
  const stage = getEgretStage();
  if (!stage) return;
  const pt = screenToStage(ev.clientX, ev.clientY);
  if (!pt) return;
  const node = hitTestNode(stage, pt.x, pt.y);
  if (node) {
    showNodeBounds(getDisplayId(node), node);
  } else {
    hideNodeBounds();
  }
}

function onMouseDown(ev: MouseEvent): void {
  if (!active) return;
  ev.preventDefault();
  ev.stopPropagation();
  const stage = getEgretStage();
  if (!stage) return;
  const pt = screenToStage(ev.clientX, ev.clientY);
  if (!pt) return;
  const node = hitTestNode(stage, pt.x, pt.y);
  if (node && onPickCb) {
    onPickCb(getDisplayId(node));
  }
}

function onKeyDown(ev: KeyboardEvent): void {
  if (active && ev.key === 'Escape') stopPickMode();
}

export function startPickMode(onPick: (nodeId: string) => void): void {
  if (active) return;
  active = true;
  onPickCb = onPick;
  const opts: AddEventListenerOptions = { capture: true, passive: false };
  window.addEventListener('mousemove', onMouseMove, opts);
  window.addEventListener('mousedown', onMouseDown, opts);
  window.addEventListener('keydown', onKeyDown);
  document.body.style.cursor = 'crosshair';
}

export function stopPickMode(): void {
  if (!active) return;
  active = false;
  onPickCb = null;
  const capOpts: EventListenerOptions = { capture: true };
  window.removeEventListener('mousemove', onMouseMove, capOpts);
  window.removeEventListener('mousedown', onMouseDown, capOpts);
  window.removeEventListener('keydown', onKeyDown);
  document.body.style.cursor = '';
  hideNodeBounds();
  disposeOverlay();
}

export function isPickModeActive(): boolean {
  return active;
}
