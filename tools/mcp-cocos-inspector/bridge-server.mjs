import { WebSocket, WebSocketServer } from 'ws';
import {
  normalizeDomain,
  patchRegistryInstance,
  removeRegistryInstance,
  upsertRegistryInstance,
} from './bridge-registry.mjs';
import {
  addAllowedDomainHint,
  addAllowedHostname,
  verifyLocalBridgeClient,
} from './local-origin-guard.mjs';

const DEFAULT_PORT = Number(process.env.COCOS_BRIDGE_PORT ?? 17373);
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** @type {'none' | 'server' | 'client'} */
let mode = 'none';
/** @type {import('ws').WebSocketServer | null} */
let wss = null;
/** @type {import('ws').WebSocket | null} */
let extensionWs = null;
/** @type {import('ws').WebSocket | null} */
let mcpClientWs = null;
let clientConnectedPort = null;
/** @type {Set<import('ws').WebSocket>} */
const mcpClients = new Set();
/** @type {Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout>; relayTo?: import('ws').WebSocket }>} */
const pending = new Map();
let seq = 0;
let ephemeralSeq = 100000;
/** 服务端转发 ID，避免多 MCP 客户端 id 碰撞 */
let serverRelaySeq = 2_000_000;
/** @type {Map<number, { clientWs: import('ws').WebSocket; clientId: number }>} */
const relayByServerId = new Map();
let lastTabs = [];

/** @type {{ domain?: string; pageUrlMatch?: string; wsPort?: number; httpPort?: number; shareDir?: string } | null} */
let daemonMeta = null;

export function setDaemonMeta(meta) {
  daemonMeta = meta ? { ...meta } : null;
  if (daemonMeta?.domain) addAllowedHostname(daemonMeta.domain);
  if (daemonMeta?.pageUrlMatch) addAllowedDomainHint(daemonMeta.pageUrlMatch);
}

export function getDaemonMeta() {
  return daemonMeta ? { ...daemonMeta } : null;
}

function syncRegistryExtension(connected, domainOverride) {
  if (mode !== 'server' || !daemonMeta) return;
  const domain =
    normalizeDomain(domainOverride ?? daemonMeta.domain ?? extensionWs?.reportedDomain);
  if (!domain) return;
  daemonMeta.domain = domain;
  try {
    upsertRegistryInstance({
      domain,
      wsPort: daemonMeta.wsPort,
      httpPort: daemonMeta.httpPort,
      pageUrlMatch: daemonMeta.pageUrlMatch ?? domain.split('.')[0],
      shareDir: daemonMeta.shareDir ?? '',
      pid: process.pid,
      extensionConnected: connected,
    });
  } catch {
    /* domain 尚未就绪时忽略 */
  }
}

function routeResponse(msg) {
  const relay = relayByServerId.get(msg.id);
  if (relay) {
    relayByServerId.delete(msg.id);
    if (relay.timer) clearTimeout(relay.timer);
    const out = { ...msg, id: relay.clientId };
    if (relay.clientWs.readyState === WebSocket.OPEN) {
      relay.clientWs.send(JSON.stringify(out));
    }
    return;
  }

  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);

  if (p.relayTo && p.relayTo.readyState === WebSocket.OPEN) {
    p.relayTo.send(JSON.stringify(msg));
    return;
  }

  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
}

function relayCallFromMcpClient(msg, mcpWs) {
  if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
    mcpWs.send(
      JSON.stringify({
        type: 'response',
        id: msg.id,
        error:
          '扩展未连接桥接。请用普通 Chrome 打开试玩页并确认已加载 Cocos Inspector 扩展。',
      })
    );
    return;
  }

  const serverId = ++serverRelaySeq;
  const timer = setTimeout(() => {
    relayByServerId.delete(serverId);
    if (mcpWs.readyState === WebSocket.OPEN) {
      mcpWs.send(
        JSON.stringify({
          type: 'response',
          id: msg.id,
          error: `桥接调用超时 (${msg.method ?? 'call'})`,
        })
      );
    }
  }, msg.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  relayByServerId.set(serverId, { clientWs: mcpWs, clientId: msg.id, timer });

  extensionWs.send(
    JSON.stringify({
      type: 'call',
      id: serverId,
      method: msg.method,
      args: msg.args ?? [],
      pageUrlMatch: msg.pageUrlMatch ?? daemonMeta?.pageUrlMatch ?? '',
    })
  );
}

