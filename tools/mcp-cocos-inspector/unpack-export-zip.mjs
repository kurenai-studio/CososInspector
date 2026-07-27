/**
 * 解压 Inspector Spine/BMFont zip 到目标目录（扁平化子目录）
 */
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

const SKIP_ROOT = new Set(['manifest.json', 'IMPORT_README.txt']);

/**
 * @param {Buffer|Uint8Array} zipBuf
 * @param {string} destDir
 * @returns {Promise<{ written: Array<{ outPath: string, bytes: number }>, manifest: object|null, primaryAsset: string|null }>}
 */
export async function unpackExportZip(zipBuf, destDir) {
  const zip = await JSZip.loadAsync(zipBuf);
  let manifest = null;
  if (zip.file('manifest.json')) {
    try {
      manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    } catch {
      manifest = null;
    }
  }

  fs.mkdirSync(destDir, { recursive: true });
  const written = [];

  for (const [rel, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const base = path.basename(rel);
    if (SKIP_ROOT.has(base) && !rel.includes('/')) continue;

    let outRel = rel.includes('/') ? rel.split('/').slice(1).join('/') : rel;
    const outPath = path.join(destDir, outRel || base);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const data = await entry.async('nodebuffer');
    fs.writeFileSync(outPath, data);
    written.push({ outPath, bytes: data.length, rel: outRel || base });
  }

  // 主资源：优先 .json/.skel 或 .fnt
  const primary =
    written.find((w) => /\.(json|skel)$/i.test(w.rel) && !/manifest/i.test(w.rel)) ||
    written.find((w) => /\.fnt$/i.test(w.rel)) ||
    null;

  return {
    written,
    manifest,
    primaryAsset: primary ? primary.rel : null,
  };
}

export async function unpackExportZipFile(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  return unpackExportZip(buf, destDir);
}
