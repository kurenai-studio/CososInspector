# Cocos Inspector 怎么用（简要）

Chrome 扩展：在试玩页上看场景；重度流程走 MCP / 命令行（**不提供面板按钮**）。

## 1. 装扩展

```powershell
npm install
npm run build
```

Chrome → `chrome://extensions/` → 开发者模式 →「加载已解压的扩展程序」→ 选**项目根目录**（含 `manifest.json`）。  
打开试玩页后 **F5**。

## 2. 页面上的面板（有 UI）

刷新成功后，试玩页右侧出现浮层：

| 能力 | 说明 |
|------|------|
| 节点树 | 展开 / 搜索 / 改 active / 选中高亮 |
| Inspector | 底部看组件、位置、Sprite 预览 |
| 暂停 | 停住再看属性 |
| 资源 | 资源加载浮窗 |
| Spine / 还原 TS / 扫描 DC | 选中节点后在面板操作 |
| MCP 指示灯 | 桥连上后为绿色「已连接」 |

收起后只剩右侧「节点树」标签，再点展开。  
扩展图标 **popup** 很小：主要是「启用 PixiJS 探测」开关。

详参：[node-tree.md](./node-tree.md)、[asset-loading.md](./asset-loading.md)、[spine-export.md](./spine-export.md)

## 3. MCP 桥（自动化 / Dump）

```powershell
npm run cocos-bridge -- --domain <试玩域名>
```

Cursor 启用 `cocos-inspector` MCP → 试玩页 F5 → 面板 MCP 变绿。

常用：截图、列 Sprite、下纹理、导出场景快照、`cocos_dump_runtime`。  
工具列表：[tools/mcp-cocos-inspector/README.md](../../tools/mcp-cocos-inspector/README.md)

## 4. Dump → Creator（无面板，CLI）

流程概要：

1. MCP `cocos_dump_runtime`（`fetchUrls=true`）落到 `tmp/runtime-dump/`
2. 组装 `build/` 后跑 `npm run cocos-reverse`
3. 打开 Creator **前**跑后处理脚本（图集 / Spine / UUID / 节点 id 等）

完整步骤与脚本顺序：[runtime-dump-reverse.md](./runtime-dump-reverse.md)  
逻辑阅读（`-restored`）：[bundle-logic-recovery.md](./bundle-logic-recovery.md)  
场景复刻（试玩快照 → Creator）：[scene-recovery.md](./scene-recovery.md)

## 5. 能力边界（一眼看懂）

| 有面板 | 无面板（文档 / MCP / CLI） |
|--------|---------------------------|
| 看树、改 active、暂停、贴图预览 | 运行时 Dump |
| Spine / BMFont 导出、DC 扫描 | cc-reverse 后处理、脚本 CID |
| 资源浮窗 | Bundle 逻辑还原阅读 |

无 sourcemap 时得不到完整可编译原工程；服务端算奖不在 dump 里。
