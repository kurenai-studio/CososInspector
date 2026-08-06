/**
 * 从 Cocos 3.x bundle config 展开可下载的 import/native/index URL。
 * 逻辑对齐 cc-reverse parseBundleConfig / getImportPath / getNativePath。
 */

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const BASE64_VALUES = new Array(123).fill(64);
for (let i = 0; i < 64; i += 1) {
  BASE64_VALUES[BASE64_KEYS.charCodeAt(i)] = i;
}
const HexChars = '0123456789abcdef'.split('');
const UuidTemplate = ['', '', '', '', '', '', '', '', '-', '', '', '', '', '-', '', '', '', '', '-', '', '', '', '', '-', '', '', '', '', '', '', '', '', '', '', '', ''];
const Indices = UuidTemplate.map((x, i) => (x === '-' ? NaN : i)).filter(Number.isFinite);

export function decodeUuid(base64) {
  if (typeof base64 !== 'string') return '';
  const raw = base64.split('@')[0];
  if (raw.length !== 22) return raw;
  try {
    const template = UuidTemplate.slice();
    template[0] = raw[0];
    template[1] = raw[1];
    for (let i = 2, j = 2; i < 22; i += 2) {
      const lhs = BASE64_VALUES[raw.charCodeAt(i)];
      const rhs = BASE64_VALUES[raw.charCodeAt(i + 1)];
      template[Indices[j++]] = HexChars[lhs >> 2];
      template[Indices[j++]] = HexChars[((lhs & 3) << 2) | (rhs >> 4)];
      template[Indices[j++]] = HexChars[rhs & 0xf];
    }
    return template.join('');
  } catch {
    return raw;
  }
}

function indexedVersionMap(flat, uuids) {
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const idx = parseInt(String(flat[i]), 10);
    const ver = flat[i + 1];
    if (Number.isNaN(idx) || ver == null) continue;
    const uuid = uuids[idx];
    if (uuid) out[uuid] = String(ver);
  }
  return out;
}