function onSocketMessage(ws, msg) {
  if (msg.role === 'extension') {
    if (extensionWs && extensionWs !== ws && extensionWs.readyState === WebSocket.OPEN) {
      try {
        extensionWs.close();
      } catch {
        /* ignore */
      }
    }
    extensionWs = ws;
    ws.reportedDomain = normalizeDomain(msg.domain ?? '');
    if (ws.reportedDomain) addAllowedHostname(ws.reportedDomain);
    if (msg.pageUrlMatch) {
      if (daemonMeta) daemonMeta.pageUrlMatch = msg.pageUrlMatch;
      addAllowedDomainHint(msg.pageUrlMatch);
    }
    if (Array.isArray(msg.tabs)) lastTabs = msg.tabs;
    syncRegistryExtension(true, ws.reportedDomain);
    return;
  }

  if (msg.role === 'mcp') {
    mcpClients.add(ws);
    if (!mcpClientWs || mcpClientWs.readyState !== WebSocket.OPEN) {
      mcpClientWs = ws;
    }
    return;
  }

  if (msg.type === 'tabs' && Array.isArray(msg.tabs)) {
    lastTabs = msg.tabs;
    const first = msg.tabs.find((t) => t.url)?.url;
    if (first && extensionWs) {
      try {
        const d = normalizeDomain(new URL(first).hostname);
        if (d) {
          extensionWs.reportedDomain = d;
          addAllowedHostname(d);
          syncRegistryExtension(true, d);
        }
      } catch {
        /* ignore */
      }
    }
    return;
  }

  if (msg.type === 'status' || msg.type === 'ping') {
    ws.send(
      JSON.stringify({
        type: 'status',
        extensionConnected: extensionWs?.readyState === WebSocket.OPEN,
        tabs: lastTabs,
        mode,
        domain: daemonMeta?.domain ?? extensionWs?.reportedDomain ?? null,
        wsPort: daemonMeta?.wsPort ?? null,
        httpPort: daemonMeta?.httpPort ?? null,
        pageUrlMatch: daemonMeta?.pageUrlMatch ?? null,
      })
    );
    return;
  }

  if (msg.type === 'call' && ws !== extensionWs) {
    relayCallFromMcpClient(msg, ws);
    return;
  }

  if (msg.type === 'response') {
    routeResponse(msg);
  }
}

function wireConnection(ws) {
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    try {
      onSocketMessage(ws, JSON.parse(String(raw)));
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => {
    if (extensionWs === ws) {
      extensionWs = null;
      if (daemonMeta?.domain) {
        patchRegistryInstance(daemonMeta.domain, { extensionConnected: false });
      }
    }
    mcpClients.delete(ws);
    if (mcpClientWs === ws) {
      mcpClientWs = null;
      for (const c of mcpClients) {
        if (c.readyState === WebSocket.OPEN) {
          mcpClientWs = c;
          break;
        }
      }
    }
  });
}

function connectBridgeClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`连接已有桥接超时 (127.0.0.1:${port})`));
    }, 8000);

    ws.on('open', () => {
      clearTimeout(timer);
      mcpClientWs = ws;
      mcpClients.add(ws);
      mode = 'client';
      wireConnection(ws);
      ws.send(JSON.stringify({ role: 'mcp' }));
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function isBridgeRunning() {
  return mode === 'server' && !!wss;
}

export async function isExtensionConnected() {
  if (mode === 'server') {
    return extensionWs?.readyState === WebSocket.OPEN;
  }
  if (mode === 'client' && mcpClientWs?.readyState === WebSocket.OPEN) {
    try {
      const st = await bridgeGetStatus();
      return !!st.extensionConnected;
    } catch {
      return false;
    }
  }
  return false;
}

export function getLastTabs() {
  return lastTabs;
}

export async function bridgeGetStatus() {
  if (mode === 'client' && mcpClientWs?.readyState === WebSocket.OPEN) {
    return new Promise((resolve, reject) => {
      const handler = (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'status') {
            mcpClientWs.off('message', handler);
            lastTabs = msg.tabs ?? lastTabs;
            resolve(msg);
          }
        } catch {
          /* ignore */
        }
      };
      mcpClientWs.on('message', handler);
      mcpClientWs.send(JSON.stringify({ type: 'status' }));
      setTimeout(() => {
        mcpClientWs?.off('message', handler);
        reject(new Error('status 超时'));
      }, 5000);
    });
  }
  return {
    extensionConnected: extensionWs?.readyState === WebSocket.OPEN,
    tabs: lastTabs,
    domain: daemonMeta?.domain ?? extensionWs?.reportedDomain ?? null,
    wsPort: daemonMeta?.wsPort ?? null,
    httpPort: daemonMeta?.httpPort ?? null,
    pageUrlMatch: daemonMeta?.pageUrlMatch ?? null,
  };
}

