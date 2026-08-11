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
import { listSceneSpriteUrls, collectSceneAtlasInfo, type AtlasInfo } from './sceneAssetsExport';
import { listDragonBones, listDragonBonesUrls, getFactory as getDbFactory } from './dragonBonesExport';
import { listSpines, getSpineComp, isSpineNode, type SpineListItem } from './spineExport';
import { listMovieClips } from './movieClipExport';
import { collectResourceList, type EgretResourceList } from './resources';
import { getTextureSourceUrl } from './textureExtract';
import { pushSkeletonData, sanitizeFilename, bytesToBase64, type SkeletonExportFile } from './skeletonCommon';

export interface AssetUrlItem {
  name: string;
  url: string;
  /** 推荐保存相对路径（相对下载根目录） */
  saveAs?: string;
  /**
   * Inline 数据（CDN 上根本没有原文件时的回退）。
   * 当 inlineData 存在时，Node 端应跳过 fetch 直接落盘。
   * rawData 来自 Egret 内存：factory._dragonBonesDataMap[key].rawData / _textureAtlasDataMap[key][i].rawData
   */
  inlineData?: {
    /** text=直接文本写入；base64=二进制（如 .skel/.dbbin）经 base64 编码 */
    kind: 'text' | 'base64';
    mime: string;
    data: string;
    bytes: number;
    /** 来源标记，便于排查 */
    source: 'memory-rawData';
  };
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
    atlases: AtlasInfo[];
    dragonBones: DragonBonesUrlGroup[];
    spines: SpineUrlGroup[];
    movieclips: MovieClipUrlGroup[];
    resources: EgretResourceList;
  };
  totals: {
    sprites: number;
    atlases: number;
    atlasSprites: number;
    dragonBones: number;
    spines: number;
    movieclips: number;
    resources: number;
    totalUrls: number;
  };
  postProcess: {
    /** Sprite 图集裁剪（按 atlas.sprites 区域用 sharp 切单张 png + 输出 Cocos plist + Egret json） */
    spriteAtlas: boolean;
    /** 龙骨工程整理（同名子目录 ske+tex.json+tex.png） */
    dragonBones: boolean;
    /** Spine 工程整理（同名子目录 json/skel+atlas+png） */
    spine: boolean;
    /** MovieClip 重组（序列帧目录 + manifest） */
    movieclip: boolean;
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

/**
 * 把内存 rawData 序列化后挂到 url 项的 inlineData 字段。
 * 复用 pushSkeletonData（等价参考插件 pt()）的三分支逻辑：
 *   string → text inline
 *   ArrayBuffer/TypedArray → base64 inline（.skel/.dbbin）
 *   object 有 skeleton/bones/animations/armature → JSON.stringify text inline
 */
function attachInline(target: AssetUrlItem, raw: unknown, mime: string): boolean {
  const files: SkeletonExportFile[] = [];
  if (!pushSkeletonData(files, raw, target.name, mime)) return false;
  const f = files[0];
  if (!f) return false;
  if (f.text != null) {
    target.inlineData = {
      kind: 'text',
      mime: f.mime,
      data: f.text,
      bytes: f.text.length,
      source: 'memory-rawData',
    };
    // pushSkeletonData 对 ArrayBuffer 会把 name 改成 .skel，同步回 target
    if (f.name && f.name !== target.name) {
      target.name = f.name;
      const safeDir = target.saveAs?.replace(/[^/]+$/, '') || '';
      target.saveAs = safeDir + f.name;
    }
    return true;
  }
  if (f.dataBase64 != null) {
    target.inlineData = {
      kind: 'base64',
      mime: f.mime,
      data: f.dataBase64,
      bytes: f.bytes ?? Math.round(f.dataBase64.length * 0.75),
      source: 'memory-rawData',
    };
    if (f.name && f.name !== target.name) {
      target.name = f.name;
      const safeDir = target.saveAs?.replace(/[^/]+$/, '') || '';
      target.saveAs = safeDir + f.name;
    }
    return true;
  }
  return false;
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

  // 1.5) atlases（图集 + 每 sprite 区域，供 GUI 后处理裁剪）
  const atlases: AtlasInfo[] = collectSceneAtlasInfo().map((a) => ({
    url: a.url,
    filename: a.filename,
    sprites: a.sprites,
  }));

  // 2) dragonBones
  //    URL 清单（listDragonBonesUrls）+ 内存 rawData inline（CDN 上根本没有 ske/tex.json 原文件时的回退）
  //    rawData 来源：factory._dragonBonesDataMap[armatureName].rawData → ske
  //                  factory._textureAtlasDataMap[armatureName][i].rawData → tex.json
  //    完全参考 exportDragonBones 的 step 2/3，但走 inlineData 字段，不打包 zip
  const dbFactory = getDbFactory();
  const dragonBones: DragonBonesUrlGroup[] = [];
  for (const item of listDragonBones()) {
    const r = listDragonBonesUrls(item.id);
    if (!r.ok || !r.urls) continue;
    const safe = sanitize(item.name, `db_${item.id}`);
    const armName = r.armatureName || item.name;
    const urls: AssetUrlItem[] = r.urls.map((u) => ({
      name: u.name,
      url: u.url,
      saveAs: `dragonbones/${safe}/${u.name}`,
    }));

    // 把内存 rawData inline 进对应的 url 项（按 name 匹配 _ske/_tex.json）
    // ske：factory._dragonBonesDataMap[armatureName].rawData
    if (dbFactory) {
      const dbMap =
        dbFactory._dragonBonesDataMap ?? dbFactory.dragonBonesDataMap;
      if (dbMap && typeof dbMap === 'object') {
        const entry = dbMap[armName];
        const raw = (entry as { rawData?: unknown } | undefined)?.rawData ?? entry;
        if (raw != null) {
          const skeFile = urls.find((u) => /_ske[._]/i.test(u.name));
          const target = skeFile ?? (() => {
            // 没找到 URL 项，补一条 inline-only（url 用空串标记）
            const extra: AssetUrlItem = {
              name: `${armName}_ske.json`,
              url: '',
              saveAs: `dragonbones/${safe}/${armName}_ske.json`,
            };
            urls.push(extra);
            return extra;
          })();
          attachInline(target, raw, 'application/json');
        }
      }

      // tex.json：factory._textureAtlasDataMap[armatureName][i].rawData
      const atlasMap =
        dbFactory._textureAtlasDataMap ?? dbFactory.textureAtlasDataMap;
      if (atlasMap && typeof atlasMap === 'object') {
        const entries = atlasMap[armName];
        const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
        list.forEach((entry, idx) => {
          const raw =
            (entry as { rawData?: unknown; textureAtlasRawData?: unknown })
              ?.rawData ??
            (entry as { textureAtlasRawData?: unknown })
              ?.textureAtlasRawData;
          if (raw == null) return;
          const texFile = urls.find((u) => /_tex\.json$/i.test(u.name));
          const target = texFile ?? (() => {
            const extra: AssetUrlItem = {
              name: `${armName}_tex.json`,
              url: '',
              saveAs: `dragonbones/${safe}/${armName}_tex.json`,
            };
            urls.push(extra);
            return extra;
          })();
          attachInline(target, raw, 'application/json');
          // 标 idx（多 atlas 时避免重名）
          if (list.length > 1 && target) {
            target.name = `${armName}_${idx}_tex.json`;
            target.saveAs = `dragonbones/${safe}/${armName}_${idx}_tex.json`;
          }
        });
      }
    }

    dragonBones.push({
      name: item.name,
      armatureName: r.armatureName,
      nodeId: item.id,
      urls,
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
    atlases: atlases.length,
    atlasSprites: atlases.reduce((n, a) => n + a.sprites.length, 0),
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
    groups: { sprites: spriteUrls, atlases, dragonBones, spines, movieclips, resources },
    totals,
    postProcess: {
      spriteAtlas: true,
      dragonBones: true,
      spine: true,
      movieclip: true,
    },
  };
}