function joinUrl(base, ...parts) {
  const root = String(base || '').replace(/\/?$/, '/');
  const rel = parts
    .map((p) => String(p || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return root + rel;
}

function fileName(uuid, ver, ext) {
  const e = ext.startsWith('.') ? ext : `.${ext}`;
  return ver ? `${uuid}.${ver}${e}` : `${uuid}${e}`;
}

/** 按资源类型猜测 native 扩展（extensionMap 未覆盖时探测用） */
function nativeExtCandidates(typeName, mappedExt) {
  if (mappedExt) return [mappedExt];
  const t = String(typeName || '');
  if (/ImageAsset|Texture2D|SpriteFrame|SpriteAtlas/i.test(t)) {
    return ['.png', '.webp', '.jpg', '.jpeg'];
  }
  if (/AudioClip/i.test(t)) return ['.mp3', '.ogg', '.wav', '.m4a'];
  if (/BitmapFont/i.test(t)) return ['.png', '.fnt'];
  if (/SkeletonData/i.test(t)) return ['.bin', '.skel', '.json', '.atlas', '.png'];
  if (/Material|Effect/i.test(t)) return [];
  if (/Prefab|SceneAsset|AnimationClip|Asset$/i.test(t)) return [];
  return ['.bin', '.png', '.webp'];
}

/**
 * 归一化：引擎 runtime 序列化后可能是 { assetInfos: { _map, _count } }，
 * 没有原始 uuids[]。尽量转成可展开形态，或直接从 _map 展开。
 */
export function configExpandScore(raw) {
  if (!raw || typeof raw !== 'object') return 0;
  if (Array.isArray(raw.uuids) && raw.uuids.length) return 1000 + raw.uuids.length;
  const map = unwrapCacheMap(raw.assetInfos);
  if (map) return 100 + Object.keys(map).length;
  return 1;
}

function unwrapCacheMap(bag) {
  if (!bag || typeof bag !== 'object') return null;
  if (bag._map && typeof bag._map === 'object' && !Array.isArray(bag._map)) {
    return bag._map;
  }
  // 已是普通 map
  if (!(' _count' in bag) && !('_count' in bag)) {
    const keys = Object.keys(bag);
    if (keys.length > 0 && typeof bag[keys[0]] === 'object') return bag;
  }
  if ('_count' in bag && !bag._map) return null;
  return null;
}

/**
 * @param {object} raw config.json
 * @param {string} baseUrl bundle 根 URL（含末尾 / 更佳）
 * @returns {{ urls: string[], meta: object }}
 */
export function expandUrlsFromBundleConfig(raw, baseUrl) {
  const urls = [];
  if (!raw || !baseUrl) {
    return { urls, meta: { skipped: true } };
  }

  // runtime 形态：无 uuids，有 assetInfos._map
  if (!Array.isArray(raw.uuids) || raw.uuids.length === 0) {
    const fromRuntime = expandFromRuntimeAssetInfos(raw, baseUrl);
    if (fromRuntime.meta.urlCount > 2) return fromRuntime;
  }

  const debug = raw.debug === true;
  const importBase = raw.importBase || 'import';
  const nativeBase = raw.nativeBase || 'native';
  const types = Array.isArray(raw.types) ? raw.types : [];
  const uuidsRaw = Array.isArray(raw.uuids) ? raw.uuids : [];
  const uuids = uuidsRaw.map((u) => {
    const s = String(u || '');
    return debug ? s.split('@')[0] : decodeUuid(s);
  });

  const importVer = indexedVersionMap(raw.versions?.import, uuids);
  const nativeVer = indexedVersionMap(raw.versions?.native, uuids);

  /** @type {Record<string, string>} */
  const extensionMap = {};
  const rawExt = raw.extensionMap && typeof raw.extensionMap === 'object'
    ? raw.extensionMap
    : {};
  for (const [ext, list] of Object.entries(rawExt)) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      let uuid = null;
      if (typeof c === 'number' || (typeof c === 'string' && /^\d+$/.test(c))) {
        uuid = uuids[parseInt(String(c), 10)];
      } else if (typeof c === 'string') {
        uuid = debug ? c.split('@')[0] : decodeUuid(c);
      }
      if (uuid) extensionMap[uuid] = ext.startsWith('.') ? ext : `.${ext}`;
    }
  }

  /** @type {Record<string, { path?: string, type?: string|null }>} */
  const paths = {};
  const rawPaths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const pathEntries = unwrapCacheMap(rawPaths) || rawPaths;
  for (const [key, entry] of Object.entries(pathEntries)) {
    if (key === '_map' || key === '_count') continue;
    const uuidIdx = parseInt(key, 10);
    if (Array.isArray(entry) && !Number.isNaN(uuidIdx)) {
      const uuid = uuids[uuidIdx];
      if (!uuid) continue;
      paths[uuid] = {
        path: entry[0],
        type: entry[1] != null ? types[entry[1]] : null,
      };
      continue;
    }
  }

  const redirect = new Set();
  const redirectList = Array.isArray(raw.redirect) ? raw.redirect : [];
  for (let i = 0; i < redirectList.length; i += 2) {
    const idx = parseInt(String(redirectList[i]), 10);
    if (!Number.isNaN(idx) && uuids[idx]) redirect.add(uuids[idx]);
  }

  urls.push(joinUrl(baseUrl, 'config.json'));
  urls.push(joinUrl(baseUrl, 'index.js'));

  const packed = new Set();
  const rawPacks = raw.packs && typeof raw.packs === 'object' ? raw.packs : {};
  for (const packKey of Object.keys(rawPacks)) {
    if (packKey === '_map' || packKey === '_count') continue;
    const packUuid = debug ? packKey : decodeUuid(packKey);
    if (!packUuid) continue;
    const ver = importVer[packUuid];
    urls.push(
      joinUrl(
        baseUrl,
        importBase,
        packUuid.slice(0, 2),
        fileName(packUuid, ver, '.json'),
      ),
    );
    const children = rawPacks[packKey];
    if (!Array.isArray(children)) continue;
    for (const c of children) {
      const idx = parseInt(String(c), 10);
      let childUuid = null;
      if (!Number.isNaN(idx) && uuids[idx]) childUuid = uuids[idx];
      else if (typeof c === 'string') {
        childUuid = debug ? c.split('@')[0] : decodeUuid(c);
      }
      if (childUuid) packed.add(childUuid);
    }
  }

  let importCount = 0;
  let nativeProbeCount = 0;
  for (let i = 0; i < uuids.length; i += 1) {
    const uuid = uuids[i];
    if (!uuid || redirect.has(uuid)) continue;
    const mapped = extensionMap[uuid];
    if (!packed.has(uuid) && !rawPacks[uuidsRaw[i]] && !rawPacks[uuid]) {
      const importExt = mapped === '.cconb' ? '.cconb' : '.json';
      const ver = importVer[uuid];
      urls.push(
        joinUrl(
          baseUrl,
          importBase,
          uuid.slice(0, 2),
          fileName(uuid, ver, importExt),
        ),
      );
      importCount += 1;
    }

    const info = paths[uuid];
    const typeName = info?.type || '';
    const candidates = nativeExtCandidates(
      typeName,
      mapped && mapped !== '.cconb' ? mapped : null,
    );
    const nVer = nativeVer[uuid];
    for (const ext of candidates) {
      urls.push(
        joinUrl(
          baseUrl,
          nativeBase,
          uuid.slice(0, 2),
          fileName(uuid, nVer, ext),
        ),
      );
      nativeProbeCount += 1;
    }
  }

  const uniq = [...new Set(urls)];
  return {
    urls: uniq,
    meta: {
      name: raw.name || '',
      baseUrl,
      uuidCount: uuids.length,
      importCount,
      nativeProbeCount,
      urlCount: uniq.length,
      redirectCount: redirect.size,
      source: 'raw-config',
    },
  };
}

