import JSZip from 'jszip';
import { buildNodePath, findNodeById, getNodeId, getSceneRoot } from './sceneTree';
import {
  extractFullTexturePixels,
  type TextureRuntime,
} from './textureExtract';
import { textureResultToPngBlob, triggerBlobDownload } from './texturePng';

type CompRecord = Record<string, unknown>;

export interface SpineExportFileEntry {
  path: string;
  bytes: number;
  method?: string;
  width?: number;
  height?: number;
}

export interface SpineExportResult {
  ok: boolean;
  zipName: string;
  zipBlob?: Blob;
  files: SpineExportFileEntry[];
  log: string[];
  error?: string;
}

const sanitize = (name: string): string =>
  name.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_') || 'spine';

const getComponentName = (comp: unknown): string => {
  const rec = comp as {
    __classname__?: string;
    constructor?: { name?: string };
  };
  return rec.__classname__ ?? rec.constructor?.name ?? 'Component';
};

const isSpineSkeletonComp = (comp: unknown): boolean => {
  const name = getComponentName(comp);
  return /Skeleton/.test(name) && !/SkeletonData/.test(name);
};

const getSpineComponents = (node: cc.Node): unknown[] => {
  const ccg = window.cc as { sp?: { Skeleton?: unknown } };
  const Skeleton = ccg.sp?.Skeleton;
  if (Skeleton && typeof node.getComponent === 'function') {
    try {
      const one = node.getComponent(Skeleton as never);
      if (one) return [one];
    } catch {
      /* ignore */
    }
  }
  const comps = (node as cc.Node & { _components?: unknown[] })._components ?? [];
  return comps.filter(isSpineSkeletonComp);
};

const assetName = (data: CompRecord): string =>
  String(data.name ?? data._name ?? 'skeleton');

const extractAtlasText = (data: CompRecord): string | null => {
  const atlas = data.atlasText ?? data._atlasText;
  if (typeof atlas === 'string' && atlas.length > 0) return atlas;
  return null;
};

const extractSkeletonBlob = (
  data: CompRecord,
  baseName: string
): { path: string; blob: Blob } | null => {
  const jsonStr = data.skeletonJsonStr ?? data._skeletonJsonStr;
  if (typeof jsonStr === 'string' && jsonStr.length > 0) {
    return {
      path: `${baseName}.json`,
      blob: new Blob([jsonStr], { type: 'application/json' }),
    };
  }

  const jsonObj = data.skeletonJson ?? data._skeletonJson;
  if (jsonObj && typeof jsonObj === 'object') {
    if (jsonObj instanceof ArrayBuffer) {
      return {
        path: `${baseName}.skel`,
        blob: new Blob([jsonObj], { type: 'application/octet-stream' }),
      };
    }
    if (ArrayBuffer.isView(jsonObj)) {
      return {
        path: `${baseName}.skel`,
        blob: new Blob([jsonObj], { type: 'application/octet-stream' }),
      };
    }
    const nested = jsonObj as { text?: string; _text?: string; json?: unknown };
    if (typeof nested.text === 'string' || typeof nested._text === 'string') {
      const text = nested.text ?? nested._text ?? '';
      return {
        path: `${baseName}.json`,
        blob: new Blob([text], { type: 'application/json' }),
      };
    }
    try {
      return {
        path: `${baseName}.json`,
        blob: new Blob([JSON.stringify(jsonObj, null, 2)], {
          type: 'application/json',
        }),
      };
    } catch {
      /* fallthrough */
    }
  }

  const native = data._nativeAsset ?? data.nativeAsset;
  if (native instanceof ArrayBuffer) {
    return {
      path: `${baseName}.skel`,
      blob: new Blob([native], { type: 'application/octet-stream' }),
    };
  }
  if (ArrayBuffer.isView(native)) {
    return {
      path: `${baseName}.skel`,
      blob: new Blob([native], { type: 'application/octet-stream' }),
    };
  }

  return null;
};

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** 从 atlas 文本解析各页纹理文件名（与 Spine/Creator 导入一致） */
export const parseAtlasPageNames = (atlasText: string): string[] => {
  const pages: string[] = [];
  const lines = atlasText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const next = lines[i + 1]?.trim() ?? '';
    if (next.startsWith('size:')) {
      pages.push(line);
    }
  }
  return pages;
};

const resolveAtlasTextureFileName = (base: string, index: number): string => {
  const trimmed = base.trim();
  if (!trimmed) return `texture_${index}.png`;
  if (IMAGE_EXT.test(trimmed)) return trimmed;
  return `${trimmed}.png`;
};

