import http from 'http';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, extname, resolve } from 'path';
import { getShareDir, ensureShareDirs } from './shared-fs.mjs';
import { bridgeGetStatus, getDaemonMeta } from './bridge-server.mjs';
import { exportPackViaBridge } from './export-pack-server.mjs';
import {
  assertLocalBridgeRequest,
  applyCorsHeaders,
} from './local-origin-guard.mjs';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/** @type {http.Server | null} */
let server = null;
let listeningPort = 0;

export function isShareHttpRunning() {
  return !!server?.listening;
}

export function getShareHttpListeningPort() {
  return listeningPort;
}

export function startShareHttp(port) {
  if (server?.listening) return Promise.resolve(listeningPort);

  ensureShareDirs();
  const root = getShareDir();

  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handle(req, res, root);
    });

    s.on('error', reject);
    s.listen(port, '127.0.0.1', () => {
      server = s;
      const addr = s.address();
      listeningPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve(listeningPort);
    });
  });
}

function joinSafe(root, rel) {
  const abs = resolve(root, rel);
  if (!abs.startsWith(root)) throw new Error('path escape');
  return abs;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function corsBase(origin) {
  return applyCorsHeaders({}, origin);
}

function sendJson(res, status, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...corsBase(origin),
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

async function handleApi(req, res, url, origin) {
  if (url.pathname === '/api/status' && req.method === 'GET') {
    try {
      const st = await bridgeGetStatus();
      const meta = getDaemonMeta();
      sendJson(
        res,
        200,
        {
          ok: true,
          service: 'cocos-inspector-local',
          extensionConnected: !!st.extensionConnected,
          shareDir: getShareDir(),
          httpPort: listeningPort,
          wsPort: meta?.wsPort ?? Number(process.env.COCOS_BRIDGE_PORT ?? 17373),
          domain: st.domain ?? meta?.domain ?? null,
          pageUrlMatch: st.pageUrlMatch ?? meta?.pageUrlMatch ?? null,
          tabs: st.tabs ?? [],
        },
        origin
      );
    } catch (e) {
      sendJson(
        res,
        500,
        {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
        origin
      );
    }
    return true;
  }

  if (url.pathname === '/api/export-pack' && req.method === 'POST') {
    let pageUrlMatch = process.env.COCOS_PAGE_URL_MATCH ?? 'applovin';
    let repack = true;
    try {
      const raw = await collectBody(req);
      if (raw.length) {
        const body = JSON.parse(String(raw));
        if (body.pageUrlMatch != null) pageUrlMatch = String(body.pageUrlMatch);
        if (body.repack === false) repack = false;
      }
    } catch {
      /* 使用默认 match */
    }

    const result = await exportPackViaBridge({ pageUrlMatch, repack });
    sendJson(res, result.ok ? 200 : 400, result, origin);
    return true;
  }

  return false;
}

async function handle(req, res, root) {
  const gate = assertLocalBridgeRequest(req);
  if (!gate.ok) {
    sendJson(res, gate.status, { ok: false, error: gate.error }, null);
    return;
  }
  const origin = gate.origin;

  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsBase(origin));
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url, origin);
      if (handled) return;
      sendJson(res, 404, { ok: false, error: '未知 API' }, origin);
      return;
    }

    const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!rel || rel.includes('..')) {
      res.writeHead(403, corsBase(origin));
      res.end();
      return;
    }
    const abs = joinSafe(root, rel);

    if (req.method === 'PUT') {
      const body = await collectBody(req);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      res.writeHead(204, corsBase(origin));
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, corsBase(origin));
      res.end();
      return;
    }

    if (!existsSync(abs)) {
      res.writeHead(404, corsBase(origin));
      res.end();
      return;
    }
    const mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { ...corsBase(origin), 'Content-Type': mime });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(abs).pipe(res);
  } catch (e) {
    sendJson(
      res,
      500,
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      origin
    );
  }
}
