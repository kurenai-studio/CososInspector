#!/usr/bin/env node
/**
 * 自研后处理：从 dump 的 config + import packs 抽出 SpriteAtlas / SpriteFrame，
 * 写成 Creator 可识别的 TexturePacker `.plist` + `.plist.meta`（保留原 atlas/帧 UUID），
 * 弥补 cc-reverse 默认把图集落成 importer:json（JsonAsset，帧 UUID 不存在）。
 *
 * 用法:
 *   node fix-sprite-atlas-from-import.mjs <工程>/assets
 *     --bundle-root <build/assets/<bundle>>
 *     [--restore-scene <run1>/.../game_scene.fire]
 *     [--restore-prefabs-from <run1>/assets]
 *     [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const { rehydrateIFileData } = require(
  path.join(toolDir, 'node_modules/cc-reverse/src/core/cocos3x/rehydrate.js')
);
const { uuidUtils } = require(
  path.join(toolDir, 'node_modules/cc-reverse/src/utils/uuidUtils.js')
);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const brIdx = args.indexOf('--bundle-root');
const bundleRootArg = brIdx >= 0 ? args[brIdx + 1] : null;
const rsIdx = args.indexOf('--restore-scene');
const restoreSceneArg = rsIdx >= 0 ? args[rsIdx + 1] : null;
const rpIdx = args.indexOf('--restore-prefabs-from');
const restorePrefabsArg = rpIdx >= 0 ? args[rpIdx + 1] : null;
const assetsRootArg = args.find(
  (a, i) =>
    !a.startsWith('-') &&
    !(brIdx >= 0 && i === brIdx + 1) &&
    !(rsIdx >= 0 && i === rsIdx + 1) &&
    !(rpIdx >= 0 && i === rpIdx + 1)
);

if (!assetsRootArg || !bundleRootArg) {
  console.error(
    '用法: node fix-sprite-atlas-from-import.mjs <工程>/assets ' +
      '--bundle-root <build/assets/<bundle>> ' +
      '[--restore-scene <game_scene.fire>] ' +
      '[--restore-prefabs-from <run1>/assets] [--dry-run]'
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

const decompress = (u) => {
  if (!u) return null;
  const base = String(u).split('@')[0];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(base)) return base.toLowerCase();
  try {
    return uuidUtils.decodeUuid(base);
  } catch {
    return null;
  }
};

const splitUuid = (u) => {
  const s = String(u || '');
  const i = s.indexOf('@');
  if (i < 0) return { base: s, hash: '' };
  return { base: s.slice(0, i), hash: s.slice(i + 1) };
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
 * @param {string} dir
 * @param {Map<string, string>} out
 */
function indexMetas(dir, out = new Map()) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (
        ent.name === 'library' ||
        ent.name === 'temp' ||
        ent.name === 'node_modules' ||
        ent.name === 'scripts'
      ) {
        continue;
      }
      indexMetas(full, out);
      continue;
    }
    if (!ent.name.endsWith('.meta')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (typeof meta.uuid === 'string') out.set(meta.uuid.toLowerCase(), full);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * @param {number} n
 */
function escXml(n) {
  return String(n);
}

/**
 * @param {object} frames name -> frameData
 * @param {string} textureFileName
 * @param {{w:number,h:number}} size
 */
function buildPlistXml(frames, textureFileName, size) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>frames</key>',
    '  <dict>',
  ];
  for (const [name, f] of Object.entries(frames)) {
    const r = f.rect;
    const o = f.offset;
    const os = f.originalSize;
    const rot = f.rotated ? '      <true/>' : '      <false/>';
    lines.push(`    <key>${name}</key>`);
    lines.push('    <dict>');
    lines.push('      <key>frame</key>');
    lines.push(
      `      <string>{{${escXml(r.x)},${escXml(r.y)}},{${escXml(r.width)},${escXml(r.height)}}}</string>`
    );
    lines.push('      <key>offset</key>');
    lines.push(`      <string>{${escXml(o.x)},${escXml(o.y)}}</string>`);
    lines.push('      <key>rotated</key>');
    lines.push(rot);
    lines.push('      <key>sourceColorRect</key>');
    lines.push(
      `      <string>{{${escXml(r.x)},${escXml(r.y)}},{${escXml(r.width)},${escXml(r.height)}}}</string>`
    );
    lines.push('      <key>sourceSize</key>');
    lines.push(
      `      <string>{${escXml(os.width)},${escXml(os.height)}}</string>`
    );
    lines.push('    </dict>');
  }
  lines.push('  </dict>');
  lines.push('  <key>metadata</key>');
  lines.push('  <dict>');
  lines.push('    <key>format</key>');
  lines.push('    <integer>2</integer>');
  lines.push('    <key>realTextureFileName</key>');
  lines.push(`    <string>${textureFileName}</string>`);
  lines.push('    <key>size</key>');
  lines.push(`    <string>{${size.w},${size.h}}</string>`);
  lines.push('    <key>textureFileName</key>');
  lines.push(`    <string>${textureFileName}</string>`);
  lines.push('  </dict>');
  lines.push('</dict>');
  lines.push('</plist>');
  lines.push('');
  return lines.join('\n');
}

