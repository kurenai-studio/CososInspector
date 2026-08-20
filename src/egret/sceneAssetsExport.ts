/**
 * Egret 场景资源批量打包导出
 * 扫描场景所有 Sprite + DragonBones + Spine 节点 → 收集引用 → JSZip
 */
import JSZip from 'jszip';
import { getEgretStage, type EgretDisplayObject } from './runtime';
import { walkDisplayTree, getDisplayId, getDisplayName } from './sceneTree';
import { getNodeTexture, getTextureSourceUrl, extractWholeSourceToPng } from './textureExtract';
import { exportDragonBones, listDragonBones } from './dragonBonesExport';
import { exportSpine, listSpines } from './spineExport';
import type { SkeletonExportFile, SkeletonExportResult } from './skeletonCommon';

interface CollectedSprite {
  nodeId: string;
  name: string;
  url: string | null;
}

/** 遍历场景收集所有带纹理的 Sprite 节点（按 URL 去重） */
function collectSceneSprites(): CollectedSprite[] {
  const stage = getEgretStage();
  if (!stage) return [];
  const out: CollectedSprite[] = [];
  const seen = new Set<string>();
  walkDisplayTree(stage, (node) => {
    const tex = getNodeTexture(node);
    if (!tex) return;
    const url = getTextureSourceUrl(tex);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({
      nodeId: getDisplayId(node),
      name: getDisplayName(node),
      url,
    });
  });
  return out;
}

/** 公开 API：列出场景所有 Sprite 引用的 CDN URL（按 URL 去重） */
export function listSceneSpriteUrls(): { name: string; url: string }[] {
  return collectSceneSprites()
    .filter((s): s is CollectedSprite & { url: string } => !!s.url)
    .map((s) => ({
      name: urlToFilename(s.url, `${s.nodeId}.png`),
      url: s.url,
    }));
}

/** 图集中单个 sprite 区域 */
export interface AtlasSpriteRect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 是否旋转（Egret 部分图集支持旋转 90°，未启用检测） */
  rotated?: boolean;
  /** 该 sprite 所属节点 ID（便于追溯） */
  nodeId: string;
}

/** 一个图集的所有 sprite 区域 */
export interface AtlasInfo {
  /** 图集原图 CDN URL */
  url: string;
  /** 图集文件名（去 query） */
  filename: string;
  /** 该图集下所有 sprite 区域 */
  sprites: AtlasSpriteRect[];
}

/**
 * 收集场景所有图集 + 每个图集下的 sprite 区域。
 * 数据直接从 Egret 引擎内存拿（texture.$bitmapX/Y/W/H + $bitmapData.$source.src），
 * 不依赖 atlas json 文件。
 *
 * 一个图集原图 URL 对应多个 sprite（Bitmap 节点）。同一图集下的 sprite 被分组到一起。
 */
export function collectSceneAtlasInfo(): AtlasInfo[] {
  const stage = getEgretStage();
  if (!stage) return [];
  const byUrl = new Map<string, AtlasInfo>();
  const seen = new Set<string>(); // 按 url+sprite 区域去重
  walkDisplayTree(stage, (node) => {
    const tex = getNodeTexture(node);
    if (!tex) return;
    const url = getTextureSourceUrl(tex);
    if (!url) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyTex = tex as any;
    const x = Number(anyTex.$bitmapX ?? 0);
    const y = Number(anyTex.$bitmapY ?? 0);
    const w = Number(anyTex.$bitmapWidth ?? anyTex.textureWidth ?? 0);
    const h = Number(anyTex.$bitmapHeight ?? anyTex.textureHeight ?? 0);
    if (w <= 0 || h <= 0) return;
    const key = `${url}|${x},${y},${w}x${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    let info = byUrl.get(url);
    if (!info) {
      info = { url, filename: urlToFilename(url, 'atlas.png'), sprites: [] };
      byUrl.set(url, info);
    }
    const name = getDisplayName(node) || String(node.name || `sprite_${info.sprites.length}`);
    info.sprites.push({
      name,
      x, y, w, h,
      nodeId: getDisplayId(node),
    });
  });
  return Array.from(byUrl.values());
}

/**
 * 收集指定子树所有图集 + 每个图集下的 sprite 区域。
 * 与 collectSceneAtlasInfo 同样逻辑，但仅遍历以 root 为根的子树（不含 root 之外的节点）。
 */
export function collectSubtreeAtlasInfo(root: EgretDisplayObject): AtlasInfo[] {
  const byUrl = new Map<string, AtlasInfo>();
  const seen = new Set<string>();
  walkDisplayTree(root, (node) => {
    const tex = getNodeTexture(node);
    if (!tex) return;
    const url = getTextureSourceUrl(tex);
    if (!url) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyTex = tex as any;
    const x = Number(anyTex.$bitmapX ?? 0);
    const y = Number(anyTex.$bitmapY ?? 0);
    const w = Number(anyTex.$bitmapWidth ?? anyTex.textureWidth ?? 0);
    const h = Number(anyTex.$bitmapHeight ?? anyTex.textureHeight ?? 0);
    if (w <= 0 || h <= 0) return;
    const key = `${url}|${x},${y},${w}x${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    let info = byUrl.get(url);
    if (!info) {
      info = { url, filename: urlToFilename(url, 'atlas.png'), sprites: [] };
      byUrl.set(url, info);
    }
    const name = getDisplayName(node) || String(node.name || `sprite_${info.sprites.length}`);
    info.sprites.push({
      name, x, y, w, h,
      nodeId: getDisplayId(node),
    });
  });
  return Array.from(byUrl.values());
}

/** 把 URL 转成相对路径文件名（去 query/hash） */
function urlToFilename(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop();
    if (last) return decodeURIComponent(last);
  } catch {
    /* ignore */
  }
  return fallback;
}

