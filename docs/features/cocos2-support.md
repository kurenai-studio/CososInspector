# Cocos Creator 2.x（含 2.4）支持

> 状态：**P0–P4a 已落地**。P4a = 2.x 面板导出 Spine/BMFont zip（手动拖入 Creator 3.x）。自动绑定 SkeletonData/BitmapFont 仍待做。

## 能力矩阵

| 能力 | 3.x | 2.x |
|------|-----|-----|
| 环境检测与面板挂载 | ✓ | ✓ P0 |
| 全量节点树 + Active 切换 | ✓ | ✓ P0 |
| 节点基础属性 Inspector | ✓ | ✓ P0 |
| 暂停 / 继续 | ✓ | ✓ P0 |
| Sprite 纹理预览 / PNG 下载 | ✓ | ✓ P1 |
| MCP 桥接 / 场景快照 / 纹理下载 API | ✓ | ✓ P2（子集） |
| 场景复刻（层级/UI/Sprite/Label/Widget） | ✓ | ✓ P3a/b |
| Spine / BMFont **zip 导出** | ✓ | ✓ P4a |
| Spine / BMFont **自动绑入 Creator** | ✗ | ✗（手动 unpack） |

## P4a：Spine / BMFont 导出

- 入口：`src/cocos2/spineExport.ts`、`bmfontExport.ts`（DOM 整图提取）
- Inspector 组件头：`导出 Spine` / `导出 BMFont`
- zip 布局与 3.x 一致；`manifest.engineFamily: '2'`
- 迁入：`npm run unpack-spine` 或手动拖入 Creator 3.x assets 后 reimport
- 注意：2.x 运行时 Spine 版本可能与 Creator 3.x 不一致，导入失败时用 Spine 编辑器重导

复刻命令见 [scene-recovery.md](scene-recovery.md)。

## 验收（P4a）

1. 2.4 试玩页选中带 Skeleton / BMFont Label 的节点  
2. 点「导出 Spine」或「导出 BMFont」下载 zip  
3. 解压后含 json|skel + atlas + 纹理（或 .fnt + png）  

## 后续（P4b）

scene-to-creator 自动导入并绑定 `skeletonData` / `Label.font`。
