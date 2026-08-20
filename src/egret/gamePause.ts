/**
 * Egret 暂停：egret.ticker.pause()/resume()
 *
 * 状态判定参考 H5 Game AI Inspector：
 *   $pauseCount > 0 / $paused === true / isPaused === true 均视为暂停。
 */
import { getEgretTicker, type EgretTickerLike } from './runtime';

export interface PauseState {
  paused: boolean;
  directorPaused: boolean;
  gamePaused: boolean;
  mode: 'ticker';
}

function tickerPaused(ticker: EgretTickerLike | null): boolean {
  if (!ticker) return false;
  try {
    if (typeof ticker.$pauseCount === 'number' && ticker.$pauseCount > 0) {
      return true;
    }
    if (ticker.$paused === true) return true;
    if (ticker.isPaused === true) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function getPauseState(): PauseState {
  const paused = tickerPaused(getEgretTicker());
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
  const ticker = getEgretTicker();
  try {
    if (typeof ticker?.pause === 'function') {
      ticker.pause();
      console.log('[暂停游戏:egret] ticker.pause');
      return { ok: true, state: getPauseState() };
    }
    return { ok: false, error: '未找到 egret.ticker.pause' };
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
  const ticker = getEgretTicker();
  try {
    if (typeof ticker?.resume === 'function') {
      ticker.resume();
      console.log('[暂停游戏:egret] ticker.resume');
      return { ok: true, state: getPauseState() };
    }
    return { ok: false, error: '未找到 egret.ticker.resume' };
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
