/**
 * 整场景资源 URL 清单收集（不拉字节，避免内存爆 + egret 主循环卡死）
 *
 * 设计意图：
 *   - 浏览器端只列 URL 清单 → 写入 scene-urls.json
 *   - 外部 Node 脚本读清单 → 批量并发 fetch 落盘
 * 这样把字节拉取从浏览器主线程搬到 Node 进程，不阻塞 egret，可重试、可断点续传。
 *
 * 数据来源：
 *   1) sprites:    listSceneSpriteUrls()           — 所有 Sprite 引用的 PNG CDN URL
 *   2) dragonBones: listDragonBones() + listDragonBonesUrls(id) — 龙骨 ske.json/tex.json/tex.png
 *   3) spines:     listSpines() + 从 skeletonData.textures 取 source URL
 *   4) movieclips: listMovieClips() + 从 mcd.textures[key] 取 source URL（按 key 去重）
 *   5) resources:  collectResourceList()           — RES.config 全量资源 URL
 */
import { getEgretStage, type EgretDisplayObject } from './runtime';
import { getDisplayName } from './sceneTree';
import { listSceneSpriteUrls } from './sceneAssetsExport';
import { listDragonBones, listDragonBonesUrls } from './dragonBonesExport';
import { listSpines, getSpineComp, isSpineNode, type SpineListItem } from './spineExport';
import { listMovieClips } from './movieClipExport';
import { collectResourceList, type EgretResourceList } from './resources';
import { getTextureSourceUrl } from './textureExtract';

export interface AssetUrlItem {
  name: string;
  url: string;
  /** 推荐保存相对路径（相对下载根目录） */
  saveAs?: string;
}

export interface DragonBonesUrlGroup {
  name: string;
  armatureName?: string;
  nodeId?: string;
  urls: AssetUrlItem[];
}

export interface SpineUrlGroup {
  name: string;
  nodeId?: string;
  urls: AssetUrlItem[];
}

export interface MovieClipUrlGroup {
  name: string;
  nodeId?: string;
  frameCount: number;
  urls: AssetUrlItem[];
}

export interface SceneAssetUrls {
  scene: string;
  pageUrl: string;
  exportedAt: string;
  groups: {
    sprites: AssetUrlItem[];
    dragonBones: DragonBonesUrlGroup[];
    spines: SpineUrlGroup[];
    movieclips: MovieClipUrlGroup[];
    resources: EgretResourceList;
  };
  totals: {
    sprites: number;
    dragonBones: number;
    spines: number;
    movieclips: number;
    resources: number;
    totalUrls: number;
  };
}

function sanitize(name: string, fallback: string): string {
  const s = (name || '')
    .replace(/[<>:"/\\|?*\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || fallback;
}

function pickUrlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split('/').pop()?.split('?')[0] || '';
  } catch {
    return url.split('/').pop()?.split('?')[0] || '';
  }
}

/** 按节点 __cocos_id 在显示树里找节点 */
function findNodeById(
  root: EgretDisplayObject,
  id: string
): EgretDisplayObject | null {
  const stack: EgretDisplayObject[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if ((n as unknown as { __cocos_id?: string }).__cocos_id === id) return n;
    const kids = (n as unknown as { $children?: EgretDisplayObject[] }).$children;
    if (Array.isArray(kids)) stack.push(...kids);
  }
  return null;
}

interface SpineDataLike {
  textures?: unknown;
  _textures?: unknown;
}

interface SpineCompLike {
  skeletonData?: SpineDataLike;
  _skeletonData?: SpineDataLike;
  templet?: SpineDataLike;
  _templet?: SpineDataLike;
}

/** 收集 Spine 节点纹理 source URL */
function collectSpineUrls(item: SpineListItem): AssetUrlItem[] {
  const stage = getEgretStage();
  if (!stage) return [];
  const node = findNodeById(stage, item.id);
  if (!node || !isSpineNode(node)) return [];
  const comp = node as unknown as SpineCompLike;
  const data =
    comp.skeletonData ?? comp._skeletonData ?? comp.templet ?? comp._templet;
  if (!data) return [];
  const out: AssetUrlItem[] = [];
  const seen = new Set<string>();
  const texList = (data.textures ?? data._textures) as unknown;
  if (Array.isArray(texList)) {
    texList.forEach((tex, i) => {
      if (!tex) return;
      const u = getTextureSourceUrl(tex as never);
      if (u && !seen.has(u)) {
        seen.add(u);
        const fname = pickUrlPath(u) || `${sanitize(item.name, 'spine')}_${i}.png`;
        out.push({
          name: fname,
          url: u,
          saveAs: `spines/${sanitize(item.name, 'spine')}/${fname}`,
        });
      }
    });
  }
  return out;
}