/**
 * @param {string} srcRoot
 * @param {string} dstRoot
 */
function copyPrefabs(srcRoot, dstRoot) {
  let n = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.name.endsWith('.prefab')) continue;
      const rel = path.relative(srcRoot, full);
      const dest = path.join(dstRoot, rel);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        const metaSrc = `${full}.meta`;
        const metaDst = `${dest}.meta`;
        if (fs.existsSync(metaSrc)) fs.copyFileSync(metaSrc, metaDst);
      }
      n++;
    }
  };
  walk(srcRoot);
  return n;
}

const atlasByUuid = new Map();
const frameByUuid = new Map();

for (const [packId, list] of Object.entries(packs)) {
  if (!Array.isArray(list)) continue;
  let pack;
  try {
    pack = loadPack(packId);
  } catch {
    continue;
  }
  if (!pack) continue;
  for (let pos = 0; pos < list.length; pos++) {
    const compressed = uuids[list[pos]];
    if (!compressed) continue;
    let out;
    try {
      out = extractSection(pack, pos);
    } catch {
      continue;
    }
    const obj = out && out[0];
    if (!obj || !obj.__type__) continue;
    if (obj.__type__ === 'cc.SpriteAtlas') {
      const full = decompress(compressed) || compressed;
      const pairs = obj.content?.spriteFrames || [];
      const frames = [];
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        frames.push({ name: pairs[i], frameUuid: pairs[i + 1] });
      }
      atlasByUuid.set(full, {
        compressed,
        name: obj.content?.name || '',
        frames,
      });
    } else if (obj.__type__ === 'cc.SpriteFrame') {
      const c = obj.content || {};
      const tex =
        obj._textureSource?.__uuid__ ||
        obj._texture?.__uuid__ ||
        c.texture?.__uuid__ ||
        null;
      frameByUuid.set(String(compressed), {
        compressed,
        full: decompress(compressed),
        name: c.name || '',
        rect: c.rect || { x: 0, y: 0, width: 0, height: 0 },
        offset: c.offset || { x: 0, y: 0 },
        originalSize: c.originalSize || {
          width: c.rect?.width || 0,
          height: c.rect?.height || 0,
        },
        rotated: !!c.rotated,
        capInsets: Array.isArray(c.capInsets) ? c.capInsets : [0, 0, 0, 0],
        textureUuid: tex,
        packable: c.packable !== false,
        pixelsToUnit: c.pixelsToUnit || 100,
        pivot: c.pivot || { x: 0.5, y: 0.5 },
        meshType: c.meshType || 0,
      });
    }
  }
}

const metaIndex = indexMetas(assetsRoot);
const report = {
  dryRun,
  atlases: atlasByUuid.size,
  frames: frameByUuid.size,
  written: 0,
  skipped: 0,
  errors: [],
  brokenJsonRemoved: 0,
  prefabsRestored: 0,
  sceneRestored: null,
  items: [],
};

