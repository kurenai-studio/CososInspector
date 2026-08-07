#!/usr/bin/env node
/**
 * 修复 cc-reverse 产出的「image 空壳目录」：
 * - 同名旁路已有 .png/.jpg 时：把原 UUID 写回旁路 .meta，删除空壳目录
 * - 无旁路时：从 build/assets/<bundle>/native 拷贝贴图并写 meta，再删空壳目录
 *
 * 用法:
 *   node fix-image-shell-dirs.mjs <assets根>
 *     [--native-root <build/assets>] [--dry-run]
 */
import fs from 'fs';
import path from 'path';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const assetsRoot = args.find((a) => !a.startsWith('-'));
const nativeIdx = args.indexOf('--native-root');
const nativeRoot =
  nativeIdx >= 0 ? args[nativeIdx + 1] : null;

if (!assetsRoot) {
  console.error(
    '用法: node fix-image-shell-dirs.mjs <assets根> ' +
      '[--native-root <build/assets>] [--dry-run]'
  );
  process.exit(1);
}

const absAssets = path.resolve(assetsRoot);
if (!fs.existsSync(absAssets)) {
  console.error(`assets 不存在: ${absAssets}`);
  process.exit(1);
}

const absNative = nativeRoot ? path.resolve(nativeRoot) : null;

/**
 * @param {string} dir
 * @param {Array} acc
 */
function collectImageDirs(dir, acc = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error(`[collect] 读目录失败 ${dir}: ${e.message}`);
    return acc;
  }
  const metaPath = `${dir}.meta`;
  if (fs.existsSync(metaPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (m.importer === 'image' && m.uuid) {
        acc.push({ dir, metaPath, uuid: m.uuid, meta: m });
      }
    } catch (e) {
      console.error(`[collect] 解析 meta 失败 ${metaPath}: ${e.message}`);
    }
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      collectImageDirs(path.join(dir, e.name), acc);
    }
  }
  return acc;
}

/**
 * @param {string} uuid
 * @returns {string|null}
 */
function findNativeFile(uuid) {
  if (!absNative || !fs.existsSync(absNative)) return null;
  const pref = uuid.slice(0, 2);
  let bundles;
  try {
    bundles = fs.readdirSync(absNative, { withFileTypes: true });
  } catch {
    return null;
  }
  const hits = [];
  for (const b of bundles) {
    if (!b.isDirectory()) continue;
    const nativeDir = path.join(absNative, b.name, 'native', pref);
    if (!fs.existsSync(nativeDir)) continue;
    for (const f of fs.readdirSync(nativeDir)) {
      if (!f.startsWith(uuid)) continue;
      const ext = path.extname(f).toLowerCase();
      if (!IMAGE_EXT.includes(ext) && ext !== '.webp') continue;
      hits.push(path.join(nativeDir, f));
    }
  }
  // 优先 png/jpg，其次 webp
  hits.sort((a, b) => {
    const score = (p) => {
      const e = path.extname(p).toLowerCase();
      if (e === '.png') return 0;
      if (e === '.jpg' || e === '.jpeg') return 1;
      return 2;
    };
    return score(a) - score(b);
  });
  return hits[0] || null;
}

/**
 * 把 meta 内所有 oldUuid 替换为 newUuid（含子资源 @suffix）
 * @param {object} meta
 * @param {string} oldUuid
 * @param {string} newUuid
 */
function remapUuidInMeta(meta, oldUuid, newUuid) {
  const text = JSON.stringify(meta);
  if (!text.includes(oldUuid)) {
    // 无 old 时：直接设根 uuid，并尝试替换任意根 uuid 形态
    meta.uuid = newUuid;
    if (meta.subMetas && typeof meta.subMetas === 'object') {
      for (const sub of Object.values(meta.subMetas)) {
        if (!sub || typeof sub !== 'object') continue;
        if (typeof sub.uuid === 'string' && sub.uuid.includes('@')) {
          const suf = sub.uuid.split('@')[1];
          sub.uuid = `${newUuid}@${suf}`;
        }
        const ud = sub.userData;
        if (ud && typeof ud.imageUuidOrDatabaseUri === 'string') {
          if (ud.imageUuidOrDatabaseUri.includes('@')) {
            const suf = ud.imageUuidOrDatabaseUri.split('@')[1];
            ud.imageUuidOrDatabaseUri = `${newUuid}@${suf}`;
          } else {
            ud.imageUuidOrDatabaseUri = newUuid;
          }
        }
      }
    }
    if (meta.userData && typeof meta.userData.redirect === 'string') {
      if (meta.userData.redirect.includes('@')) {
        const suf = meta.userData.redirect.split('@')[1];
        meta.userData.redirect = `${newUuid}@${suf}`;
      } else {
        meta.userData.redirect = newUuid;
      }
    }
    return meta;
  }
  const replaced = text.split(oldUuid).join(newUuid);
  return JSON.parse(replaced);
}

