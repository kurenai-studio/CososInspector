# Cocos Inspector 3 文档索引

当前主能力：**试玩页场景读取（S）+ Creator 场景复刻（P）+ MCP 自动化**。版本见 `package.json`（如 v2.1.0）。

## Agent Skills（本仓库）

| Skill | 路径 | 何时读 |
|-------|------|--------|
| **场景复刻 P+S** | `.cursor/skills/inspector-scene-recovery/SKILL.md` | 试玩页 → Creator 恢复、scene-to-creator |
| （上游）建场景 P 侧 | `~/.cursor/skills/cocos-meta-mcp-scene/` | Creator 建树、save-scene、磁盘流程 |
| （上游）场景编辑原则 | `~/.cursor/skills/creator-scene-editing/` | eval 改节点，禁止手改 `.scene` |
| （上游）cocosmcp Recipe | `~/.cursor/skills/cocos-meta-mcp-recipes/` | 连接 cocosmcp 前 |

换皮/替换纹理为**分支能力**（`feat/texture-replace`），见 `tools/repack-web/README.md`。

## 功能文档

| 文档 | 说明 |
|------|------|
| [cocos2-support.md](features/cocos2-support.md) | Creator 2.x（含 2.4）P0–P3a 支持 |
| [scene-recovery.md](features/scene-recovery.md) | Inspector → Creator 场景恢复（详细） |
| [inspector-mcp-multi-instance.md](features/inspector-mcp-multi-instance.md) | 多试玩域 MCP 桥接 |
| [node-tree.md](features/node-tree.md) | 节点树、Inspector 面板、位置显示 |
| [spine-export.md](features/spine-export.md) | Spine 内存导出 |
| [script-recover.md](features/script-recover.md) | 自定义组件 TS 草稿 |
| [asset-loading.md](features/asset-loading.md) | 资源浮窗 |
| [slots-dev-loop.md](slots-dev-loop.md) | Slots 开发闭环图 |

## 工具

| 文档 | 说明 |
|------|------|
| [../tools/mcp-cocos-inspector/README.md](../tools/mcp-cocos-inspector/README.md) | Inspector MCP 工具列表 |
| [../tools/repack-web/README.md](../tools/repack-web/README.md) | 换皮 Web 重打包 |
| [technical-challenges/README.md](technical-challenges/README.md) | 难点技术图示 |

## 历史 / 参考

- `design/` — 旧版架构与钩子设计，**不再描述当前实现**
- `features/hooks.md`、`inspector.md`、`performance.md`、`ui-controls.md` — 2.x 已移除能力，仅作参考
- `fastspin-analysis/` — FastSpin 逆向（`archive/legacy-main` 时代产物）

实现代码：`src/cocos3/`、`tools/mcp-cocos-inspector/`。根目录 [README.md](../README.md) 含构建安装说明。
