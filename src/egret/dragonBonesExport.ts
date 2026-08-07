/**
 * Egret DragonBones 内存导出
 *
 * 参考 hgjkfcojmobceiihkjifeioioffcmond/inspector.js 的 Qe/Ae/Ee/le/ce 函数：
 *   数据源：
 *     - 场景节点：egret.dragonBones.EgretArmatureDisplay / ArmatureDisplay
 *     - 全局缓存：dragonBones.EgretFactory.factory._dragonBonesDataMap
 *     - 纹理：dragonBones.EgretFactory.factory._textureAtlasDataMap
 */
import {
  getEgretStage,
  type DragonBonesAtlasEntry,
  type DragonBonesDataEntry,
  type DragonBonesFactoryLike,
  type EgretDisplayObject,
} from './runtime';
import {
  buildNodePath,
  findDisplayById,
  getDisplayId,
  walkDisplayTree,
} from './sceneTree';

export interface DragonBonesListItem {
  id: string;
  name: string;
  kind: 'dragonBones';
  nodePath: string;
  armatureName: string;
  anims: string[];
  exportable: boolean;
  source: 'scene' | 'cache';
}

function isArmatureDisplay(node: EgretDisplayObject): boolean {
  const db = window.dragonBones;
  if (!db) return false;
  try {
    if (db.EgretArmatureDisplay && node instanceof (db.EgretArmatureDisplay as never)) return true;
    if (db.ArmatureDisplay && node instanceof (db.ArmatureDisplay as never)) return true;
  } catch {
    /* ignore */
  }
  const ctor = node.constructor?.name || '';
  return /EgretArmatureDisplay|ArmatureDisplay/i.test(ctor);
}

function getFactory(): DragonBonesFactoryLike | null {
  const db = window.dragonBones;
  if (!db) return null;
  const f = db.EgretFactory?.factory ?? db.BaseFactory?.factory;
  return f ?? null;
}

function getArmatureName(node: EgretDisplayObject): string {
  const arm = (node as { armature?: { name?: string } }).armature;
  return String(arm?.name || node.name || 'armature');
}

function getAnimations(node: EgretDisplayObject): string[] {
  const arm = (node as {
    armature?: { animation?: { names?: string[]; getAnimationNames?: () => string[] } };
  }).armature;
  const anim = arm?.animation;
  if (!anim) return [];
  try {
    if (typeof anim.getAnimationNames === 'function') {
      return anim.getAnimationNames().filter(Boolean);
    }
    if (Array.isArray(anim.names)) return anim.names.filter(Boolean);
  } catch {
    /* ignore */
  }
  return [];
}

/** 列出场景中的 DragonBones 节点 + 缓存中已注册的 dragonBones 数据 */
export function listDragonBones(): DragonBonesListItem[] {
  const stage = getEgretStage();
  const out: DragonBonesListItem[] = [];
  const seen = new Set<string>();

  if (stage) {
    walkDisplayTree(stage, (node) => {
      if (!isArmatureDisplay(node)) return;
      const id = getDisplayId(node);
      const armName = getArmatureName(node);
      seen.add(armName);
      out.push({
        id,
        kind: 'dragonBones',
        name: armName,
        nodePath: buildNodePath(stage, id),
        armatureName: armName,
        anims: getAnimations(node),
        exportable: true,
        source: 'scene',
      });
    });
  }

  // 缓存中已注册但未挂到场景的数据
  const factory = getFactory();
  const dataMap = factory?._dragonBonesDataMap ?? factory?.dragonBonesDataMap;
  if (dataMap && typeof dataMap === 'object') {
    for (const key of Object.keys(dataMap)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `egret-db-cache-${key}`,
        kind: 'dragonBones',
        name: key,
        nodePath: '(asset-cache)',
        armatureName: key,
        anims: [],
        exportable: true,
        source: 'cache',
      });
    }
  }

  return out;
}
