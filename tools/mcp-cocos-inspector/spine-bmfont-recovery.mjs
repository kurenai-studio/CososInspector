/**
 * scene-to-creator：从试玩页导出 Spine/BMFont zip → 解压到 recovered → 生成 manifest
 * 按 path 匹配 live 节点 ID（避免快照 id 漂移）
 */
import fs from 'fs';
import path from 'path';
import { unpackExportZip } from './unpack-export-zip.mjs';
import { resolveSharePath } from './shared-fs.mjs';
import { normalizeScenePath } from './scene-snapshot-parse.mjs';

const collectSpineNodes = (node, out = []) => {
  const isSpine = (node.components || []).some(
    (c) =>
      c.flags?.isSpine ||
      (/Spine|Skeleton/.test(c.typeName || '') && !/Sprite|SkeletonData/.test(c.typeName || ''))
  );
  if (isSpine) out.push({ id: node.id, name: node.name, path: node.path });
  for (const ch of node.children ?? []) collectSpineNodes(ch, out);
  return out;
};

const collectBmfontNodes = (node, out = []) => {
  const isBm = (node.components || []).some((c) => {
    if (!/Label/.test(c.typeName || '') || /RichText/.test(c.typeName || '')) {
      return false;
    }
    return true;
  });
  if (isBm) out.push({ id: node.id, name: node.name, path: node.path });
  for (const ch of node.children ?? []) collectBmfontNodes(ch, out);
  return out;
};

const readMetaUuid = (absPath) => {
  const metaPath = `${absPath}.meta`;
  try {
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return meta.uuid ?? null;
  } catch {
    return null;
  }
};

const buildLivePathMap = (liveList = []) => {
  const map = new Map();
  for (const sp of liveList) {
    const norm = normalizeScenePath(sp.path);
    const keys = [
      norm,
      sp.path,
      norm && sp.skeletonName ? `${norm}@@${sp.skeletonName}` : null,
      norm && sp.fontName ? `${norm}@@${sp.fontName}` : null,
      sp.name && sp.skeletonName ? `${sp.name}@@${sp.skeletonName}` : null,
      sp.name && sp.fontName ? `${sp.name}@@${sp.fontName}` : null,
    ].filter(Boolean);
    for (const key of keys) {
      if (!map.has(key)) map.set(key, sp);
    }
  }
  return map;
};

const resolveLiveId = (snapNode, liveByPath) => {
  const pathKey = normalizeScenePath(snapNode.path);
  const hit =
    liveByPath.get(pathKey) ??
    liveByPath.get(snapNode.path) ??
    liveByPath.get(snapNode.name);
  return hit?.id ?? snapNode.id;
};

/**
 * @param {object} snapshot
 * @param {object} args
 * @param {(wsPort, method, argList, opts) => Promise<any>} inspectorCall
 */
