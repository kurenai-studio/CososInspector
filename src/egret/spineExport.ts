/**
 * Egret Spine 内存导出（简化版）
 *
 * 本游戏（bydrqp 捕鱼）使用 DragonBones，但 Egret 5.x 仍可能加载
 * spine（window.spine / window.sp）。本模块覆盖 sp.SkeletonAnimation /
 * SkeletonRenderer 节点，从 skeletonData 取 skeletonJsonStr/_nativeAsset
 * /atlasText/textures。
 *
 * 参考 inspector.js 的 xe/Ee/le/ce 函数。
 */
import JSZip from 'jszip';
import { getEgretStage, type EgretDisplayObject } from './runtime';
import {
  buildNodePath,
  findDisplayById,
  getDisplayId,
  walkDisplayTree,
} from './sceneTree';
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

export interface SpineListItem {
  id: string;
  name: string;
  kind: 'spine';
  nodePath: string;
  anims: string[];
  exportable: boolean;
  source: 'scene';
}

interface SpineCompLike {
  skeletonData?: SkeletonDataLike;
  _skeletonData?: SkeletonDataLike;
  templet?: SkeletonDataLike;
  _templet?: SkeletonDataLike;
  source?: string;
  _source?: string;
}

interface SkeletonDataLike {
  name?: string;
  skeletonJsonStr?: string;
  _skeletonJsonStr?: string;
  skeletonJson?: unknown;
  _skeletonJson?: unknown;
  _nativeAsset?: ArrayBuffer | Uint8Array | string;
  nativeAsset?: ArrayBuffer | Uint8Array | string;
  nativeUrl?: string;
  _nativeUrl?: string;
  atlasText?: string;
  _atlasText?: string;
  textures?: unknown[];
  _textures?: unknown[];
  textureNames?: string[];
  _textureNames?: string[];
}

function isSpineNode(node: EgretDisplayObject): boolean {
  const sp = window.spine;
  if (!sp) return false;
  try {
    if (sp.SkeletonAnimation && node instanceof (sp.SkeletonAnimation as never)) return true;
    if (sp.SkeletonRenderer && node instanceof (sp.SkeletonRenderer as never)) return true;
  } catch {
    /* ignore */
  }
  const ctor = node.constructor?.name || '';
  return /SkeletonAnimation|SkeletonRenderer|SpineAnimation/i.test(ctor);
}

function getSpineComp(node: EgretDisplayObject): SpineCompLike | null {
  const n = node as unknown as SpineCompLike;
  if (n.skeletonData || n._skeletonData) return n;
  if (n.templet || n._templet) return n;
  return null;
}

function getAnims(data: SkeletonDataLike | undefined): string[] {
  if (!data) return [];
  const sj = (data.skeletonJson ?? data._skeletonJson) as
    | { animations?: Record<string, unknown> }
    | null
    | undefined;
  if (sj?.animations && typeof sj.animations === 'object') {
    return Object.keys(sj.animations);
  }
  return [];
}

export function listSpines(): SpineListItem[] {
  const stage = getEgretStage();
  if (!stage) return [];
  const out: SpineListItem[] = [];
  walkDisplayTree(stage, (node) => {
    if (!isSpineNode(node)) return;
    const comp = getSpineComp(node);
    const data =
      comp?.skeletonData ?? comp?._skeletonData ?? comp?.templet ?? comp?._templet;
    const name = String(data?.name || node.name || 'spine');
    const id = getDisplayId(node);
    out.push({
      id,
      name,
      kind: 'spine',
      nodePath: buildNodePath(stage, id),
      anims: getAnims(data),
      exportable: !!data,
      source: 'scene',
    });
  });
  return out;
}

export async function exportSpine(
  id: string
): Promise<SkeletonExportResult> {
  const log: string[] = [];
  const files: SkeletonExportFile[] = [];
  const stage = getEgretStage();
  if (!stage) return { ok: false, zipName: '', files, log, error: 'stage 未就绪' };
  const node = findDisplayById(stage, id);
  if (!node || !isSpineNode(node)) {
    return { ok: false, zipName: '', files, log, error: `未找到 Spine 节点 ${id}` };
  }
  const comp = getSpineComp(node);
  const data =
    comp?.skeletonData ?? comp?._skeletonData ?? comp?.templet ?? comp?._templet;
  if (!data) {
    return { ok: false, zipName: '', files, log, error: '节点无 skeletonData' };
  }
  const baseName = sanitizeFilename(String(data.name || node.name || 'spine'));
  let hasSkeleton = false;

  if (
    pushSkeletonData(
      files,
      data.skeletonJsonStr ?? data._skeletonJsonStr,
      `${baseName}.json`,
      'application/json'
    )
  ) {
    hasSkeleton = true;
    log.push(`骨架 ${baseName}.json (skeletonJsonStr)`);
  } else if (
    pushSkeletonData(
      files,
      data.skeletonJson ?? data._skeletonJson,
      `${baseName}.json`,
      'application/json'
    )
  ) {
    hasSkeleton = true;
    log.push(`骨架 ${baseName}.json (skeletonJson)`);
  } else if (
    pushSkeletonData(
      files,
      data._nativeAsset ?? data.nativeAsset,
      `${baseName}.skel`,
      'application/octet-stream'
    )
  ) {
    hasSkeleton = true;
    log.push(`骨架 ${baseName}.skel (_nativeAsset)`);
  }

  const atlas = data.atlasText ?? data._atlasText;
  if (typeof atlas === 'string' && atlas.length > 0) {
    files.push({
      name: `${baseName}.atlas`,
      mime: 'text/plain',
      text: atlas,
      bytes: atlas.length,
    });
    log.push(`Atlas ${baseName}.atlas`);
  }

  const texList = (data.textures ?? data._textures) as unknown;
  if (Array.isArray(texList)) {
    texList.forEach((tex, i) => {
      if (!tex) return;
      const whole = extractWholeSourceToPng(tex as never);
      if (whole.ok) {
        files.push({
          name: `${baseName}_${i}.png`,
          mime: 'image/png',
          dataBase64: whole.base64,
          bytes: Math.round(whole.base64.length * 0.75),
        });
        log.push(`纹理 ${baseName}_${i}.png`);
      } else {
        const url = getTextureSourceUrl(tex as never);
        if (url) {
          files.push({ name: `${baseName}_${i}.png`, mime: 'image/png', url });
        }
      }
    });
  }

  files.push({
    name: `${baseName}_runtime_summary.json`,
    mime: 'application/json',
    text: runtimeSummaryJson({
      engine: 'Egret',
      kind: 'spine',
      name: baseName,
      hasSkeletonRaw: hasSkeleton,
      anims: getAnims(data),
    }),
    bytes: 0,
  });

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
  }

  const zipBase64 = await zip.generateAsync({ type: 'base64' });
  return {
    ok: hasSkeleton || files.length > 1,
    zipName: `${baseName}_spine.zip`,
    zipBase64,
    files,
    log,
    reason: hasSkeleton
      ? undefined
      : '缺 .json/.skel；已尽量导出 atlas/纹理与 runtime_summary',
  };
}
