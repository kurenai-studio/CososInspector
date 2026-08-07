#!/usr/bin/env node
/**
 * 自研后处理：从 dump 的 config + import（含 packs）抽出 sp.SkeletonData，
 * 写成 Creator 可识别的 Spine 三件套（.json + .atlas + 已有 .png），
 * 弥补 cc-reverse 3.x 不拆 Spine 源文件的缺口。
 *
 * 用法:
 *   node fix-spine-from-import.mjs <工程assets根> --bundle-root <build/assets/resources>
 *     [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const require = createRequire(import.meta.url);
const { rehydrateIFileData } = require(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'node_modules/cc-reverse/src/core/cocos3x/rehydrate.js'
  )
);
const { uuidUtils } = require(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'node_modules/cc-reverse/src/utils/uuidUtils.js'
  )
);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const assetsRootArg = args.find((a) => !a.startsWith('-'));
const brIdx = args.indexOf('--bundle-root');
const bundleRootArg = brIdx >= 0 ? args[brIdx + 1] : null;

if (!assetsRootArg || !bundleRootArg) {
  console.error(
    '用法: node fix-spine-from-import.mjs <工程assets根> ' +
      '--bundle-root <build/assets/<bundle>> [--dry-run]'
  );
  process.exit(1);
}

const assetsRoot = path.resolve(assetsRootArg);
const bundleRoot = path.resolve(bundleRootArg);
const configPath = path.join(bundleRoot, 'config.json');

if (!fs.existsSync(assetsRoot) || !fs.existsSync(configPath)) {
  console.error('assets 或 config.json 不存在');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const uuids = cfg.uuids || [];
const packs = cfg.packs || {};
const types = cfg.types || [];
const skelTypeIdx = types.indexOf('sp.SkeletonData');

const decompress = (u) => {
  if (!u) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(u)) return u.split('@')[0];
  try {
    return uuidUtils.decodeUuid(u.split('@')[0]);
  } catch {
    return null;
  }
};

const packCache = new Map();

/**
 * @param {string} packId
 */
function loadPack(packId) {
  if (packCache.has(packId)) return packCache.get(packId);
  const pref = packId.slice(0, 2);
  const candidates = [
    path.join(bundleRoot, 'import', pref, `${packId}.json`),
    path.join(bundleRoot, 'import', `${packId}.json`),
  ];
  let doc = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      doc = JSON.parse(fs.readFileSync(c, 'utf8'));
      break;
    }
  }
  packCache.set(packId, doc);
  return doc;
}

/**
 * @param {object} pack
 * @param {number} pos
 */
function extractSection(pack, pos) {
  if (!Array.isArray(pack) || pack.length < 6) return null;
  const sections = pack[5];
  if (!Array.isArray(sections) || pos < 0 || pos >= sections.length) return null;
  const section = sections[pos];
  if (!Array.isArray(section)) return null;
  const doc = [
    pack[0],
    pack[1],
    pack[2],
    pack[3],
    pack[4],
    section[0] || [],
    section[1] || 0,
    section[2] || null,
    section[3] || [],
    section[4] || [],
    section[5] || [],
  ];
  return rehydrateIFileData(doc);
}

/**
 * @param {number} uuidIdx
 * @param {string} compressedUuid
 */
function loadSkeletonData(uuidIdx, compressedUuid) {
  for (const [packId, list] of Object.entries(packs)) {
    if (!Array.isArray(list)) continue;
    const pos = list.indexOf(uuidIdx);
    if (pos < 0) continue;
    const pack = loadPack(packId);
    if (!pack) continue;
    const out = extractSection(pack, pos);
    if (out && out[0] && out[0].__type__ === 'sp.SkeletonData') {
      return { data: out[0], source: `pack:${packId}#${pos}` };
    }
  }

  const full = decompress(compressedUuid);
  if (full) {
    const pref = full.slice(0, 2);
    const candidates = [
      path.join(bundleRoot, 'import', pref, `${full}.json`),
      path.join(bundleRoot, 'import', pref, `${compressedUuid}.json`),
    ];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const raw = JSON.parse(fs.readFileSync(c, 'utf8'));
      let out = null;
      try {
        out = rehydrateIFileData(raw);
      } catch {
        out = null;
      }
      if (out && out[0] && out[0].__type__ === 'sp.SkeletonData') {
        return { data: out[0], source: c };
      }
      if (Array.isArray(raw) && raw[0]?.__type__ === 'sp.SkeletonData') {
        return { data: raw[0], source: c };
      }
    }
  }
  return null;
}

