/**
 * 运行时 Dump：收集已加载脚本模块、业务类、资源 URL / bundle config。
 * 供 MCP 落盘后交给 cc-reverse / webcrack，不是还原原 TS。
 */

import { isCustomComponentName } from './scriptRecover';
import { getSceneRoot } from './sceneTree';

const DEFAULT_MAX_SCRIPT_CHARS = 200_000;
const DEFAULT_MAX_TOTAL_SCRIPT_CHARS = 4_000_000;
const DEFAULT_MAX_CLASSES = 400;
const DEFAULT_MAX_URLS = 5000;

export interface RuntimeDumpOptions {
  /** 是否收集 System 模块源码 */
  includeModuleSources?: boolean;
  /** 是否收集自定义组件 toString */
  includeClassSources?: boolean;
  /** 是否收集 performance / 资源 URL */
  includeResourceUrls?: boolean;
  /** 是否尝试序列化已加载 bundle config */
  includeBundleConfigs?: boolean;
  maxScriptChars?: number;
  maxTotalScriptChars?: number;
  maxClasses?: number;
  maxUrls?: number;
}

export interface RuntimeDumpModule {
  id: string;
  source: string | null;
  truncated: boolean;
  error?: string;
}

export interface RuntimeDumpClass {
  className: string;
  compiledSource: string;
  truncated: boolean;
  propNames: string[];
}

export interface RuntimeDumpBundle {
  name: string;
  base?: string;
  config?: unknown;
  error?: string;
}

export interface RuntimeDumpResult {
  ok: true;
  version: 1;
  pageUrl: string;
  origin: string;
  engineVersion: string;
  capturedAt: string;
  sceneName: string;
  stats: {
    moduleCount: number;
    classCount: number;
    urlCount: number;
    bundleCount: number;
    totalScriptChars: number;
    truncatedScripts: number;
  };
  modules: RuntimeDumpModule[];
  classes: RuntimeDumpClass[];
  resourceUrls: string[];
  jsUrls: string[];
  configUrls: string[];
  bundles: RuntimeDumpBundle[];
  notes: string[];
}

export type RuntimeDumpError = { ok: false; error: string };

