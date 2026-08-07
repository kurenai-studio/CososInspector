/**
 * Egret 原始资源还原：基于 RES 5.x 清单 + 纹理 $source.src
 *
 * 资源地址解析优先级（与运行游戏一致）：
 *   1) 入参已是 http(s)/data URL → 直接返回
 *   2) RES.config.config.fileSystem.fsData[name] → {url, type, root}
 *   3) RES.config.config.fileSystem.getFile(name) → string | { url }
 *   4) RES.config.config.alias[name] → 相对路径（多为子帧引用，需二次查 fsData）
 *   5) 退化为 resourceRoot + name
 *
 * 字节获取走页内 fetch（CDN 已带 ACAO:*），失败时给出明确错误。
 * fetch 失败时由 mcpBridge.downloadResource 回退到 canvas 整图导出。
 */
import { getEgretStage, type EgretDisplayObject } from './runtime';
import { getNodeTexture, getTextureSourceUrl } from './textureExtract';

export interface EgretResourceItem {
  /** 资源名 / 别名（RES.key）；URL 直传时为文件名 */
  name: string;
  /** 解析后的绝对 URL */
  url: string;
  /** 资源类型猜测：image / json / text / unknown */
  type: 'image' | 'json' | 'text' | 'unknown';
  /** 当前显示列表中是否有 Bitmap 引用（仅对 image 有意义） */
  inUse: boolean;
}

export type EgretResourceList =
  | {
      ok: true;
      total: number;
      items: EgretResourceItem[];
    }
  | { ok: false; error: string };

export type EgretResourceDownload =
  | {
      ok: true;
      delivery: 'inline';
      base64: string;
      filename: string;
      detail: { sourceUrl: string; bytes: number; mime: string };
    }
  | { ok: false; error: string };

interface FsDataEntry {
  url?: string;
  type?: string;
  name?: string;
  root?: string;
}

interface ResConfigLike {
  resourceRoot?: string;
  alias?: Record<string, string | unknown>;
  fileSystem?: {
    fsData?: Record<string, FsDataEntry>;
    getFile?: (name: string) => string | FsDataEntry | null | undefined;
  };
}

declare global {
  interface Window {
    RES?: {
      config?: { config?: ResConfigLike };
      host?: string;
      getResourceInfo?: (name: string) => unknown;
    };
  }
}

function getResConfig(): ResConfigLike | null {
  return window.RES?.config?.config ?? null;
}

function normalizeUrl(base: string, rel: string): string {
  if (/^https?:|^data:|^blob:/i.test(rel)) return rel;
  if (!base) return rel;
  try {
    return new URL(rel, base).href;
  } catch {
    return base.replace(/\/$/, '') + '/' + rel.replace(/^\//, '');
  }
}

function guessType(name: string, fsType?: string): EgretResourceItem['type'] {
  if (fsType === 'image' || fsType === 'sheet') return 'image';
  if (fsType === 'json' || fsType === 'sheet') return 'json';
  const ext = name.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].indexOf(ext) >= 0) return 'image';
  if (['json', 'fnt', 'thm'].indexOf(ext) >= 0) return 'json';
  if (['txt', 'xml', 'csv', 'cfg'].indexOf(ext) >= 0) return 'text';
  return 'unknown';
}

/** 收集当前显示列表中所有 Bitmap 纹理的原始图源 URL */
function collectInUseUrls(): Set<string> {
  const stage = getEgretStage();
  const set = new Set<string>();
  if (!stage) return set;
  const walk = (node: EgretDisplayObject): void => {
    const url = getTextureSourceUrl(getNodeTexture(node));
    if (url) set.add(url);
    const kids = node.$children;
    if (Array.isArray(kids)) for (const c of kids) if (c) walk(c);
  };
  walk(stage);
  return set;
}

function entryToItem(
  name: string,
  entry: FsDataEntry,
  root: string,
  inUse: Set<string>
): EgretResourceItem | null {
  if (!entry || !entry.url) return null;
  const base = entry.root || root;
  const url = normalizeUrl(base, entry.url);
  return {
    name: entry.name || name,
    url,
    type: guessType(url, entry.type),
    inUse: inUse.has(url),
  };
}

