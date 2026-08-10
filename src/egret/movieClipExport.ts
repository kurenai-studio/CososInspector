/**
 * Egret MovieClip 序列帧导出
 *
 * 内存结构（基于 Egret 5.x）：
 *   node (egret.MovieClip)
 *     └─ node.movieClipData : egret.MovieClipData
 *          ├─ frames[i].texture : string  (subimage key)
 *          ├─ frames[i].x / .y
 *          └─ textures[key] : egret.Texture  (按 key 索引的纹理表)
 *
 * 同一 MovieClipData 可含多个动画（walk/run/idle），但运行时只持当前一份 frames。
 * 完整动画清单需从原始 JSON 的 mc 字段取；本模块只导出当前激活的 frames。
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
  getNodeTexture,
} from './textureExtract';
import {
  runtimeSummaryJson,
  sanitizeFilename,
  type SkeletonExportFile,
  type SkeletonExportResult,
} from './skeletonCommon';

export interface MovieClipListItem {
  id: string;
  name: string;
  kind: 'movieclip';
  nodePath: string;
  frameCount: number;
  textureCount: number;
  anims: string[];
  exportable: boolean;
  source: 'scene';
}

function isMovieClipNode(node: EgretDisplayObject): boolean {
  const egret = window.egret;
  if (egret?.MovieClip) {
    try {
      if (node instanceof (egret.MovieClip as never)) return true;
    } catch {
      /* ignore */
    }
  }
  const ctor = node.constructor?.name || '';
  return /MovieClip/i.test(ctor);
}

function getMovieClipData(node: EgretDisplayObject): MovieClipDataLike | null {
  if (!node) return null;
  const n = node as unknown as { movieClipData?: MovieClipDataLike; _movieClipData?: MovieClipDataLike };
  return n.movieClipData ?? n._movieClipData ?? null;
}

export function _getMovieClipDataForTest(node: unknown): MovieClipDataLike | null {
  return getMovieClipData(node as EgretDisplayObject);
}

interface MovieClipDataLike {
  frames?: MovieClipFrameLike[];
  textures?: Record<string, unknown>;
  mcData?: { labels?: Record<string, unknown>; frameRate?: number };
  frameRate?: number;
  name?: string;
}

interface MovieClipFrameLike {
  texture?: string;
  x?: number;
  y?: number;
}

function getAnimsFromMcData(data: MovieClipDataLike | null): string[] {
  if (!data) return [];
  const labels = data.mcData?.labels;
  if (labels && typeof labels === 'object') {
    return Object.keys(labels).filter(Boolean);
  }
  return [];
}

export function _getAnimsFromMcDataForTest(data: unknown): string[] {
  return getAnimsFromMcData((data as MovieClipDataLike) ?? null);
}

/** 从 frames 数组提取去重后的 texture key 序列 + offset 信息（纯逻辑，便于单测） */
export function _buildFrameManifestForTest(
  frames: MovieClipFrameLike[] | undefined
): Array<{ frame: number; textureKey: string | null; x: number; y: number }> {
  if (!frames || frames.length === 0) return [];
  return frames.map((f, i) => ({
    frame: i,
    textureKey: f?.texture ?? null,
    x: Number(f?.x ?? 0),
    y: Number(f?.y ?? 0),
  }));
}

