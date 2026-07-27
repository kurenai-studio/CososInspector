/// <reference path="./types/chrome.d.ts" />

import {
  HarCaptureSession,
  type HarCaptureStats,
} from './har/harCapture';

declare const __INSPECTOR_VERSION__: string;

function bridgePort(): number {
  return Number(
    (globalThis as { __COCOS_BRIDGE_PORT__?: number }).__COCOS_BRIDGE_PORT__ ??
      17373
  );
}

function wsUrl(): string {
  return `ws://127.0.0.1:${bridgePort()}`;
}

type McpBridgeStatus = 'connecting' | 'connected' | 'disconnected';

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let mcpStatus: McpBridgeStatus = 'disconnected';

/** tabId → HAR 录制会话 */
const harSessions = new Map<number, HarCaptureSession>();
/** 已 attach debugger 的 tab，避免重复 attach */
const debuggerAttached = new Set<number>();

function setMcpStatus(next: McpBridgeStatus): void {
  if (mcpStatus === next) return;
  mcpStatus = next;
  broadcastMcpStatus();
}

function getMcpStatusPayload(): {
  status: McpBridgeStatus;
  port: number;
  wsUrl: string;
} {
  return { status: mcpStatus, port: bridgePort(), wsUrl: wsUrl() };
}

function broadcastMcpStatus(): void {
  const payload = { type: 'cocos-mcp-status', ...getMcpStatusPayload() };
  void chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).then((tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
  });
}

async function publishTabs(): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  socket.send(
    JSON.stringify({
      type: 'tabs',
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url ?? '',
        title: t.title ?? '',
      })),
    })
  );
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

async function getExtensionHandshakePayload(): Promise<{
  domain: string;
  pageUrlMatch: string;
}> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (!(await pingTab(tab.id))) continue;
    const domain = domainFromUrl(tab.url);
    return {
      domain,
      pageUrlMatch: domain.split('.')[0] || domain,
    };
  }
  return { domain: '', pageUrlMatch: '' };
}

async function findCocosTab(
  pageUrlMatch: string
): Promise<chrome.tabs.Tab | null> {
  const match = pageUrlMatch.trim().toLowerCase();
  const all = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });

  const candidates = all.filter((t) => {
    if (!t.id || !t.url) return false;
    if (match && !t.url.toLowerCase().includes(match)) return false;
    return true;
  });

  for (const tab of candidates) {
    if (!tab.id) continue;
    if (await pingTab(tab.id)) return tab;
  }

  return null;
}

function callApiViaContent(
  tabId: number,
  method: string,
  args: unknown[]
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'cocos-api-call', method, args: args ?? [] },
      (res) => {
        const err = chrome.runtime.lastError;
        if (err?.message) {
          reject(new Error(err.message));
          return;
        }
        if (!res?.ok) {
          reject(new Error(res?.error ?? '页面 API 调用失败'));
          return;
        }
        resolve(res.result);
      }
    );
  });
}

async function pingTab(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'cocos-api-ping' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        resolve(false);
        return;
      }
      const info = res.result as { hasCocos?: boolean } | null;
      resolve(!!info?.hasCocos);
    });
  });
}

async function captureVisibleTab(
  pageUrlMatch: string
): Promise<{ ok: true; base64: string; width: number; height: number }> {
  const tab = await findCocosTab(pageUrlMatch);
  if (!tab?.windowId) throw new Error('未找到试玩标签页');

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png',
  });
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1]! : dataUrl;

  return {
    ok: true,
    base64,
    width: 0,
    height: 0,
  };
}

function dbgSend(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err?.message) {
        reject(new Error(err.message));
        return;
      }
      resolve(result);
    });
  });
}

function dbgAttach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (debuggerAttached.has(tabId)) {
      resolve();
      return;
    }
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err?.message) {
        reject(new Error(err.message));
        return;
      }
      debuggerAttached.add(tabId);
      resolve();
    });
  });
}

