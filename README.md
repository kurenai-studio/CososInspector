# Cocos Inspector 3

面向 **Cocos Creator 3.x** 与 **2.x（含 2.4，P0）** 的 Chrome 扩展 + MCP：在浏览器试玩页查看场景、导出快照与纹理，并配合 **cocos-meta-mcp** 在 Creator 中复刻场景。

> 3.x：完整能力（树 / Inspector / 纹理 / MCP / 复刻）。  
> 2.x：P0 节点树+暂停，P1 Sprite 贴图预览/下载，详见 [docs/features/cocos2-support.md](docs/features/cocos2-support.md)。

## 功能

### 核心（main）

- 场景节点树、Inspector 组件面板（含 **Node 位置**、扩展 **版本号**）
- 工具栏 **暂停/继续**（`director.pause`），停住后看节点属性；MCP：`cocos_pause_game` 等
- MCP：`cocos_export_scene_snapshot`、`cocos_download_texture`、`scene-to-creator` 等
- Spine / BMFont 内存导出、DC 扫描、资源浮窗
- 与 Creator **cocos-meta-mcp** 配合复刻试玩场景（见下方 Skill）

### 分支（换皮）

- Sprite 预览、运行时替换、替换包导出、super-html 重打包（`tools/repack-web`）

## 场景复刻（推荐入口）

1. 读 Agent Skill：**`.cursor/skills/inspector-scene-recovery/SKILL.md`**
2. 详参：**[docs/features/scene-recovery.md](docs/features/scene-recovery.md)**
3. 上游 Creator 侧：Skill `cocos-meta-mcp-scene`（`~/.cursor/skills/`）

```powershell
npm run build
npm run cocos-bridge -- --domain play.godeebxp.com --page-url-match godeebxp
npm run cocos-scene-to-creator -- tmp/scene-snapshot.json `
  --project D:/workspace/testAutoCopy `
  --scene assets/scene/godeebxp_recovered.scene `
  --clear --with-textures --page-url-match godeebxp
```

## 构建与安装

```bash
npm install
npm run build
```

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 加载已解压的扩展 → 选择项目根目录

## 项目结构

```
src/
  content.ts / injected.ts / background.ts
  cocos3/               # 场景树、快照、纹理、MCP 桥
tools/
  mcp-cocos-inspector/  # Inspector MCP + scene-to-creator
  repack-web/           # 换皮 Web（分支能力）
.cursor/skills/
  inspector-scene-recovery/  # 场景复刻 P+S Skill
docs/                   # 见 docs/README.md
```

换皮流程详见 [tools/repack-web/README.md](tools/repack-web/README.md)。

## 开发

```bash
npm run watch
```

修改后重新加载扩展即可。

## 许可证

MIT License
