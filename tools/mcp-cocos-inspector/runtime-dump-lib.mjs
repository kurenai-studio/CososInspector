/**
 * 将页内 runtime dump 落盘，并按 URL 拉取 JS / config / 资源。
 * 本阶段专注下载完整包；build 组装与 cc-reverse 另议。
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  expandUrlsFromBundleConfig,
  collectBundleConfigsForExpand,
  baseUrlFromConfigUrl,
  configExpandScore,
} from './expand-bundle-urls.mjs';

/**
 * @typedef {object} RuntimeDump
 * @property {boolean} ok
 * @property {string} [pageUrl]
 * @property {string} [origin]
 * @property {object} [stats]
 * @property {Array<{id:string,source:string|null,truncated?:boolean}>} [modules]
 * @property {Array<{className:string,compiledSource:string,propNames?:string[]}>} [classes]
 * @property {string[]} [resourceUrls]
 * @property {string[]} [jsUrls]
 * @property {string[]} [configUrls]
 * @property {Array<{name:string,base?:string,config?:unknown,error?:string}>} [bundles]
 * @property {string[]} [notes]
 */

function safeName(s) {
  return String(s || 'x')
    .replace(/[<>:"/\\|?*\s]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120) || 'x';
}

function writeText(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, obj) {
  writeText(filePath, JSON.stringify(obj, null, 2));
}

function urlToRelPath(url) {
  try {
    const u = new URL(url);
    let p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (!p || p.endsWith('/')) p += 'index';
    const q = u.searchParams.toString();
    if (q && q.length < 40) p += `_${safeName(q)}`;
    return p;
  } catch {
    return `misc/${safeName(url)}`;
  }
}

function isAssetLikeUrl(url) {
  const path = String(url || '').split('?')[0].toLowerCase();
  if (/\/(import|native)\//.test(path)) return true;
  return /\.(png|jpe?g|webp|gif|mp3|ogg|wav|m4a|bin|cconb|atlas|plist|fnt|skel|wasm|json)$/i.test(
    path,
  );
}

/**
 * @param {RuntimeDump} dump
 * @param {string} outDir
 */
export function materializeDumpLocal(dump, outDir) {
  mkdirSync(outDir, { recursive: true });
  writeJson(join(outDir, 'manifest.json'), dump);

  const scriptsDir = join(outDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });

  let moduleFiles = 0;
  for (const m of dump.modules || []) {
    if (!m?.source) continue;
    const file = join(scriptsDir, 'modules', `${safeName(m.id)}.js`);
    writeText(file, `/* module: ${m.id} */\n${m.source}\n`);
    moduleFiles += 1;
  }

  let classFiles = 0;
  for (const c of dump.classes || []) {
    if (!c?.compiledSource) continue;
    const file = join(scriptsDir, 'classes', `${safeName(c.className)}.js`);
    const header = `/* class: ${c.className} props: ${(c.propNames || []).join(', ')} */\n`;
    writeText(file, header + c.compiledSource + '\n');
    classFiles += 1;
  }

  const assetsDir = join(outDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  let bundleConfigs = 0;
  for (const b of dump.bundles || []) {
    if (!b?.config) continue;
    const file = join(assetsDir, safeName(b.name), 'config.json');
    writeJson(file, b.config);
    bundleConfigs += 1;
    if (b.base) {
      writeText(join(assetsDir, safeName(b.name), 'base.url.txt'), String(b.base));
    }
  }

  writeJson(join(outDir, 'urls.json'), {
    resourceUrls: dump.resourceUrls || [],
    jsUrls: dump.jsUrls || [],
    configUrls: dump.configUrls || [],
  });

  writeText(
    join(outDir, 'README.md'),
    [
      '# Runtime Dump',
      '',
      `- page: ${dump.pageUrl || ''}`,
      `- captured: ${dump.capturedAt || ''}`,
      `- modules with source: ${moduleFiles}`,
      `- classes with source: ${classFiles}`,
      `- bundle configs: ${bundleConfigs}`,
      '',
      '下载：`cocos_dump_runtime`（fetchUrls=true）会拉 js/config/按 config 展开的资源。',
      'build 组装与 cc-reverse 另见后续。',
      '',
      ...(dump.notes || []).map((n) => `- note: ${n}`),
      '',
    ].join('\n'),
  );

  return {
    outDir,
    moduleFiles,
    classFiles,
    bundleConfigs,
    urlCount: (dump.resourceUrls || []).length,
  };
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fetchOne(url, abs, dump) {
  try {
    mkdirSync(dirname(abs), { recursive: true });
    if (existsSync(abs)) {
      const st = statSync(abs);
      if (st.isFile() && st.size > 0) {
        return { url, ok: true, status: 200, path: abs, bytes: st.size, skipped: true };
      }
    }
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 CocosInspectorRuntimeDump/1.1',
        Referer: dump.pageUrl || dump.origin || '',
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return { url, ok: false, status: res.status };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(abs, buf);
    return { url, ok: true, status: res.status, path: abs, bytes: buf.length };
  } catch (e) {
    return {
      url,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 合并 dump / 已下载 config，展开全量资源 URL。
 * 优先使用带 uuids[] 的 CDN raw config；runtime 序列化 config 作兜底。
 * @param {RuntimeDump} dump
 * @param {string} downloadDir
 */
export function expandAssetUrls(dump, downloadDir) {
  /** @type {Map<string, { baseUrl: string, config: object, name: string, score: number }>} */
  const byBase = new Map();

  const put = (baseUrl, config, name) => {
    if (!baseUrl || !config) return;
    const key = baseUrl.replace(/\/?$/, '/');
    const score = configExpandScore(config);
    const prev = byBase.get(key);
    if (prev && prev.score >= score) return;
    byBase.set(key, {
      baseUrl: key,
      config,
      name: name || config.name || '',
      score,
    });
  };

  for (const item of collectBundleConfigsForExpand(dump)) {
    put(item.baseUrl, item.config, item.name);
  }

  // bundles[].base 即使 config 弱，也登记 base，方便和 disk 对齐
  for (const b of dump.bundles || []) {
    if (!b?.base) continue;
    let base = b.base;
    try {
      base = new URL(base, dump.pageUrl || undefined).href;
    } catch {
      /* keep */
    }
    if (b.config) put(base, b.config, b.name);
  }

  const walkConfigs = (dir) => {
    if (!existsSync(dir)) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walkConfigs(abs);
        continue;
      }
      if (!/^config(?:\.[a-f0-9]+)?\.json$/i.test(name)) continue;
      let raw;
      try {
        raw = JSON.parse(readFileSync(abs, 'utf8'));
      } catch {
        continue;
      }
      const bundleName = raw?.name || '';
      let baseUrl = '';
      for (const cu of dump.configUrls || []) {
        if (bundleName && cu.includes(`/${bundleName}/`)) {
          baseUrl = baseUrlFromConfigUrl(cu);
          break;
        }
      }
      if (!baseUrl && bundleName) {
        for (const b of dump.bundles || []) {
          if (b.name === bundleName && b.base) {
            try {
              baseUrl = new URL(b.base, dump.pageUrl || undefined).href;
            } catch {
              baseUrl = b.base;
            }
            break;
          }
        }
      }
      if (!baseUrl) continue;
      put(baseUrl, raw, bundleName);
    }
  };
  walkConfigs(downloadDir);

  /** @type {string[]} */
  const urls = [];
  /** @type {object[]} */
  const expandMeta = [];
  for (const item of byBase.values()) {
    const { urls: list, meta } = expandUrlsFromBundleConfig(item.config, item.baseUrl);
    urls.push(...list);
    expandMeta.push({ ...meta, score: item.score });
  }

  for (const cu of dump.configUrls || []) {
    const base = baseUrlFromConfigUrl(cu);
    if (!base) continue;
    const key = base.replace(/\/?$/, '/');
    if (byBase.has(key)) continue;
    urls.push(cu);
    urls.push(joinUrlLoose(base, 'index.js'));
  }

  return {
    urls: [...new Set(urls)],
    expandMeta,
  };
}

function joinUrlLoose(base, name) {
  return `${String(base).replace(/\/?$/, '/')}${name.replace(/^\//, '')}`;
}

/**
 * 拉取 dump 中的 URL 到 downloads/。
 * @param {RuntimeDump} dump
 * @param {string} outDir
 * @param {{
 *   maxFiles?: number,
 *   concurrency?: number,
 *   kinds?: Array<'js'|'config'|'asset'|'all'>,
 *   expandFromConfig?: boolean,
 * }} [opts]
 */
export async function fetchDumpUrls(dump, outDir, opts = {}) {
  const maxFiles = opts.maxFiles ?? 8000;
  const concurrency = opts.concurrency ?? 8;
  const expandFromConfig = opts.expandFromConfig !== false;
  const kinds = new Set(opts.kinds || ['js', 'config', 'asset']);

  /** @type {string[]} */
  let list = [];
  if (kinds.has('all')) {
    list = [...(dump.resourceUrls || [])];
  } else {
    if (kinds.has('js')) list.push(...(dump.jsUrls || []));
    if (kinds.has('config')) list.push(...(dump.configUrls || []));
    if (kinds.has('asset')) {
      for (const u of dump.resourceUrls || []) {
        if (isAssetLikeUrl(u)) list.push(u);
      }
    }
  }

  const downloadDir = join(outDir, 'downloads');
  mkdirSync(downloadDir, { recursive: true });

  // 先拉第一批（含 config），再按 config 展开
  list = [...new Set(list)].filter(
    (u) => u && !String(u).startsWith('chrome-extension://'),
  );
  const firstBatch = list.slice(0, Math.min(list.length, maxFiles));

  let results = await mapPool(firstBatch, concurrency, async (url) => {
    const abs = join(downloadDir, urlToRelPath(url));
    return fetchOne(url, abs, dump);
  });

  /** @type {object|null} */
  let expandInfo = null;
  if (expandFromConfig && (kinds.has('asset') || kinds.has('all') || kinds.has('config'))) {
    const expanded = expandAssetUrls(dump, downloadDir);
    expandInfo = {
      expandMeta: expanded.expandMeta,
      expandedUrlCount: expanded.urls.length,
    };
    const have = new Set(firstBatch);
    const more = expanded.urls.filter((u) => !have.has(u));
    const remainSlots = Math.max(0, maxFiles - firstBatch.length);
    const secondBatch = more.slice(0, remainSlots);
    if (secondBatch.length > 0) {
      const moreResults = await mapPool(secondBatch, concurrency, async (url) => {
        const abs = join(downloadDir, urlToRelPath(url));
        return fetchOne(url, abs, dump);
      });
      results = results.concat(moreResults);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const fail404 = results.filter((r) => !r.ok && r.status === 404).length;
  const failOther = results.filter((r) => !r.ok && r.status !== 404).length;
  const skipped = results.filter((r) => r.skipped).length;

  writeJson(join(outDir, 'download-report.json'), {
    okCount,
    failCount: results.length - okCount,
    fail404,
    failOther,
    skipped,
    expand: expandInfo,
    results,
  });

  // 保留旧 promote（不作为本阶段目标，但避免破坏已有路径）
  const buildDir = join(outDir, 'build');
  promoteConfigsToBuild(downloadDir, buildDir, dump);

  return {
    okCount,
    failCount: results.length - okCount,
    fail404,
    failOther,
    skipped,
    downloadDir,
    buildDir,
    expand: expandInfo,
    fetched: results.length,
  };
}

function promoteConfigsToBuild(downloadDir, buildDir, dump) {
  mkdirSync(buildDir, { recursive: true });
  for (const b of dump.bundles || []) {
    if (!b?.config) continue;
    writeJson(join(buildDir, 'assets', safeName(b.name), 'config.json'), b.config);
  }

  const walk = (dir, rel = '') => {
    if (!existsSync(dir)) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      const st = statSync(abs);
      const nextRel = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        walk(abs, nextRel);
        continue;
      }
      const m = nextRel.replace(/\\/g, '/').match(
        /(?:^|\/)assets\/([^/]+)\/(config(?:\.[a-f0-9]+)?\.json)$/i,
      );
      if (!m) continue;
      const bundle = safeName(m[1]);
      const destName = m[2].toLowerCase().startsWith('config.')
        ? 'config.json'
        : m[2];
      const dest = join(buildDir, 'assets', bundle, destName);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      if (destName !== 'config.json' && /config\./i.test(m[2])) {
        copyFileSync(abs, join(buildDir, 'assets', bundle, 'config.json'));
      }
    }
  };
  walk(downloadDir);

  writeJson(join(buildDir, '_dump-meta.json'), {
    pageUrl: dump.pageUrl,
    origin: dump.origin,
    engineVersion: dump.engineVersion,
    capturedAt: dump.capturedAt,
  });
}