for (const [atlasFull, atlas] of atlasByUuid) {
  try {
    const plistFrames = {};
    let textureImageUuid = null;
    let textureRef = null;
    let imageMetaPath = null;
    let textureFileName = null;

    for (const { name, frameUuid } of atlas.frames) {
      const frame = frameByUuid.get(String(frameUuid));
      if (!frame) {
        report.errors.push({
          atlas: atlas.name,
          name,
          frameUuid,
          error: 'missing frame',
        });
        continue;
      }
      const texFull = decompress(frame.textureUuid);
      if (!texFull) {
        report.errors.push({
          atlas: atlas.name,
          name,
          error: 'bad texture uuid',
        });
        continue;
      }
      if (!textureImageUuid) {
        textureImageUuid = texFull.toLowerCase();
        imageMetaPath = metaIndex.get(textureImageUuid);
        if (!imageMetaPath) {
          report.errors.push({
            atlas: atlas.name,
            error: `texture meta missing ${textureImageUuid}`,
          });
          break;
        }
        const imageMeta = JSON.parse(fs.readFileSync(imageMetaPath, 'utf8'));
        const textureSub = Object.values(imageMeta.subMetas || {}).find(
          (s) => s && s.importer === 'texture'
        );
        textureRef =
          (textureSub && textureSub.uuid) || `${imageMeta.uuid}@6c48a`;
        textureFileName = path.basename(imageMetaPath.replace(/\.meta$/i, ''));
      }
      plistFrames[name || frame.name || splitUuid(frame.compressed).hash] = frame;
    }

    if (!imageMetaPath || !textureFileName || Object.keys(plistFrames).length === 0) {
      report.skipped++;
      continue;
    }

    const imageMeta = JSON.parse(fs.readFileSync(imageMetaPath, 'utf8'));
    let sizeW = 0;
    let sizeH = 0;
    for (const s of Object.values(imageMeta.subMetas || {})) {
      if (s && s.importer === 'sprite-frame' && s.userData) {
        sizeW = s.userData.rawWidth || s.userData.width || sizeW;
        sizeH = s.userData.rawHeight || s.userData.height || sizeH;
      }
    }
    if (!sizeW || !sizeH) {
      sizeW = 2048;
      sizeH = 2048;
    }

    const imageDir = path.dirname(imageMetaPath);
    const atlasName = atlas.name || path.parse(textureFileName).name;
    const plistPath = path.join(imageDir, `${atlasName}.plist`);
    const plistMetaPath = `${plistPath}.meta`;

    // 清理同 UUID 的旧 JsonAsset 图集
    const oldMetaPath = metaIndex.get(atlasFull.toLowerCase());
    if (oldMetaPath && oldMetaPath !== plistMetaPath) {
      const oldAsset = oldMetaPath.replace(/\.meta$/i, '');
      if (/\.json$/i.test(oldAsset) && fs.existsSync(oldAsset)) {
        if (!dryRun) {
          fs.unlinkSync(oldAsset);
          fs.unlinkSync(oldMetaPath);
        }
        report.brokenJsonRemoved++;
      }
    }

    const subMetas = {};
    for (const [name, frame] of Object.entries(plistFrames)) {
      const hash = splitUuid(frame.compressed).hash;
      if (!hash) continue;
      const rect = frame.rect;
      const ow = frame.originalSize.width || rect.width || 0;
      const oh = frame.originalSize.height || rect.height || 0;
      const [bT, bB, bL, bR] = frame.capInsets;
      subMetas[hash] = {
        importer: 'sprite-frame',
        uuid: `${atlasFull}@${hash}`,
        displayName: '',
        id: hash,
        name,
        userData: {
          trimThreshold: 1,
          rotated: frame.rotated,
          offsetX: frame.offset.x || 0,
          offsetY: frame.offset.y || 0,
          trimX: rect.x || 0,
          trimY: rect.y || 0,
          width: rect.width || 0,
          height: rect.height || 0,
          rawWidth: ow,
          rawHeight: oh,
          borderTop: bT || 0,
          borderBottom: bB || 0,
          borderLeft: bL || 0,
          borderRight: bR || 0,
          packable: frame.packable,
          pixelsToUnit: frame.pixelsToUnit,
          pivotX: frame.pivot.x,
          pivotY: frame.pivot.y,
          meshType: frame.meshType,
          vertices: {
            rawPosition: [],
            indexes: [],
            uv: [],
            nuv: [],
            minPos: [],
            maxPos: [],
          },
          isUuid: true,
          imageUuidOrDatabaseUri: textureRef,
          atlasUuid: atlasFull,
          trimType: 'custom',
        },
        ver: '1.0.12',
        imported: false,
        files: [],
        subMetas: {},
      };
    }

    const plistXml = buildPlistXml(plistFrames, textureFileName, {
      w: sizeW,
      h: sizeH,
    });
    const plistMeta = {
      ver: '1.0.8',
      importer: 'sprite-atlas',
      imported: false,
      uuid: atlasFull,
      files: [],
      subMetas,
      userData: {
        atlasTextureName: textureFileName,
        format: 2,
        uuid: atlasFull,
        textureUuid: textureRef,
      },
    };

    if (!dryRun) {
      fs.writeFileSync(plistPath, plistXml);
      fs.writeFileSync(plistMetaPath, `${JSON.stringify(plistMeta, null, 2)}\n`);
    }

    report.written++;
    report.items.push({
      name: atlasName,
      uuid: atlasFull,
      frames: Object.keys(subMetas).length,
      plist: path.relative(assetsRoot, plistPath).replace(/\\/g, '/'),
      texture: textureFileName,
    });
  } catch (e) {
    report.skipped++;
    report.errors.push({ atlas: atlas.name, error: e.message });
  }
}