function dbgDetach(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    if (!debuggerAttached.has(tabId)) {
      resolve();
      return;
    }
    chrome.debugger.detach({ tabId }, () => {
      debuggerAttached.delete(tabId);
      resolve();
    });
  });
}

function emptyHarStats(tabId: number | null = null): HarCaptureStats {
  return {
    recording: false,
    tabId,
    requestCount: 0,
    finishedCount: 0,
    withBodyCount: 0,
    imageWithBodyCount: 0,
    failedBodyCount: 0,
    bytesCaptured: 0,
    startedAt: null,
    lastError: null,
  };
}

async function harStart(
  tabId: number,
  opts: { reload?: boolean; pageUrl?: string; pageTitle?: string } = {}
): Promise<{ ok: true; stats: HarCaptureStats }> {
  const existing = harSessions.get(tabId);
  if (existing?.recording) {
    return { ok: true, stats: existing.getStats() };
  }

  await dbgAttach(tabId);
  const session = new HarCaptureSession(tabId, (method, params) =>
    dbgSend(tabId, method, params)
  );
  harSessions.set(tabId, session);

  const pageUrl = opts.pageUrl ?? '';
  const pageTitle = opts.pageTitle ?? '';
  await session.start(pageUrl, pageTitle);
  console.log(`[HAR抓包] tab=${tabId} - 开始录制 cacheDisabled=true`);

  if (opts.reload) {
    try {
      await chrome.tabs.reload(tabId, { bypassCache: true });
    } catch (e) {
      session.lastError =
        e instanceof Error ? e.message : `reload failed: ${String(e)}`;
      console.error(`[HAR抓包] tab=${tabId} - 刷新失败: ${session.lastError}`);
    }
  }

  return { ok: true, stats: session.getStats() };
}

async function harStop(
  tabId: number
): Promise<{ ok: true; stats: HarCaptureStats }> {
  const session = harSessions.get(tabId);
  if (!session) {
    await dbgDetach(tabId);
    return { ok: true, stats: emptyHarStats(tabId) };
  }
  await session.stop();
  await dbgDetach(tabId);
  console.log(
    `[HAR抓包] tab=${tabId} - 停止 请求=${session.getStats().requestCount}` +
      ` 含body=${session.getStats().withBodyCount}`
  );
  return { ok: true, stats: session.getStats() };
}

function harStatus(tabId: number): { ok: true; stats: HarCaptureStats } {
  const session = harSessions.get(tabId);
  return { ok: true, stats: session?.getStats() ?? emptyHarStats(tabId) };
}

async function resolveShareHttpBase(wsPort = bridgePort()): Promise<string> {
  const ports = [...new Set([17374, 17375, wsPort + 1])];
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) return `http://127.0.0.1:${port}`;
    } catch {
      /* next */
    }
  }
  return `http://127.0.0.1:17374`;
}

async function uploadHarToShare(
  harJson: string,
  filename: string,
  wsPort?: number
): Promise<
  | { ok: true; sharePath: string; shareUrl: string }
  | { ok: false; error: string }
