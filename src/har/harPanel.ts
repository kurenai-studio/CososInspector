/** 面板侧 HAR 抓包：经 content → background CDP，不依赖 F12 */

export type HarStats = {
  recording?: boolean;
  requestCount?: number;
  finishedCount?: number;
  withBodyCount?: number;
  imageWithBodyCount?: number;
  failedBodyCount?: number;
  bytesCaptured?: number;
  lastError?: string | null;
};

export type HarCmdResult = {
  ok?: boolean;
  stats?: HarStats;
  filename?: string;
  harJson?: string;
  error?: string;
};

export function callHarCmd(
  action: 'start' | 'stop' | 'status' | 'export',
  opts: { reload?: boolean; stop?: boolean; filename?: string } = {}
): Promise<HarCmdResult> {
  return new Promise((resolve) => {
    const requestId = `har_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onResult);
      resolve({ ok: false, error: `HAR ${action} 超时` });
    }, 120_000);

    const onResult = (ev: MessageEvent) => {
      if (ev.source !== window || ev.data?.type !== 'cocos-har-result') return;
      if (ev.data.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onResult);
      resolve((ev.data.result ?? {}) as HarCmdResult);
    };

    window.addEventListener('message', onResult);
    window.postMessage(
      {
        type: 'cocos-har-cmd',
        requestId,
        action,
        reload: opts.reload !== false,
        stop: !!opts.stop,
        filename: opts.filename,
      },
      '*'
    );
  });
}

export function formatHarStats(stats?: HarStats | null): string {
  if (!stats) return '无统计';
  const parts = [
    `请求 ${stats.requestCount ?? 0}`,
    `完成 ${stats.finishedCount ?? 0}`,
    `含body ${stats.withBodyCount ?? 0}`,
    `图 ${stats.imageWithBodyCount ?? 0}`,
  ];
  if (stats.failedBodyCount) parts.push(`失败 ${stats.failedBodyCount}`);
  if (stats.lastError) parts.push(`err=${stats.lastError}`);
  return parts.join(' · ');
}
