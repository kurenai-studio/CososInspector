# Cocos Creator 2.x（含 2.4）支持

> 状态：**P0–P3a 已落地**（节点树 / Inspector / 暂停 / Sprite 裁切 / MCP 快照 / **→ Creator 3.x 复刻适配**）。P3b（Widget/Label/Spine）未做。

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
| 场景复刻到 Creator 3.x | ✓ | ✓ P3a（路径/sizeMode/设计分辨率/Camera） |

## 代码入口

- 统一检测：`src/engine/detect.ts`
- 启动分流：`src/injected.ts` → `bootInspector()`
- 2.x：`src/cocos2/`（含 `sceneSnapshot` / `mcpBridge`）
- 复刻工具：`tools/mcp-cocos-inspector/scene-to-creator.mjs`（读 `engineFamily`）

## P3a 映射要点

1. **path**：快照使用 ` › `（与 3.x 一致）；工具对旧 `/` 快照做归一  
2. **sizeMode**：2.x `CUSTOM=0/TRIMMED=1/RAW=2` → 快照内写 **3.x 枚举**（0/1/2 = TRIMMED/RAW/CUSTOM）  
3. **spriteFrame**：补 `offset` / `originalSize`  
4. **designResolution**：快照顶栏 `designResolution` + Canvas 组件行  
5. **Camera**：磁盘补丁在无 Camera 时于 Canvas 下合成  

复刻命令与 3.x 相同，见 [scene-recovery.md](scene-recovery.md) / Skill `inspector-scene-recovery`。

## 验收

### P0 / P1 / P2
见此前章节（节点树、贴图预览、MCP 连接与快照）。

### P3a
1. 2.4 试玩页导出快照：`engineFamily === '2'`，path 含 ` › `，`spriteFrame.sizeMode` 为 3.x 枚举  
2. `npm run cocos-scene-to-creator -- <snapshot> --clear --with-textures …`  
3. Creator 场景节点尺寸非大量 100×100；主 Sprite 可见；缺 Camera 时补丁可合成  

## 后续（P3b）

Widget 映射、Label/Spine、2.x originalCanvas 引擎对齐合成。
