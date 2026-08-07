/**
 * Egret DragonBones 内存导出
 *
 * 参考 hgjkfcojmobceiihkjifeioioffcmond/inspector.js 的 Qe/Ae/Ee/le/ce 函数：
 *   数据源：
 *     - 场景节点：egret.dragonBones.EgretArmatureDisplay / ArmatureDisplay
 *     - 全局缓存：dragonBones.EgretFactory.factory._dragonBonesDataMap
 *     - 纹理：dragonBones.EgretFactory.factory._textureAtlasDataMap
 */
import {
  getEgretStage,
  type DragonBonesAtlasEntry,
  type DragonBonesDataEntry,
  type DragonBonesFactoryLike,
  type EgretDisplayObject,
  type EgretTextureLike,
} from './runtime';
import {
  buildNodePath,
  findDisplayById,
  getDisplayId,
  walkDisplayTree,
} from './sceneTree';
import JSZip from 'jszip';
import {
  extractWholeSourceToPng,
  getTextureSourceUrl,
} from './textureExtract';
import {
  pushSkeletonData,
  runtimeSummaryJson,
  sanitizeFilename,
  type SkeletonExportFile,
  type SkeletonExportResult,
} from './skeletonCommon';

export interface DragonBonesListItem {
  id: string;
  name: string;
  kind: 'dragonBones';
  nodePath: string;
  armatureName: string;
  anims: string[];
  exportable: boolean;
  source: 'scene' | 'cache';
}

function isArmatureDisplay(node: EgretDisplayObject): boolean {
  const db = window.dragonBones;
  if (!db) return false;
  try {
    if (db.EgretArmatureDisplay && node instanceof (db.EgretArmatureDisplay as never)) return true;
    if (db.ArmatureDisplay && node instanceof (db.ArmatureDisplay as never)) return true;
  } catch {
    /* ignore */
  }
  const ctor = node.constructor?.name || '';
  return /EgretArmatureDisplay|ArmatureDisplay/i.test(ctor);
}

function getFactory(): DragonBonesFactoryLike | null {
  const db = window.dragonBones;
  if (!db) return null;
  const f = db.EgretFactory?.factory ?? db.BaseFactory?.factory;
  return f ?? null;
}

function getArmatureName(node: EgretDisplayObject): string {
  const arm = (node as { armature?: { name?: string } }).armature;
  return String(arm?.name || node.name || 'armature');
}

function getAnimations(node: EgretDisplayObject): string[] {
  const arm = (node as {
    armature?: { animation?: { names?: string[]; getAnimationNames?: () => string[] } };
  }).armature;
  const anim = arm?.animation;
  if (!anim) return [];
  try {
    if (typeof anim.getAnimationNames === 'function') {
      return anim.getAnimationNames().filter(Boolean);
    }
    if (Array.isArray(anim.names)) return anim.names.filter(Boolean);
  } catch {
    /* ignore */
  }
  return [];
}

/** 列出场景中的 DragonBones 节点 + 缓存中已注册的 dragonBones 数据 */
export function listDragonBones(): DragonBonesListItem[] {
  const stage = getEgretStage();
  const out: DragonBonesListItem[] = [];
  const seen = new Set<string>();

  if (stage) {
    walkDisplayTree(stage, (node) => {
      if (!isArmatureDisplay(node)) return;
      const id = getDisplayId(node);
      const armName = getArmatureName(node);
      seen.add(armName);
      out.push({
        id,
        kind: 'dragonBones',
        name: armName,
        nodePath: buildNodePath(stage, id),
        armatureName: armName,
        anims: getAnimations(node),
        exportable: true,
        source: 'scene',
      });
    });
  }

  // 缓存中已注册但未挂到场景的数据
  const factory = getFactory();
  const dataMap = factory?._dragonBonesDataMap ?? factory?.dragonBonesDataMap;
  if (dataMap && typeof dataMap === 'object') {
    for (const key of Object.keys(dataMap)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `egret-db-cache-${key}`,
        kind: 'dragonBones',
        name: key,
        nodePath: '(asset-cache)',
        armatureName: key,
        anims: [],
        exportable: true,
        source: 'cache',
      });
    }
  }

  return out;
}

function exportTexture(
  out: SkeletonExportFile[],
  tex: unknown,
  baseName: string
): void {
  if (!tex) return;
  const t = tex as EgretTextureLike | null;
  if (!t) return;
  const url = getTextureSourceUrl(t);
  const whole = extractWholeSourceToPng(t);
  if (whole.ok) {
    out.push({
      name: `${baseName}.png`,
      mime: 'image/png',
      dataBase64: whole.base64,
      bytes: Math.round(whole.base64.length * 0.75),
    });
    return;
  }
  if (url) {
    out.push({ name: `${baseName}.png`, mime: 'image/png', url });
  }
}