/**
 * @param {string} parent
 * @param {string} base
 */
function findSiblingImages(parent, base) {
  return fs
    .readdirSync(parent)
    .filter((n) => {
      if (!n.startsWith(`${base}.`)) return false;
      const ext = path.extname(n).toLowerCase();
      return IMAGE_EXT.includes(ext);
    })
    .map((n) => path.join(parent, n));
}

/**
 * @param {string} dir
 */
function rmDirRecursive(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const dirs = collectImageDirs(absAssets);
const report = {
  total: dirs.length,
  remappedSibling: 0,
  copiedFromNative: 0,
  skipped: 0,
  errors: [],
  items: [],
};

for (const item of dirs) {
  const base = path.basename(item.dir);
  const parent = path.dirname(item.dir);
  const rel = path.relative(absAssets, item.dir).replace(/\\/g, '/');
  const siblings = findSiblingImages(parent, base);

  try {
    if (siblings.length > 0) {
      const imgPath = siblings[0];
      const imgMetaPath = `${imgPath}.meta`;
      if (!fs.existsSync(imgMetaPath)) {
        report.errors.push({ rel, error: `旁路无 meta: ${imgMetaPath}` });
        report.skipped++;
        continue;
      }
      const imgMeta = JSON.parse(fs.readFileSync(imgMetaPath, 'utf8'));
      const oldUuid = imgMeta.uuid;
      const nextMeta = remapUuidInMeta(imgMeta, oldUuid, item.uuid);
      nextMeta.uuid = item.uuid;

      const entry = {
        rel,
        action: 'remap-sibling',
        sibling: path.basename(imgPath),
        fromUuid: oldUuid,
        toUuid: item.uuid,
      };
      if (!dryRun) {
        fs.writeFileSync(imgMetaPath, `${JSON.stringify(nextMeta, null, 2)}\n`);
        rmDirRecursive(item.dir);
        if (fs.existsSync(item.metaPath)) fs.unlinkSync(item.metaPath);
      }
      report.remappedSibling++;
      report.items.push(entry);
      continue;
    }

    // 无旁路：从 native 补
    const nativeFile = findNativeFile(item.uuid);
    if (!nativeFile) {
      report.errors.push({ rel, error: `无旁路且找不到 native: ${item.uuid}` });
      report.skipped++;
      continue;
    }
    const ext = path.extname(nativeFile).toLowerCase();
    const destImg = path.join(parent, `${base}${ext}`);
    const destMeta = `${destImg}.meta`;
    const newMeta = {
      ver: '1.0.27',
      importer: 'image',
      imported: false,
      uuid: item.uuid,
      files: [],
      subMetas: {},
      userData: {
        type: 'sprite-frame',
        fixAlphaTransparencyArtifacts: false,
      },
    };
    const entry = {
      rel,
      action: 'copy-native',
      native: nativeFile,
      dest: path.basename(destImg),
      uuid: item.uuid,
    };
    if (!dryRun) {
      fs.copyFileSync(nativeFile, destImg);
      fs.writeFileSync(destMeta, `${JSON.stringify(newMeta, null, 2)}\n`);
      rmDirRecursive(item.dir);
      if (fs.existsSync(item.metaPath)) fs.unlinkSync(item.metaPath);
    }
    report.copiedFromNative++;
    report.items.push(entry);
  } catch (e) {
    report.errors.push({ rel, error: e.message });
    report.skipped++;
  }
}

console.log(
  JSON.stringify(
    {
      dryRun,
      assetsRoot: absAssets,
      nativeRoot: absNative,
      total: report.total,
      remappedSibling: report.remappedSibling,
      copiedFromNative: report.copiedFromNative,
      skipped: report.skipped,
      errorCount: report.errors.length,
      errors: report.errors,
      sample: report.items.slice(0, 8),
    },
    null,
    2
  )
);