function capText(
  text: string,
  maxChars: number
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n/* --- truncated ${text.length - maxChars} chars --- */\n`,
    truncated: true,
  };
}

function uniqueUrls(urls: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const u = String(raw || '').trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

function absUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function collectPerformanceUrls(max: number): string[] {
  const urls: string[] = [];
  try {
    const entries = performance.getEntriesByType(
      'resource'
    ) as PerformanceResourceTiming[];
    for (const e of entries) {
      if (e.name) urls.push(e.name);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const s of Array.from(document.scripts)) {
      if (s.src) urls.push(s.src);
    }
  } catch {
    /* ignore */
  }
  return uniqueUrls(urls, max);
}

function collectSystemModules(
  includeSources: boolean,
  maxScriptChars: number,
  budget: { used: number; max: number }
): { modules: RuntimeDumpModule[]; truncatedScripts: number } {
  const modules: RuntimeDumpModule[] = [];
  let truncatedScripts = 0;
  const System = (window as Window & { System?: Record<string, unknown> })
    .System;
  if (!System) return { modules, truncatedScripts };

  const ids = new Set<string>();

  const registry = System.registry as
    | Map<string, unknown>
    | Record<string, unknown>
    | undefined;
  if (registry instanceof Map) {
    for (const k of registry.keys()) ids.add(String(k));
  } else if (registry && typeof registry === 'object') {
    for (const k of Object.keys(registry)) ids.add(k);
  }

  // 常见私有表兜底
  for (const key of ['_loader', 'entries', '_registry']) {
    const bag = System[key] as Map<string, unknown> | Record<string, unknown> | undefined;
    if (bag instanceof Map) {
      for (const k of bag.keys()) ids.add(String(k));
    } else if (bag && typeof bag === 'object') {
      for (const k of Object.keys(bag)) ids.add(k);
    }
  }

  const has = (System as { has?: (id: string) => boolean }).has;
  const get = (System as { get?: (id: string) => unknown }).get;

  for (const id of ids) {
    if (typeof has === 'function') {
      try {
        if (!has.call(System, id)) continue;
      } catch {
        /* keep */
      }
    }
    const mod: RuntimeDumpModule = {
      id,
      source: null,
      truncated: false,
    };
    if (includeSources && budget.used < budget.max) {
      try {
        const rec = typeof get === 'function' ? get.call(System, id) : null;
        // SystemJS 模块记录不一定带源码；优先从 script 标签 / import 映射无法可靠取，
        // 尝试 toString 注册工厂（若存在）
        const factory =
          rec &&
          typeof rec === 'object' &&
          (rec as { execute?: unknown; source?: unknown });
        let raw = '';
        if (factory && typeof factory.source === 'string') {
          raw = factory.source;
        } else if (
          factory &&
          typeof (factory as { execute?: () => unknown }).execute === 'function'
        ) {
          raw = String((factory as { execute: () => unknown }).execute);
        }
        if (raw) {
          const remain = budget.max - budget.used;
          const capped = capText(raw, Math.min(maxScriptChars, remain));
          mod.source = capped.text;
          mod.truncated = capped.truncated;
          budget.used += capped.text.length;
          if (capped.truncated) truncatedScripts += 1;
        }
      } catch (e) {
        mod.error = e instanceof Error ? e.message : String(e);
      }
    }
    modules.push(mod);
  }

  return { modules, truncatedScripts };
}

function walkNodes(root: cc.Node, visit: (n: cc.Node) => void): void {
  visit(root);
  const children = root.children ?? [];
  for (const c of children) walkNodes(c, visit);
}

function collectCustomClasses(
  includeSources: boolean,
  maxClasses: number,
  maxScriptChars: number,
  budget: { used: number; max: number }
): { classes: RuntimeDumpClass[]; truncatedScripts: number } {
  const classes: RuntimeDumpClass[] = [];
  let truncatedScripts = 0;
  const scene = getSceneRoot();
  if (!scene) return { classes, truncatedScripts };

  const byName = new Map<string, unknown>();

  walkNodes(scene, (node) => {
    const comps =
      (node as cc.Node & { _components?: unknown[] })._components ?? [];
    for (const comp of comps) {
      const rec = comp as {
        __classname__?: string;
        constructor?: { name?: string; prototype?: object };
      };
      const full = rec.__classname__ ?? rec.constructor?.name ?? '';
      const short = full.replace(/^cc\./, '').split('.').pop() ?? full;
      if (!short) continue;
      if (!isCustomComponentName(full) && !isCustomComponentName(short)) {
        continue;
      }
      if (!byName.has(short)) byName.set(short, comp);
    }
  });

  // 补充 js 注册表（若可枚举）
  try {
    const js = (window.cc as { js?: { _nameToClass?: Record<string, unknown> } })
      ?.js;
    const map = js?._nameToClass;
    if (map && typeof map === 'object') {
      for (const [name, cls] of Object.entries(map)) {
        if (!isCustomComponentName(name)) continue;
        if (!byName.has(name)) byName.set(name, { constructor: cls });
      }
    }
  } catch {
    /* ignore */
  }

  let n = 0;
  for (const [className, comp] of byName) {
    if (n >= maxClasses) break;
    n += 1;
    const propNames: string[] = [];
    const inst = comp as Record<string, unknown>;
    try {
      for (const k of Object.keys(inst)) {
        if (k.startsWith('_')) continue;
        if (typeof inst[k] === 'function') continue;
        propNames.push(k);
      }
    } catch {
      /* ignore */
    }

    let compiledSource = '';
    let truncated = false;
    if (includeSources && budget.used < budget.max) {
      const parts: string[] = [];
      const ctor = (comp as { constructor?: unknown }).constructor;
      if (typeof ctor === 'function') {
        try {
          parts.push(ctor.toString());
        } catch {
          /* ignore */
        }
      }
      const proto = (ctor as { prototype?: object } | undefined)?.prototype;
      if (proto) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (key === 'constructor') continue;
          const desc = Object.getOwnPropertyDescriptor(proto, key);
          if (desc?.value && typeof desc.value === 'function') {
            try {
              parts.push(`// --- ${key} ---\n${desc.value.toString()}`);
            } catch {
              /* ignore */
            }
          }
        }
      }
      const raw = parts.join('\n\n');
      const remain = budget.max - budget.used;
      const capped = capText(raw, Math.min(maxScriptChars, remain));
      compiledSource = capped.text;
      truncated = capped.truncated;
      budget.used += capped.text.length;
      if (capped.truncated) truncatedScripts += 1;
    }

    classes.push({
      className,
      compiledSource,
      truncated,
      propNames: propNames.sort(),
    });
  }

  return { classes, truncatedScripts };
}

