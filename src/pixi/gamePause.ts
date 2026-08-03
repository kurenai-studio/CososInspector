/**
 * Pixi 暂停：优先 app.ticker.stop/start
 */
import { findPixiApplication } from './runtime';

export interface PauseState {
  paused: boolean;
  directorPaused: boolean;
  gamePaused: boolean;
  mode: 'ticker';
}

let inspectorPaused = false;

export function getPauseState(): PauseState {
  const app = findPixiApplication();
  const started = app?.ticker?.started;
  const tickerStopped =
    typeof started === 'boolean' ? !started : inspectorPaused;
  const paused = inspectorPaused || tickerStopped;
  return {
    paused,
    directorPaused: paused,
    gamePaused: paused,
    mode: 'ticker',
  };
}

export function pauseGame():
  | { ok: true; state: PauseState }
  | { ok: false; error: string } {
  const app = findPixiApplication();
  try {
    if (typeof app?.ticker?.stop === 'function') {
      app.ticker.stop();
      inspectorPaused = true;
      console.log('[暂停游戏:pixi] ticker.stop');
      return { ok: true, state: getPauseState() };
    }
    return { ok: false, error: '未找到 app.ticker.stop' };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function resumeGame():
  | { ok: true; state: PauseState }
  | { ok: false; error: string } {
  const app = findPixiApplication();
  try {
    if (typeof app?.ticker?.start === 'function') {
      app.ticker.start();
      inspectorPaused = false;
      console.log('[暂停游戏:pixi] ticker.start');
      return { ok: true, state: getPauseState() };
    }
    return { ok: false, error: '未找到 app.ticker.start' };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function togglePause():
  | { ok: true; state: PauseState }
  | { ok: false; error: string } {
  return getPauseState().paused ? resumeGame() : pauseGame();
}
