/// <reference path="./types/chrome.d.ts" />

const DEFAULT_API_CALL_TIMEOUT_MS = 120_000;
const API_CALL_TIMEOUT_BY_METHOD: Record<string, number> = {
  downloadTexture: 300_000,
  downloadSpine: 300_000,
  downloadBmfont: 180_000,
  listSprites: 180_000,
  exportSceneSnapshot: 300_000,
};

const getApiCallTimeoutMs = (method: string): number =>
  API_CALL_TIMEOUT_BY_METHOD[method] ?? DEFAULT_API_CALL_TIMEOUT_MS;
let pageApiReady = false;

function markPageApiReady(): void {
    pageApiReady = true;
}

// 注入资源到页面
function injectResources(): void {
    console.log('Injecting Cocos Inspector resources...');

    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.type = 'text/css';
    style.href = chrome.runtime.getURL('dist/inspector.css');
    document.head.appendChild(style);

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dist/injected.js');
    document.head.appendChild(script);
}

function notifyExtensionActive(): void {
    try {
        chrome.runtime.sendMessage({ type: 'cocos-page-active', url: location.href });
    } catch {
        /* ignore */
    }
}

async function waitForPageApi(maxMs = 30_000): Promise<void> {
    if (pageApiReady) return;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (pageApiReady) return;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('页面 Inspector API 未就绪，请刷新试玩页');
}

function callPageApi(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const requestId = `api_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const timer = window.setTimeout(() => {
            window.removeEventListener('message', onResponse);
            reject(new Error(`页面 API 超时 (${method})`));
        }, getApiCallTimeoutMs(method));

        const onResponse = (ev: MessageEvent) => {
            if (ev.source !== window || ev.data?.type !== 'cocos-api-response') return;
            if (ev.data.requestId !== requestId) return;
            window.clearTimeout(timer);
            window.removeEventListener('message', onResponse);
            if (ev.data.error) reject(new Error(String(ev.data.error)));
            else resolve(ev.data.result);
        };

        window.addEventListener('message', onResponse);
        window.postMessage(
            { type: 'cocos-api-call', requestId, method, args: args ?? [] },
            '*'
        );
    });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'cocos-api-call') {
        void waitForPageApi()
            .then(() => callPageApi(message.method, message.args ?? []))
            .then((result) => sendResponse({ ok: true, result }))
            .catch((e) =>
                sendResponse({
                    ok: false,
                    error: e instanceof Error ? e.message : String(e),
                })
            );
        return true;
    }

    if (message?.type === 'cocos-api-ping') {
        void waitForPageApi()
            .then(() => callPageApi('getPageInfo', []))
            .then((result) => sendResponse({ ok: true, result }))
            .catch((e) =>
                sendResponse({
                    ok: false,
                    error: e instanceof Error ? e.message : String(e),
                })
            );
        return true;
    }

    return false;
});

function pollMcpStatus(): void {
    try {
        chrome.runtime.sendMessage({ type: 'get-mcp-status' }, (res) => {
            if (chrome.runtime.lastError || !res) return;
            window.postMessage(
                {
                    type: 'cocos-mcp-status',
                    status: res.status,
                    port: res.port,
                    wsUrl: res.wsUrl,
                },
                '*'
            );
        });
    } catch {
        /* ignore */
    }
}

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'cocos-mcp-status') {
        window.postMessage(message, '*');
    }
});

if (document.readyState === 'complete') {
    injectResources();
    notifyExtensionActive();
} else {
    window.addEventListener('load', () => {
        injectResources();
        notifyExtensionActive();
    });
}

window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'cocos-inspector-ready') {
        markPageApiReady();
        notifyExtensionActive();
    }
});

pollMcpStatus();
window.setInterval(pollMcpStatus, 1500);
