#!/usr/bin/env node
/**
 * 查 Egret 面板当前状态：status 文字、按钮 disabled、console 错误日志
 */
const WS_URL = process.argv[2];
if (!WS_URL) { console.error('usage: node egret-cdp-status.mjs ws://...'); process.exit(1); }

const ws = new WebSocket(WS_URL);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data.toString());
  if (m.id != null && pending.has(m.id)) {
    const {resolve, reject} = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
});
function send(method, params = {}) {
  const thisId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(thisId, {resolve, reject});
    ws.send(JSON.stringify({id: thisId, method, params}));
  });
}
function evalJs(expression) {
  return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }).then(r => {
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? 'err' };
    return r.result?.value;
  });
}

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');
    await send('Log.enable');

    const status = await evalJs(`(() => {
      const el = document.querySelector('.cocos-inspector-root .inspector-status');
      return el ? el.textContent : '(no status)';
    })()`);
    console.log('[status]', status);

    const state = await evalJs(`(() => {
      const root = document.querySelector('.cocos-inspector-root');
      if (!root) return { error: 'no root' };
      const btn = root.querySelector('.download-btn');
      const menu = root.querySelector('.download-menu');
      const selectedRow = root.querySelector('.node-tree-item.selected, .node-tree-item[data-selected="true"]');
      // 选中节点 ID：detail 标题里有
      const detailTitle = root.querySelector('.node-inspector-title');
      return {
        btnDisabled: btn ? btn.disabled : null,
        btnText: btn ? btn.textContent : null,
        menuDisplay: menu ? menu.style.display : null,
        detailTitle: detailTitle ? detailTitle.textContent : null,
      };
    })()`);
    console.log('[state]', JSON.stringify(state));

    const api = await evalJs(`(() => {
      const a = window.__cocosInspectorApi && window.__cocosInspectorApi.egret;
      if (!a) return { ready: false };
      return {
        ready: true,
        hasScene: !!(window.egret && window.egret.sys && window.egret.sys.$TempStage),
        spriteCount: typeof a.listSprites === 'function' ? a.listSprites().length : -1,
        dragonBonesCount: typeof a.listDragonBones === 'function' ? a.listDragonBones().length : -1,
        spineCount: typeof a.listSpines === 'function' ? a.listSpines().length : -1,
      };
    })()`);
    console.log('[api]', JSON.stringify(api));

    // console 错误日志（最近 30 条）
    const logs = await send('Runtime.getHeapUsage').catch(() => null);
    // 用 Logging API：Log.entryAdded 事件
    const logEntries = await evalJs(`(() => {
      // 重写 console.error 抓最近 30 条
      if (!window.__capturedErrors) {
        window.__capturedErrors = [];
        const orig = console.error;
        console.error = function(...args) {
          try { window.__capturedErrors.push(args.map(a => (a && a.stack) || String(a)).join(' ')); } catch {}
          if (window.__capturedErrors.length > 50) window.__capturedErrors.shift();
          orig.apply(console, args);
        };
        return 'just-installed';
      }
      return window.__capturedErrors.slice(-30);
    })()`);
    console.log('[errs]', JSON.stringify(logEntries));

  } catch (e) {
    console.error('err:', e.message);
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', (e) => console.error('ws err:', e.message || e));