/** 导出指定 DragonBones 节点/缓存为 zip（base64 inline） */
export async function exportDragonBones(
  id: string
): Promise<SkeletonExportResult> {
  const log: string[] = [];
  const files: SkeletonExportFile[] = [];
  const factory = getFactory();

  let armatureName = 'dragonBones';
  let nodePath = '';
  let source: 'scene' | 'cache' = 'cache';
  let anims: string[] = [];

  // 场景节点
  let sceneNode: EgretDisplayObject | null = null;
  const stage = getEgretStage();
  if (stage && !id.startsWith('egret-db-cache-')) {
    const node = findDisplayById(stage, id);
    if (node && isArmatureDisplay(node)) {
      sceneNode = node;
      armatureName = getArmatureName(node);
      nodePath = node.name || armatureName;
      anims = getAnimations(node);
      source = 'scene';
      log.push(`场景节点 ${nodePath} · armature=${armatureName}`);
    }
  } else if (id.startsWith('egret-db-cache-')) {
    armatureName = id.slice('egret-db-cache-'.length);
    nodePath = '(asset-cache)';
    log.push(`缓存资源 ${armatureName}`);
  } else {
    return {
      ok: false,
      zipName: '',
      files,
      log,
      error: `未找到 DragonBones 节点 ${id}`,
    };
  }

  const baseName = sanitizeFilename(armatureName);
  let hasSkeleton = false;

  // 1) 节点上的 _dragonBonesData（直接对象）
  if (sceneNode) {
    const m = (sceneNode as { _dragonBonesData?: unknown; dragonBonesData?: unknown })
      ._dragonBonesData
      ?? (sceneNode as { dragonBonesData?: unknown }).dragonBonesData;
    if (pushSkeletonData(files, m, `${baseName}_ske.json`, 'application/json')) {
      hasSkeleton = true;
      log.push(`骨架 ${baseName}_ske.json (节点 _dragonBonesData)`);
    }
  }

  // 2) factory._dragonBonesDataMap 全表（含 cache）
  if (factory) {
    const dbMap = factory._dragonBonesDataMap ?? factory.dragonBonesDataMap;
    if (dbMap && typeof dbMap === 'object') {
      for (const key of Object.keys(dbMap)) {
        const entry: DragonBonesDataEntry | undefined = dbMap[key];
        const raw = entry?.rawData ?? entry;
        if (
          pushSkeletonData(
            files,
            raw,
            `${sanitizeFilename(key)}_ske.json`,
            'application/json'
          )
        ) {
          hasSkeleton = true;
          log.push(
            `骨架 ${sanitizeFilename(key)}_ske.json (factory._dragonBonesDataMap)`
          );
        }
      }
    }

    // 3) factory._textureAtlasDataMap → atlas json + 纹理
    const atlasMap = factory._textureAtlasDataMap ?? factory.textureAtlasDataMap;
    if (atlasMap && typeof atlasMap === 'object') {
      for (const key of Object.keys(atlasMap)) {
        const entries = atlasMap[key];
        const list: DragonBonesAtlasEntry[] = Array.isArray(entries)
          ? entries
          : [entries];
        list.forEach((entry, idx) => {
          const raw = entry?.rawData ?? entry?.textureAtlasRawData;
          if (
            pushSkeletonData(
              files,
              raw,
              `${sanitizeFilename(key)}_tex.json`,
              'application/json'
            )
          ) {
            log.push(`Atlas ${sanitizeFilename(key)}_tex.json`);
          }
          const tex = entry?.renderTexture ?? entry?.texture;
          if (tex) {
            exportTexture(files, tex, `${sanitizeFilename(key)}_${idx}`);
            log.push(`纹理 ${sanitizeFilename(key)}_${idx}.png`);
          }
        });
      }
    }
  }

  // 4) runtime_summary
  files.push({
    name: `${baseName}_runtime_summary.json`,
    mime: 'application/json',
    text: runtimeSummaryJson({
      engine: 'Egret',
      kind: 'dragonBones',
      name: baseName,
      nodePath,
      hasSkeletonRaw: hasSkeleton,
      anims,
      source,
    }),
    bytes: 0,
  });

  // 5) JSZip 打包
  const zip = new JSZip();
  const prefix = `${baseName}/`;
  const urlOnly: SkeletonExportFile[] = [];
  for (const f of files) {
    if (f.text != null) {
      zip.file(prefix + f.name, f.text);
    } else if (f.dataBase64 != null) {
      zip.file(prefix + f.name, f.dataBase64, { base64: true });
    } else if (f.url) {
      urlOnly.push(f);
    }
  }
  if (urlOnly.length) {
    const text = urlOnly.map((f) => `${f.url}\t${f.name}`).join('\n');
    zip.file(prefix + '_url_list.txt', text);
    log.push(`URL-only 资源 ${urlOnly.length} 项，已写入 _url_list.txt`);
  }

  const zipBase64 = await zip.generateAsync({ type: 'base64' });
  return {
    ok: hasSkeleton || files.length > 1,
    zipName: `${baseName}_dragonBones.zip`,
    zipBase64,
    files,
    log,
    reason: hasSkeleton
      ? undefined
      : '缺 _ske.json；已尽量导出 atlas/纹理与 runtime_summary',
  };
}