const collectTextures = (
  data: CompRecord,
  atlasText: string | null
): Array<{ name: string; texture: TextureRuntime }> => {
  const textures = (data.textures ?? data._textures) as unknown;
  const names = (data.textureNames ?? data._textureNames) as unknown;
  const list: unknown[] = Array.isArray(textures) ? textures : [];
  const nameList: string[] = Array.isArray(names) ? names.map(String) : [];
  const atlasPages = atlasText ? parseAtlasPageNames(atlasText) : [];
  const out: Array<{ name: string; texture: TextureRuntime }> = [];

  list.forEach((tex, i) => {
    if (!tex || typeof tex !== 'object') return;
    const fromRuntime = nameList[i];
    const fromAtlas = atlasPages[i];
    const base = fromRuntime ?? fromAtlas ?? `texture_${i}`;
    out.push({
      name: resolveAtlasTextureFileName(base, i),
      texture: tex as TextureRuntime,
    });
  });

  return out;
};

export const exportSpineFromNode = async (
  nodeId: string,
  spineIndex = 0
): Promise<SpineExportResult> => {
  const log: string[] = [];
  const files: SpineExportFileEntry[] = [];

  try {
    const scene = getSceneRoot();
    if (!scene) {
      return { ok: false, zipName: '', files, log, error: '场景未就绪' };
    }

    const node = findNodeById(scene, nodeId);
    if (!node) {
      return { ok: false, zipName: '', files, log, error: '节点不存在' };
    }

    const spines = getSpineComponents(node);
    if (spines.length === 0) {
      return {
        ok: false,
        zipName: '',
        files,
        log,
        error: '节点无 sp.Skeleton 组件',
      };
    }

    const comp = spines[spineIndex] as CompRecord;
    if (!comp) {
      return { ok: false, zipName: '', files, log, error: 'Spine 组件索引无效' };
    }

    const skeletonData = (comp.skeletonData ?? comp._skeletonData) as
      | CompRecord
      | null
      | undefined;
    if (!skeletonData) {
      return {
        ok: false,
        zipName: '',
        files,
        log,
        error: 'Skeleton 未绑定 skeletonData',
      };
    }

    const nodeName = node.name || 'node';
    const skName = assetName(skeletonData);
    const baseName = sanitize(skName);
    const zipName = `${sanitize(nodeName)}_${baseName}_spine.zip`;
    const zip = new JSZip();
    const prefix = `${baseName}/`;

    log.push(`节点 ${nodeName}(${nodeId}) · SkeletonData ${skName}`);

    const skBlob = extractSkeletonBlob(skeletonData, baseName);
    if (skBlob) {
      const rel = skBlob.path.endsWith('.skel')
        ? `${prefix}${baseName}.skel`
        : `${prefix}${baseName}.json`;
      zip.file(rel, skBlob.blob);
      files.push({ path: rel, bytes: skBlob.blob.size, method: 'runtime' });
      log.push(`骨架 ${rel} (${skBlob.blob.size} B)`);
    } else {
      log.push('警告: 未读取到 skeleton json/skel');
    }

    const atlas = extractAtlasText(skeletonData);
    const atlasPages = atlas ? parseAtlasPageNames(atlas) : [];
    if (atlas) {
      const atlasPath = `${prefix}${baseName}.atlas`;
      zip.file(atlasPath, atlas);
      files.push({ path: atlasPath, bytes: atlas.length, method: 'runtime' });
      log.push(`Atlas ${atlasPath} (${atlas.length} B)`);
      if (atlasPages.length > 0) {
        log.push(`Atlas 纹理页 ${atlasPages.length} 张: ${atlasPages.join(', ')}`);
      }
    } else {
      log.push('警告: 未读取到 atlasText');
    }

    const texList = collectTextures(skeletonData, atlas);
    if (atlasPages.length > 0 && texList.length !== atlasPages.length) {
      log.push(
        `警告: 运行时纹理 ${texList.length} 张，atlas 页 ${atlasPages.length} 张，导入 Creator 请核对文件名`
      );
    }
    log.push(`纹理 ${texList.length} 张，从内存提取 PNG…`);

    for (const { name, texture } of texList) {
      const texW = Math.floor(texture.width ?? 0);
      const texH = Math.floor(texture.height ?? 0);
      const result = await extractFullTexturePixels(texture);
      if (!result) {
        log.push(`失败: ${name} (${texW}×${texH}) 内存提取为空`);
        continue;
      }
      const png = textureResultToPngBlob(result);
      if (!png) {
        log.push(`失败: ${name} 转 PNG 失败`);
        continue;
      }
      const texPath = `${prefix}${name}`;
      zip.file(texPath, png);
      files.push({
        path: texPath,
        bytes: png.size,
        method: result.method,
        width: result.imageData.width,
        height: result.imageData.height,
      });
      log.push(
        `纹理 ${texPath} ${result.imageData.width}×${result.imageData.height} · ${result.method}`
      );
    }

    const compInfo = {
      animation: comp.animation ?? comp.defaultAnimation ?? null,
      defaultSkin: comp.defaultSkin ?? null,
      premultipliedAlpha: comp.premultipliedAlpha ?? null,
      timeScale: comp.timeScale ?? null,
    };

    const manifest = {
      exporter: 'cocos-inspector-spine-v2',
      engineVersion: window.cc?.ENGINE_VERSION ?? '3.x',
      nodeId,
      nodeName,
      skeletonDataName: skName,
      skeletonDataUuid:
        skeletonData.uuid ?? skeletonData._uuid ?? null,
      atlasPages,
      spineComponent: compInfo,
      exportedAt: new Date().toISOString(),
      files,
      log,
      importHint:
        '纹理文件名须与 .atlas 各页名称一致（如 intro.webp、intro.jpg），与 json/atlas 同目录导入 Creator',
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    const readmeLines = [
      'Cocos Inspector — Spine 导出包',
      '',
      '目录结构（解压到 Creator 工程 assets 下任意文件夹）：',
      `  ${baseName}/${baseName}.json`,
      `  ${baseName}/${baseName}.atlas`,
      ...(atlasPages.length > 0
        ? atlasPages.map((p) => `  ${baseName}/${p}`)
        : [`  ${baseName}/<atlas页名>`]),
      '',
      'Creator 导入：',
      '  1. 保持纹理文件名与 .atlas 各页第一行一致（多页如 intro.webp + intro.jpg）',
      '  2. 在资源管理器中 reimport .json',
      '  3. 检查 SkeletonData.textureNames 页数与 atlas 一致',
      '',
      atlasPages.length > 1
        ? `本资源为多页图集（${atlasPages.length} 页），缺页会导致部分 attachment 不显示。`
        : '本资源为单页图集。',
    ];
    zip.file('IMPORT_README.txt', readmeLines.join('\n'));

    if (files.length === 0) {
      return {
        ok: false,
        zipName,
        files,
        log,
        error: '未导出任何文件（检查 skeletonData 与纹理）',
      };
    }

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    console.log(
      `[Spine导出] ${nodeName}(${nodeId}) ${skName} · ${files.length} 文件`
    );

    return { ok: true, zipName, zipBlob, files, log };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Spine导出] exportSpineFromNode 失败', error);
    return { ok: false, zipName: '', files, log, error: msg };
  }
};

