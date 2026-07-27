/**
 * Cocos Creator 2.x 游戏暂停 / 恢复
 */

export interface PauseState {
  paused: boolean;
  directorPaused: boolean;
}

type DirectorLike = {
  pause?: () => void;
  resume?: () => void;
  isPaused?: () => boolean;
};

type GameLike = {
  pause?: () => void;
  resume?: () => void;
};

let inspectorPaused = false;

const getDirector = (): DirectorLike | null => {
  const d = window.cc?.director as DirectorLike | undefined;
  return d ?? null;
};

const getGame = (): GameLike | null => {
  const g = (window.cc as { game?: GameLike } | undefined)?.game;
  return g ?? null;
};

const readDirectorPaused = (): boolean => {
  const d = getDirector();
  if (typeof d?.isPaused === 'function') {
    try {
      return !!d.isPaused();
    } catch {
      /* ignore */
    }
  }
  return inspectorPaused;
};

export const getPauseState = (): PauseState => {
  const directorPaused = readDirectorPaused();
  return {
    paused: inspectorPaused || directorPaused,
    directorPaused,
  };
};

export const pauseGame = ():
  | { ok: true; state: PauseState }
  | { ok: false; error: string } => {
  const director = getDirector();
  const game = getGame();
  try {
    if (typeof director?.pause === 'function') {
      director.pause();
    } else if (typeof game?.pause === 'function') {
      game.pause();
    } else {
      return { ok: false, error: 'cc.director.pause / cc.game.pause 不可用' };
    }
    // 2.x 部分构建同时调 game.pause 更稳
    if (typeof game?.pause === 'function' && director?.pause) {
      try {
        game.pause();
      } catch {
        /* ignore */
      }
    }
    inspectorPaused = true;
    console.log(
      `[暂停游戏:2.x] directorPaused=${readDirectorPaused()}`
    );
    return { ok: true, state: getPauseState() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[暂停游戏:2.x] 失败: ${msg}`);
    return { ok: false, error: msg };
  }
};

export const resumeGame = ():
  | { ok: true; state: PauseState }
  | { ok: false; error: string } => {
  const director = getDirector();
  const game = getGame();
  try {
    if (typeof director?.resume === 'function') director.resume();
    if (typeof game?.resume === 'function') game.resume();
    inspectorPaused = false;
    console.log(`[恢复游戏:2.x] directorPaused=${readDirectorPaused()}`);
    return { ok: true, state: getPauseState() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[恢复游戏:2.x] 失败: ${msg}`);
    return { ok: false, error: msg };
  }
};

export const togglePause = ():
  | { ok: true; state: PauseState }
  | { ok: false; error: string } => {
  if (getPauseState().paused) return resumeGame();
  return pauseGame();
};
