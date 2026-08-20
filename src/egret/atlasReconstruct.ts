/**
 * 图集元数据重组：从 AtlasInfo 生成 Cocos2d-x .plist + Egret .json
 * 让裁剪好的 sprite PNG 可直接喂回 Cocos/Egret 工程使用。
 *
 * 参考：
 *   - Cocos2d-x zwoptext format 2/3
 *   - Egret SpriteSheet JSON 格式
 */
import type { AtlasInfo } from './sceneAssetsExport';

/**
 * 生成 Cocos2d-x v2 plist（format=2，最通用）
 * 结构：frames.{name}.{frame, offset, rotated, sourceColorRect, sourceSize} + metadata
 */
export function buildCocosPlist(atlas: AtlasInfo): string {
  const texFileName = atlas.filename;
  // plist 用相对路径：默认跟 sprite PNG 同目录的 ../images/{texFileName}
  // 但用户把 plist 写到 atlas-meta/ 下，images/ 在隔壁，路径写 ../images/{texFileName}
  const texRelPath = `../images/${texFileName}`;
  const frames: string[] = [];
  for (const s of atlas.sprites) {
    const name = `${s.name}.png`;
    frames.push(
      `    <key>${escapeXml(name)}</key>
    <dict>
      <key>frame</key>
      <string>{{${s.x},${s.y}},{${s.w},${s.h}}}</string>
      <key>offset</key>
      <string>{0,0}</string>
      <key>rotated</key>
      <false/>
      <key>sourceColorRect</key>
      <string>{{${s.x},${s.y}},{${s.w},${s.h}}}</string>
      <key>sourceSize</key>
      <string>{${s.w},${s.h}}</string>
    </dict>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>frames</key>
  <dict>
${frames.join('\n')}
  </dict>
  <key>metadata</key>
  <dict>
    <key>format</key>
    <integer>2</integer>
    <key>textureFileName</key>
    <string>${escapeXml(texFileName)}</string>
    <key>textureFilePath</key>
    <string>${escapeXml(texRelPath)}</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * 生成 Egret SpriteSheet JSON
 * 结构：{ file, frames: { name: { x,y,w,h,offX,offY,sourceW,sourceH } } }
 */
export function buildEgretJson(atlas: AtlasInfo): string {
  const frames: Record<string, {
    x: number; y: number; w: number; h: number;
    offX: number; offY: number; sourceW: number; sourceH: number;
  }> = {};
  for (const s of atlas.sprites) {
    frames[`${s.name}.png`] = {
      x: s.x, y: s.y, w: s.w, h: s.h,
      offX: 0, offY: 0,
      sourceW: s.w, sourceH: s.h,
    };
  }
  return JSON.stringify({
    file: `../images/${atlas.filename}`,
    frames,
  }, null, 2);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
