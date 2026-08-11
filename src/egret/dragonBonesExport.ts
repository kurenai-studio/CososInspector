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
import { collectResourceList } from './resources';
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

export function getFactory(): DragonBonesFactoryLike | null {
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

export interface DragonBonesUrlItem {
  name: string;
  url: string;
  /** 简单类型标识：ske/tex.json/tex.png/other，便于面板显示 */
  kind: 'ske' | 'tex-json' | 'tex-png' | 'other';
}

/**
 * 列出指定 DragonBones 节点/缓存引用的所有 CDN URL。
 * 不调任何导出函数（不会触发 canvas 提取、不会爆 WebSocket）：
 *   - tex.png URL：从 factory._textureAtlasDataMap[key].renderTexture 用 getTextureSourceUrl 拿
 *   - ske/tex.json URL：在 collectResourceList 里按 armatureName 前缀匹配 alias
 */
export function listDragonBonesUrls(id: string): {
  ok: boolean;
  urls?: DragonBonesUrlItem[];
  armatureName?: string;
  error?: string;
} {
  const factory = getFactory();
  if (!factory) {
    return { ok: false, error: '未找到 dragonBones.EgretFactory' };
  }

  // 1) 找到 armatureName（场景节点 → getArmatureName；cache → key）
  let armatureName = '';
  let sceneNode: EgretDisplayObject | null = null;
  if (id.startsWith('egret-db-cache-')) {
    armatureName = id.slice('egret-db-cache-'.length);
  } else {
    const stage = getEgretStage();
    if (stage) {
      const node = findDisplayById(stage, id);
      if (node && isArmatureDisplay(node)) {
        sceneNode = node;
        armatureName = getArmatureName(node);
      }
    }
    if (!armatureName) {
      return { ok: false, error: `未找到 DragonBones 节点 ${id}` };
    }
  }

  const urls: DragonBonesUrlItem[] = [];
  const seen = new Set<string>();

  // 2) tex.png URL：从 _textureAtlasDataMap 找 armatureName 对应的 renderTexture
  const atlasMap = factory._textureAtlasDataMap ?? factory.textureAtlasDataMap;
  if (atlasMap && typeof atlasMap === 'object') {
    const entries = atlasMap[armatureName];
    const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
    list.forEach((entry, idx) => {
      const tex = entry?.renderTexture ?? entry?.texture;
      if (!tex) return;
      const u = getTextureSourceUrl(tex as never);
      if (u && !seen.has(u)) {
        seen.add(u);
        const suffix = list.length > 1 ? `_${idx}` : '';
        urls.push({ name: `${armatureName}${suffix}.png`, url: u, kind: 'tex-png' });
      }
    });
  }

  // 3) ske/tex.json URL：在 collectResourceList 的 alias 里严格前缀匹配
  //    只接受 _ske / _tex 后缀的项，过滤 mp3/csv/png 等非龙骨文件
  const resList = collectResourceList(2000);
  if (resList.ok && resList.items) {
    const needle = armatureName.toLowerCase();
    // 严格前缀匹配：alias 必须以 armatureName + _ 开头，避免 'open' 命中 mp3/csv
    const prefixRe = new RegExp('^' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[_.]');
    for (const it of resList.items) {
      const alias = (it.name || '').toLowerCase();
      if (!prefixRe.test(alias)) continue;
      // 只接受 _ske 或 _tex 后缀，其它（mp3/csv/png 等）一律过滤
      const isSke = /_ske[_.]/.test(alias) || /_skel[_.]/.test(alias);
      const isTexJson = /_tex[_.]json/.test(alias);
      const isTexPng = /_tex[_.]png/.test(alias);
      if (!isSke && !isTexJson && !isTexPng) continue;
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      const kind: DragonBonesUrlItem['kind'] = isSke ? 'ske' : isTexJson ? 'tex-json' : 'tex-png';
      // tex.png 已在 step 2 从 atlas renderTexture 拿到（运行时实际加载的 webp URL，
      // 比这里的 png URL 更可靠），跳过避免重复且 404
      if (kind === 'tex-png') continue;
      // 文件名：alias → 标准 ske/tex 命名
      let fname = it.name;
      if (kind === 'ske') fname = `${armatureName}_ske${/\.json$/i.test(it.name) ? '.json' : '.dbbin'}`;
      else if (kind === 'tex-json') fname = `${armatureName}_tex.json`;
      urls.push({ name: fname, url: it.url, kind });
    }
  }

  // 4) 去重：tex.png 可能在 step 2 和 step 3 都拿到，已 by url 去重
  return { ok: true, urls, armatureName };
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
