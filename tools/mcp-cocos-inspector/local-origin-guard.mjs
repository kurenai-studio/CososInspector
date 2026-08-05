/**
 * 本地桥 Host / Origin 防护（防 DNS rebinding + 恶意页调用 localhost）。
 * - Host 必须是 loopback
 * - 无 Origin：允许（Node / MCP / curl）
 * - 有 Origin：须在白名单（扩展 / loopback / 动态域名 / 环境变量）
 */

/** @type {Set<string>} */
const dynamicHostnames = new Set();

/**
 * @param {string | null | undefined} hostname
 */
export function addAllowedHostname(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (h) dynamicHostnames.add(h);
}

/**
 * @param {string | null | undefined} domainOrMatch
 */
export function addAllowedDomainHint(domainOrMatch) {
  const raw = String(domainOrMatch || '').trim().toLowerCase();
  if (!raw) return;
  if (raw.includes('.')) {
    addAllowedHostname(raw);
    return;
  }
  // pageUrlMatch 短名：存为后缀匹配标记（前缀 *）
  dynamicHostnames.add(`*.${raw}`);
}

export function clearDynamicAllowedHostnames() {
  dynamicHostnames.clear();
}

/**
 * @param {string | undefined} hostHeader
 */
export function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).split(',')[0].trim().toLowerCase();
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1'
  );
}

/**
 * @param {string} envKey
 * @returns {string[]}
 */
function envOriginList(envKey) {
  const raw = process.env[envKey] || '';
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} origin
 * @param {string} pattern  完整 origin 或 https://*.example.com
 */
function originMatchesPattern(origin, pattern) {
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;
  try {
    const o = new URL(origin);
    const p = new URL(pattern.replace('://*', '://wildcard.invalid'));
    // https://*.example.com
    const m = pattern.match(/^(https?|chrome-extension|moz-extension):\/\/\*\.(.+)$/i);
    if (m) {
      const scheme = m[1].toLowerCase();
      const suffix = m[2].toLowerCase();
      return (
        o.protocol.replace(':', '') === scheme &&
        (o.hostname === suffix || o.hostname.endsWith(`.${suffix}`))
      );
    }
    void p;
  } catch {
    return false;
  }
  return false;
}

/**
 * @param {string | undefined} origin
 * @param {{ envKey?: string }} [opts]
 */
export function isAllowedOrigin(origin, opts = {}) {
  if (origin == null || origin === '') return true;

  const o = String(origin).trim();
  if (o === 'null') return false;

  let url;
  try {
    url = new URL(o);
  } catch {
    return false;
  }

  const proto = url.protocol;
  if (proto === 'chrome-extension:' || proto === 'moz-extension:') return true;

  if (proto === 'http:' || proto === 'https:') {
    const host = url.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return true;
    }
    for (const hint of dynamicHostnames) {
      if (hint.startsWith('*.')) {
        const needle = hint.slice(2);
        if (host === needle || host.includes(needle)) return true;
      } else if (host === hint || host.endsWith(`.${hint}`)) {
        return true;
      }
    }
  }

  const envKey = opts.envKey || 'COCOS_BRIDGE_ALLOWED_ORIGINS';
  for (const pat of envOriginList(envKey)) {
    if (originMatchesPattern(o, pat) || pat === o) return true;
  }

  return false;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {{ envKey?: string }} [opts]
 * @returns {{ ok: true, origin: string | null } | { ok: false, status: number, error: string }}
 */
export function assertLocalBridgeRequest(req, opts = {}) {
  const host = req.headers.host;
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      status: 403,
      error: `拒绝非 loopback Host: ${host || '(empty)'}`,
    };
  }

  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!isAllowedOrigin(origin, opts)) {
    return {
      ok: false,
      status: 403,
      error: `拒绝 Origin: ${origin || '(empty)'}`,
    };
  }

  return { ok: true, origin: origin || null };
}

/**
 * 仅对白名单 Origin 回显 ACAO（禁止 *）。
 * @param {Record<string, string | number>} headers
 * @param {string | null | undefined} origin
 */
export function applyCorsHeaders(headers, origin) {
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Methods'] = 'GET, HEAD, PUT, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return headers;
}

/**
 * ws.verifyClient
 * @param {{ origin: string; req: import('http').IncomingMessage }} info
 * @param {{ envKey?: string }} [opts]
 */
export function verifyLocalBridgeClient(info, opts = {}) {
  const gate = assertLocalBridgeRequest(info.req, opts);
  return gate.ok;
}
