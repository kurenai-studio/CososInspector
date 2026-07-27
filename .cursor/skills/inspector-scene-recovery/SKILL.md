---
name: inspector-scene-recovery
description: >-
  Inspector 试玩页 → Creator 场景复刻（P+S 编排）。S 侧用本仓库 cocos-inspector MCP
  读快照/纹理；P 侧用 cocos-meta-mcp 在 Creator 建树与磁盘补丁。使用时机：复刻试玩场景、
  scene-to-creator、PowerOfThor2/godeebxp 恢复、纹理 manifest 绑定。
---

# Inspector → Creator 场景复刻（本仓库 Skill）

## 角色分工（P + S）

| 侧 | 工具 / Skill | 职责 |
|----|----------------|------|
| **S（读取）** | 本仓库 `cocos-inspector` MCP + 扩展 | 试玩页快照、Sprite 纹理、诊断日志 |
| **P（写入）** | `cocosmcp` + Skill **`cocos-meta-mcp-scene`** | Creator 建树、`save-scene`、磁盘补丁约束 |
| **编排** | 本 Skill + `docs/features/scene-recovery.md` | 端到端命令、参数、验收 |

上游 **`cocos-meta-mcp-scene`** 工作流 D 只写 P 侧；S 侧快照与纹理**必须读本 Skill**。

相关上游 Skill（个人目录 `~/.cursor/skills/`，连接前应先读）：

- `cocos-meta-mcp-scene` — 建场景、避免 dirty 弹窗、批量补丁约束
- `creator-scene-editing` — eval 操作场景，禁止手改 `.scene`
- `cocos-meta-mcp-recipes` — `cocosmcp` 注册表与 preview/console recipe
- `creator-preview-refresh` — TS 改完强制进预览验收

## 前置

1. `npm run build` + Chrome 重载扩展（标题应显示 `v2.x`）
2. 终端常驻：`npm run cocos-bridge -- --domain <host> --page-url-match <url片段>`
3. Cursor MCP：`cocos-inspector`（本仓库 `tools/mcp-cocos-inspector/index.mjs`）
4. Creator 打开目标工程，`cocos-meta-mcp` 扩展启用；MCP `cocosmcp` 的 `cwd` 指向工程根
5. 试玩页 F5，Inspector MCP 绿点；`cocos_inspector_list_bridges` 确认 `extensionConnected`

多实例路由见 `docs/features/inspector-mcp-multi-instance.md`（优先 `wsPort` / `domain`）。

## S 侧：导出快照与纹理

```text
cocos_export_scene_snapshot → tmp/<game>-scene-snapshot.json
cocos_list_sprites（或缓存 --live-sprites JSON）
cocos_download_texture / scene-to-creator --with-textures
```

**nodeId 漂移**：快照 ID 与试玩页 live ID 常不一致；`scene-to-creator` 按 **path** 匹配 live
sprite 再 `downloadTexture`，manifest 仍 keyed 快照 id。可 `--live-sprites` 跳过慢速
`listSprites`。

```powershell
cd D:\UGit\CososInspectorNew
npm run cocos-scene-to-creator -- tmp/<game>-scene-snapshot.json `
  --project D:/workspace/<cocos-project> `
  --scene assets/scene/<game>_recovered.scene `
  --clear --with-textures `
  --page-url-match <url片段> --ws-port 17373 `
  --live-sprites tmp/<game>-live-sprites.json `
  --manifest tmp/<game>-texture-manifest.json `
  --max-nodes 5000 --max-sprites 600
```

仅纹理：`--textures-only --force-textures`；仅绑定：`--skip-textures`。

## P 侧：Creator 重建与补丁

1. `scene-to-creator` 通过 `%LOCALAPPDATA%/cocos-meta-mcp/instances.json` 解析工程端口
2. 建树走 `cocosmcp_exec` eval（见上游 `cocos-meta-mcp-scene` 工作流 B/D）
3. Sprite/Mask/UITransform 引用类字段：`scene-patch-disk.mjs` 程序化写盘
4. **补丁后**：关闭场景选「不保存」→ 重新打开（勿在 Creator 内 save 覆盖补丁）
5. 补丁 PNG 的 `.meta` 设 `trimType:none` 后**勿**对该资源 `refresh-asset`

一键磁盘修复：

```powershell
node tools/mcp-cocos-inspector/repair-scene-all.mjs `
  tmp/<game>-texture-manifest.json tmp/<game>-scene-snapshot.json
```

（默认 scene 路径以脚本内 `SCENE_REL` 为准，非 godeebxp 工程需改参数或走 `scene-to-creator`。）

## 验收清单

- [ ] `cocos_page_info` → `hasCocos: true`
- [ ] 快照节点数与试玩页量级一致
- [ ] manifest `ok` > 0，`uniqueFiles` 合理
- [ ] Creator 场景节点数接近快照（±动态节点）
- [ ] Canvas 设计分辨率、主要 Sprite 贴图可见
- [ ] 符号/遮罩区域无异常溢出（Mask 补丁）

## 与本仓库其它能力区分

| 能力 | 分支 / 文档 |
|------|-------------|
| 试玩页换皮、替换包、repack-web | `feat/texture-replace`、`tools/repack-web/` |
| 场景复刻到 Creator | **本 Skill**、`docs/features/scene-recovery.md` |

## 实现索引

- `tools/mcp-cocos-inspector/scene-to-creator.mjs`
- `tools/mcp-cocos-inspector/scene-patch-disk.mjs`
- `tools/mcp-cocos-inspector/scene-snapshot-parse.mjs`
- `src/cocos3/sceneSnapshot.ts`、`spriteDownload.ts`
- `src/cocos2/sceneSnapshot.ts`、`mcpBridge.ts`（2.x → 3.x 复刻读侧）
- `docs/features/scene-recovery.md`、`docs/features/cocos2-support.md`
