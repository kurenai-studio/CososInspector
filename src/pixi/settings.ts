/** Pixi 探测开关（chrome.storage.sync） */
export const PIXI_ENABLED_STORAGE_KEY = 'pixiEnabled';

/** 默认关闭，避免探针误伤普通网页 */
export const PIXI_ENABLED_DEFAULT = false;

/** 已知 Pixi 试玩宿主：允许 webpack 偷 require 等激进钩子 */
export const KNOWN_PIXI_HOST_RE =
  /(^|\.)(slotmill\.com|gameart\.io|gahypergaming\.com)$/i;

export function isKnownPixiHost(hostname: string): boolean {
  try {
    return KNOWN_PIXI_HOST_RE.test(String(hostname || ''));
  } catch {
    return false;
  }
}
