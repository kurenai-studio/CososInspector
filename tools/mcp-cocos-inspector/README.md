# MCP — Cocos Inspector 3

Cursor 通过 MCP 控制试玩页上的 Inspector：**无需 Chrome 调试模式**。

## 连接方式：本地服务（`npm run cocos-bridge`）

```text
npm run cocos-bridge  （一个 Node 进程 = 本地服务）
  ├─ WebSocket :17373  ← 扩展 background 常驻连接
  └─ HTTP      :17374  ← 文件共享 + REST API
        └─ 扩展试玩页 __cocosInspectorApi（经 WS 被服务调用）

导出并打包：试玩页 POST /api/export-pack → 服务拉数据 → 写替换包 → **自动 repack** 生成 `repacked_*.html`
（默认 `repack: true`；仅导出可传 `{ "repack": false }`）
```

| API | 作用 |
|-----|------|
| `GET /api/status` | 扩展是否已连 WS、共享目录路径 |
| `POST /api/export-pack` | **在本地服务上执行导出**（body: `{ "pageUrlMatch": "applovin" }`） |

### 共享目录（大图上传/下载）

| 方向 | 做法 |
|------|------|
| **上传替换** | MCP 写入 `tmp/mcp-share/in/`；页面 HTTP 拉图 |
| **下载纹理** | 桥接写入 `out/xxx.png`，返回路径 |

环境变量：`COCOS_MCP_SHARE_DIR`、`COCOS_SHARE_HTTP_PORT`（默认 17374）、`COCOS_BRIDGE_ALLOWED_ORIGINS`（额外 Origin 白名单）

本地桥 **CORS / Host / Origin** 安全说明：[docs/features/mcp-local-bridge-cors.md](../../docs/features/mcp-local-bridge-cors.md)

`cocos_replace_texture` 优先用 **`imagePath`**（本地文件），避免 WebSocket 塞满 base64。

1. 项目根目录启动**常驻桥接**（保持终端不关）：

```powershell
cd D:\UGit\CososInspector
npm run cocos-bridge
```

2. 在 Cursor 启用 `cocos-inspector` MCP（作为客户端连 `17373`）
3. **普通方式**打开 Chrome，打开 Cocos 试玩页
4. 加载 **Cocos Inspector 3** 扩展（`npm run build` 后重载扩展），试玩页 **F5 刷新**

扩展连上桥接后，面板右上角 MCP 应为绿色「已连接」。

### 自动化冒烟

```powershell
npm run cocos-bridge    # 终端 1，保持运行
# Chrome 试玩页 F5，MCP 绿点
npm run build           # 改过 src 后重载扩展
npm run cocos-autotest  # 列 Sprite / 截屏 / 分片导出替换包
```

### 可选：CDP 模式（需调试端口）

仅当你坚持用远程调试时：

```powershell
$env:COCOS_USE_CDP = "1"
# Chrome 需 --remote-debugging-port=9222
```

## 安装

```powershell
cd tools/mcp-cocos-inspector
npm install
```

## Cursor 配置

```json
{
  "mcpServers": {
    "cocos-inspector": {
      "command": "node",
      "args": ["D:/UGit/CososInspector/tools/mcp-cocos-inspector/index.mjs"],
      "env": {
        "COCOS_PAGE_URL_MATCH": "applovin",
        "COCOS_BRIDGE_PORT": "17373"
      }
    }
  }
}
```

`COCOS_PAGE_URL_MATCH`：试玩页 URL 子串，用于在多个标签里选中正确页面。

## 自检

1. `cocos_list_tabs` → `extensionConnected: true`
2. 试玩页控制台：`await window.__cocosInspectorApi?.listSprites()`

若 `extensionConnected: false`：确认 Cursor 已启用 MCP、扩展已重载、试玩页为 http(s)。

## 工具与工作流

| 工具 | 作用 |
|------|------|
| `cocos_list_tabs` | 桥接是否连通 |
| `cocos_page_info` | 试玩页信息（含 `paused`） |
| `cocos_pause_game` / `cocos_resume_game` / `cocos_toggle_pause` | 暂停/恢复游戏以便查看节点属性 |
| `cocos_list_sprites` | 列 UI Sprite（供 Agent 筛选） |
| `cocos_screenshot` | `game` / `node` / `tab`（tab 用扩展截屏，无需 CDP） |
| `cocos_download_texture` | 导出 PNG |
| `cocos_texture_extract_logs` | 纹理提取诊断日志（localStorage，可 `nodeUUID` 过滤） |
| `cocos_replace_texture` | base64 替换预览 |
| `cocos_export_replacement_pack` | 写出替换包 |
| `cocos_get_scene_tree` | 轻量场景树 |
| `cocos_export_scene_snapshot` | 完整场景快照 JSON |
| `cocos_dump_runtime` | 运行时 Dump + 按 config 下载 js/config/import/native → `tmp/runtime-dump/` |
| `cocos_reverse_project` | 对构建目录跑 cc-reverse |
| `cocos_repack_super_html` | 本机重打包 |

运行时 Dump → 离线逆向：`docs/features/runtime-dump-reverse.md`。

Creator 打开 cc-reverse 资源前若出现大量 `EISDIR`，跑：

```powershell
node fix-image-shell-dirs.mjs <工程>/assets --native-root <dump>/build/assets
```

Spine 显示为 JsonAsset / 缺 atlas 时，跑：

```powershell
node fix-spine-from-import.mjs <工程>/assets --bundle-root <dump>/build/assets/resources
```

风格替换流程：截屏 → 列 Sprite → 下载 → GenerateImage → `cocos_replace_texture` → 导出 → 重打包。

**场景复刻**（试玩 → Creator）：读 `.cursor/skills/inspector-scene-recovery/SKILL.md`，详参 `docs/features/scene-recovery.md`。

### HAR 扫粒子（资源 + 参数）

从抓包 HAR 提取粒子 plist/贴图，以及 Prefab 上 `ParticleSystem2D` 的序列化参数（`custom` 覆盖）：

```powershell
npm run extract-har-particles -- play.godeebxp.com.har --out tmp/har-particles-all
```

输出 `manifest.json`：

| kind | 含义 |
|------|------|
| `particleAsset` | plist 底稿参数（`paramSource: plist`） |
| `particleComponent` | Prefab 节点上的对象参数（`paramSource: prefab`，优先） |

同时落盘 `plists/`、`textures/`、`prefabs/`。