export function closeBridgeClient() {
  if (mcpClientWs) {
    try {
      mcpClientWs.close();
    } catch {
      /* ignore */
    }
  }
  mcpClientWs = null;
  clientConnectedPort = null;
  mcpClients.clear();
  if (mode === 'client') mode = 'none';
}

export async function connectBridgeClientOnly(port = DEFAULT_PORT) {
  if (mcpClientWs?.readyState === WebSocket.OPEN && clientConnectedPort === port) return;
  closeBridgeClient();
  clientConnectedPort = port;
  return connectBridgeClient(port);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForExtension(maxMs = 60_000, wsPort = DEFAULT_PORT) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await connectBridgeClientOnly(wsPort);
      const st = await bridgeGetStatus();
      if (st.extensionConnected) return st;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(
    `扩展未在 ${maxMs}ms 内连接桥接 (ws://127.0.0.1:${wsPort})。请打开试玩页并确认 Inspector MCP 为已连接。`
  );
}

export function listenBridgeServer(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: preferredPort,
      verifyClient: (info) => verifyLocalBridgeClient(info),
    });

    const onListenError = (err) => {
      server.removeListener('error', onListenError);
      if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
        server.close();
        listenBridgeServer(0).then(resolve).catch(reject);
        return;
      }
      reject(err);
    };

    server.on('error', onListenError);

    server.on('listening', () => {
      server.removeListener('error', onListenError);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : preferredPort;
      wss = server;
      mode = 'server';
      server.on('connection', wireConnection);
      resolve(actualPort);
    });
  });
}

export function startBridge(port = DEFAULT_PORT, meta = null) {
  if (meta) setDaemonMeta(meta);
  if (mode === 'server' && wss) return Promise.resolve(daemonMeta?.wsPort ?? port);
  if (mode === 'client' && mcpClientWs?.readyState === WebSocket.OPEN) {
    return Promise.resolve(daemonMeta?.wsPort ?? port);
  }

  return listenBridgeServer(port).then((actualPort) => {
    if (daemonMeta) daemonMeta.wsPort = actualPort;
    if (daemonMeta?.domain) syncRegistryExtension(false);
    return actualPort;
  });
}

export function stopBridgeServer() {
  if (wss) {
    try {
      wss.close();
    } catch {
      /* ignore */
    }
  }
  wss = null;
  extensionWs = null;
  if (mode === 'server') mode = 'none';
  if (daemonMeta?.domain) {
    removeRegistryInstance(daemonMeta.domain);
  }
}

export function bridgeApiCall(method, argList = [], opts = {}) {
  const id = ++seq;
  const payload = {
    type: 'call',
    id,
    method,
    args: argList,
    pageUrlMatch: opts.pageUrlMatch ?? daemonMeta?.pageUrlMatch ?? process.env.COCOS_PAGE_URL_MATCH ?? '',
    timeoutMs: opts.timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`桥接调用超时 (${method})`));
    }, opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);

    if (mode === 'client') {
      if (!mcpClientWs || mcpClientWs.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        reject(new Error('MCP 桥接客户端未连接'));
        return;
      }
      pending.set(id, { resolve, reject, timer });
      mcpClientWs.send(JSON.stringify(payload));
      return;
    }

    if (mode !== 'server') {
      clearTimeout(timer);
      reject(new Error('桥接未启动'));
      return;
    }

    pending.set(id, { resolve, reject, timer });

    if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
      clearTimeout(timer);
      pending.delete(id);
      reject(
        new Error(
          '扩展未连接 MCP 桥接。请用普通 Chrome 打开试玩页并确认扩展已加载。'
        )
      );
      return;
    }

    extensionWs.send(JSON.stringify(payload));
  });
}

/** 向指定端口的 daemon 发起一次性调用（多实例路由） */
export function callBridgeAtPort(port, method, argList = [], opts = {}) {
  const id = ++ephemeralSeq;
  const payload = {
    type: 'call',
    id,
    method,
    args: argList,
    pageUrlMatch: opts.pageUrlMatch ?? '',
  };

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      pending.delete(id);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`桥接调用超时 (${method} @ :${port})`));
    }, opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify({ role: 'mcp' }));
      pending.set(id, {
        resolve: (r) => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolve(r);
        },
        reject: (e) => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(e);
        },
        timer,
      });
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'response' && msg.id === id) {
          routeResponse(msg);
        }
      } catch {
        /* ignore */
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    });
  });
}

export async function bridgeCaptureVisibleTab(pageUrlMatch) {
  return bridgeApiCall('__captureVisibleTab', [], { pageUrlMatch });
}
