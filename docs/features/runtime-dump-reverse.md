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

## Creator 工程：Spine 源文件化（必要步骤）

cc-reverse **3.x** 不会像 2.x 那样把 `sp.SkeletonData` 拆成
`.json + .atlas + .png`，只会留下 library JSON / atlas 空壳。

在 image 空壳修复之后、打开/刷新 Spine 前执行：

```bash
node tools/mcp-cocos-inspector/fix-spine-from-import.mjs <工程>/assets \
  --bundle-root <dump>/build/assets/resources
```

真源：`config.packs` + `import/`（rehydrate）中的 `_atlasText` / `_skeletonJson`。  
产出：同目录 Spine 三件套，`importer: spine-data`；`legendwin2`/`ultrawin2` 仅为贴图页，属原包设计。

## Creator 工程：SpriteAtlas 修复（必要步骤）

cc-reverse 默认 `spriteOutputMode: single`，会把 `cc.SpriteAtlas` 落成
`importer: json`（JsonAsset），帧 UUID（`atlasUuid@hash`）在编辑器里不存在 →
场景/Prefab 的 `_spriteFrame` 全空。若再在 Creator 里 `save-scene`，未解析引用会被写成
`null`，进一步恶化。

在 image 空壳修复之后执行：

```bash
node tools/mcp-cocos-inspector/fix-sprite-atlas-from-import.mjs <工程>/assets \
  --bundle-root <dump>/build/assets/slotgame \
  --restore-scene <run1>/assets/slotgame/game_scene.fire \
  --restore-prefabs-from <run1>/assets
node tools/mcp-cocos-inspector/fix-sprite-atlas-from-import.mjs <工程>/assets \
  --bundle-root <dump>/build/assets/freegame
node tools/mcp-cocos-inspector/fix-sprite-atlas-from-import.mjs <工程>/assets \
  --bundle-root <dump>/build/assets/resources
node tools/mcp-cocos-inspector/expand-compressed-uuids.mjs <工程>/assets
node tools/mcp-cocos-inspector/fix-scene-node-ids.mjs <工程>/assets
```

行为：从 `config.packs` rehydrate 出图集帧，写成同目录 TexturePacker `.plist` +
`.plist.meta`（**保留**原 atlas/帧 UUID）；可选从 run1 恢复场景/Prefab 绑定；
再把压缩 UUID 展开为完整 UUID（asset-db 只认完整形态）。

验证：`asset-db` 能查到 `cc.SpriteAtlas`；抽样 `atlasUuid@hash` 为 `cc.SpriteFrame`；
场景 Sprite 大量 unbound 消失。**勿在引用未解析时 save-scene**。

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

## Creator 工程：Material 规范化（必要步骤）

cc-reverse 产出的 `.mtl` 常是「运行时反序列化形态」：

- 外层包成 `[{ "__type__": "cc.Material", ... }]`（编辑器要单对象）
- `_effectAsset` / 贴图引用仍是压缩 UUID
- `_techIdx` 为字符串或缺省 → `invalid: true`
- `.mtl.meta` 偶发 `importer: "*"`

在 Spine / image 修复之后执行：

```bash
node tools/mcp-cocos-inspector/fix-materials.mjs <工程>/assets
```

行为：去数组壳、解压 UUID、补 `__expectedType__`、`_techIdx` 转 number（缺省 0）、
meta 强制 `importer: material`。

验证：`query-assets` 模式 `db://assets/**/*.mtl` → 几乎全部
`imported: true, invalid: false`（粒子 = builtin-particle；
`material_one-scren` = builtin-spine）。

已知缺口：`gauss-blur.effect` 仍是编译态 `cc.EffectAsset` JSON（非 YAML 源），
`invalid: true`；对应 `.mtl` 可导入但自定义模糊需另案从 glsl3 回写 effect 源。

## Creator 工程：编译态 Effect → YAML 源（必要步骤）

cc-reverse 会把自定义 `.effect` 写成已编译的 `[{ "__type__": "cc.EffectAsset", shaders.glsl3... }]`，
编辑器 effect importer 只认 `CCEffect` / `CCProgram` YAML → 资源面板红叹号。

在 material 规范化之后执行：

```bash
node tools/mcp-cocos-inspector/fix-compiled-effects.mjs <工程>/assets
```

行为（当前覆盖 sprite 管线 2D 特效，如 `gauss-blur`）：

- 识别 JSON EffectAsset；备份为 `*.effect.compiled.json`
- 用 builtin-sprite 模板重建 vert；从 `glsl3.frag` 抽出自定义逻辑（如 `mainImage` / `FragConstants`）
- 写出 YAML 源，**保留原 UUID**，便于材质继续引用

验证：`gauss-blur.effect` → `imported: true, invalid: false`；
再 `reimport` 对应 `.mtl` 应同样通过。