/** 按 texture key 去重，返回首次出现的 key 序列（用于决定哪些帧需要导出 PNG） */
export function _uniqueTextureKeysForTest(
  frames: MovieClipFrameLike[] | undefined
): string[] {
  if (!frames) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of frames) {
    const k = f?.texture ?? '';
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/** 列出场景所有 MovieClip 节点 */
export function listMovieClips(): MovieClipListItem[] {
  const stage = getEgretStage();
  if (!stage) return [];
  const out: MovieClipListItem[] = [];
  walkDisplayTree(stage, (node) => {
    if (!isMovieClipNode(node)) return;
    const data = getMovieClipData(node);
    const frameCount = data?.frames?.length ?? 0;
    const textureCount = data?.textures ? Object.keys(data.textures).length : 0;
    const id = getDisplayId(node);
    const name = String(node.name || `movieclip_${id}`);
    out.push({
      id,
      name,
      kind: 'movieclip',
      nodePath: buildNodePath(stage, id),
      frameCount,
      textureCount,
      anims: getAnimsFromMcData(data),
      exportable: frameCount > 0,
      source: 'scene',
    });
  });
  return out;
}

/**
 * 导出指定 MovieClip 节点的所有帧为 zip（base64 inline）
 *   - 每帧 textures[key] → extractWholeSourceToPng → {name}_{frameIndex}.png
 *   - 同 texture 的多帧只导一次（按 key 去重）
 *   - 同时输出 manifest.json（帧序号 → texture key + offset）
 *   - runtime_summary.json
 */
export async function exportMovieClip(
  id: string
): Promise<SkeletonExportResult> {
  const log: string[] = [];
  const files: SkeletonExportFile[] = [];
  const stage = getEgretStage();
  if (!stage) return { ok: false, zipName: '', files, log, error: 'stage 未就绪' };
  const node = findDisplayById(stage, id);
  if (!node || !isMovieClipNode(node)) {
    return { ok: false, zipName: '', files, log, error: `未找到 MovieClip 节点 ${id}` };
  }
  const data = getMovieClipData(node);
  if (!data || !data.frames || data.frames.length === 0) {
    return { ok: false, zipName: '', files, log, error: '节点无 movieClipData 或 frames 为空' };
  }

  const baseName = sanitizeFilename(String(node.name || `movieclip_${id}`));
  const frames = data.frames;
  const textures = data.textures ?? {};
  log.push(`MovieClip ${baseName} · ${frames.length} 帧 · ${Object.keys(textures).length} 纹理`);

  // 1) 逐帧导出 PNG（按 texture key 去重，同一图集区域不重复导）
  const seenTextureKey = new Set<string>();
  let frameDone = 0;
  const manifest: Array<{ frame: number; textureKey: string | null; x: number; y: number; pngFile: string | null }> = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const key = f?.texture ?? '';
    const offX = Number(f?.x ?? 0);
    const offY = Number(f?.y ?? 0);
    let pngFile: string | null = null;
    if (key && !seenTextureKey.has(key)) {
      seenTextureKey.add(key);
      const tex = textures[key];
      if (tex) {
        const whole = extractWholeSourceToPng(tex as never);
        if (whole.ok) {
          pngFile = `${baseName}_${key}.png`;
          files.push({
            name: pngFile,
            mime: 'image/png',
            dataBase64: whole.base64,
            bytes: Math.round(whole.base64.length * 0.75),
          });
          log.push(`帧 ${i} → ${pngFile}`);
        } else {
          const url = getTextureSourceUrl(tex as never);
          if (url) {
            pngFile = `${baseName}_${key}.png`;
            files.push({ name: pngFile, mime: 'image/png', url });
            log.push(`帧 ${i} → ${pngFile} (URL fallback)`);
          } else {
            log.push(`帧 ${i} 纹理 ${key} 提取失败`);
          }
        }
      }
    } else if (key && seenTextureKey.has(key)) {
      // 复用之前导出的 png 文件名
      pngFile = `${baseName}_${key}.png`;
    }
    manifest.push({ frame: i, textureKey: key || null, x: offX, y: offY, pngFile });
    frameDone++;
  }

  // 2) manifest.json（帧序号 → texture key + offset + pngFile）
  files.push({
    name: `${baseName}_manifest.json`,
    mime: 'application/json',
    text: JSON.stringify({
      movieclip: baseName,
      frameCount: frames.length,
      textureCount: Object.keys(textures).length,
      anims: getAnimsFromMcData(data),
      frameRate: data.frameRate ?? data.mcData?.frameRate ?? 0,
      frames: manifest,
    }, null, 2),
    bytes: 0,
  });
  log.push(`manifest: ${frames.length} 帧清单`);

  // 3) runtime_summary.json
  files.push({
    name: `${baseName}_runtime_summary.json`,
    mime: 'application/json',
    text: runtimeSummaryJson({
      engine: 'Egret',
      kind: 'spine' as const,  // 复用 SkeletonExportResult 类型，标记为 movieclip
      name: baseName,
      hasSkeletonRaw: true,
      anims: getAnimsFromMcData(data),
      note: 'MovieClip 序列帧：每帧 PNG + manifest 帧清单',
    }),
    bytes: 0,
  });

  // 4) JSZip 打包（沿用 SkeletonExportResult 接口，便于复用 writeSkeletonFilesToDir）
  const zip = new JSZip();
  const prefix = `${baseName}/`;
  const urlOnly: SkeletonExportFile[] = [];
  for (const f of files) {
    if (f.text != null) zip.file(prefix + f.name, f.text);
    else if (f.dataBase64 != null) zip.file(prefix + f.name, f.dataBase64, { base64: true });
    else if (f.url) urlOnly.push(f);
  }
  if (urlOnly.length) {
    const text = urlOnly.map((f) => `${f.url}\t${f.name}`).join('\n');
    zip.file(prefix + '_url_list.txt', text);
  }

  const zipBase64 = await zip.generateAsync({ type: 'base64' });
  return {
    ok: frameDone > 0,
    zipName: `${baseName}_movieclip.zip`,
    zipBase64,
    files,
    log,
    reason: frameDone === 0 ? '无可用帧' : undefined,
  };
}
