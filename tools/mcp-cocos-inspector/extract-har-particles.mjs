#!/usr/bin/env node
/**
 * 从 HAR 扫出所有粒子资源 + 参数（plist / ParticleAsset / Prefab 上 ParticleSystem2D）
 *
 * 用法:
 *   node tools/mcp-cocos-inspector/extract-har-particles.mjs <file.har> [--out DIR]
 *
 * 输出 outDir:
 *   manifest.json          — 汇总（资源路径、uuid、参数）
 *   plists/*.plist
 *   textures/*.png
 *   prefabs/*.json         — 含 ParticleSystem2D 的 import
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const parseArgs = () => {
  const argv = process.argv.slice(2);
  const harPath = argv.find((a) => !a.startsWith('--'));
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  if (!harPath) {
    console.error(
      '用法: node extract-har-particles.mjs <file.har> [--out tmp/har-particles]'
    );
    process.exit(1);
  }
  return {
    harPath: path.resolve(harPath),
    outDir: path.resolve(
      get('--out', path.join(path.dirname(path.resolve(harPath)), 'tmp/har-particles'))
    ),
  };
};

const PARTICLE_PLIST_KEYS = [
  'emissionRate',
  'particleLifespan',
  'maxParticles',
  'spriteFrameUuid',
  'gravityx',
  'startParticleSize',
];

const isParticlePlistText = (text) => {
  if (!text || typeof text !== 'string') return false;
  if (!text.includes('<plist') && !text.includes('emissionRate')) return false;
  return PARTICLE_PLIST_KEYS.some((k) => text.includes(k));
};

const decodeBody = (content) => {
  if (!content?.text) return null;
  try {
    if (content.encoding === 'base64') {
      return Buffer.from(content.text, 'base64');
    }
    return Buffer.from(content.text, 'utf8');
  } catch {
    return null;
  }
};

const parsePlistParams = (xml) => {
  const params = {};
  const re =
    /<key>([^<]+)<\/key>\s*<(integer|real|string|true|false)(?:\s*\/>|>([^<]*)<\/\2>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = m[1];
    const typ = m[2];
    if (typ === 'true') params[key] = true;
    else if (typ === 'false') params[key] = false;
    else if (typ === 'integer') params[key] = parseInt(m[3], 10);
    else if (typ === 'real') params[key] = parseFloat(m[3]);
    else params[key] = m[3];
  }
  // 归一化常用字段名（与运行时 ParticleSystem2D 对齐）
  const normalized = {
    duration: params.duration,
    emissionRate: params.emissionRate,
    life: params.particleLifespan,
    lifeVar: params.particleLifespanVariance,
    totalParticles: params.maxParticles,
    startSize: params.startParticleSize,
    startSizeVar: params.startParticleSizeVariance,
    endSize: params.finishParticleSize,
    endSizeVar: params.finishParticleSizeVariance,
    startSpin: params.rotationStart,
    startSpinVar: params.rotationStartVariance,
    endSpin: params.rotationEnd,
    endSpinVar: params.rotationEndVariance,
    angle: params.angle,
    angleVar: params.angleVariance,
    speed: params.speed,
    speedVar: params.speedVariance,
    posVar: {
      x: params.sourcePositionVariancex,
      y: params.sourcePositionVariancey,
    },
    sourcePos: {
      x: params.sourcePositionx,
      y: params.sourcePositiony,
    },
    gravity: { x: params.gravityx, y: params.gravityy },
    tangentialAccel: params.tangentialAcceleration,
    tangentialAccelVar: params.tangentialAccelVariance,
    radialAccel: params.radialAcceleration,
    radialAccelVar: params.radialAccelVariance,
    emitterMode: params.emitterType,
    positionType: params.positionType,
    startColor: {
      r: Math.round((params.startColorRed ?? 0) * 255),
      g: Math.round((params.startColorGreen ?? 0) * 255),
      b: Math.round((params.startColorBlue ?? 0) * 255),
      a: Math.round((params.startColorAlpha ?? 1) * 255),
    },
    endColor: {
      r: Math.round((params.finishColorRed ?? 0) * 255),
      g: Math.round((params.finishColorGreen ?? 0) * 255),
      b: Math.round((params.finishColorBlue ?? 0) * 255),
      a: Math.round((params.finishColorAlpha ?? 1) * 255),
    },
    spriteFrameUuid: params.spriteFrameUuid,
    blendFuncSource: params.blendFuncSource,
    blendFuncDestination: params.blendFuncDestination,
    rotationIsDir: params.rotationIsDir,
  };
  return { raw: params, normalized };
};

const colorFromUint = (n) => {
  // Cocos Color._val 多为 ABGR
  const u = n >>> 0;
  return {
    a: (u >>> 24) & 0xff,
    b: (u >>> 16) & 0xff,
    g: (u >>> 8) & 0xff,
    r: u & 0xff,
  };
};

/**
 * 从 Creator import JSON 提取 ParticleSystem2D 实例参数
 * 兼容压缩序列化：[typeIdx, ...fieldValues]
 */