/** 入口：列出资源清单（默认上限 200，避免 alias 海量时撑爆 IPC） */
export function collectResourceList(limit = 200): EgretResourceList {
  const cfg = getResConfig();
  if (!cfg) {
    return { ok: false, error: '未检测到 RES.config（非 RES 资源管线）' };
  }
  const inUse = collectInUseUrls();
  const root = cfg.resourceRoot ?? window.RES?.host ?? '';
  const fsData = cfg.fileSystem?.fsData ?? {};

  const items: EgretResourceItem[] = [];
  const seen = new Set<string>();
  const keys = Object.keys(fsData);
  for (let i = 0; i < keys.length && items.length < limit; i++) {
    const name = keys[i];
    const item = entryToItem(name, fsData[name], root, inUse);
    if (!item) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    items.push(item);
  }

  // alias 中存在但 fsData 没有的（运行时动态加载），用 inUse 补齐
  for (const url of inUse) {
    if (items.length >= limit) break;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      name: url.split('/').pop() || url,
      url,
      type: guessType(url),
      inUse: true,
    });
  }

  return { ok: true, total: items.length, items };
}

/** 入口：解析资源名/URL 为绝对 URL；失败返回 null */
export function resolveResourceUrl(nameOrUrl: string): string | null {
  if (!nameOrUrl) return null;
  if (/^https?:|^data:|^blob:/i.test(nameOrUrl)) return nameOrUrl;

  const cfg = getResConfig();
  if (!cfg) return null;
  const root = cfg.resourceRoot ?? window.RES?.host ?? '';

  // fsData 优先（完整资源表，含 url/type/root）
  try {
    const fsData = cfg.fileSystem?.fsData;
    if (fsData && Object.prototype.hasOwnProperty.call(fsData, nameOrUrl)) {
      const entry = fsData[nameOrUrl];
      if (entry && entry.url) {
        return normalizeUrl(entry.root || root, entry.url);
      }
    }
  } catch {
    /* ignore */
  }

  // fileSystem.getFile（动态注册时走这里）
  try {
    const fs = cfg.fileSystem;
    if (fs && typeof fs.getFile === 'function') {
      const r = fs.getFile(nameOrUrl);
      if (r) {
        const url = typeof r === 'string' ? r : r.url;
        if (url) {
          const r2 = typeof r === 'string' ? null : r;
          return normalizeUrl(r2?.root || root, url);
        }
      }
    }
  } catch {
    /* ignore */
  }

  // alias 表（多为子帧引用 fish_192_json#0；查找对应父级 _json）
  const a = cfg.alias?.[nameOrUrl];
  if (typeof a === 'string') {
    // 子帧引用 → 解析父资源
    const parent = a.split('#')[0];
    if (parent && fsDataHas(parent)) {
      const entry = cfg.fileSystem!.fsData![parent];
      if (entry && entry.url) {
        return normalizeUrl(entry.root || root, entry.url);
      }
    }
    return normalizeUrl(root, a);
  }

  // 退化为 resourceRoot + name
  return normalizeUrl(root, nameOrUrl);
}

function fsDataHas(name: string): boolean {
  const cfg = getResConfig();
  return !!cfg?.fileSystem?.fsData && Object.prototype.hasOwnProperty.call(cfg.fileSystem.fsData, name);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    out += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(out);
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop();
    return last && last.length ? last : 'resource.bin';
  } catch {
    const last = url.split('/').pop() || url;
    return last.split('?')[0] || 'resource.bin';
  }
}

/** 下载资源原始字节并返回 base64 */
export async function downloadResource(
  nameOrUrl: string
): Promise<EgretResourceDownload> {
  const url = resolveResourceUrl(nameOrUrl);
  if (!url) {
    return { ok: false, error: `无法解析资源地址: ${nameOrUrl}` };
  }
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) {
      return {
        ok: false,
        error: `HTTP ${res.status} ${res.statusText} (${url})`,
      };
    }
    const buf = await res.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    return {
      ok: true,
      delivery: 'inline',
      base64,
      filename: filenameFromUrl(url),
      detail: { sourceUrl: url, bytes: buf.byteLength, mime },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/CORS|cross-origin|Failed to fetch/i.test(msg)) {
      return {
        ok: false,
        error: `跨域或网络错误（CDN 未带 CORS）: ${msg}`,
      };
    }
    return { ok: false, error: msg };
  }
}