export const downloadSpineExport = async (
  nodeId: string,
  spineIndex = 0
): Promise<SpineExportResult> => {
  const result = await exportSpineFromNode(nodeId, spineIndex);
  if (result.ok && result.zipBlob && result.zipName) {
    triggerBlobDownload(result.zipBlob, result.zipName);
  }
  return result;
};

export const nodeHasSpine = (nodeId: string): boolean => {
  const scene = getSceneRoot();
  if (!scene) return false;
  const node = findNodeById(scene, nodeId);
  if (!node) return false;
  return getSpineComponents(node).length > 0;
};

export interface SpineListItem {
  id: string;
  name: string;
  path: string;
  skeletonName: string;
  animation: string;
  searchText: string;
}

/** 扁平收集场景中所有 Spine 节点 */
export const collectSpineList = (scene: cc.Node): SpineListItem[] => {
  const items: SpineListItem[] = [];
  const walk = (node: cc.Node): void => {
    const spines = getSpineComponents(node);
    if (spines.length > 0) {
      const id = getNodeId(node);
      const path = buildNodePath(scene, id);
      const comp = spines[0] as Record<string, unknown>;
      const data = (comp.skeletonData ?? comp._skeletonData) as
        | { name?: string; _name?: string }
        | null
        | undefined;
      const skeletonName = String(data?.name ?? data?._name ?? '');
      const animation = String(
        comp.animation ?? comp.defaultAnimation ?? ''
      );
      items.push({
        id,
        name: node.name || '(unnamed)',
        path,
        skeletonName,
        animation,
        searchText: `${node.name} ${path} ${skeletonName}`.toLowerCase(),
      });
    }
    const children = [...(node.children ?? [])]
      .filter(Boolean)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const child of children) walk(child);
  };
  walk(scene);
  return items;
};
