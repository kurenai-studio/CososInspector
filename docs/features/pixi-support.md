# PixiJS 支持（MVP）

同一 Chrome 扩展在**无 Cocos** 的页面上可识别 PixiJS，并挂载精简 Inspector + MCP 桥。

## 检测与截获

1. Cocos Creator 3.x / 2.x（`cc.director.getScene`）优先
2. 否则 Pixi：
   - `document_start` **同步探针**（`earlyProbeSource` + `dist/pixi-probe.js`）
     - hook `console` / `canvas.getContext(webgl)`
     - **拦截 `window.PIXI` 赋值并 wrap `Application` 构造 / `init`**
     - hook `webpackChunk*.push` + 扫描 `__webpack_require__.c`
     - 截获实例写入 `window.__PIXI_APP__` / `__cocosInspectorPixiApps`
   - **SlotMill / Eternal Dusk（已实探）**：`webpackChunk*` 第 3 参偷 `require`，模块在 `require.m`（无 `.c`）；`Application.prototype.render` 截已创建 `pixiApp`

面板挂到 `document.documentElement`，被拆除后自动重挂。

## MVP 能力

| 能力 | 说明 |
|------|------|
| Stage 树 | `app.stage` 递归 DisplayObject |
| visible | 树节点勾选 → `node.visible` |
| Sprite 列表 | MCP `listSprites` |
| 截图 | `renderer.extract` 或 canvas |
| 暂停 | `app.ticker.stop` / `start` |
| MCP | `__cocosInspectorApi` |

## 本地验证

1. `npm run build`，Chrome **重新加载扩展**
2. **硬刷新**试玩页（探针须在 `new Application` 前注入）
3. 控制台 / 面板：应出现 stage 树；若仍「等待 Application」，在 Console 执行：
   `window.__cocosInspectorPixiApps` / `window.__PIXI_APP__`
4. 仍为空则该页 Application 创建早于探针或非标准构造，需页面主动挂 `__PIXI_APP__`
