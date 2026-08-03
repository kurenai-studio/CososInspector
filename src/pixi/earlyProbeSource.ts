/**
 * 注入到页面主世界的同步探针源码（字符串）。
 *
 * 仅在 popup「启用 PixiJS 探测」打开后由 content 注入。
 * 激进 webpack 偷 require / 扫模块：仅已知试玩域，避免白屏普通站。
 *
 * Eternal Dusk / SlotMill 要点（Playwright 实探）：
 * - 仅有 webpackChunk*，无 window.__webpack_require__ / .c
 * - 用 chunk.push([ids, {}, runtimeFn]) 可偷到 require；模块在 require.m
 * - this.pixiApp = new Application(...)；hook Application.prototype.render
 */
export const EARLY_PIXI_PROBE_SOURCE = `(function () {
  if (window.__cocosInspectorEarlyProbe) return;
  // 开关未开则直接退出（双重保险；content 默认不注入本脚本）
  if (window.__cocosInspectorPixiEnabled !== true) return;
  window.__cocosInspectorEarlyProbe = true;
  window.__cocosInspectorPixiHint = !!window.__cocosInspectorPixiHint;
  window.__cocosInspectorPixiApps = window.__cocosInspectorPixiApps || [];

  function isKnownPixiHost() {
    try {
      return /(^|\\.)(slotmill\\.com|gameart\\.io|gahypergaming\\.com)$/i
        .test(location.hostname);
    } catch (e) { return false; }
  }
  /** 允许偷 webpack / 扫模块：仅已知宿主，避免误伤全网 SPA */
  function allowAggressiveWebpack() {
    return isKnownPixiHost();
  }

  function looksLikeStage(v) {
    return !!(v && typeof v === 'object' && Array.isArray(v.children));
  }
  function looksLikeApp(v) {
    return !!(v && looksLikeStage(v.stage) && (v.renderer || v.view || v.canvas || v.ticker));
  }
  function looksLikePixiLib(v) {
    if (!v || typeof v !== 'object') return false;
    if (typeof v.Application !== 'function') return false;
    return !!(typeof v.Container === 'function' || typeof v.Sprite === 'function');
  }
  function looksLikeRendererCtor(v) {
    return !!(typeof v === 'function' && v.prototype &&
      typeof v.prototype.render === 'function' &&
      (typeof v.prototype.resize === 'function' ||
        typeof v.prototype.generateTexture === 'function'));
  }
  function stageRoot(node) {
    var n = node, g = 0;
    while (n && n.parent && g++ < 64) n = n.parent;
    return n;
  }
  function registerApp(app) {
    try {
      if (!app || !looksLikeStage(app.stage)) return false;
      if (window.__PIXI_APP__ === app) return true;
      if (!(app.renderer || app.view || app.canvas || app.ticker ||
            typeof app.render === 'function')) {
        return false;
      }
      window.__cocosInspectorPixiHint = true;
      window.__PIXI_APP__ = app;
      window.__PIXI_STAGE__ = app.stage;
      var list = window.__cocosInspectorPixiApps;
      if (list.indexOf(app) < 0) {
        list.push(app);
        if (list.length > 8) list.splice(0, list.length - 8);
      }
      var view = app.canvas || app.view ||
        (app.renderer && (app.renderer.canvas || app.renderer.view));
      if (view && view instanceof HTMLCanvasElement) {
        try { view.__PIXI_APP__ = app; } catch (e) {}
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  function registerStageRenderer(stage, renderer) {
    try {
      if (!looksLikeStage(stage) || !renderer) return;
      registerApp({
        stage: stageRoot(stage),
        renderer: renderer,
        view: renderer.view || renderer.canvas,
        canvas: renderer.canvas || renderer.view,
        ticker: null
      });
    } catch (e) {}
  }

  function patchApplicationPrototype(Application) {
    if (!Application || !Application.prototype) return;
    var proto = Application.prototype;
    if (proto.render && !proto.render.__cocosInspLive) {
      var or = proto.render;
      proto.render = function () {
        try { registerApp(this); } catch (e) {}
        return or.apply(this, arguments);
      };
      proto.render.__cocosInspLive = true;
    }
    if (proto.start && !proto.start.__cocosInspLive) {
      var os = proto.start;
      proto.start = function () {
        try { registerApp(this); } catch (e) {}
        return os.apply(this, arguments);
      };
      proto.start.__cocosInspLive = true;
    }
  }

  function patchRendererPrototype(Renderer) {
    if (!looksLikeRendererCtor(Renderer)) return;
    var proto = Renderer.prototype;
    if (!proto.render || proto.render.__cocosInspLive) return;
    var or = proto.render;
    proto.render = function (displayObject) {
      try {
        if (!window.__PIXI_APP__ && looksLikeStage(displayObject)) {
          registerStageRenderer(displayObject, this);
        }
      } catch (e) {}
      return or.apply(this, arguments);
    };
    proto.render.__cocosInspLive = true;
  }

  function patchApplicationCtor(Application) {
    if (!Application) return Application;
    patchApplicationPrototype(Application);
    if (Application.__cocosInspPatched) return Application;
    var Orig = Application;
    function Wrapped() {
      var inst;
      try {
        inst = Reflect.construct(Orig, arguments, new.target || Wrapped);
      } catch (e1) {
        inst = new (Function.prototype.bind.apply(
          Orig, [null].concat([].slice.call(arguments))
        ))();
      }
      registerApp(inst);
      try {
        if (inst && typeof inst.init === 'function' && !inst.init.__cocosInspWrapped) {
          var oi = inst.init.bind(inst);
          inst.init = function () {
            var r = oi.apply(inst, arguments);
            if (r && typeof r.then === 'function') {
              return r.then(function (x) { registerApp(inst); return x; });
            }
            registerApp(inst);
            return r;
          };
          inst.init.__cocosInspWrapped = true;
        }
      } catch (e) {}
      return inst;
    }
    Wrapped.prototype = Orig.prototype;
    try { Object.setPrototypeOf(Wrapped, Orig); } catch (e) {}
    Wrapped.__cocosInspPatched = true;
    Wrapped.__cocosInspOrig = Orig;
    return Wrapped;
  }

  function patchPixiNamespace(ns) {
    if (!ns || typeof ns !== 'object') return;
    try {
      if (ns.Application) {
        ns.Application = patchApplicationCtor(ns.Application);
        patchApplicationPrototype(ns.Application);
      }
      if (ns.Renderer) patchRendererPrototype(ns.Renderer);
      if (ns.WebGLRenderer) patchRendererPrototype(ns.WebGLRenderer);
    } catch (e) {}
  }

  function markPixiLib(ns) {
    window.__cocosInspectorPixiHint = true;
    window.__cocosInspectorPixiLib = true;
    patchPixiNamespace(ns);
  }

  // console 劫持仅已知宿主（普通站日志包装易踩雷）
  if (allowAggressiveWebpack()) {
    function markConsole(args) {
      try {
        for (var i = 0; i < args.length; i++) {
          var s = typeof args[i] === 'string' ? args[i] : String(args[i]);
          if (/PixiJS|pixi\\.js|@pixi\\//i.test(s)) {
            window.__cocosInspectorPixiHint = true;
            return;
          }
        }
      } catch (e) {}
    }
    ['warn', 'log', 'error', 'info'].forEach(function (m) {
      try {
        var orig = console[m].bind(console);
        console[m] = function () {
          markConsole(arguments);
          return orig.apply(console, arguments);
        };
      } catch (e) {}
    });
  }

  try {
    var _pixi = window.PIXI;
    Object.defineProperty(window, 'PIXI', {
      configurable: true,
      enumerable: true,
      get: function () { return _pixi; },
      set: function (v) {
        _pixi = v;
        markPixiLib(v);
      }
    });
    if (_pixi) markPixiLib(_pixi);
  } catch (e) {}

  function stealWebpackRequire() {
    if (!allowAggressiveWebpack()) return null;
    try {
      if (typeof window.__webpack_require__ === 'function' &&
          (window.__webpack_require__.m || window.__webpack_require__.c)) {
        return window.__webpack_require__;
      }
      if (window.__cocosInspectorWebpackRequire) {
        return window.__cocosInspectorWebpackRequire;
      }
      var names = Object.getOwnPropertyNames(window);
      var sawChunk = false;
      for (var i = 0; i < names.length; i++) {
        var k = names[i];
        if (k.indexOf('webpackChunk') !== 0 && k.indexOf('webpackJsonp') !== 0) continue;
        sawChunk = true;
        var chunk = window[k];
        if (!Array.isArray(chunk)) continue;
        if (chunk.__cocosInspStolen) {
          return window.__cocosInspectorWebpackRequire || null;
        }
        var got = null;
        chunk.push([
          ['__cocos_insp_rt_' + Date.now()],
          {},
          function (req) {
            got = req;
            window.__webpack_require__ = req;
            window.__cocosInspectorWebpackRequire = req;
          }
        ]);
        chunk.__cocosInspStolen = true;
        if (typeof got === 'function') return got;
      }
      if (!sawChunk) return null;
    } catch (e) {}
    return window.__webpack_require__ || null;
  }

  function scanExportsLight(exp) {
    if (!exp || typeof exp !== 'object') return;
    try {
      if (looksLikePixiLib(exp)) markPixiLib(exp);
      else if (exp.pixiApp && looksLikeStage(exp.pixiApp.stage)) registerApp(exp.pixiApp);
      else if (looksLikeApp(exp)) registerApp(exp);
    } catch (e) {}
  }

  function scanWebpack() {
    if (!allowAggressiveWebpack()) return;
    try {
      if (window.__cocosInspectorPixiLib) return;
      var req = stealWebpackRequire();
      if (!req || typeof req !== 'function') return;

      var patchedLibs = 0;
      var factories = req.m;
      if (factories && typeof factories === 'object') {
        var ids = Object.keys(factories);
        var limit = Math.min(ids.length, 1500);
        for (var i = 0; i < limit; i++) {
          try {
            var exp = req(ids[i]);
            if (looksLikePixiLib(exp)) {
              markPixiLib(exp);
              patchedLibs++;
            } else {
              scanExportsLight(exp);
            }
          } catch (e) {}
          if (patchedLibs >= 2) break;
        }
      }
    } catch (e) {}
  }

  try {
    if (isKnownPixiHost()) {
      window.__cocosInspectorPixiHint = true;
      window.__cocosInspectorPixiHost = true;
    }
  } catch (e) {}

  if (allowAggressiveWebpack()) {
    scanWebpack();
    var retries = 0;
    var timer = setInterval(function () {
      retries++;
      if (window.__PIXI_APP__) {
        clearInterval(timer);
        return;
      }
      if (!window.__cocosInspectorPixiLib) scanWebpack();
      if (retries >= 10) clearInterval(timer);
    }, 2000);
  }
})();`;
