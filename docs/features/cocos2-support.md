# Cocos Creator 2.x（含 2.4）支持

> 状态：**P0 + P1 + P2 已落地**（节点树 / Inspector / 暂停 / Sprite 裁切下载 / MCP 桥接与场景快照）。场景复刻（P3）仍仅 3.x 目标工程。

## 能力矩阵

| 能力 | 3.x | 2.x |
|------|-----|-----|
| 环境检测与面板挂载 | ✓ | ✓ P0 |
| 全量节点树 + Active 切换 | ✓ | ✓ P0 |
| 节点基础属性 Inspector | ✓ | ✓ P0 |
| 暂停 / 继续 | ✓ | ✓ P0 |
| Sprite 纹理预览 / PNG 下载（图集裁切+旋转还原） | ✓ | ✓ P1 |
| MCP 桥接 / 场景快照 / 纹理下载 API | ✓ | ✓ P2（子集） |
| 纹理替换 / 换皮包 / 节点画框 / 截图 | ✓ | ✗（P2 返回明确错误） |
| 场景复刻 | ✓ | ✗（P3，目标仍为 Creator 3 工程） |

## 代码入口

- 统一检测：`src/engine/detect.ts`（`detectEngineFamily` → `'2' | '3'`）
- 启动分流：`src/injected.ts` → `bootInspector()`
- 2.x 实现：`src/cocos2/`（`sceneTree` / `nodeInspector` / `gamePause` / `spriteExtract` / `sceneSnapshot` / `mcpBridge` / `panel`）

## P2 MCP 子集

安装 `window.__cocosInspectorApi`（与 3.x 同协议），可用：

- `getPageInfo`（含 `engineFamily: '2'`）
- `getSceneTree` / `exportSceneSnapshot`（`engineFamily: '2'`）
- `pauseGame` / `resumeGame` / `togglePause` / `getPauseState`
- `setNodeActive` / `listSprites` / `getSpriteDetail` / `downloadTexture`
- `evalPage`

快照字段对齐 3.x `SceneSnapshot`（Transform / uiTransform / spriteFrame / 组件摘要）。

## 验收

### P0
1. 打开 **Cocos Creator 2.4** 试玩页，加载本扩展  
2. 面板标题为 `Cocos Inspector 2.x`，引擎版本显示 `2.4.x`  
3. 节点树可展开、搜索、勾选 Active；暂停可停住画面  

### P1
1. 选中带 `cc.Sprite` 的节点  
2. Inspector 出现贴图预览（棋盘格底）与「下载 PNG」  
3. 旋转图集帧应正向显示；控制台有 `[纹理提取:2.x] name(uuid) …` 日志  

### P2
1. 面板 MCP 状态可显示「已连接」（Cursor 启用 cocos-inspector MCP）  
2. `cocos_page_info` 返回 `engineFamily`/`engineVersion` 含 2.x  
3. `cocos_export_scene_snapshot` 可导出 JSON，`engineFamily === '2'`  
4. `cocos_download_texture` 能导出 Sprite PNG（share 或 inline）  

## 后续

P3：2.x 快照 → Creator 3.x 场景复刻映射。
