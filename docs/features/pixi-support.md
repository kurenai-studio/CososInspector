# PixiJS 支持（MVP）

同一 Chrome 扩展在**无 Cocos** 的页面上可识别 PixiJS，并挂载精简 Inspector + MCP 桥。

## 开关（v3.2.1，默认关闭）

点击扩展图标打开 popup：

- **启用 PixiJS 探测**：默认 **关**
- 关闭时不注入 early probe / `pixi-probe.js`，普通网页不会被 webpack/console 钩子误伤（白屏问题）
- Cocos Creator 2.x / 3.x **不受此开关影响**
- 开启后请对试玩页 **硬刷新**（探针须赶在 `new Application` 前）

存储键：`chrome.storage.sync.pixiEnabled`（默认 `false`）。

## 检测与截获

1. Cocos Creator 3.x / 2.x（`cc.director.getScene`）优先
2. 否则且开关打开时 Pixi：
   - `document_start` 探针（`earlyProbeSource` + `dist/pixi-probe.js`）
     - 拦截 `window.PIXI` 赋值并 wrap `Application` 构造 / `init`
     - **仅已知试玩域**（`slotmill.com` / `gameart.io` / `gahypergaming.com`）才偷 `webpackChunk*` / 扫模块、劫持 console
     - 截获实例写入 `window.__PIXI_APP__` / `__cocosInspectorPixiApps`
   - SlotMill：`webpackChunk*` 第 3 参偷 `require`；`Application.prototype.render` 截已创建实例

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
2. 扩展图标 → 打开「启用 PixiJS 探测」→ **硬刷新**试玩页
3. 控制台 / 面板：应出现 stage 树；若仍「等待 Application」，查 `window.__PIXI_APP__`
4. 普通网页保持开关关闭，确认不再白屏
