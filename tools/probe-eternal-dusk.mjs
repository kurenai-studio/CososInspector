/**
 * 探活 Eternal Dusk：找出 Pixi Application / stage 挂载点
 */
import { createRequire } from 'module';
const require = createRequire('D:/workspace/harExplore/package.json');
const { chromium } = require('playwright');

const URL =
  process.env.URL ||
  'https://eternal-dusk.slotmill.com/?currency=EUR&language=en&org=SlotMill&homeurl=https://slotmill.com';

const probe = `
(() => {
  const out = {
    href: location.href,
    hasPIXI: !!window.PIXI,
    pixiKeys: window.PIXI ? Object.keys(window.PIXI).slice(0, 40) : [],
    __PIXI_APP__: !!(window.__PIXI_APP__ && window.__PIXI_APP__.stage),
    appsLen: (window.__cocosInspectorPixiApps || []).length,
    hint: !!window.__cocosInspectorPixiHint,
    lib: !!window.__cocosInspectorPixiLib,
    host: !!window.__cocosInspectorPixiHost,
    canvasCount: document.querySelectorAll('canvas').length,
    webpackRequire: typeof window.__webpack_require__,
    chunkKeys: Object.getOwnPropertyNames(window).filter(
      (k) => k.startsWith('webpackChunk') || k.startsWith('webpackJsonp')
    ),
    windowAppKeys: [],
    pixiLibModules: [],
    appLikeCount: 0,
    sampleApp: null,
    tickerShared: false,
    errors: []
  };

  try {
    for (const k of Object.getOwnPropertyNames(window).slice(0, 500)) {
      try {
        const v = window[k];
        if (!v || typeof v !== 'object') continue;
        if (v.stage && Array.isArray(v.stage.children) && (v.renderer || v.ticker || v.canvas)) {
          out.windowAppKeys.push(k);
          out.appLikeCount++;
          if (!out.sampleApp) {
            out.sampleApp = {
              key: k,
              ctor: v.constructor && v.constructor.name,
              childCount: v.stage.children.length,
              hasRenderer: !!v.renderer,
              hasTicker: !!v.ticker
            };
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    out.errors.push(String(e));
  }

  try {
    const req = window.__webpack_require__;
    if (typeof req === 'function' && req.c) {
      let n = 0;
      for (const id of Object.keys(req.c)) {
        const exp = req.c[id] && req.c[id].exports;
        if (!exp || typeof exp !== 'object') continue;
        const hasApp = typeof exp.Application === 'function';
        const hasContainer = typeof exp.Container === 'function';
        const hasSprite = typeof exp.Sprite === 'function';
        if (hasApp && (hasContainer || hasSprite)) {
          out.pixiLibModules.push({
            id,
            keys: Object.keys(exp).slice(0, 30),
            VERSION: exp.VERSION || null,
            hasTicker: typeof exp.Ticker === 'function',
            hasRenderer: typeof exp.Renderer === 'function',
            ApplicationPatched: !!(exp.Application && exp.Application.__cocosInspPatched)
          });
        }
        // live app instance exported?
        if (exp.stage && Array.isArray(exp.stage.children) && (exp.renderer || exp.ticker)) {
          out.appLikeCount++;
          if (!out.sampleApp) {
            out.sampleApp = {
              key: 'webpack:' + id,
              ctor: exp.constructor && exp.constructor.name,
              childCount: exp.stage.children.length
            };
          }
        }
        // nested default
        const d = exp.default;
        if (d && typeof d === 'object') {
          if (typeof d.Application === 'function' && typeof d.Container === 'function') {
            out.pixiLibModules.push({
              id: id + '#default',
              keys: Object.keys(d).slice(0, 30),
              VERSION: d.VERSION || null
            });
          }
        }
        if (++n > 8000) break;
      }
    }
  } catch (e) {
    out.errors.push('webpack:' + e);
  }

  // scan constructor names on canvas-related
  try {
    const canvases = [...document.querySelectorAll('canvas')];
    out.canvases = canvases.map((c) => ({
      w: c.width,
      h: c.height,
      hasApp: !!(c.__PIXI_APP__ && c.__PIXI_APP__.stage),
      parent: c.parentElement && c.parentElement.tagName
    }));
  } catch (e) {}

  // Look for common SlotMill globals
  out.globals = {};
  for (const k of ['game', 'app', 'application', 'Game', 'slot', 'engine', 'pixi', 'PIXI', 'store', 'config']) {
    try {
      const v = window[k];
      out.globals[k] = v == null ? null : typeof v;
      if (v && typeof v === 'object') {
        out.globals[k + '_keys'] = Object.keys(v).slice(0, 20);
        if (v.app) out.globals[k + '.app'] = typeof v.app;
        if (v.stage) out.globals[k + '.stage'] = Array.isArray(v.stage.children);
      }
    } catch (e) {
      out.globals[k] = 'error';
    }
  }

  return out;
})()
`;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (/PixiJS|pixi|Cocos Inspector|__PIXI/i.test(t)) {
      console.log('[console]', t.slice(0, 200));
    }
  });

  console.log('goto', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // wait for game canvas
  await page.waitForTimeout(8000);
  try {
    await page.waitForSelector('canvas', { timeout: 30000 });
  } catch {
    console.log('no canvas yet');
  }
  await page.waitForTimeout(5000);

  const result = await page.evaluate(probe);
  console.log(JSON.stringify(result, null, 2));

  // deeper: find any object with constructor name Application
  const deeper = await page.evaluate(() => {
    const hits = [];
    const req = window.__webpack_require__;
    if (typeof req !== 'function' || !req.c) return { hits, reason: 'no webpack c' };
    for (const id of Object.keys(req.c)) {
      const exp = req.c[id]?.exports;
      if (!exp) continue;
      const name = exp?.constructor?.name;
      if (name === 'Application' && exp.stage) {
        hits.push({ id, children: exp.stage?.children?.length, keys: Object.keys(exp).slice(0, 15) });
      }
      // search one level values
      if (typeof exp === 'object') {
        for (const [k, v] of Object.entries(exp)) {
          if (v && v.constructor?.name === 'Application' && v.stage) {
            hits.push({
              id,
              key: k,
              children: v.stage.children?.length,
            });
          }
        }
      }
      if (hits.length >= 10) break;
    }
    return { hits, moduleCount: Object.keys(req.c).length };
  });
  console.log('deeper', JSON.stringify(deeper, null, 2));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
