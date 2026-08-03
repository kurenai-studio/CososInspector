import { createRequire } from 'module';
const require = createRequire('D:/workspace/harExplore/package.json');
const { chromium } = require('playwright');

const URL =
  'https://eternal-dusk.slotmill.com/?currency=EUR&language=en&org=SlotMill&homeurl=https://slotmill.com';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('canvas', { timeout: 60000 });
  await page.waitForTimeout(5000);

  const result = await page.evaluate(async () => {
    const chunk = window.webpackChunketernal_dusk;
    let req = null;
    chunk.push([
      ['__insp_rt2_' + Date.now()],
      {},
      function (r) {
        req = r;
        window.__webpack_require__ = r;
      },
    ]);

    const info = {
      typeofReq: typeof req,
      keys: req ? Reflect.ownKeys(req).map(String) : [],
      props: {},
    };
    if (req) {
      for (const k of info.keys) {
        try {
          const v = req[k];
          info.props[k] =
            v == null
              ? String(v)
              : typeof v === 'function'
                ? 'fn'
                : typeof v === 'object'
                  ? 'obj:' + Object.keys(v).length
                  : typeof v;
        } catch (e) {
          info.props[k] = 'err';
        }
      }
    }

    // Try require.cache / m / moduleCache etc
    const cacheCandidates = ['c', 'cache', 'moduleCache', 'm'];
    for (const name of cacheCandidates) {
      try {
        const c = req && req[name];
        info['cache_' + name] = c ? Object.keys(c).length : 0;
      } catch (e) {
        info['cache_' + name] = 'err';
      }
    }

    // Walk chunk array entries for installed modules somehow
    info.chunkLen = chunk.length;

    // Alternative: hook Function to catch Application - too late

    // Alternative: find Application via Error stack sampling on rAF? 

    // Try: intercept Object.defineProperty on prototypes - no

    // Get all property names including non-enumerable on req
    if (req) {
      info.desc = Object.getOwnPropertyNames(req);
    }

    // webpack 5 sometimes puts modules only in closure; 
    // use req.m (module factories)
    try {
      if (req.m) {
        info.mKeys = Object.keys(req.m).length;
        info.mSample = Object.keys(req.m).slice(0, 10);
      }
    } catch (e) {}

    // Execute a known approach: iterate req.m and call? dangerous

    // Search in already-pushed chunk modules definitions for Application string - offline

    // LIVE: patch via stealing Application from module factory by requiring each module id
    const libs = [];
    const apps = [];
    if (req && req.m) {
      const ids = Object.keys(req.m);
      info.totalFactories = ids.length;
      for (const id of ids.slice(0, 3000)) {
        try {
          const exp = req(id);
          if (!exp || typeof exp !== 'object') continue;
          if (typeof exp.Application === 'function' && typeof exp.Container === 'function') {
            libs.push({ id, VERSION: exp.VERSION, keys: Object.keys(exp).slice(0, 15) });
          }
          if (exp.pixiApp?.stage) {
            apps.push({ id, children: exp.pixiApp.stage.children.length });
          }
          for (const [k, v] of Object.entries(exp)) {
            if (v?.pixiApp?.stage) {
              apps.push({
                id,
                key: k,
                children: v.pixiApp.stage.children.length,
                ctor: v.pixiApp.constructor?.name,
              });
            }
            if (
              v &&
              v.stage &&
              Array.isArray(v.stage.children) &&
              (v.renderer || v.ticker) &&
              v.constructor?.name === 'Application'
            ) {
              apps.push({
                type: 'Application',
                id,
                key: k,
                children: v.stage.children.length,
              });
            }
          }
        } catch (e) {
          /* circular / not ready */
        }
        if (libs.length >= 3 && apps.length >= 3) break;
      }
    }

    // If we found Application class, patch prototype.render and wait
    let patched = false;
    for (const lib of libs) {
      try {
        const exp = req(lib.id);
        const App = exp.Application;
        if (App?.prototype?.render && !App.prototype.render.__insp) {
          const o = App.prototype.render;
          App.prototype.render = function () {
            window.__PIXI_APP__ = this;
            window.__PIXI_STAGE__ = this.stage;
            window.__cocosInspectorPixiApps = window.__cocosInspectorPixiApps || [];
            if (window.__cocosInspectorPixiApps.indexOf(this) < 0) {
              window.__cocosInspectorPixiApps.push(this);
            }
            return o.apply(this, arguments);
          };
          App.prototype.render.__insp = true;
          patched = true;
        }
        if (exp.Renderer?.prototype?.render && !exp.Renderer.prototype.render.__insp) {
          const o = exp.Renderer.prototype.render;
          exp.Renderer.prototype.render = function (stage) {
            if (stage && Array.isArray(stage.children)) {
              window.__PIXI_STAGE__ = stage;
              window.__PIXI_APP__ = window.__PIXI_APP__ || {
                stage,
                renderer: this,
                view: this.view || this.canvas,
                canvas: this.canvas || this.view,
              };
            }
            return o.apply(this, arguments);
          };
          exp.Renderer.prototype.render.__insp = true;
          patched = true;
        }
      } catch (e) {}
    }

    return { info, libs, apps, patched };
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.patched) {
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      app: !!(window.__PIXI_APP__ && window.__PIXI_APP__.stage),
      children: window.__PIXI_APP__?.stage?.children?.length,
      ctor: window.__PIXI_APP__?.constructor?.name,
      appsLen: (window.__cocosInspectorPixiApps || []).length,
    }));
    console.log('AFTER PATCH FRAME', after);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
