/**
 * @deprecated 请优先使用 `src/engine/detect.ts`
 * 保留导出以兼容既有 cocos3 引用。
 */
import {
  detectEngineFamily,
  isCocos2,
  isCocos3,
  logEngine,
  waitForEngine,
} from '../engine/detect';

export {
  detectEngineFamily,
  isCocos2,
  isCocos3,
  waitForEngine,
};

export const log = logEngine;

/** 仅等待 3.x（旧 API） */
export function waitForCocos3(
  onReady: () => void,
  maxAttempts = 30,
  intervalMs = 500
): void {
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (isCocos3()) {
      window.clearInterval(timer);
      logEngine('检测到 Cocos Creator 3.x 环境');
      onReady();
      return;
    }
    if (attempts >= maxAttempts) {
      window.clearInterval(timer);
      logEngine('未检测到 Cocos Creator 3.x，扩展不会启动');
    }
  }, intervalMs);
}
