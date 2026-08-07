# 运行时 Dump → 下载完整包（资源/脚本 URL）

> 工作流：游戏加载完成 → Dump → **按 bundle config 展开并下载**  
> 本阶段聚焦下载与 JS 切片操作；**方法论 / 验收标准**见
> [bundle-logic-recovery.md](./bundle-logic-recovery.md)。  
> `build/` 组装与 `cc-reverse` 为资源支线，不绑死「理解层」验收。

## 目标

把试玩页已加载（及 config 可推导）的 **js / config / import / native** 尽量下到磁盘。

```text
试玩页
  └─ dumpRuntime()  类 / URL / bundle config(+base)
        ↓ MCP cocos_dump_runtime（fetchUrls=true）
tmp/runtime-dump/<host>/
  ├─ manifest.json
  ├─ scripts/classes/
  ├─ urls.json
  └─ downloads/          ← 完整下载落点（保留 CDN 路径）
        └─ .../remote/<bundle>/{config.json,index.js,import/,native/}
```

## 使用前

1. `npm run build` 后重载扩展  
2. `npm run cocos-bridge`（按域名）  
3. 打开游戏，等到主场景/远程 bundle 加载完  
4. `cd tools/mcp-cocos-inspector && npm install`

## MCP：`cocos_dump_runtime`

| 参数 | 默认 | 说明 |
|------|------|------|
| `fetchUrls` | `true` | Node 拉取 |
| `fetchKinds` | `js,config,asset` | 种类；`all`=整份 resourceUrls |
| `maxFiles` | `8000` | URL 上限 |
| `concurrency` | `8` | 并发 |
| `runReverse` | `false` | 本阶段可忽略 |

下载策略：

1. 先拉 `jsUrls` + `configUrls` + performance 里已出现的 import/native  
2. 用 dump 内 `bundles[].config` 与已下到的 `config.json` **展开全量** import（+ 按类型探测 native 扩展）  
3. 再拉展开列表；已存在且非空的文件会 skip  

404（错误扩展探测）记在 `download-report.json` 的 `fail404`，属预期噪声。

## 页内 API

`window.__cocosInspectorApi.dumpRuntime(options?)`  
实现：`src/cocos3/runtimeDump.ts`（`collectBundles` 走 Cache.forEach，避免 `_map/_count`）

## 限制

- native 扩展不在 `extensionMap` 时会按类型探测（png/webp/mp3…），多请求一些 404  
- 未出现在任何 bundle config、也未进 performance 的 URL 仍会缺  
- 本阶段 **不保证** 已拼成 cc-reverse 可用的 `build/`  

## Bundle 内 JS：拆分 / 可读化 / 目录还原

远程包常有 `index.js`（多段 `System.register`）。可分步处理（以 slotgame 为例）：

```text
① split-system-register.mjs     → scripts-split/<bundle>/
② readableize-system-register.mjs → *-readable/（抽出 execute + prettier）
③ restore-scripts-l3.mjs        → *-restored/（setter 变量名 + 目录）
```

目录线索：

| 来源 | 说明 |
|------|------|
| dump `classes[].className` 含 `/` | 最接近原工程（如 `widgets/Foo`、`Anim/Bar`） |
| 命名启发式 | `workers/`、`game/`、`boards/`、`interfaces/`（`i-*`）等，便于浏览，**非原仓保证** |

```bash
node split-system-register.mjs <index.js> --out .../scripts-split/slotgame
node readableize-system-register.mjs .../slotgame --out .../slotgame-readable
node restore-scripts-l3.mjs .../slotgame --out .../slotgame-restored \
  --dump .../manifest.json
```

## Creator 工程：image 空壳目录修复（必要步骤）

`cc-reverse --assets-only` 常把 Image 展开成「目录 + texture/spriteFrame meta」，
同时又从 `native/` 旁路生成同名 `.png/.jpg`。Creator 打开时会优先啃**空壳目录**
（`importer: image` 却无贴图）→ 大量 `EISDIR` / `Importer exec failed`，
资源面板粉线、`spriteFrame` 显示 `{}`。

**必要修复**（打开 Creator 前或导入失败后立刻做）：

```bash
node tools/mcp-cocos-inspector/fix-image-shell-dirs.mjs <工程>/assets \
  --native-root <dump>/build/assets
```

行为：

| 情况 | 处理 |
|------|------|
| 旁路已有同名 `.png/.jpg` | 把空壳目录的**原包 UUID**写回旁路 `.meta`，删除空壳目录 |
| 无旁路 | 从 `build/assets/*/native/<uuid>.*` 拷图并写 meta，再删空壳 |

验证：`asset-db` 用原 UUID 能查到 `cc.ImageAsset` 且 `imported: true`；
控制台不再新增 `EISDIR`。

## 实现

- `src/cocos3/runtimeDump.ts`
- `tools/mcp-cocos-inspector/expand-bundle-urls.mjs`
- `tools/mcp-cocos-inspector/runtime-dump-lib.mjs`
- `tools/mcp-cocos-inspector/split-system-register.mjs`
- `tools/mcp-cocos-inspector/readableize-system-register.mjs`
- `tools/mcp-cocos-inspector/restore-scripts-l3.mjs`
- `tools/mcp-cocos-inspector/fix-image-shell-dirs.mjs`
- MCP：`index.mjs` → `cocos_dump_runtime`