function collectBundles(): RuntimeDumpBundle[] {
  const bundles: RuntimeDumpBundle[] = [];
  try {
    const am = (
      window.cc as {
        assetManager?: {
          bundles?: Map<string, unknown> | Record<string, unknown> & {
            forEach?: (cb: (b: unknown, name: string) => void) => void;
            _map?: Map<string, unknown>;
          };
        };
      }
    )?.assetManager;
    const bag = am?.bundles;
    if (!bag) return bundles;

    const entries: Array<[string, unknown]> = [];
    const pushEntry = (name: string, b: unknown) => {
      if (!name || name.startsWith('_')) return;
      if (name === 'count' || name === 'map') return;
      if (!b || typeof b !== 'object') return;
      entries.push([name, b]);
    };

    const asAny = bag as {
      forEach?: (cb: (b: unknown, name: string) => void) => void;
      _map?: Map<string, unknown>;
    };

    // Cocos Cache：优先 forEach，避免 Object.entries 扫到 _map/_count
    if (typeof asAny.forEach === 'function') {
      try {
        asAny.forEach((b, name) => pushEntry(String(name), b));
      } catch {
        /* fall through */
      }
    }
    if (entries.length === 0 && bag instanceof Map) {
      for (const [k, v] of bag.entries()) pushEntry(String(k), v);
    }
    if (entries.length === 0 && asAny._map instanceof Map) {
      for (const [k, v] of asAny._map.entries()) pushEntry(String(k), v);
    }
    if (entries.length === 0) {
      for (const [k, v] of Object.entries(bag)) pushEntry(k, v);
    }

    for (const [name, b] of entries) {
      const item: RuntimeDumpBundle = { name };
      try {
        const bundle = b as {
          name?: string;
          base?: string;
          _config?: unknown;
          config?: unknown;
        };
        const realName =
          typeof bundle.name === 'string' && bundle.name ? bundle.name : name;
        item.name = realName;
        item.base = typeof bundle.base === 'string' ? bundle.base : undefined;
        const cfg = bundle._config ?? bundle.config;
        if (cfg != null) {
          item.config = JSON.parse(JSON.stringify(cfg));
        }
      } catch (e) {
        item.error = e instanceof Error ? e.message : String(e);
      }
      bundles.push(item);
    }
  } catch {
    /* ignore */
  }
  return bundles;
}

function classifyUrls(urls: string[], pageUrl: string): {
  all: string[];
  jsUrls: string[];
  configUrls: string[];
} {
  const all = uniqueUrls(
    urls
      .map((u) => absUrl(u, pageUrl) || u)
      .filter(Boolean) as string[],
    DEFAULT_MAX_URLS
  );
  const jsUrls: string[] = [];
  const configUrls: string[] = [];
  for (const u of all) {
    const path = u.split('?')[0].toLowerCase();
    if (path.endsWith('.js') || path.includes('.js?')) jsUrls.push(u);
    if (path.includes('config') && path.endsWith('.json')) configUrls.push(u);
    if (/\/config\.[a-f0-9]+\.json$/i.test(path)) configUrls.push(u);
  }
  return {
    all,
    jsUrls: uniqueUrls(jsUrls, DEFAULT_MAX_URLS),
    configUrls: uniqueUrls(configUrls, 500),
  };
}

