/**
 * 试玩页游戏暂停 / 恢复（便于停住后看节点属性）
 *
 * Cocos 3.x：优先 cc.director.pause/resume；可选同时调 cc.game。
 * 部分 Slots 自管 ticker，可能不完全跟随 director —— 面板可切换模式。
 */

export type PauseMode = 'director' | 'game' | 'both';

export interface PauseState {
  paused: boolean;
  mode: PauseMode;
  directorPaused: boolean;
  gamePaused: boolean;
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

/** 本扩展发起的暂停意图（director.isPaused 可能被业务改写） */
let inspectorPaused = false;
let pauseMode: PauseMode = 'director';

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
    mode: pauseMode,
    directorPaused,
    gamePaused: inspectorPaused && (pauseMode === 'game' || pauseMode === 'both'),
  };
};

export const pauseGame = (
  mode: PauseMode = pauseMode
): { ok: true; state: PauseState } | { ok: false; error: string } => {
  pauseMode = mode;
  const director = getDirector();
  const game = getGame();

  try {
    if (mode === 'director' || mode === 'both') {
      if (typeof director?.pause !== 'function') {
        return { ok: false, error: 'cc.director.pause 不可用' };
      }
      director.pause();
    }
    if (mode === 'game' || mode === 'both') {
      if (typeof game?.pause === 'function') {
        game.pause();
      } else if (mode === 'game') {
        return { ok: false, error: 'cc.game.pause 不可用' };
      }
    }
    inspectorPaused = true;
    console.log(
      `[暂停游戏] mode=${mode} directorPaused=${readDirectorPaused()}`
    );
    return { ok: true, state: getPauseState() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[暂停游戏] 失败 mode=${mode}: ${msg}`);
    return { ok: false, error: msg };
  }
};

export const resumeGame = ():
  | { ok: true; state: PauseState }
  | { ok: false; error: string } => {
  const director = getDirector();
  const game = getGame();

  try {
    if (typeof director?.resume === 'function') {
      director.resume();
    }
    if (typeof game?.resume === 'function') {
      game.resume();
    }
    inspectorPaused = false;
    console.log(`[恢复游戏] directorPaused=${readDirectorPaused()}`);
    return { ok: true, state: getPauseState() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[恢复游戏] 失败: ${msg}`);
    return { ok: false, error: msg };
  }
};

export const togglePause = (
  mode?: PauseMode
): { ok: true; state: PauseState } | { ok: false; error: string } => {
  if (getPauseState().paused) return resumeGame();
  return pauseGame(mode ?? pauseMode);
};

export const setPauseMode = (mode: PauseMode): void => {
  pauseMode = mode;
};
