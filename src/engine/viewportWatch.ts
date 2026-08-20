/**
 * 视口 / DevTools 相关诊断：用于排查「开着 Inspector 按 F12 变手机模式」。
 * 只写 diagLog，不改页面布局。
 */

import { diagLog } from './diagLog';

declare const __INSPECTOR_VERSION__: string;

let started = false;
let panelCollapsed = false;
let engineFamily = 'unknown';
let lastSnapshotKey = '';
let resizeTimer: number | null = null;
let f12ArmUntil = 0;

const snapshot = (): Record<string, string | number | boolean> => {
  const vv = window.visualViewport;
  const dockGapW = Math.max(0, window.outerWidth - window.innerWidth);
  const dockGapH = Math.max(0, window.outerHeight - window.innerHeight);
  const narrow = window.matchMedia('(max-width: 520px)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const hoverNone = window.matchMedia('(hover: none)').matches;
  return {
    inspectorVersion: __INSPECTOR_VERSION__,
    engineFamily,
    panelCollapsed,
    hrefHost: location.hostname,
    hrefPath: location.pathname.slice(0, 120),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    outerW: window.outerWidth,
    outerH: window.outerHeight,
    screenW: window.screen?.width ?? 0,
    screenH: window.screen?.height ?? 0,
    dpr: window.devicePixelRatio || 1,
    vvW: vv?.width ?? -1,
    vvH: vv?.height ?? -1,
    vvScale: vv?.scale ?? -1,
    dockGapW,
    dockGapH,
    // 经验：停靠 DevTools 时常有较大 outer-inner 差；Device Mode 时常 narrow+触摸特征
    suspectDevToolsDock: dockGapW >= 280 || dockGapH >= 200,
    suspectNarrowMobileLayout: narrow,
    pointerCoarse: coarse,
    hoverNone,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    orientation:
      (window.screen as { orientation?: { type?: string } })?.orientation
        ?.type ??
      (window as { orientation?: number }).orientation ??
      '',
  };
};

const snapshotLine = (): string => {
  const s = snapshot();
  return Object.keys(s)
    .map((k) => `${k}=${String(s[k])}`)
    .join(' ');
};

const emitIfChanged = (reason: string): void => {
  const line = snapshotLine();
  const key = `${reason}|${line}`;
  if (key === lastSnapshotKey) return;
  lastSnapshotKey = key;
  diagLog(`viewport:${reason}`, line);
};

const onResize = (): void => {
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    const armed = Date.now() < f12ArmUntil;
    emitIfChanged(armed ? 'resize-after-f12' : 'resize');
  }, 80);
};

const onKeyDown = (ev: KeyboardEvent): void => {
  const isF12 = ev.key === 'F12' || ev.code === 'F12';
  const isDevtoolsChord =
    (ev.ctrlKey || ev.metaKey) &&
    ev.shiftKey &&
    (ev.key === 'I' || ev.key === 'i' || ev.key === 'J' || ev.key === 'j');
  const isDeviceModeChord =
    (ev.ctrlKey || ev.metaKey) &&
    ev.shiftKey &&
    (ev.key === 'M' || ev.key === 'm');

  if (isF12 || isDevtoolsChord) {
    f12ArmUntil = Date.now() + 8000;
    diagLog(
      isF12 ? 'key:F12' : 'key:devtools-chord',
      snapshotLine()
    );
    window.setTimeout(() => emitIfChanged('post-f12-250ms'), 250);
    window.setTimeout(() => emitIfChanged('post-f12-1000ms'), 1000);
    window.setTimeout(() => emitIfChanged('post-f12-3000ms'), 3000);
  }
  if (isDeviceModeChord) {
    diagLog('key:device-mode-chord(Ctrl+Shift+M)', snapshotLine());
    window.setTimeout(() => emitIfChanged('post-device-mode-chord'), 300);
  }
};

export const notePanelCollapsed = (collapsed: boolean): void => {
  panelCollapsed = collapsed;
  diagLog('panel:collapsed', `collapsed=${collapsed} ${snapshotLine()}`);
};

export const noteEngineFamily = (family: string): void => {
  engineFamily = family || 'unknown';
  diagLog('panel:engine', `family=${engineFamily}`);
};

export const startViewportWatch = (family: string): void => {
  try {
    noteEngineFamily(family);
    if (started) {
      emitIfChanged('watch-already-on');
      return;
    }
    started = true;
    emitIfChanged('watch-start');
    window.addEventListener('resize', onResize, { passive: true });
    window.visualViewport?.addEventListener('resize', onResize, {
      passive: true,
    });
    window.visualViewport?.addEventListener('scroll', onResize, {
      passive: true,
    });
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', () => {
      diagLog(
        'visibility',
        `state=${document.visibilityState} ${snapshotLine()}`
      );
    });
  } catch (error) {
    console.error('[Cocos Inspector:诊断] 启动视口监视失败', error);
  }
};