/** 单个图片资源：fetch 拿字节 → base64 */
async function fetchImageToBase64(url: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
      out += String.fromCharCode.apply(null, slice as unknown as number[]);
    }
    const mime = res.headers.get('content-type') || 'image/png';
    return { base64: btoa(out), mime };
  } catch {
    return null;
  }
}

/** 按 nodeId 反查节点 */
function findNodeByIdFromStage(stage: EgretDisplayObject, id: string): EgretDisplayObject | null {
  let hit: EgretDisplayObject | null = null;
  walkDisplayTree(stage, (n) => {
    if (hit) return;
    if (getDisplayId(n) === id) hit = n;
  });
  return hit;
}

/**
 * 导出当前场景用到的所有图片和龙骨为 zip
 *   - 图片：场景 Sprite 节点引用的纹理源 URL，fetch 原始字节
 *   - 龙骨：listDragonBones() 每项调 exportDragonBones() 得子 zip，合并到主 zip 子目录
 *   - Spine：listSpines() 每项调 exportSpine() 同理
 */
export async function exportSceneAssets(): Promise<SkeletonExportResult> {
  const log: string[] = [];
  const files: SkeletonExportFile[] = [];
  const stage = getEgretStage();
  if (!stage) {
    return { ok: false, zipName: '', files, log, error: 'stage 未就绪' };
  }

  // 1) 图片
  const sprites = collectSceneSprites();
  log.push(`场景 Sprite ${sprites.length} 项`);
  for (const s of sprites) {
    if (!s.url) continue;
    const fetched = await fetchImageToBase64(s.url);
    if (fetched) {
      const fname = `images/${urlToFilename(s.url, `${s.nodeId}.png`)}`;
      files.push({
        name: fname,
        mime: fetched.mime,
        dataBase64: fetched.base64,
        bytes: Math.round(fetched.base64.length * 0.75),
      });
      log.push(`图片 ${fname}`);
      continue;
    }
    // fetch 失败：从节点回退整图导出
    const node = findNodeByIdFromStage(stage, s.nodeId);
    if (node) {
      const tex = getNodeTexture(node);
      if (tex) {
        const whole = extractWholeSourceToPng(tex);
        if (whole.ok) {
          const fname = `images/${s.nodeId}_${urlToFilename(s.url, 'fallback.png')}`;
          files.push({
            name: fname,
            mime: 'image/png',
            dataBase64: whole.base64,
            bytes: Math.round(whole.base64.length * 0.75),
          });
          log.push(`图片(回退) ${fname}`);
        }
      }
    }
  }

  // 2) DragonBones：每个调 exportDragonBones 得 zipBase64 → 作为子 zip 嵌入
  const dbList = listDragonBones();
  log.push(`DragonBones ${dbList.length} 项`);
  for (const item of dbList) {
    const r = await exportDragonBones(item.id);
    if (r.ok && r.zipBase64) {
      files.push({
        name: `dragonbones/${item.name}.zip`,
        mime: 'application/zip',
        dataBase64: r.zipBase64,
        bytes: Math.round(r.zipBase64.length * 0.75),
      });
      log.push(`DragonBones ${item.name} (子 zip)`);
    } else if (r.error) {
      log.push(`DragonBones ${item.name} 失败: ${r.error}`);
    } else if (r.reason) {
      log.push(`DragonBones ${item.name} 部分缺失: ${r.reason}`);
    }
  }

  // 3) Spine：同上
  const spList = listSpines();
  log.push(`Spine ${spList.length} 项`);
  for (const item of spList) {
    const r = await exportSpine(item.id);
    if (r.ok && r.zipBase64) {
      files.push({
        name: `spines/${item.name}.zip`,
        mime: 'application/zip',
        dataBase64: r.zipBase64,
        bytes: Math.round(r.zipBase64.length * 0.75),
      });
      log.push(`Spine ${item.name} (子 zip)`);
    } else if (r.error) {
      log.push(`Spine ${item.name} 失败: ${r.error}`);
    }
  }

  // 4) runtime_summary
  files.push({
    name: 'runtime_summary.json',
    mime: 'application/json',
    text: JSON.stringify(
      {
        note: '运行时场景资源快照：非原始工程文件，仅供对照',
        engine: 'Egret',
        stage: getDisplayName(stage),
        spriteCount: sprites.length,
        dragonBonesCount: dbList.length,
        spineCount: spList.length,
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    bytes: 0,
  });

  // 5) 打包
  const zip = new JSZip();
  for (const f of files) {
    if (f.text != null) zip.file(f.name, f.text);
    else if (f.dataBase64 != null) zip.file(f.name, f.dataBase64, { base64: true });
  }
  const zipBase64 = await zip.generateAsync({ type: 'base64' });

  return {
    ok: files.length > 0,
    zipName: `scene_assets_${Date.now()}.zip`,
    zipBase64,
    files,
    log,
    reason: files.length === 0 ? '场景无可用资源' : undefined,
  };
}
