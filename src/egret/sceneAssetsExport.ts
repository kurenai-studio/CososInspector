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