> {
  const base = await resolveShareHttpBase(wsPort ?? bridgePort());
  const safe =
    filename.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_') || 'capture.har';
  const sharePath = `out/${Date.now()}-${safe.endsWith('.har') ? safe : `${safe}.har`}`;
  try {
    const res = await fetch(`${base}/${sharePath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: harJson,
    });
    if (!res.ok) {
      return { ok: false, error: `共享目录 PUT 失败 HTTP ${res.status}` };
    }
    return { ok: true, sharePath, shareUrl: `${base}/${sharePath}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function defaultHarName(pageUrl: string): string {
  try {
    const host = new URL(pageUrl).hostname || 'capture';
    return `${host}.har`;
  } catch {
    return 'cocos-capture.har';
  }
}

async function harExport(
  tabId: number,
  opts: {
    stop?: boolean;
    delivery?: 'share' | 'inline';
    filename?: string;
    wsPort?: number;
  } = {}
): Promise<{
  ok: boolean;
  stats: HarCaptureStats;
  filename: string;
  harJson?: string;
  sharePath?: string;
  shareUrl?: string;
  error?: string;
}> {
  const session = harSessions.get(tabId);
  if (!session) {
    return {
      ok: false,
      stats: emptyHarStats(tabId),
      filename: 'capture.har',
      error: '尚无 HAR 会话，请先开始录制',
    };
  }

  if (opts.stop !== false && session.recording) {
    await session.stop();
    await dbgDetach(tabId);
  } else {
    await session.awaitPendingBodies();
  }

  const stats = session.getStats();
  const har = session.buildHar(
    typeof __INSPECTOR_VERSION__ !== 'undefined' ? __INSPECTOR_VERSION__ : '3.1.0'
  );
  const harJson = JSON.stringify(har);
  const filename =
    opts.filename || defaultHarName(session.pageUrl || `tab-${tabId}`);

  const delivery = opts.delivery ?? 'inline';
  if (delivery === 'share') {
    const uploaded = await uploadHarToShare(harJson, filename, opts.wsPort);
    if (!uploaded.ok) {
      return { ok: false, stats, filename, error: uploaded.error };
    }
    console.log(
      `[HAR抓包] tab=${tabId} - 导出 share ${uploaded.sharePath} ` +
        `请求=${stats.requestCount} 含body=${stats.withBodyCount}`
    );
    return {
      ok: true,
      stats,
      filename,
      sharePath: uploaded.sharePath,
      shareUrl: uploaded.shareUrl,
    };
  }

  console.log(
    `[HAR抓包] tab=${tabId} - 导出 inline 字节≈${harJson.length} ` +
      `请求=${stats.requestCount} 含body=${stats.withBodyCount}`
  );
  return { ok: true, stats, filename, harJson };
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const session = harSessions.get(tabId);
  if (!session) return;
  session.onEvent(method, (params ?? {}) as Record<string, unknown>);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  debuggerAttached.delete(tabId);
  const session = harSessions.get(tabId);
  if (session?.recording) {
    session.recording = false;
    session.lastError = `debugger detached: ${reason}`;
    console.warn(`[HAR抓包] tab=${tabId} - debugger 断开: ${reason}`);
  }
});

async function resolveTabId(
  pageUrlMatch: string,
  explicitTabId?: number
): Promise<number> {
  if (explicitTabId != null) return explicitTabId;
  const tab = await findCocosTab(pageUrlMatch);
  if (!tab?.id) {
    throw new Error(
      '未找到已注入 Inspector 的试玩页。请打开游戏页并保持标签页存在。'
    );
  }
  return tab.id;
}

async function handleBridgeCall(msg: {
  id: number;
  method: string;
  args: unknown[];
  pageUrlMatch?: string;
}): Promise<void> {
  const respond = (payload: object) => {
    socket?.send(JSON.stringify({ type: 'response', id: msg.id, ...payload }));
  };

  try {
    if (msg.method === '__captureVisibleTab') {
      const result = await captureVisibleTab(msg.pageUrlMatch ?? '');
      respond({ result });
      return;
    }

    if (msg.method === '__harStart') {
      const opt = (msg.args?.[0] ?? {}) as {
        reload?: boolean;
        tabId?: number;
      };
      const tabId = await resolveTabId(msg.pageUrlMatch ?? '', opt.tabId);
      const tabs = await chrome.tabs.query({
        url: ['http://*/*', 'https://*/*'],
      });
      const tab = tabs.find((t) => t.id === tabId);
      const result = await harStart(tabId, {
        reload: opt.reload !== false,
        pageUrl: tab?.url ?? '',
        pageTitle: tab?.title ?? '',
      });
      respond({ result });
      return;
    }

    if (msg.method === '__harStatus') {
      const opt = (msg.args?.[0] ?? {}) as { tabId?: number };
      const tabId = await resolveTabId(msg.pageUrlMatch ?? '', opt.tabId);
      respond({ result: harStatus(tabId) });
      return;
    }

    if (msg.method === '__harStopExport') {
      const opt = (msg.args?.[0] ?? {}) as {
        tabId?: number;
        delivery?: 'share' | 'inline';
        filename?: string;
        wsPort?: number;
        stop?: boolean;
      };
      const tabId = await resolveTabId(msg.pageUrlMatch ?? '', opt.tabId);
      const result = await harExport(tabId, {
        stop: opt.stop !== false,
        delivery: opt.delivery ?? 'share',
        filename: opt.filename,
        wsPort: opt.wsPort,
      });
      respond({ result });
      return;
    }

    if (msg.method === '__harStop') {
      const opt = (msg.args?.[0] ?? {}) as { tabId?: number };
      const tabId = await resolveTabId(msg.pageUrlMatch ?? '', opt.tabId);
      respond({ result: await harStop(tabId) });
      return;
    }

    const tab = await findCocosTab(msg.pageUrlMatch ?? '');
    if (!tab?.id) {
      respond({
        error:
          '未找到已注入 Inspector 的试玩页。请打开游戏页并保持标签页存在。',
      });
      return;
    }

    const result = await callApiViaContent(tab.id, msg.method, msg.args ?? []);
    respond({ result });
  } catch (e) {
    respond({
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function sendExtensionRole(handshake?: {
  domain: string;
  pageUrlMatch: string;
}): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(
      JSON.stringify({
        role: 'extension',
        domain: handshake?.domain ?? '',
        pageUrlMatch: handshake?.pageUrlMatch ?? '',
      })
    );
    return true;
  } catch {
    return false;
  }
}

function connectBridge(): void {
  if (socket?.readyState === WebSocket.OPEN) return;

  setMcpStatus('connecting');

  try {
    socket = new WebSocket(wsUrl());
  } catch {
    setMcpStatus('disconnected');
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    // 必须先注册 role，桥接才认 extensionConnected；勿等 ping 全标签后再发
    if (sendExtensionRole()) {
      setMcpStatus('connected');
    } else {
      setMcpStatus('disconnected');
      socket?.close();
      return;
    }

    void getExtensionHandshakePayload().then((handshake) => {
      sendExtensionRole(handshake);
      void publishTabs();
    });
  };

  socket.onmessage = (ev) => {
    let msg: {
      type?: string;
      id?: number;
      method?: string;
      args?: unknown[];
      pageUrlMatch?: string;
    };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === 'call' && typeof msg.id === 'number' && msg.method) {
      void handleBridgeCall(msg as Parameters<typeof handleBridgeCall>[0]);
    }
  };

  socket.onclose = () => {
    socket = null;
    setMcpStatus('disconnected');
    scheduleReconnect();
  };

  socket.onerror = () => {
    setMcpStatus('disconnected');
    socket?.close();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, 2500);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'cocos-page-active') {
    void getExtensionHandshakePayload().then((handshake) => {
      sendExtensionRole(handshake);
      void publishTabs();
    });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === 'get-mcp-status') {
    sendResponse(getMcpStatusPayload());
    return true;
  }

  if (message?.type === 'cocos-har') {
    const tabId = (sender as { tab?: { id?: number } })?.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: '无 tabId' });
      return true;
    }
    const action = String(message.action ?? '');
    const pageUrl = String(message.pageUrl ?? '');
    const pageTitle = String(message.pageTitle ?? '');

    void (async () => {
      try {
        if (action === 'start') {
          sendResponse(
            await harStart(tabId, {
              reload: message.reload !== false,
              pageUrl,
              pageTitle,
            })
          );
          return;
        }
        if (action === 'stop') {
          sendResponse(await harStop(tabId));
          return;
        }
        if (action === 'status') {
          sendResponse(harStatus(tabId));
          return;
        }
        if (action === 'export') {
          const result = await harExport(tabId, {
            stop: !!message.stop,
            delivery: 'inline',
            filename: message.filename,
          });
          sendResponse(result);
          return;
        }
        sendResponse({ ok: false, error: `未知 HAR 动作: ${action}` });
      } catch (e) {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener(() => {
  void publishTabs();
});

connectBridge();