/** 从 runtime assetInfos._map 展开（无原始 uuids 时） */
function expandFromRuntimeAssetInfos(raw, baseUrl) {
  const urls = [];
  const importBase = raw.importBase || 'import';
  const nativeBase = raw.nativeBase || 'native';
  urls.push(joinUrl(baseUrl, 'config.json'));
  urls.push(joinUrl(baseUrl, 'index.js'));

  const infos = unwrapCacheMap(raw.assetInfos);
  if (!infos) {
    return {
      urls: [...new Set(urls)],
      meta: {
        name: raw.name || '',
        baseUrl,
        uuidCount: 0,
        importCount: 0,
        nativeProbeCount: 0,
        urlCount: 2,
        redirectCount: 0,
        source: 'runtime-empty',
      },
    };
  }

  const packIds = new Set();
  let importCount = 0;
  let nativeProbeCount = 0;
  let uuidCount = 0;

  for (const [key, info] of Object.entries(infos)) {
    if (!info || typeof info !== 'object') continue;
    uuidCount += 1;
    const full = String(info.uuid || key);
    const uuid = full.includes('-')
      ? full.split('@')[0]
      : decodeUuid(full.split('@')[0]);
    if (!uuid) continue;

    const packs = Array.isArray(info.packs) ? info.packs : [];
    for (const p of packs) {
      const pid = typeof p === 'string' ? p : p?.uuid;
      if (pid) packIds.add(String(pid).split('@')[0]);
    }

    const inPack = packs.length > 0;
    if (!inPack) {
      urls.push(
        joinUrl(baseUrl, importBase, uuid.slice(0, 2), fileName(uuid, null, '.json')),
      );
      importCount += 1;
    }

    const pathStr = String(info.path || '');
    // runtime 通常不带 type 名；按路径粗猜
    let typeHint = '';
    if (/texture|image|\.png|\.jpg|\.webp/i.test(pathStr)) typeHint = 'cc.ImageAsset';
    else if (/audio|sound|bgm|sfx/i.test(pathStr)) typeHint = 'cc.AudioClip';
    else if (/spine|skeleton/i.test(pathStr)) typeHint = 'sp.SkeletonData';
    else if (/font/i.test(pathStr)) typeHint = 'cc.BitmapFont';

    for (const ext of nativeExtCandidates(typeHint, null)) {
      urls.push(
        joinUrl(baseUrl, nativeBase, uuid.slice(0, 2), fileName(uuid, null, ext)),
      );
      nativeProbeCount += 1;
    }
  }

  for (const packUuid of packIds) {
    if (!packUuid) continue;
    urls.push(
      joinUrl(
        baseUrl,
        importBase,
        packUuid.slice(0, 2),
        fileName(packUuid, null, '.json'),
      ),
    );
  }

  const uniq = [...new Set(urls)];
  return {
    urls: uniq,
    meta: {
      name: raw.name || '',
      baseUrl,
      uuidCount,
      importCount,
      nativeProbeCount,
      urlCount: uniq.length,
      redirectCount: 0,
      source: 'runtime-assetInfos',
    },
  };
}

/**
 * 从已落盘/dump 的 bundles 与 configUrls 推断 base。
 * @param {{ bundles?: Array<{name?:string,base?:string,config?:object}>, configUrls?: string[], pageUrl?: string }} dump
 * @returns {Array<{ baseUrl: string, config: object, name: string }>}
 */
export function collectBundleConfigsForExpand(dump) {
  /** @type {Array<{ baseUrl: string, config: object, name: string }>} */
  const out = [];
  const seen = new Set();

  for (const b of dump.bundles || []) {
    if (!b?.config || typeof b.config !== 'object') continue;
    let base = b.base || '';
    if (!base && dump.pageUrl) {
      // 无法推断则跳过，等 configUrl
      continue;
    }
    try {
      base = new URL(base, dump.pageUrl || undefined).href;
    } catch {
      /* keep */
    }
    if (!base) continue;
    const key = base.replace(/\/?$/, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      baseUrl: key,
      config: b.config,
      name: b.name || b.config.name || '',
    });
  }

  return out;
}

/**
 * 从 config.json 的绝对 URL 推 bundle base。
 */
export function baseUrlFromConfigUrl(configUrl) {
  try {
    const u = new URL(configUrl);
    u.search = '';
    u.hash = '';
    const path = u.pathname.replace(/\/config(?:\.[^/]+)?\.json$/i, '/');
    u.pathname = path.endsWith('/') ? path : `${path}/`;
    return u.href;
  } catch {
    return '';
  }
}
