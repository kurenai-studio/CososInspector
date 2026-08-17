# Chrome 网上应用店 — 上架材料与清单

> Git 仓库保留完整工程（含 MCP / tools）。**商店安装包只含扩展运行文件。**

## 一键出包

```bash
npm run package
```

产物：`release/cocos-inspector-<version>-store.zip`

本地验证：

1. `chrome://extensions/` → 开发者模式 → **加载已解压的扩展程序**
2. 也可：把 zip 解压到临时目录再加载（根目录须有 `manifest.json`）
3. 打开任意 Creator / Egret 试玩页，确认面板可用

## 开发者控制台

- 控制台首页：https://chrome.google.com/webstore/devconsole  
- 注册开发者（一次性费用，以 Google 当前政策为准）：同一入口引导  
- 上传：**新增商品** → 上传 `release/cocos-inspector-*-store.zip`

## 商店文案（可直接粘贴）

### 名称

```
Cocos Inspector 3
```

### 简短说明（≤ 132 字符，建议）

```
在试玩页查看 Cocos Creator / Egret / PixiJS 场景节点树与资源，辅助 H5 游戏调试与导出。
```

### 详细说明

```
Cocos Inspector 3 是面向游戏开发者的浏览器调试扩展。

【功能】
• 自动识别 Cocos Creator 3.x / 2.x、Egret 5.x；PixiJS 可在弹窗中按需开启
• 场景 / 显示对象节点树、组件属性、暂停继续
• 纹理 / 图集预览与导出（能力随引擎而异）
• 本机可选 MCP 桥接（需自行运行开源仓库中的桥接进程；商店包不含 MCP）

【权限说明】
扩展需在 http/https 页面注入探测脚本，以便在你打开的试玩页工作。未检测到支持的游戏引擎时不会启动完整调试面板。截屏等能力仅在你主动使用时发生。数据默认留在本机，不会上传到我们的服务器。

【开源】
完整源码与 MCP 工具见 GitHub 仓库；网上应用店仅分发扩展本体。

【隐私政策】
见扩展隐私政策链接（提交时填写下方 URL）。
```

### 类别建议

开发者工具 / Developer Tools

### 语言

简体中文（可另加 English 简述）

## 隐私政策 URL（提交必填）

将本仓库 `docs/privacy.md` 推送到**公开**默认分支后，可用其一：

1. **推荐（GitHub Pages / 稳定链接）**  
   若已开启 Pages：`https://shinjiyu.github.io/CososInspector/privacy`  
2. **临时可用**  
   `https://github.com/shinjiyu/CososInspector/blob/main/docs/privacy.md`  
   （若当前发布分支不是 `main`，把路径改成实际分支，例如 `feat/egret`。）

**当前工作区对应原始文件：** `docs/privacy.md`  
推送前请确认远程公开可读，否则审核无法打开链接。

## 单用途说明（审核问答可参考）

本扩展唯一用途：帮助开发者在浏览器中检查游戏引擎场景树与相关资源。  
需要广泛主机权限的原因：试玩包与广告落地页域名高度分散，无法用固定域名列表覆盖；脚本在页内检测引擎，非游戏页不启用完整面板。

## 截图要求（需你本地补拍后上传）

| 资源 | 规格 | 说明 |
|------|------|------|
| 截图 ≥ 1 张 | 1280×800 或 640×400 | 建议：节点树面板 + 试玩页各一张 |
| 小宣传图（可选） | 440×280 | |
| 大宣传图（可选） | 1400×560 | |

截图请勿含无关隐私信息。可放仓库 `docs/store-assets/`（自行创建）备档，**不必打进 zip**。

## 权限与包内容对照

| 含在商店 zip | 不含（仅 Git） |
|--------------|----------------|
| `manifest.json` | `tools/mcp-cocos-inspector` |
| `dist/*`（无 `.map`） | `tools/*` 探针 / 下载器 / GUI |
| `icons/*` | `src/`、`docs/`、`tmp/`、测试 |

## 提交前自检

- [ ] `npm run package` 成功，zip 根目录有 `manifest.json`
- [ ] 版本号与 `package.json` / `manifest.json` 一致
- [ ] 图标 16/48/128 齐全
- [ ] 隐私政策 URL 可公网打开
- [ ] 粘贴商店文案与截图
- [ ] 用「加载已解压」抽测 Creator + Egret 页
- [ ] 说明中写明 MCP 不在商店包内
- [ ] 已写入根目录 `CHANGELOG.md`，并准备商店「最新动态」文案

## 后续发版

商店已上线后，每次主干/商店相关优化都要：

1. 升 `package.json` 与 `manifest.json` 版本号
2. 在根目录 `CHANGELOG.md` 追加条目（含可粘贴的商店「最新动态」文案）
3. 更新本页「当前准备上架版本」

## 版本

当前准备上架版本：**3.3.36**

商店「最新动态 / What's new」可粘贴：

```
3.3.36：Cocos 3.x 支持 3D Mesh 拾取与 AABB 线框高亮。
```

完整变更见仓库根目录 [CHANGELOG.md](../CHANGELOG.md)。