/**
 * atlas meta UUID：优先新建，避免复用已占用的旧 Asset UUID（Creator 会改号导致断链）
 */
function newAtlasUuid() {
  return randomUUID();
}

/**
 * @param {string} atlasText
 */
function atlasPageNames(atlasText) {
  return [
    ...new Set(
      String(atlasText || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[^/\s].+\.(png|jpg|jpeg|webp)$/i.test(l))
    ),
  ];
}

/**
 * @param {string} filePath
 * @param {string|object} content
 */
function writeText(filePath, content) {
  const text =
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
  }
}

/**
 * @param {string} filePath
 */
function rmIfExists(filePath) {
  if (dryRun) return;
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

if (skelTypeIdx < 0) {
  console.error('config.types 中无 sp.SkeletonData');
  process.exit(1);
}

const jobs = [];
for (const [k, v] of Object.entries(cfg.paths || {})) {
  if (!Array.isArray(v) || v[1] !== skelTypeIdx) continue;
  jobs.push({
    idx: Number(k),
    assetPath: v[0],
    compressed: uuids[Number(k)],
  });
}

const bundleName = path.basename(bundleRoot);
const report = {
  dryRun,
  assetsRoot,
  bundleRoot,
  bundleName,
  total: jobs.length,
  written: 0,
  skipped: 0,
  errors: [],
  items: [],
};

for (const job of jobs) {
  const rel = job.assetPath;
  try {
    const loaded = loadSkeletonData(job.idx, job.compressed);
    if (!loaded) {
      report.skipped++;
      report.errors.push({ rel, error: '未能从 import/packs 提取 SkeletonData' });
      continue;
    }
    const data = loaded.data;
    const name = data._name || path.basename(rel);
    const skelJson = data._skeletonJson;
    const atlasText = data._atlasText;
    if (!skelJson || !atlasText) {
      report.skipped++;
      report.errors.push({ rel, error: '缺少 _skeletonJson 或 _atlasText' });
      continue;
    }

    const skelUuid = decompress(job.compressed) || randomUUID();
    const atlasUuid = newAtlasUuid();
    const destBase = path.join(
      assetsRoot,
      bundleName,
      rel.replace(/\//g, path.sep)
    );
    const destDir = path.dirname(destBase);
    const baseName = path.basename(destBase);

    const jsonPath = path.join(destDir, `${baseName}.json`);
    const atlasPath = path.join(destDir, `${baseName}.atlas`);
    const jsonMetaPath = `${jsonPath}.meta`;
    const atlasMetaPath = `${atlasPath}.meta`;

    // 清理 cc-reverse 误产物
    rmIfExists(path.join(destDir, `${baseName}.atlas.json`));
    rmIfExists(path.join(destDir, `${baseName}.atlas.json.meta`));

    writeText(jsonPath, skelJson);
    writeText(atlasPath, atlasText.endsWith('\n') ? atlasText : `${atlasText}\n`);
    writeText(jsonMetaPath, {
      ver: '1.2.7',
      importer: 'spine-data',
      imported: false,
      uuid: skelUuid,
      files: [],
      subMetas: {},
      userData: {
        atlasUuid,
      },
    });
    writeText(atlasMetaPath, {
      ver: '1.0.0',
      importer: '*',
      imported: false,
      uuid: atlasUuid,
      files: [],
      subMetas: {},
      userData: {},
    });

    const pages = atlasPageNames(atlasText);
    const missingPages = pages.filter(
      (p) => !fs.existsSync(path.join(destDir, p))
    );

    report.written++;
    report.items.push({
      rel,
      name,
      source: loaded.source,
      skelUuid,
      atlasUuid,
      pages,
      missingPages,
      jsonPath: path.relative(assetsRoot, jsonPath).replace(/\\/g, '/'),
    });
  } catch (e) {
    report.skipped++;
    report.errors.push({ rel, error: e.message });
  }
}

console.log(
  JSON.stringify(
    {
      dryRun: report.dryRun,
      total: report.total,
      written: report.written,
      skipped: report.skipped,
      errorCount: report.errors.length,
      errors: report.errors,
      items: report.items,
    },
    null,
    2
  )
);
