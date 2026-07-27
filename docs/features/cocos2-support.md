# Cocos Creator 2.x（含 2.4）支持

> 状态：**P0 + P1 已落地**（节点树 / Inspector / 暂停 / Sprite 贴图裁切下载）。MCP、场景复刻仍仅 3.x。

## 能力矩阵

| 能力 | 3.x | 2.x |
|------|-----|-----|
| 环境检测与面板挂载 | ✓ | ✓ P0 |
| 全量节点树 + Active 切换 | ✓ | ✓ P0 |
| 节点基础属性 Inspector | ✓ | ✓ P0 |
| 暂停 / 继续 | ✓ | ✓ P0 |
| Sprite 纹理预览 / PNG 下载（图集裁切+旋转还原） | ✓ | ✓ P1 |
| MCP 桥接 / 场景快照 | ✓ | ✗（P2） |
| 场景复刻 | ✓ | ✗（P3，目标仍为 Creator 3 工程） |

## 代码入口

- 统一检测：`src/engine/detect.ts`（`detectEngineFamily` → `'2' | '3'`）
- 启动分流：`src/injected.ts` → `bootInspector()`
- 2.x 实现：`src/cocos2/`（`sceneTree` / `nodeInspector` / `gamePause` / `spriteExtract` / `panel`）

## 验收

### P0
1. 打开 **Cocos Creator 2.4** 试玩页，加载本扩展  
2. 面板标题为 `Cocos Inspector 2.x`，引擎版本显示 `2.4.x`  
3. 节点树可展开、搜索、勾选 Active；暂停可停住画面  

### P1
1. 选中带 `cc.Sprite` 的节点  
2. Inspector 出现贴图预览（棋盘格底）与「下载 PNG」  
3. 旋转图集帧应正向显示；控制台有 `[纹理提取:2.x] name(uuid) …` 日志  

## 后续

P2 MCP 快照字段对齐；P3 复刻映射。
