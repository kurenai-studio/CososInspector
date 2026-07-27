# Cocos Creator 2.x（含 2.4）支持

> 状态：**P0–P3b 已落地**（节点树 / Inspector / 暂停 / Sprite / MCP 快照 / Creator 3.x 复刻含 Label·Widget·Spine 占位）。Spine 骨架资源绑定仍待做。

## 能力矩阵

| 能力 | 3.x | 2.x |
|------|-----|-----|
| 环境检测与面板挂载 | ✓ | ✓ P0 |
| 全量节点树 + Active 切换 | ✓ | ✓ P0 |
| 节点基础属性 Inspector | ✓ | ✓ P0 |
| 暂停 / 继续 | ✓ | ✓ P0 |
| Sprite 纹理预览 / PNG 下载（图集裁切+旋转还原） | ✓ | ✓ P1 |
| MCP 桥接 / 场景快照 / 纹理下载 API | ✓ | ✓ P2（子集） |
| 纹理替换 / 换皮包 / 节点画框 / 截图 | ✓ | ✗（返回明确错误） |
| 场景复刻（层级/Transform/UI/Sprite） | ✓ | ✓ P3a |
| 场景复刻 Label / Widget / Spine 占位 | ✓ P3b | ✓ P3b |

## 代码入口

- 统一检测：`src/engine/detect.ts`
- 启动分流：`src/injected.ts` → `bootInspector()`
- 2.x：`src/cocos2/`（含 `sceneSnapshot` / `mcpBridge`）
- 复刻工具：`tools/mcp-cocos-inspector/scene-to-creator.mjs`

## P3a 映射要点

1. **path**：快照使用 ` › `；工具对旧 `/` 快照做归一  
2. **sizeMode**：2.x → 快照内写 **3.x 枚举**  
3. **spriteFrame**：补 `offset` / `originalSize`  
4. **designResolution**：快照顶栏 + Canvas 组件行  
5. **Camera**：无 Camera 时磁盘补丁可合成  

## P3b 映射要点

1. **Label**：`cc.Label` + string / fontSize / lineHeight / color / overflow（系统字体，不绑 BMFont/TTF 资源）  
2. **Widget**：`cc.Widget` 对齐边与边距（由快照「左/右/上/下」行还原）  
3. **Spine**：仅 `sp.Skeleton` 占位 + defaultAnimation 名；**不**导出/绑定 skeletonData  

复刻命令见 [scene-recovery.md](scene-recovery.md)。

## 验收

### P3a
1. 2.4 快照 `engineFamily === '2'`，path 含 ` › `  
2. `cocos-scene-to-creator --clear --with-textures` 后主 Sprite 与尺寸基本正确  

### P3b
1. 快照中 Label 有「文本/字号」；Widget 有「左/右/上/下」  
2. 重建结果含 `labelsAppliedCount` / `widgetsAppliedCount`；有 Spine 节点时 `spinesAppliedCount` > 0（组件存在即可，无贴图正常）  

## 后续

Spine/BMFont 资源迁入、Widget 与动态布局精调、2.x originalCanvas 引擎对齐合成。