const extractParticleFromImport = (json, url) => {
  const results = [];
  if (!Array.isArray(json) || json.length < 5) return results;

  const sharedUuids = Array.isArray(json[1]) ? json[1] : [];
  const classes = Array.isArray(json[3]) ? json[3] : [];
  const dataRoot = json[5];

  const particleClassIdx = classes.findIndex(
    (c) => Array.isArray(c) && c[0] === 'cc.ParticleSystem2D'
  );
  if (particleClassIdx < 0) return results;

  const classDef = classes[particleClassIdx];
  const keys = Array.isArray(classDef[1]) ? classDef[1] : [];

  const walk = (node, nodeNameHint) => {
    if (!Array.isArray(node)) return;
    // 组件实例：首元素为 ParticleSystem2D 的 class index
    if (typeof node[0] === 'number' && node[0] === particleClassIdx) {
      const values = node.slice(1);
      const params = {};
      for (let i = 0; i < keys.length && i < values.length; i += 1) {
        const key = keys[i];
        let val = values[i];
        if (key === '_startColor' || key === '_endColor' || key === 'startColor' || key === 'endColor') {
          if (Array.isArray(val) && typeof val[1] === 'number') {
            val = colorFromUint(val[1]);
          }
        } else if (
          (key === 'posVar' || key === 'gravity' || key === 'sourcePos') &&
          Array.isArray(val) &&
          val.length >= 3
        ) {
          val = { x: val[1], y: val[2] };
        } else if (key === '_file' || key === '_spriteFrame' || key === 'file' || key === 'spriteFrame') {
          if (typeof val === 'number' && sharedUuids[val]) {
            val = { ref: sharedUuids[val], index: val };
          } else if (Array.isArray(val) && typeof val[1] === 'string') {
            val = { ref: val[1] };
          }
        } else if (key === 'node' || key === '__prefab') {
          continue;
        }
        const outKey = key.startsWith('_') ? key.slice(1) : key;
        params[outKey] = val;
      }
      // 依赖顺序常为 [spriteFrame, particleAsset]；若 file 指到 @f9941 而 spriteFrame 不像帧，则对调
      if (
        params.file?.ref &&
        params.spriteFrame?.ref &&
        String(params.file.ref).includes('@f9941') &&
        !String(params.spriteFrame.ref).includes('@')
      ) {
        const tmp = params.file;
        params.file = params.spriteFrame;
        params.spriteFrame = tmp;
      }
      results.push({
        source: 'prefab',
        url,
        nodeName: nodeNameHint || null,
        params,
        sharedUuids,
      });
      return;
    }

    // 节点：[type, name, layer, components, ...]
    let nameHint = nodeNameHint;
    if (typeof node[1] === 'string' && node[1].length < 80) {
      nameHint = node[1];
    }
    for (const child of node) {
      if (Array.isArray(child)) walk(child, nameHint);
    }
  };

  walk(dataRoot, null);

  const assetClassIdx = classes.findIndex(
    (c) => Array.isArray(c) && c[0] === 'cc.ParticleAsset'
  );

  // ParticleAsset 名（尾部常有 [6,"timesParticle",".plist"]）
  const findAssetNames = (node, out = []) => {
    if (!Array.isArray(node)) return out;
    if (
      node.length >= 3 &&
      (node[0] === 6 || node[0] === assetClassIdx) &&
      typeof node[1] === 'string' &&
      (node[2] === '.plist' || typeof node[2] === 'string')
    ) {
      out.push(node[1]);
    }
    for (const c of node) {
      if (Array.isArray(c)) findAssetNames(c, out);
    }
    return out;
  };
  const assetNames = [...new Set(findAssetNames(dataRoot))];

  for (const r of results) {
    if (assetNames.length) r.particleAssetName = assetNames[0];
  }

  // 按 url+nodeName 去重
  const seen = new Set();
  return results.filter((r) => {
    const k = `${r.url}::${r.nodeName || ''}::${JSON.stringify(r.params)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const uuidFromUrl = (url) => {
  const m = String(url).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return m ? m[1].toLowerCase() : null;
};

const basenameFromUrl = (url) => {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return path.basename(url.split('?')[0]);
  }
};

const main = () => {
  const args = parseArgs();
  console.error(`[extract-har-particles] 读取 ${args.harPath}`);
  const har = JSON.parse(fs.readFileSync(args.harPath, 'utf8'));
  const entries = har.log?.entries || [];
  console.error(`[extract-har-particles] entries=${entries.length}`);

  const plistsDir = path.join(args.outDir, 'plists');
  const texDir = path.join(args.outDir, 'textures');
  const prefabDir = path.join(args.outDir, 'prefabs');
  fs.mkdirSync(plistsDir, { recursive: true });
  fs.mkdirSync(texDir, { recursive: true });
  fs.mkdirSync(prefabDir, { recursive: true });

  /** @type {Map<string, {url:string, buf:Buffer, mime?:string}>} */
  const byUuidNative = new Map();
  /** @type {Array<{url:string, uuid:string|null, file:string, params:object}>} */
  const particlePlists = [];
  /** @type {Array<object>} */
  const prefabParticles = [];
  /** @type {Array<{path:string, uuid:string}>} */
  const configParticlePaths = [];

  for (const e of entries) {
    const url = e.request?.url || '';
    const buf = decodeBody(e.response?.content);
    if (!buf) continue;
    const uuid = uuidFromUrl(url);
    const mime = e.response?.content?.mimeType || '';

    if (uuid && /\/native\//.test(url)) {
      byUuidNative.set(uuid, { url, buf, mime });
    }

    // config.json → assets/particle/*
    if (/\/config\.json(\?|$)/.test(url)) {
      try {
        const cfg = JSON.parse(buf.toString('utf8'));
        const paths = cfg.paths || {};
        const uuids = cfg.uuids || [];
        for (const [k, v] of Object.entries(paths)) {
          const p = Array.isArray(v) ? v[0] : v;
          if (!/particle/i.test(String(p))) continue;
          const id = uuids[Number(k)] ?? uuids[k] ?? null;
          configParticlePaths.push({
            path: String(p),
            uuid: id,
            index: Number(k),
          });
        }
      } catch {
        /* ignore non-bundle config */
      }
    }

    // particle plist
    if (/\.plist(\?|$)/i.test(url)) {
      const text = buf.toString('utf8');
      if (!isParticlePlistText(text)) continue;
      const name = basenameFromUrl(url);
      const file = path.join(plistsDir, name);
      fs.writeFileSync(file, buf);
      const parsed = parsePlistParams(text);
      particlePlists.push({
        url,
        uuid,
        file: path.relative(args.outDir, file).replace(/\\/g, '/'),
        params: parsed.normalized,
        rawKeys: Object.keys(parsed.raw).length,
      });
      console.error(`[plist] ${name}`);
    }

    // import json with ParticleSystem2D
    if (/\/import\/.+\.json(\?|$)/i.test(url) || /0e[0-9a-f]+\.json/i.test(url)) {
      let text;
      try {
        text = buf.toString('utf8');
        if (!text.includes('ParticleSystem2D') && !text.includes('ParticleAsset')) {
          continue;
        }
        const json = JSON.parse(text);
        const found = extractParticleFromImport(json, url);
        if (!found.length) continue;
        const name = basenameFromUrl(url);
        const file = path.join(prefabDir, name);
        fs.writeFileSync(file, buf);
        for (const f of found) {
          prefabParticles.push({
            ...f,
            file: path.relative(args.outDir, file).replace(/\\/g, '/'),
          });
        }
        console.error(`[prefab] ${name} particles=${found.length}`);
      } catch {
        /* ignore */
      }
    }
  }

  // 按 spriteFrameUuid 导出贴图
  const textures = [];
  const ensureTexture = (sfUuid) => {
    if (!sfUuid) return null;
    const base = String(sfUuid).split('@')[0].toLowerCase();
    const hit = byUuidNative.get(base);
    if (!hit) return null;
    const ext = path.extname(new URL(hit.url).pathname) || '.png';
    const fileName = `${base}${ext}`;
    const file = path.join(texDir, fileName);
    if (!fs.existsSync(file)) fs.writeFileSync(file, hit.buf);
    const rel = path.relative(args.outDir, file).replace(/\\/g, '/');
    textures.push({ uuid: base, url: hit.url, file: rel });
    return rel;
  };

  for (const p of particlePlists) {
    p.textureFile = ensureTexture(p.params.spriteFrameUuid);
  }

  // 合并 manifest
  const particles = [];

  for (const p of particlePlists) {
    // native uuid 前 2 位常与压缩 uuid 前缀一致：49…→49Fx…，3f…→3fy…
    const cfgHit = configParticlePaths.find((c) => {
      if (!p.uuid || !c.uuid) return false;
      return String(c.uuid).toLowerCase().startsWith(p.uuid.slice(0, 2));
    });
    particles.push({
      kind: 'particleAsset',
      name: cfgHit?.path?.split('/').pop() || path.basename(p.file, '.plist'),
      assetPath: cfgHit?.path || null,
      uuid: p.uuid,
      url: p.url,
      plistFile: p.file,
      textureFile: p.textureFile,
      params: p.params,
      paramSource: 'plist',
    });
  }

  const prefabSeen = new Set();
  for (const pref of prefabParticles) {
    const dk = `${pref.url}::${pref.nodeName}`;
    if (prefabSeen.has(dk)) continue;
    prefabSeen.add(dk);
    particles.push({
      kind: 'particleComponent',
      name: pref.nodeName || pref.particleAssetName || 'ParticleSystem2D',
      particleAssetName: pref.particleAssetName || null,
      assetPath: pref.particleAssetName
        ? configParticlePaths.find((c) =>
            c.path.endsWith(`/${pref.particleAssetName}`) ||
            c.path.endsWith(pref.particleAssetName)
          )?.path || null
        : null,
      url: pref.url,
      prefabFile: pref.file,
      sharedUuids: pref.sharedUuids,
      params: pref.params,
      paramSource: 'prefab',
      note:
        pref.params.custom === true
          ? 'custom=true：以 prefab 参数为准，plist 仅为底稿'
          : undefined,
    });
  }

  const manifest = {
    har: args.harPath,
    savedAt: new Date().toISOString(),
    stats: {
      particlePlists: particlePlists.length,
      prefabComponents: prefabParticles.length,
      configParticlePaths: configParticlePaths.length,
      textures: new Set(textures.map((t) => t.uuid)).size,
    },
    configParticlePaths,
    particles,
  };

  const manifestPath = path.join(args.outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.error(
    `[extract-har-particles] 完成 → ${manifestPath}`
  );
  console.error(
    `[extract-har-particles] stats ${JSON.stringify(manifest.stats)}`
  );
  console.log(JSON.stringify({ ok: true, outDir: args.outDir, stats: manifest.stats }, null, 2));
};

main();