function urlsFromBundles(bundles: RuntimeDumpBundle[], pageUrl: string): string[] {
  const out: string[] = [];
  for (const b of bundles) {
    if (!b.base) continue;
    const base = (absUrl(b.base, pageUrl) || b.base).replace(/\/?$/, '/');
    out.push(`${base}config.json`);
    out.push(`${base}index.js`);
    // 全量 import/native 由 Node 侧按 config 展开（避免页内撑爆）
  }
  return out;
}

/**
 * 在试玩页主世界收集运行时 dump（可 MCP 调用）。
 */
export function collectRuntimeDump(
  options?: RuntimeDumpOptions
): RuntimeDumpResult | RuntimeDumpError {
  try {
    if (!window.cc) {
      return { ok: false, error: 'window.cc 未就绪' };
    }

    const includeModuleSources = options?.includeModuleSources !== false;
    const includeClassSources = options?.includeClassSources !== false;
    const includeResourceUrls = options?.includeResourceUrls !== false;
    const includeBundleConfigs = options?.includeBundleConfigs !== false;
    const maxScriptChars = options?.maxScriptChars ?? DEFAULT_MAX_SCRIPT_CHARS;
    const maxTotalScriptChars =
      options?.maxTotalScriptChars ?? DEFAULT_MAX_TOTAL_SCRIPT_CHARS;
    const maxClasses = options?.maxClasses ?? DEFAULT_MAX_CLASSES;
    const maxUrls = options?.maxUrls ?? DEFAULT_MAX_URLS;

    const pageUrl = window.location.href;
    const notes: string[] = [];
    const budget = { used: 0, max: maxTotalScriptChars };

    const { modules, truncatedScripts: t1 } = collectSystemModules(
      includeModuleSources,
      maxScriptChars,
      budget
    );
    const { classes, truncatedScripts: t2 } = collectCustomClasses(
      includeClassSources,
      maxClasses,
      maxScriptChars,
      budget
    );

    const bundles = includeBundleConfigs ? collectBundles() : [];
    if (!includeBundleConfigs) notes.push('已跳过 bundle config');

    const perfUrls = includeResourceUrls ? collectPerformanceUrls(maxUrls) : [];
    const fromBundles = urlsFromBundles(bundles, pageUrl);
    const classified = classifyUrls([...perfUrls, ...fromBundles], pageUrl);

    if (modules.length === 0) {
      notes.push('未枚举到 System 模块（可能非 SystemJS 或 registry 不可见）');
    }
    if (classes.length === 0) {
      notes.push('未收集到自定义组件类（场景未挂脚本或尚未加载）');
    }
    if (classified.configUrls.length === 0) {
      notes.push('未发现 config*.json URL；可先游玩触发远程 bundle 加载');
    }

    const scene = getSceneRoot();
    const result: RuntimeDumpResult = {
      ok: true,
      version: 1,
      pageUrl,
      origin: window.location.origin,
      engineVersion: String(window.cc?.ENGINE_VERSION ?? ''),
      capturedAt: new Date().toISOString(),
      sceneName: scene?.name ?? '',
      stats: {
        moduleCount: modules.length,
        classCount: classes.length,
        urlCount: classified.all.length,
        bundleCount: bundles.length,
        totalScriptChars: budget.used,
        truncatedScripts: t1 + t2,
      },
      modules,
      classes,
      resourceUrls: classified.all,
      jsUrls: classified.jsUrls,
      configUrls: classified.configUrls,
      bundles,
      notes,
    };

    console.log(
      `[运行时Dump] ${result.sceneName} · modules=${result.stats.moduleCount} classes=${result.stats.classCount} urls=${result.stats.urlCount} bundles=${result.stats.bundleCount}`
    );
    return result;
  } catch (e) {
    console.error('[运行时Dump] 失败', e);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