## Creator 工程：脚本 CID → UUID + TS stub（必要步骤）

Prefab/场景里挂的是编译期 `_RF.push` 的 **23 位 CID**，而逻辑稿
`.logic.js` 导入时 meta 是**新随机 UUID** → 大量
`Script "…" is missing or invalid`。

在资源侧（image/spine/mtl/effect）OK 后执行：

```bash
node tools/mcp-cocos-inspector/fix-script-cid-map.mjs <工程>/scripts \
  --restored-root <dump>/scripts-split
```

行为：

- 扫 `*-restored` 的 `_RF.push(cid, mod)`，用 Creator 同款算法 decompress → 原 UUID
- 生成可编译 **TypeScript stub**（真 `@ccclass` + `extends Component`），写入同路径 `.ts`
- 删除对应 `.logic.js`（避免双份）；原稿进 `<工程>/_logic-bak/`
- stub 只为消 missing / 挂回组件，**不保证可玩逻辑**

验证：打开 UI Prefab 后，原先 14 个高频 missing CID 应能 `query-asset-info(decompress(cid))` 命中；
控制台 `Script … missing` 显著下降。Creator 若因批量刷新掉线，重开工程后再 refresh `_scripts`。

**重要（节点空白 / 仍 missing）**：不要把 `assets/_scripts` 做成指向
`scripts-split/*-logic` 的 symlink。realpath 落在工程 `assets/` 外时，
编程打包器**不会**给模块挂 uuid / 注入 `_RF.push`，类注册失败，Prefab 全粉。

正确做法：

```bash
# 1) 先生成 stub（可对 scripts-split/*-logic 或已物化目录）
node tools/mcp-cocos-inspector/fix-script-cid-map.mjs <scripts根> \
  --restored-root <dump>/scripts-split

# 2) 物化进工程内真实目录 assets/scripts（断外链）
node tools/mcp-cocos-inspector/materialize-project-scripts.mjs <export-full工程根>
```

stub 内已显式 `cclegacy._RF.push(cid, …)`，避免 packer 漏注入。
验证编译 chunk 含 `_RF.push({}, '<cid>'`；`soft-reload` 后 missing 应清空。

## Creator 工程：场景节点 `_id` 与资源 UUID 冲突（层级不渲染）

cc-reverse 场景里 Prefab 实例根节点常把 `_id` 写成**场景资源 UUID**，
与 `cc.Scene` 根撞车 → 层级面板「过滤重复 UUID」+ `Maximum call stack`，
树只剩空 / 只见一层。

```bash
# 先在 Creator 关闭该场景（或不保存关闭），再跑：
node tools/mcp-cocos-inspector/fix-scene-node-ids.mjs <工程>/assets
```

行为：节点 `_id ===` 该文件 `.meta.uuid`（或节点间重复）时清空 `_id`。  
另：3.8 工程建议把 `.fire` 重命名为 `.scene`（保留 meta UUID）。

验证：引擎 `query-node-tree` 无重复 UUID；层级可展开。  
若出现全部场景 `download failed: import://db/db://…`，是场景进程挂了，**重启 Creator** 后再开。

**PrefabInstance 根 `_id` 撞 SceneAsset UUID**（如 `BigWinAnimPlayer` 与 `game_scene` 同号）：
会刷「重复 UUID … 屏蔽节点树」+ `Maximum call stack`。  
`fix-scene-node-ids.mjs` 会改成唯一压缩 UUID；若 Creator 刷新又写回，需在场景里改掉该节点 uuid 后 `save-scene` 一次，让 PrefabInstance 序列化被重写。

## 实现

- `src/cocos3/runtimeDump.ts`
- `tools/mcp-cocos-inspector/expand-bundle-urls.mjs`
- `tools/mcp-cocos-inspector/runtime-dump-lib.mjs`
- `tools/mcp-cocos-inspector/split-system-register.mjs`
- `tools/mcp-cocos-inspector/readableize-system-register.mjs`
- `tools/mcp-cocos-inspector/restore-scripts-l3.mjs`
- `tools/mcp-cocos-inspector/fix-image-shell-dirs.mjs`
- `tools/mcp-cocos-inspector/fix-scene-node-ids.mjs`
- `tools/mcp-cocos-inspector/fix-spine-from-import.mjs`
- `tools/mcp-cocos-inspector/fix-sprite-atlas-from-import.mjs`
- `tools/mcp-cocos-inspector/expand-compressed-uuids.mjs`
- `tools/mcp-cocos-inspector/fix-materials.mjs`
- `tools/mcp-cocos-inspector/fix-compiled-effects.mjs`
- `tools/mcp-cocos-inspector/fix-script-cid-map.mjs`
- `tools/mcp-cocos-inspector/materialize-project-scripts.mjs`
- MCP：`index.mjs` → `cocos_dump_runtime`