if (restorePrefabsArg) {
  const src = path.resolve(restorePrefabsArg);
  if (!fs.existsSync(src)) {
    console.error('restore-prefabs-from 不存在:', src);
    process.exit(1);
  }
  report.prefabsRestored = copyPrefabs(src, assetsRoot);
}

if (restoreSceneArg) {
  const src = path.resolve(restoreSceneArg);
  if (!fs.existsSync(src)) {
    console.error('restore-scene 不存在:', src);
    process.exit(1);
  }
  let dest = path.join(assetsRoot, 'slotgame', 'game_scene.scene');
  const metaScene = path.join(assetsRoot, 'slotgame', 'game_scene.scene.meta');
  if (!fs.existsSync(metaScene)) {
    const fireMeta = path.join(assetsRoot, 'slotgame', 'game_scene.fire.meta');
    if (fs.existsSync(fireMeta)) dest = fireMeta.replace(/\.meta$/i, '');
  }
  if (dest.endsWith('.fire')) dest = dest.replace(/\.fire$/i, '.scene');
  if (!dryRun) {
    if (fs.existsSync(dest)) {
      fs.copyFileSync(dest, `${dest}.bak-before-sprite-fix`);
    }
    fs.writeFileSync(dest, fs.readFileSync(src));
    const firePath = dest.replace(/\.scene$/i, '.fire');
    if (firePath !== dest && fs.existsSync(firePath)) fs.unlinkSync(firePath);
  }
  report.sceneRestored = { from: src, to: dest };
}

console.log(
  JSON.stringify(
    {
      dryRun: report.dryRun,
      atlases: report.atlases,
      frames: report.frames,
      written: report.written,
      skipped: report.skipped,
      brokenJsonRemoved: report.brokenJsonRemoved,
      prefabsRestored: report.prefabsRestored,
      sceneRestored: report.sceneRestored,
      errorCount: report.errors.length,
      errors: report.errors.slice(0, 20),
      items: report.items.slice(0, 15),
    },
    null,
    2
  )
);
