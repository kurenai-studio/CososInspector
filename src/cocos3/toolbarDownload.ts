/** Cocos 3.x 工具栏下载：复用已有 Sprite / Spine / BMFont 导出 */
import {
  base64ToBlob,
  mapLimit,
  pickDirectory,
  uniqueFilename,
  writeFileToDir,
} from '../engine/downloadDir';
import { exportBmfontFromNode, nodeHasBmfont } from './bmfontExport';
import { findNodeById, getNodeId, getSceneRoot } from './sceneTree';
import { exportSpineFromNode, nodeHasSpine } from './spineExport';
import { exportSpritePngBase64 } from './spriteDownload';
import {
  collectSpriteInspectData,
  enrichSpriteInspectData,
} from './spriteInspector';
import { collectSpriteList, nodeHasSpriteTexture } from './spriteList';

const CONCURRENCY = 8;

const exportOneSprite = async (
  nodeId: string
): Promise<{ filename: string; blob: Blob }> => {
  const base = collectSpriteInspectData(nodeId);
  if (!base) throw new Error('节点没有 Sprite 纹理');
  const enriched = await enrichSpriteInspectData(base, nodeId);
  const png = exportSpritePngBase64(enriched);
  if (!png.ok) throw new Error(png.error);
  return { filename: png.filename, blob: base64ToBlob(png.base64) };
};

const collectSubtreeSpriteIds = (root: cc.Node): string[] => {
  const ids: string[] = [];
  const walk = (node: cc.Node): void => {
    if (nodeHasSpriteTexture(node)) ids.push(getNodeId(node));
    for (const child of node.children ?? []) {
      if (child) walk(child);
    }
  };
  walk(root);
  return ids;
};

const writeSprites = async (
  ids: string[],
  dir: FileSystemDirectoryHandle,
  onStatus: (s: string) => void
): Promise<number> => {
  const used = new Set<string>();
  let ok = 0;
  let fail = 0;
  await mapLimit(ids, CONCURRENCY, async (id, i) => {
    try {
      const out = await exportOneSprite(id);
      const name = uniqueFilename(used, out.filename);
      await writeFileToDir(dir, `sprites/${name}`, out.blob);
      ok += 1;
    } catch (error) {
      fail += 1;
      console.warn(`[下载:3.x] Sprite 失败 ${id}`, error);
    }
    if ((i + 1) % 8 === 0 || i + 1 === ids.length) {
      onStatus(`导出 Sprite ${i + 1}/${ids.length}（成功 ${ok}）`);
    }
  });
  if (fail > 0) {
    console.warn(`[下载:3.x] Sprite 完成 成功=${ok} 失败=${fail}`);
  }
  return ok;
};

export const runCocos3Download = async (
  key: string,
  selectedId: string | null,
  onStatus: (s: string) => void
): Promise<void> => {
  const scene = getSceneRoot();
  if (!scene) throw new Error('场景未就绪');

  const needNode = key !== 'scene-sprites';
  if (needNode && !selectedId) throw new Error('请先选中节点');

  const dir = await pickDirectory();
  if (!dir) {
    onStatus('已取消选择目录');
    return;
  }

  if (key === 'node-texture') {
    onStatus('正在导出选中节点纹理…');
    const out = await exportOneSprite(selectedId!);
    await writeFileToDir(dir, `sprites/${out.filename}`, out.blob);
    onStatus(`已写入 sprites/${out.filename}`);
    return;
  }

  if (key === 'node-subtree') {
    const node = findNodeById(scene, selectedId!);
    if (!node) throw new Error('选中节点不存在');
    const ids = collectSubtreeSpriteIds(node);
    if (ids.length === 0) throw new Error('子树中没有 Sprite 纹理');
    onStatus(`正在导出子树 ${ids.length} 张 Sprite…`);
    const n = await writeSprites(ids, dir, onStatus);
    onStatus(`已写入 ${n} 张 Sprite PNG`);
    return;
  }

  if (key === 'node-spine') {
    if (!nodeHasSpine(selectedId!)) {
      throw new Error('选中节点没有 Spine');
    }
    onStatus('正在导出 Spine zip…');
    const result = await exportSpineFromNode(selectedId!, 0);
    if (!result.ok || !result.zipBlob) {
      throw new Error(result.error ?? 'Spine 导出失败');
    }
    await writeFileToDir(dir, result.zipName, result.zipBlob);
    onStatus(`已写入 ${result.zipName}`);
    return;
  }

  if (key === 'node-bmfont') {
    if (!nodeHasBmfont(selectedId!)) {
      throw new Error('选中节点没有 BMFont');
    }
    onStatus('正在导出 BMFont zip…');
    const result = await exportBmfontFromNode(selectedId!, 0);
    if (!result.ok || !result.zipBlob) {
      throw new Error(result.error ?? 'BMFont 导出失败');
    }
    await writeFileToDir(dir, result.zipName, result.zipBlob);
    onStatus(`已写入 ${result.zipName}`);
    return;
  }

  if (key === 'scene-sprites') {
    const list = collectSpriteList(scene);
    if (list.length === 0) throw new Error('场景中没有 Sprite 纹理');
    onStatus(`正在导出整场景 ${list.length} 张 Sprite…`);
    const n = await writeSprites(
      list.map((it) => it.id),
      dir,
      onStatus
    );
    onStatus(`已写入 ${n} 张 Sprite PNG`);
    return;
  }

  throw new Error(`未知下载项: ${key}`);
};
