/**
 * scene-to-creator：从试玩页导出 Spine/BMFont zip → 解压到 recovered → 生成 manifest
 * 按 path + index / skeletonName|fontName 匹配 live 节点（支持同节点多组件）
 */
import fs from 'fs';
import path from 'path';
import { unpackExportZip } from './unpack-export-zip.mjs';
import { resolveSharePath } from './shared-fs.mjs';
import { normalizeScenePath } from './scene-snapshot-parse.mjs';

const isSpineComp = (c) =>
  c.flags?.isSpine ||
  (/Spine|Skeleton/.test(c.typeName || '') &&
    !/Sprite|SkeletonData/.test(c.typeName || ''));

const isBmfontComp = (c) => {
  if (c.flags?.isBmfont) return true;
  // 旧快照无 isBmfont：仅 Label，交给 live 过滤；此处仍收集供回退
  return (
    /Label/.test(c.typeName || '') && !/RichText/.test(c.typeName || '')
  );
};

/** 快照按组件展开（含 spineIndex / bmfontIndex） */
const collectSpineJobs = (node, out = []) => {
  let localIdx = 0;
  for (const c of node.components || []) {
    if (!isSpineComp(c)) continue;
    const spineIndex =
      typeof c.flags?.spineIndex === 'number' && c.flags.spineIndex >= 0
        ? c.flags.spineIndex
        : localIdx;
    out.push({
      id: node.id,
      name: node.name,
      path: node.path,
      spineIndex,
    });
    localIdx += 1;
  }
  for (const ch of node.children ?? []) collectSpineJobs(ch, out);
  return out;
};

const collectBmfontJobs = (node, out = []) => {
  const comps = node.components || [];
  const hasBmflag = comps.some((c) => c.flags && 'isBmfont' in c.flags);
  let localIdx = 0;
  for (const c of comps) {
    if (hasBmflag) {
      if (!c.flags?.isBmfont) continue;
    } else if (!isBmfontComp(c)) {
      continue;
    }
    const bmfontIndex =
      typeof c.flags?.bmfontIndex === 'number' && c.flags.bmfontIndex >= 0
        ? c.flags.bmfontIndex
        : localIdx;
    out.push({
      id: node.id,
      name: node.name,
      path: node.path,
      bmfontIndex,
    });
    localIdx += 1;
  }
  for (const ch of node.children ?? []) collectBmfontJobs(ch, out);
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

const buildLivePathMap = (liveList = [], indexKey) => {
  const map = new Map();
  for (const sp of liveList) {
    const norm = normalizeScenePath(sp.path);
    const idx = sp[indexKey] ?? 0;
    const nameKey = sp.skeletonName || sp.fontName || '';
    const keys = [
      `${norm}#${idx}`,
      sp.path ? `${sp.path}#${idx}` : null,
      norm && nameKey ? `${norm}@@${nameKey}` : null,
      sp.path && nameKey ? `${sp.path}@@${nameKey}` : null,
      // index 0 保留裸 path，兼容旧匹配
      idx === 0 ? norm : null,
      idx === 0 ? sp.path : null,
      sp.name && nameKey ? `${sp.name}@@${nameKey}` : null,
      idx === 0 ? sp.name : null,
    ].filter(Boolean);
    for (const key of keys) {
      if (!map.has(key)) map.set(key, sp);
    }
  }
  return map;
};

const resolveLiveEntry = (snapJob, liveByPath, indexKey, nameField) => {
  const pathKey = normalizeScenePath(snapJob.path);
  const idx = snapJob[indexKey] ?? 0;
  const nameVal = snapJob[nameField] || '';
  return (
    liveByPath.get(`${pathKey}#${idx}`) ??
    liveByPath.get(`${snapJob.path}#${idx}`) ??
    (nameVal
      ? liveByPath.get(`${pathKey}@@${nameVal}`) ??
        liveByPath.get(`${snapJob.path}@@${nameVal}`)
      : null) ??
    (idx === 0
      ? liveByPath.get(pathKey) ??
        liveByPath.get(snapJob.path) ??
        liveByPath.get(snapJob.name)
      : null) ??
    null
  );
};

const putManifest = (manifest, nodeId, index, entry) => {
  const keyed = { ...entry, nodeId, index };
  manifest[`${nodeId}#${index}`] = keyed;
  if (index === 0) manifest[nodeId] = keyed;
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

  const spineJobs = collectSpineJobs(snapshot.root).slice(
    0,
    args.maxSpines ?? 50
  );
  const bmfontJobs = collectBmfontJobs(snapshot.root).slice(
    0,
    args.maxBmfonts ?? 50
  );

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
    Array.isArray(liveSpines) ? liveSpines : [],
    'spineIndex'
  );
  const liveBmByPath = buildLivePathMap(
    Array.isArray(liveBmfonts) ? liveBmfonts : [],
    'bmfontIndex'
  );

  console.error(
    `[scene-to-creator] Spine 任务 ${spineJobs.length} / live ${
      Array.isArray(liveSpines) ? liveSpines.length : 0
    }` +
      ` · BMFont 任务 ${bmfontJobs.length} / live ${
        Array.isArray(liveBmfonts) ? liveBmfonts.length : 0
      }`
  );

  for (const job of spineJobs) {
    const live = resolveLiveEntry(
      job,
      liveSpineByPath,
      'spineIndex',
      'skeletonName'
    );
    const liveId = live?.id ?? job.id;
    const spineIndex = job.spineIndex ?? live?.spineIndex ?? 0;
    try {
      const dl = await inspectorCall(
        args.wsPort,
        'downloadSpine',
        [liveId, { delivery: 'share', wsPort: args.wsPort, spineIndex }],
        { pageUrlMatch: args.pageUrlMatch, timeoutMs: 300_000 }
      );
      if (!dl?.ok) {
        spineFail += 1;
        console.error(
          `[scene-to-creator] Spine 失败 ${job.path}#${spineIndex} ` +
            `live=${liveId}: ${dl?.error ?? 'unknown'}`
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
        const baseName = path
          .basename(dl.zipName, '.zip')
          .replace(/_spine$/i, '');
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

      putManifest(spineManifest, job.id, spineIndex, {
        ...entry,
        liveId,
        spineIndex,
        nodePath: normalizeScenePath(job.path),
        nodeName: job.name,
      });
      spineOk += 1;
    } catch (e) {
      spineFail += 1;
      console.error(
        `[scene-to-creator] Spine 异常 ${job.path}#${spineIndex}: ${
          e instanceof Error ? e.message : e
        }`
      );
    }
  }

  for (const job of bmfontJobs) {
    const live = resolveLiveEntry(
      job,
      liveBmByPath,
      'bmfontIndex',
      'fontName'
    );
    const liveId = live?.id ?? job.id;
    const bmfontIndex = job.bmfontIndex ?? live?.bmfontIndex ?? 0;
    try {
      const dl = await inspectorCall(
        args.wsPort,
        'downloadBmfont',
        [liveId, { delivery: 'share', wsPort: args.wsPort, bmfontIndex }],
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
        const baseName = path
          .basename(dl.zipName, '.zip')
          .replace(/_bmfont$/i, '');
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

      putManifest(bmfontManifest, job.id, bmfontIndex, {
        ...entry,
        liveId,
        bmfontIndex,
        nodePath: normalizeScenePath(job.path),
        nodeName: job.name,
      });
      bmOk += 1;
    } catch (e) {
      bmFail += 1;
      console.error(
        `[scene-to-creator] BMFont 异常 ${job.path}#${bmfontIndex}: ${
          e instanceof Error ? e.message : e
        }`
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
