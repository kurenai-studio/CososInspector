# Egret 支持（MVP）

同一 Chrome 扩展在 **Egret 5.x**（含 2.x 兼容）游戏页上自动识别引擎、挂载 Inspector 面板与 MCP 桥。无需开关，**window.egret + stage 可解析** 即视为 Egret 页。

## 检测与定位

- 强证据：`window.egret` 存在 + `egret.sys.$TempStage`（5.x WebGL）或 `egret.MainContext.instance.stage`（2.x）可解析
- 无需 early probe / webpack 钩子（与 Pixi 路径不同）
- 与 Cocos 互斥：检测顺序 Cocos → Egret → Pixi

## 能力

| 能力 | 说明 |
|------|------|
| 显示对象树 | `stage.$children` 递归；过滤其它检视插件遮罩节点（`$*INSPECT*MASK*`） |
| visible | 树节点勾选 → `node.visible` |
| 贴图清单 | MCP `listSprites`：Bitmap/MovieClip 节点的纹理元数据 |
| 纹理提取 | MCP `downloadTexture`：按 `$bitmapX/Y/W/H` 从图集裁剪子图 |
| **资源清单** | MCP `listResources`：基于 `RES.config.config.fileSystem.fsData` 展开为绝对 URL，标记 `inUse`（当前显示列表引用） |
| **原始资源下载** | MCP `downloadResource`：解析资源名→URL，页内 `fetch` 拿原始字节；fetch 失败时回退到从已解码 `HTMLImageElement` 整图导出 |
| 暂停 | `egret.ticker.pause` / `resume` |
| 截图 | `stage.$canvas` 或 `.egret-player canvas` |
| MCP | `window.__cocosInspectorApi`（与 Cocos 共用协议） |

### 纹理字段（5.x WebGL）

```
Texture
  $bitmapData        // 2D 模式：HTMLImageElement；WebGL 模式：引擎包装对象
    .$source         // WebGL 包装内的真实图源（HTMLImageElement）
      .src           // 原始 URL（webp/jpg/png）
  $bitmapX/Y/W/H     // 图集中区域
  $offsetX/Y         // trim 偏移
  $textureWidth/Height // 裁剪后逻辑尺寸
```

`downloadTexture` 返回的 `detail.sourceUrl` 即 `$bitmapData.$source.src`，可用于追溯原始图集。

### 资源解析优先级（`resolveResourceUrl`）

1. 入参已是 `http(s)` / `data:` / `blob:` URL → 直传
2. `RES.config.config.fileSystem.fsData[name]` → `{ url, type, root }`
3. `RES.config.config.fileSystem.getFile(name)` → 动态注册资源
4. `RES.config.config.alias[name]` → 子帧引用（`fish_192_json#0`）回溯父级 `_json`
5. 退化为 `resourceRoot + name`

### 原始资源下载回退链

```
downloadResource(nameOrUrl)
  → resolveResourceUrl
  → fetch(url) → arrayBuffer → base64
  → 失败时：findNodeBySourceUrl(url) → extractWholeSourceToPng
       （从已解码 HTMLImageElement 绘制整张源图，等价参考插件 le()）
```

## 限制

- **不做** 属性编辑、鼠标拾取、FPS 显示、FairyGUI（与参考插件对齐，仅核心还原）
- 跨域纹理：CDN 未带 CORS 时 `toDataURL` 会 tainted，需走 fetch 原始字节路径
- RES 之外的资源管线（自定义 loader）不在本期范围

## 本地验证

```bash
npm run build
node tools/verify-egret-cdp.mjs https://qp.bydrqp.com/bkby/platform/1020/index.html
```

脚本使用 Edge（Chrome 137+ 已禁用 `--load-extension`）加载扩展、CDP 导航、轮询 API，最后输出：
- 诊断信息（节点数、贴图数、stage 尺寸）
- 第一个贴图纹理提取结果
- 资源清单前 5 项
- 任一 image 资源的原始字节下载结果（字节数、mime、源 URL）
- 面板截图 `D:/work/egret-verify-shot.png`

参考插件（已逆向）：`hgjkfcojmobceiihkjifeioioffcmond` 1.0.19 的 `inspector.js` 中 `le()` / `ce()` / `de()` 提供了纹理→整图回退思路。
