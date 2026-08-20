/**
 * Egret 贴图清单：遍历显示列表收集 Bitmap/MovieClip 的纹理
 */
import {
  buildNodePath,
  getDisplayChildren,
  getDisplayId,
  getDisplayName,
  isDisplayVisible,
} from './sceneTree';
import { getNodeTexture } from './textureExtract';
import { getEgretStage, type EgretDisplayObject, type EgretTextureLike } from './runtime';

export interface EgretSpriteListItem {
  id: string;
  name: string;
  path: string;
  frameName: string;
  enabled: boolean;
  active: boolean;
  searchText: string;
  textureSize: { w: number; h: number };
}

function isBitmapLike(node: EgretDisplayObject): boolean {
  if (node.texture || node.$texture) return true;
  const n = node.constructor?.name || '';
  return /Bitmap|MovieClip/i.test(n);
}

function textureLabel(node: EgretDisplayObject, t: EgretTextureLike): string {
  if (node.name) return String(node.name);
  const data = t.$bitmapData ?? t._bitmapData;
  if (data instanceof HTMLImageElement && data.src) {
    return data.src.split('/').pop() || data.src;
  }
  return `(texture ${t.$bitmapWidth ?? 0}×${t.$bitmapHeight ?? 0})`;
}

function textureSize(t: EgretTextureLike): { w: number; h: number } {
  return {
    w: Number(t.$bitmapWidth ?? t.textureWidth ?? t.$textureWidth ?? 0),
    h: Number(t.$bitmapHeight ?? t.textureHeight ?? t.$textureHeight ?? 0),
  };
}

export function collectSpriteList(): EgretSpriteListItem[] {
  const root = getEgretStage();
  if (!root) return [];
  const items: EgretSpriteListItem[] = [];
  const walk = (node: EgretDisplayObject): void => {
    if (isBitmapLike(node)) {
      const t = getNodeTexture(node);
      if (t) {
        const id = getDisplayId(node);
        const name = getDisplayName(node);
        const path = buildNodePath(root, id);
        const frameName = textureLabel(node, t);
        const size = textureSize(t);
        items.push({
          id,
          name,
          path,
          frameName,
          enabled: true,
          active: isDisplayVisible(node),
          searchText: `${name} ${path} ${frameName}`.toLowerCase(),
          textureSize: size,
        });
      }
    }
    for (const child of getDisplayChildren(node)) walk(child);
  };
  walk(root);
  return items;
}
