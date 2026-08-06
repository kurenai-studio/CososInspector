/**
 * 统一引擎族检测：Creator 3.x / 2.x（含 2.4）/ Egret / PixiJS
 *
 * Pixi 判定必须有明确证据，禁止「任意 canvas / WebGL」兜底。
 * Egret 判定：window.egret 存在且 stage 可解析（强证据，无需开关）。
 */

import {
  findPixiApplication,
  hasPixiSoftSignal,
  installPixiConsoleHint,
} from '../pixi/runtime';
import { getEgretStage } from '../egret/runtime';

export type EngineFamily = '2' | '3' | 'egret' | 'pixi';

const LOG_PREFIX = '[Cocos Inspector]';

export function logEngine(message: string, ...args: unknown[]): void {
  console.log(LOG_PREFIX, message, ...args);
}

function detectCocosFamily(): '2' | '3' | null {
  try {
    const cc = window.cc as
      | {
          director?: { getScene?: () => unknown };
          ENGINE_VERSION?: string;
          UITransform?: unknown;
          game?: unknown;
        }
      | undefined;
    if (!cc?.director?.getScene) return null;

    const version = String(cc.ENGINE_VERSION ?? '');
    if (version.startsWith('3')) return '3';
    if (version.startsWith('2')) return '2';

    if (cc.UITransform) return '3';
    if (typeof cc.game !== 'undefined') return '2';
    return null;
  } catch {
    return null;
  }
}

function detectEgretFamily(): 'egret' | null {
  try {
    if (!window.egret) return null;
    return getEgretStage() ? 'egret' : null;
  } catch {
    return null;
  }
}

function detectPixiFamily(): 'pixi' | null {
  try {
    // 扩展 popup 开关：默认关；未显式开启则不认 Pixi
    if (window.__cocosInspectorPixiEnabled !== true) return null;
    installPixiConsoleHint();
    if (findPixiApplication()) return 'pixi';
    if (hasPixiSoftSignal()) return 'pixi';
    return null;
  } catch {
    return null;
  }
}

/** Cocos 优先；无 Cocos 时再认 Egret（强证据）；最后 Pixi（需明确证据） */
export function detectEngineFamily(): EngineFamily | null {
  return detectCocosFamily() ?? detectEgretFamily() ?? detectPixiFamily();
}

export function isCocos3(): boolean {
  return detectEngineFamily() === '3';
}

export function isCocos2(): boolean {
  return detectEngineFamily() === '2';
}

export function isPixi(): boolean {
  return detectEngineFamily() === 'pixi';
}

export function isEgret(): boolean {
  return detectEngineFamily() === 'egret';
}

function logPixiReady(): void {
  const hasApp = !!findPixiApplication();
  logEngine(
    hasApp
      ? '检测到 PixiJS（已定位 Application）'
      : '检测到 PixiJS（软信号，等待 Application）'
  );
}

/** 等待引擎就绪；超时未找到则不启动（不再把任意 canvas 当 Pixi） */
export function waitForEngine(
  onReady: (family: EngineFamily) => void,
  maxAttempts = 120,
  intervalMs = 500
): void {
  if (window.__cocosInspectorPixiEnabled === true) {
    installPixiConsoleHint();
  }
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const family = detectEngineFamily();
    if (family) {
      window.clearInterval(timer);
      if (family === '3') logEngine('检测到 Cocos Creator 3.x');
      else if (family === '2') {
        logEngine(
          `检测到 Cocos Creator 2.x（${String(window.cc?.ENGINE_VERSION ?? '2.x')}）`
        );
      } else if (family === 'egret') {
        logEngine('检测到 Egret（已定位 stage）');
      } else logPixiReady();
      onReady(family);
      return;
    }

    if (attempts >= maxAttempts) {
      window.clearInterval(timer);
      console.warn(
        LOG_PREFIX,
        '未检测到 Cocos 2.x/3.x、Egret 或 PixiJS，扩展不会启动'
      );
    }
  }, intervalMs);
}
