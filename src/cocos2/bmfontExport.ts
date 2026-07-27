import JSZip from 'jszip';
import { findNodeById, getNodeName, getSceneRoot, getNodeId, getNodeChildren, type Cc2Node } from './sceneTree';
import { extractFullTexturePixels2x } from './spriteExtract';
import {
  imageDataToPngBlob,
  triggerBlobDownload,
} from '../cocos3/texturePng';
import { buildNodePath } from './sceneSnapshot';

type CompRecord = Record<string, unknown>;

export interface BmfontExportFileEntry {
  path: string;
  bytes: number;
  method?: string;
  width?: number;
  height?: number;
}

export interface BmfontExportResult {
  ok: boolean;
  zipName: string;
  zipBlob?: Blob;
  files: BmfontExportFileEntry[];
  log: string[];
  error?: string;
}

interface FontDef {
  rect?: { x?: number; y?: number; width?: number; height?: number };
  xOffset?: number;
  yOffset?: number;
  xAdvance?: number;
}

interface FntConfig {
  fontSize?: number;
  commonHeight?: number;
  atlasName?: string;
  fontDefDictionary?: Record<string, FontDef>;
  kerningDict?: Record<string, number>;
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

const sanitize = (name: string): string =>
  name.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_') || 'bmfont';

const getComponentName = (comp: unknown): string => {
  const rec = comp as {
    __classname__?: string;
    constructor?: { name?: string };
  };
  return rec.__classname__ ?? rec.constructor?.name ?? 'Component';
};

const isLabelComp = (comp: unknown): boolean => {
  const name = getComponentName(comp);
  return /Label/.test(name) && !/RichText/.test(name);
};

const getFontClass = (font: CompRecord | null | undefined): string =>
  font
    ? String(
        (font as { __classname__?: string }).__classname__ ??
          (font as { constructor?: { name?: string } }).constructor?.name ??
          ''
      )
    : '';

const getFntConfig = (
  font: CompRecord | null | undefined
): FntConfig | null => {
  const cfg = (font?.fntConfig ?? font?._fntConfig) as
    | FntConfig
    | null
    | undefined;
  return cfg ?? null;
};

const getLabelFont = (comp: CompRecord): CompRecord | null =>
  ((comp.font ?? comp._font) as CompRecord | null | undefined) ?? null;

const isBmfontLabel = (comp: unknown): boolean => {
  if (!isLabelComp(comp)) return false;
  const font = getLabelFont(comp as CompRecord);
  if (!font) return false;
  return !!(getFntConfig(font) || /BitmapFont/.test(getFontClass(font)));
};

const getBmfontLabels = (node: Cc2Node): CompRecord[] =>
  (node._components ?? []).filter(isBmfontLabel) as CompRecord[];

export const nodeHasBmfont = (nodeId: string): boolean => {
  const scene = getSceneRoot();
  if (!scene) return false;
  const node = findNodeById(scene, nodeId);
  if (!node) return false;
  return getBmfontLabels(node).length > 0;
};

const resolveTextureName = (base: string): string => {
  const trimmed = base.trim();
  if (!trimmed) return 'bmfont.png';
  if (IMAGE_EXT.test(trimmed)) return trimmed;
  return `${sanitize(trimmed)}.png`;
};

const buildFntText = (
  cfg: FntConfig,
  faceName: string,
  pngName: string,
  texW: number,
  texH: number
): { text: string; charCount: number; kerningCount: number } => {
  const fontSize = Math.round(cfg.fontSize ?? cfg.commonHeight ?? 0);
  const lineHeight = Math.round(cfg.commonHeight ?? cfg.fontSize ?? 0);
  const dict = cfg.fontDefDictionary ?? {};
  const ids = Object.keys(dict);

  const lines: string[] = [];
  lines.push(
    `info face="${faceName}" size=${fontSize} bold=0 italic=0 charset="" ` +
      `unicode=1 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=0,0 outline=0`
  );
  lines.push(
    `common lineHeight=${lineHeight} base=${lineHeight} scaleW=${texW} ` +
      `scaleH=${texH} pages=1 packed=0 alphaChnl=0 redChnl=4 greenChnl=4 blueChnl=4`
  );
  lines.push(`page id=0 file="${pngName}"`);
  lines.push(`chars count=${ids.length}`);
  for (const id of ids) {
    const def = dict[id] ?? {};
    const rect = def.rect ?? {};
    lines.push(
      `char id=${id} x=${Math.round(rect.x ?? 0)} y=${Math.round(
        rect.y ?? 0
      )} width=${Math.round(rect.width ?? 0)} height=${Math.round(
        rect.height ?? 0
      )} xoffset=${Math.round(def.xOffset ?? 0)} yoffset=${Math.round(
        def.yOffset ?? 0
      )} xadvance=${Math.round(def.xAdvance ?? 0)} page=0 chnl=15`
    );
  }

  const kernEntries: Array<{ first: number; second: number; amount: number }> =
    [];
  const kern = cfg.kerningDict ?? {};
  for (const key of Object.keys(kern)) {
    const num = Number(key);
    const amount = Number(kern[key]);
    if (!Number.isFinite(num) || !Number.isFinite(amount)) continue;
    const first = num >>> 16;
    const second = num & 0xffff;
    if (first <= 0 || second <= 0) continue;
    kernEntries.push({ first, second, amount });
  }
  if (kernEntries.length > 0) {
    lines.push(`kernings count=${kernEntries.length}`);
    for (const k of kernEntries) {
      lines.push(
        `kerning first=${k.first} second=${k.second} amount=${k.amount}`
      );
    }
  }

  return {
    text: `${lines.join('\n')}\n`,
    charCount: ids.length,
    kerningCount: kernEntries.length,
  };
};

export const exportBmfontFromNode = async (
  nodeId: string,
  bmfontIndex = 0
): Promise<BmfontExportResult> => {
  const log: string[] = [];
  const files: BmfontExportFileEntry[] = [];

  try {
    const scene = getSceneRoot();
    if (!scene) {
      return { ok: false, zipName: '', files, log, error: '场景未就绪' };
    }

    const node = findNodeById(scene, nodeId);
    if (!node) {
      return { ok: false, zipName: '', files, log, error: '节点不存在' };
    }

    const labels = getBmfontLabels(node);
    if (labels.length === 0) {
      return {
        ok: false,
        zipName: '',
        files,
        log,
        error: '节点无 BMFont Label 组件',
      };
    }

    const comp = labels[bmfontIndex];
    if (!comp) {
      return {
        ok: false,
        zipName: '',
        files,
        log,
        error: 'BMFont Label 索引无效',
      };
    }

    const font = getLabelFont(comp);
    const cfg = getFntConfig(font);
    if (!font) {
      return { ok: false, zipName: '', files, log, error: 'Label 未绑定字体' };
    }

    const nodeName = getNodeName(node);
    const fontClass = getFontClass(font);
    const faceRaw =
      cfg?.atlasName ||
      String((font.name ?? font._name ?? '') as string) ||
      'bmfont';
    const baseName = sanitize(faceRaw);
    const zipName = `${sanitize(nodeName)}_${baseName}_bmfont.zip`;
    const zip = new JSZip();
    const prefix = `${baseName}/`;

    log.push(`节点 ${nodeName}(${nodeId}) · 字体 ${faceRaw} · ${fontClass}`);

    const spriteFrame = (font.spriteFrame ?? font._spriteFrame) as
      | CompRecord
      | null
      | undefined;
    const texture = (spriteFrame?.texture ?? spriteFrame?._texture) as
      | unknown
      | null
      | undefined;

    const pngName = resolveTextureName(cfg?.atlasName || `${baseName}.png`);
    let texW = 0;
    let texH = 0;

    if (texture) {
      const result = await extractFullTexturePixels2x(texture);
      if (result) {
        const png = imageDataToPngBlob(result.imageData);
        if (png) {
          const texPath = `${prefix}${pngName}`;
          zip.file(texPath, png);
          texW = result.width;
          texH = result.height;
          files.push({
            path: texPath,
            bytes: png.size,
            method: result.method,
            width: texW,
            height: texH,
          });
          log.push(`纹理 ${texPath} ${texW}×${texH} · ${result.method}`);
        } else {
          log.push('警告: 纹理转 PNG 失败');
        }
      } else {
        log.push('警告: 纹理内存提取为空');
      }
    } else {
      log.push('警告: 字体未绑定 spriteFrame/texture');
    }

    if (cfg) {
      const fnt = buildFntText(cfg, faceRaw, pngName, texW, texH);
      const fntPath = `${prefix}${baseName}.fnt`;
      zip.file(fntPath, fnt.text);
      files.push({ path: fntPath, bytes: fnt.text.length, method: 'rebuilt' });
      log.push(
        `字体 ${fntPath} · 字符 ${fnt.charCount} · kerning ${fnt.kerningCount}`
      );

      const cfgJson = JSON.stringify(cfg, null, 2);
      const cfgPath = `${prefix}fntConfig.json`;
      zip.file(cfgPath, cfgJson);
      files.push({ path: cfgPath, bytes: cfgJson.length, method: 'runtime' });
    } else {
      log.push('警告: 未读取到 fntConfig，无法重建 .fnt');
    }

    if (files.length === 0) {
      return {
        ok: false,
        zipName,
        files,
        log,
        error: '未导出任何文件（检查字体资源与纹理）',
      };
    }

    const manifest = {
      exporter: 'cocos-inspector-bmfont-v1',
      engineFamily: '2',
      engineVersion: window.cc?.ENGINE_VERSION ?? '2.x',
      nodeId,
      nodeName,
      fontClass,
      atlasName: cfg?.atlasName ?? null,
      fontSize: cfg?.fontSize ?? null,
      commonHeight: cfg?.commonHeight ?? null,
      charCount: cfg?.fontDefDictionary
        ? Object.keys(cfg.fontDefDictionary).length
        : 0,
      textureSize: { width: texW, height: texH },
      exportedAt: new Date().toISOString(),
      files,
      log,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    zip.file(
      'IMPORT_README.txt',
      [
        'Cocos Inspector — BMFont 导出包（Creator 2.x 试玩页）',
        '',
        `  ${baseName}/${baseName}.fnt`,
        `  ${baseName}/${pngName}`,
        '  拖入 Creator 3.x 资源管理器即可识别为 BitmapFont',
      ].join('\n')
    );

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    console.log(
      `[BMFont导出:2.x] ${nodeName}(${nodeId}) ${faceRaw} · ${files.length} 文件`
    );

    return { ok: true, zipName, zipBlob, files, log };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[BMFont导出:2.x] exportBmfontFromNode 失败`, error);
    return { ok: false, zipName: '', files, log, error: msg };
  }
};

export const downloadBmfontExport = async (
  nodeId: string,
  bmfontIndex = 0
): Promise<BmfontExportResult> => {
  const result = await exportBmfontFromNode(nodeId, bmfontIndex);
  if (result.ok && result.zipBlob && result.zipName) {
    triggerBlobDownload(result.zipBlob, result.zipName);
  }
  return result;
};

export interface BmfontListItem {
  id: string;
  name: string;
  path: string;
  fontName: string;
  searchText: string;
}

export const collectBmfontList = (scene: Cc2Node): BmfontListItem[] => {
  const items: BmfontListItem[] = [];
  const walk = (node: Cc2Node): void => {
    const labels = getBmfontLabels(node);
    if (labels.length > 0) {
      const id = getNodeId(node);
      const path = buildNodePath(scene, id);
      const font = getLabelFont(labels[0]!);
      const fontName = String(font?.name ?? font?._name ?? '');
      const name = getNodeName(node);
      items.push({
        id,
        name,
        path,
        fontName,
        searchText: `${name} ${path} ${fontName}`.toLowerCase(),
      });
    }
    for (const child of [...getNodeChildren(node)].sort((a, b) =>
      getNodeName(a).localeCompare(getNodeName(b))
    )) {
      walk(child);
    }
  };
  walk(scene);
  return items;
};
