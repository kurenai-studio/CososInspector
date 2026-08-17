/** Cocos 2.x 工具栏下载：复用 extractSpriteFrame / Spine / BMFont */
import {
  canvasToBlob,
  mapLimit,
  pickDirectory,
  uniqueFilename,
  writeFileToDir,
} from '../engine/downloadDir';
import { exportBmfontFromNode, nodeHasBmfont } from './bmfontExport';
import {
  findNodeById,
  getNodeChildren,
  getNodeId,
  getSceneRoot,
  type Cc2Node,
} from './sceneTree';
import { exportSpineFromNode, nodeHasSpine } from './spineExport';
import { extractSpriteFrame, nodeHasSprite } from './spriteExtract';

const CONCURRENCY = 8;

const collectSubtreeSpriteIds = (root: Cc2Node): string[] => {
  const ids: string[] = [];
  const walk = (node: Cc2Node): void => {
    if (nodeHasSprite(node)) ids.push(getNodeId(node));
    for (const child of getNodeChildren(node)) walk(child);
  };
  walk(root);
  return ids;
};

const exportOneSprite = async (
  nodeId: string
): Promise<{ filename: string; blob: Blob }> => {
  const result = await extractSpriteFrame(nodeId);
  if (!result) throw new Error('节点没有可提取的 Sprite');
  const blob = await canvasToBlob(result.canvas);
  const raw = `${result.nodeName}_${result.frameName}.png`;
  return { filename: raw, blob };
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
      console.warn(`[下载:2.x] Sprite 失败 ${id}`, error);
    }
    if ((i + 1) % 8 === 0 || i + 1 === ids.length) {
      onStatus(`导出 Sprite ${i + 1}/${ids.length}（成功 ${ok}）`);
    }
  });
  if (fail > 0) {
    console.warn(`[下载:2.x] Sprite 完成 成功=${ok} 失败=${fail}`);
  }
  return ok;
};

export const runCocos2Download = async (
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
    const name = uniqueFilename(new Set(), out.filename);
    await writeFileToDir(dir, `sprites/${name}`, out.blob);
    onStatus(`已写入 sprites/${name}`);
    return;
  }

  if (key === 'node-subtree') {
    const node = findNodeById(scene, selectedId!);
    if (!node) throw new Error('选中节点不存在');
    const ids = collectSubtreeSpriteIds(node);
    if (ids.length === 0) throw new Error('子树中没有 Sprite');
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
    const ids = collectSubtreeSpriteIds(scene);
    if (ids.length === 0) throw new Error('场景中没有 Sprite');
    onStatus(`正在导出整场景 ${ids.length} 张 Sprite…`);
    const n = await writeSprites(ids, dir, onStatus);
    onStatus(`已写入 ${n} 张 Sprite PNG`);
    return;
  }

  throw new Error(`未知下载项: ${key}`);
};
