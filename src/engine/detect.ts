/**
 * 统一引擎族检测：Creator 3.x / 2.x（含 2.4）
 */

export type EngineFamily = '2' | '3';

const LOG_PREFIX = '[Cocos Inspector]';

export function logEngine(message: string, ...args: unknown[]): void {
  console.log(LOG_PREFIX, message, ...args);
}

export function detectEngineFamily(): EngineFamily | null {
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

    // 无版本号：3.x 有 UITransform；2.x 通常没有
    if (cc.UITransform) return '3';
    if (typeof cc.game !== 'undefined') return '2';
    return null;
  } catch {
    return null;
  }
}

export function isCocos3(): boolean {
  return detectEngineFamily() === '3';
}

export function isCocos2(): boolean {
  return detectEngineFamily() === '2';
}

/** 等待 2.x 或 3.x 就绪后回调（先到先得） */
export function waitForEngine(
  onReady: (family: EngineFamily) => void,
  maxAttempts = 40,
  intervalMs = 500
): void {
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const family = detectEngineFamily();
    if (family) {
      window.clearInterval(timer);
      logEngine(
        family === '3'
          ? '检测到 Cocos Creator 3.x'
          : `检测到 Cocos Creator 2.x（${String(window.cc?.ENGINE_VERSION ?? '2.x')}）`
      );
      onReady(family);
      return;
    }
    if (attempts >= maxAttempts) {
      window.clearInterval(timer);
      logEngine('未检测到 Cocos 2.x/3.x，扩展不会启动');
    }
  }, intervalMs);
}
