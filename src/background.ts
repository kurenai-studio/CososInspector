/// <reference path="./types/chrome.d.ts" />

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
  return false;
});

chrome.tabs.onUpdated.addListener(() => {
  void publishTabs();
});

connectBridge();
