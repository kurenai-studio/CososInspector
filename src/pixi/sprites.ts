import {
  buildNodePath,
  getDisplayChildren,
  getDisplayId,
  getDisplayName,
  isDisplayVisible,
} from './sceneTree';
import { getPixiStage, type PixiDisplayObject, type PixiTextureLike } from './runtime';

export interface PixiSpriteListItem {
  id: string;
  name: string;
  path: string;
  frameName: string;
  enabled: boolean;
  active: boolean;
  searchText: string;
  textureSize: { w: number; h: number };
}

function isSpriteLike(node: PixiDisplayObject): boolean {
  if (node.texture) return true;
  const n = node.constructor?.name || '';
  return /Sprite|AnimatedSprite|Mesh|TilingSprite|NineSlice/i.test(n);
}

function textureLabel(t: PixiTextureLike | undefined): string {
  if (!t) return '(no-texture)';
  return (
    t.label ||
    t.textureCacheIds?.[0] ||
    t.baseTexture?.label ||
    t.baseTexture?.textureCacheIds?.[0] ||
    t.baseTexture?.resource?.url ||
    t.baseTexture?.resource?.src ||
    '(texture)'
  );
}

function textureSize(t: PixiTextureLike | undefined): { w: number; h: number } {
  return {
    w: Number(t?.width ?? t?.baseTexture?.width ?? 0),
    h: Number(t?.height ?? t?.baseTexture?.height ?? 0),
  };
}

export function collectSpriteList(): PixiSpriteListItem[] {
  const root = getPixiStage();
  if (!root) return [];
  const items: PixiSpriteListItem[] = [];
  const walk = (node: PixiDisplayObject): void => {
    if (isSpriteLike(node)) {
      const id = getDisplayId(node);
      const name = getDisplayName(node);
      const path = buildNodePath(root, id);
      const frameName = textureLabel(node.texture);
      const size = textureSize(node.texture);
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
    for (const child of getDisplayChildren(node)) walk(child);
  };
  walk(root);
  return items;
}