export const exportSpineBmfontAssets = async (snapshot, args, inspectorCall) => {
  const assetKey = args.assetKey || 'godeebxp';
  const spineRoot = path.join(args.project, `assets/recovered/${assetKey}/spine`);
  const bmfontRoot = path.join(args.project, `assets/recovered/${assetKey}/bmfont`);
  fs.mkdirSync(spineRoot, { recursive: true });
  fs.mkdirSync(bmfontRoot, { recursive: true });

  const spineNodes = collectSpineNodes(snapshot.root).slice(0, args.maxSpines ?? 50);
  const labelNodes = collectBmfontNodes(snapshot.root).slice(0, args.maxBmfonts ?? 50);

  const spineManifest = {};
  const bmfontManifest = {};
  const spineAssetCache = new Map();
  const bmfontAssetCache = new Map();

  let spineOk = 0;
  let spineFail = 0;
  let bmOk = 0;
  let bmFail = 0;

  let liveSpines = [];
  let liveBmfonts = [];
  try {
    liveSpines = await inspectorCall(args.wsPort, 'listSpines', [], {
      pageUrlMatch: args.pageUrlMatch,
      timeoutMs: 120_000,
    });
  } catch (e) {
    console.error(
      `[scene-to-creator] listSpines 失败，回退快照 id: ${e instanceof Error ? e.message : e}`
    );
  }
  try {
    liveBmfonts = await inspectorCall(args.wsPort, 'listBmfonts', [], {
      pageUrlMatch: args.pageUrlMatch,
      timeoutMs: 120_000,
    });
  } catch (e) {
    console.error(
      `[scene-to-creator] listBmfonts 失败，回退快照 id: ${e instanceof Error ? e.message : e}`
    );
  }

  const liveSpineByPath = buildLivePathMap(
    Array.isArray(liveSpines) ? liveSpines : []
  );
  const liveBmByPath = buildLivePathMap(
    Array.isArray(liveBmfonts) ? liveBmfonts : []
  );

  console.error(
    `[scene-to-creator] Spine 快照 ${spineNodes.length} / live ${liveSpineByPath.size}` +
      ` · BMFont 候选 ${labelNodes.length} / live ${liveBmByPath.size}`
  );

  for (const sp of spineNodes) {
    const liveId = resolveLiveId(sp, liveSpineByPath);
    try {
      const dl = await inspectorCall(
        args.wsPort,
        'downloadSpine',
        [liveId, { delivery: 'share', wsPort: args.wsPort, spineIndex: 0 }],
        { pageUrlMatch: args.pageUrlMatch, timeoutMs: 300_000 }
      );
      if (!dl?.ok) {
        spineFail += 1;
        console.error(
          `[scene-to-creator] Spine 失败 ${sp.path} live=${liveId}: ${dl?.error ?? 'unknown'}`
        );
        continue;
      }

      let entry = spineAssetCache.get(dl.zipName);
      if (!entry) {
        const zipAbs = path.join(spineRoot, dl.zipName);
        if (dl.sharePath) {
          fs.copyFileSync(resolveSharePath(dl.sharePath), zipAbs);
        } else if (dl.base64) {
          fs.writeFileSync(zipAbs, Buffer.from(dl.base64, 'base64'));
        } else {
          throw new Error('downloadSpine 无 sharePath/base64');
        }
        const baseName = path.basename(dl.zipName, '.zip').replace(/_spine$/i, '');
        const destDir = path.join(spineRoot, baseName);
        const unpacked = await unpackExportZip(fs.readFileSync(zipAbs), destDir);
        const primary = unpacked.primaryAsset;
        if (!primary) throw new Error('zip 内无 json/skel');
        const primaryAbs = path.join(destDir, primary);
        const rel = path.relative(args.project, primaryAbs).replace(/\\/g, '/');
        entry = {
          zipName: dl.zipName,
          baseName,
          rel,
          dbUrl: `db://${rel}`,
          primaryAbs,
          skelUuid: readMetaUuid(primaryAbs),
        };
        spineAssetCache.set(dl.zipName, entry);
        console.error(`[scene-to-creator] Spine 解压 ${baseName} → ${rel}`);
      }

      spineManifest[sp.id] = {
        ...entry,
        nodeId: sp.id,
        liveId,
        nodePath: normalizeScenePath(sp.path),
        nodeName: sp.name,
      };
      spineOk += 1;
    } catch (e) {
      spineFail += 1;
      console.error(
        `[scene-to-creator] Spine 异常 ${sp.path}: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  for (const lab of labelNodes) {
    const liveId = resolveLiveId(lab, liveBmByPath);
    try {
      const dl = await inspectorCall(
        args.wsPort,
        'downloadBmfont',
        [liveId, { delivery: 'share', wsPort: args.wsPort, bmfontIndex: 0 }],
        { pageUrlMatch: args.pageUrlMatch, timeoutMs: 180_000 }
      );
      if (!dl?.ok) {
        continue;
      }

      let entry = bmfontAssetCache.get(dl.zipName);
      if (!entry) {
        const zipAbs = path.join(bmfontRoot, dl.zipName);
        if (dl.sharePath) {
          fs.copyFileSync(resolveSharePath(dl.sharePath), zipAbs);
        } else if (dl.base64) {
          fs.writeFileSync(zipAbs, Buffer.from(dl.base64, 'base64'));
        } else {
          throw new Error('downloadBmfont 无 sharePath/base64');
        }
        const baseName = path.basename(dl.zipName, '.zip').replace(/_bmfont$/i, '');
        const destDir = path.join(bmfontRoot, baseName);
        const unpacked = await unpackExportZip(fs.readFileSync(zipAbs), destDir);
        const primary = unpacked.primaryAsset;
        if (!primary) throw new Error('zip 内无 .fnt');
        const primaryAbs = path.join(destDir, primary);
        const rel = path.relative(args.project, primaryAbs).replace(/\\/g, '/');
        entry = {
          zipName: dl.zipName,
          baseName,
          rel,
          dbUrl: `db://${rel}`,
          primaryAbs,
          fontUuid: readMetaUuid(primaryAbs),
        };
        bmfontAssetCache.set(dl.zipName, entry);
        console.error(`[scene-to-creator] BMFont 解压 ${baseName} → ${rel}`);
      }

      bmfontManifest[lab.id] = {
        ...entry,
        nodeId: lab.id,
        liveId,
        nodePath: normalizeScenePath(lab.path),
        nodeName: lab.name,
      };
      bmOk += 1;
    } catch (e) {
      bmFail += 1;
      console.error(
        `[scene-to-creator] BMFont 异常 ${lab.path}: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  return {
    spineManifest,
    bmfontManifest,
    stats: {
      spineOk,
      spineFail,
      bmOk,
      bmFail,
      spineUnique: spineAssetCache.size,
      bmUnique: bmfontAssetCache.size,
    },
  };
};