interface MovieClipDataLike {
  frames?: Array<{ texture?: string }>;
  textures?: Record<string, unknown>;
}

function getMcDataFromNode(node: EgretDisplayObject): MovieClipDataLike | null {
  const n = node as unknown as {
    movieClipData?: MovieClipDataLike;
    _movieClipData?: MovieClipDataLike;
  };
  return n.movieClipData ?? n._movieClipData ?? null;
}

/** 收集 MovieClip 节点所有帧 texture 的 source URL（按 key 去重） */
function collectMovieClipUrls(mcd: MovieClipDataLike | null): AssetUrlItem[] {
  if (!mcd?.frames || !mcd.textures) return [];
  const seen = new Set<string>();
  const out: AssetUrlItem[] = [];
  for (const f of mcd.frames) {
    const key = f?.texture ?? '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const tex = mcd.textures[key];
    if (!tex) continue;
    const u = getTextureSourceUrl(tex as never);
    if (u) {
      out.push({ name: key, url: u });
    }
  }
  return out;
}

/** 统一收集场景所有资源 URL */
export function collectSceneAssetUrls(): SceneAssetUrls {
  const stage = getEgretStage();
  const sceneName = stage ? getDisplayName(stage) : '';
  const pageUrl = typeof window !== 'undefined' ? window.location.href : '';

  // 1) sprites
  const spriteUrls: AssetUrlItem[] = listSceneSpriteUrls().map((s) => {
    const fname = pickUrlPath(s.url) || `${sanitize(s.name, 'sprite')}.png`;
    return { name: s.name, url: s.url, saveAs: `images/${fname}` };
  });

  // 2) dragonBones
  const dragonBones: DragonBonesUrlGroup[] = [];
  for (const item of listDragonBones()) {
    const r = listDragonBonesUrls(item.id);
    if (!r.ok || !r.urls) continue;
    const safe = sanitize(item.name, `db_${item.id}`);
    dragonBones.push({
      name: item.name,
      armatureName: r.armatureName,
      nodeId: item.id,
      urls: r.urls.map((u) => ({
        name: u.name,
        url: u.url,
        saveAs: `dragonbones/${safe}/${u.name}`,
      })),
    });
  }

  // 3) spines
  const spines: SpineUrlGroup[] = [];
  for (const item of listSpines()) {
    const urls = collectSpineUrls(item);
    if (urls.length === 0) continue;
    spines.push({ name: item.name, nodeId: item.id, urls });
  }

  // 4) movieclips
  const movieclips: MovieClipUrlGroup[] = [];
  if (stage) {
    for (const item of listMovieClips()) {
      const node = findNodeById(stage, item.id);
      if (!node) continue;
      const mcd = getMcDataFromNode(node);
      const urls = collectMovieClipUrls(mcd);
      if (urls.length === 0) continue;
      const safe = sanitize(item.name, `mc_${item.id}`);
      movieclips.push({
        name: item.name,
        nodeId: item.id,
        frameCount: item.frameCount,
        urls: urls.map((u) => ({
          name: u.name,
          url: u.url,
          saveAs: `movieclips/${safe}/${u.name}.png`,
        })),
      });
    }
  }

  // 5) resources（RES.config 全量）
  const resources = collectResourceList(2000);

  const totals = {
    sprites: spriteUrls.length,
    dragonBones: dragonBones.reduce((n, g) => n + g.urls.length, 0),
    spines: spines.reduce((n, g) => n + g.urls.length, 0),
    movieclips: movieclips.reduce((n, g) => n + g.urls.length, 0),
    resources: Array.isArray(resources) ? resources.length : 0,
    totalUrls: 0,
  };
  totals.totalUrls =
    totals.sprites + totals.dragonBones + totals.spines + totals.movieclips;

  return {
    scene: sceneName,
    pageUrl,
    exportedAt: new Date().toISOString(),
    groups: { sprites: spriteUrls, dragonBones, spines, movieclips, resources },
    totals,
  };
}
