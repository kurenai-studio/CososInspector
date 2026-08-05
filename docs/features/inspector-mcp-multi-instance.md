# Inspector MCP 多实例（按域名）

## 设计约定

1. **Registry 主键 = 试玩页 URL 域名**（如 `play.godeebxp.com`），不是任意 slug。
2. **单 Chrome 配置**：不依赖多 Profile；多个试玩页可同时打开，各自连对应端口的桥接。
3. **未指定实例时**：若本机仅有一个「在线且扩展已连接」的实例，MCP 自动路由到该实例；多个在线则报错，需显式指定 `domain`。

Registry 文件：`%LOCALAPPDATA%/cocos-inspector/instances.json`（Windows）。

## 启动守护进程

每个试玩域名单独起一个 bridge daemon：

```powershell
cd D:\UGit\CososInspectorNew
npm run cocos-bridge -- --domain play.godeebxp.com --page-url-match godeebxp
```

可选参数：

| 参数 | 环境变量 | 说明 |
|------|----------|------|
| `--domain` | `COCOS_INSPECTOR_DOMAIN` | registry 主键，必填（多实例） |
| `--page-url-match` | `COCOS_PAGE_URL_MATCH` | 扩展路由标签页时的 URL 子串 |
| `--ws-port` | `COCOS_BRIDGE_PORT` | WebSocket 端口，默认 17373 |
| （环境） | `COCOS_BRIDGE_ALLOWED_ORIGINS` | 额外允许的 Origin，逗号分隔；支持 `https://*.example.com` |

## 本地桥安全（Host / Origin）

HTTP（`17374`）与 WebSocket（`17373`）均强制：

1. **Host** 必须是 `127.0.0.1` / `localhost` / `::1`（防 DNS rebinding）
2. **Origin** 缺失时放行（Node / MCP）；若存在则须为 `chrome-extension://` / `moz-extension://` / loopback，或匹配 `--domain` / 扩展上报域名 / `COCOS_BRIDGE_ALLOWED_ORIGINS`
3. **禁止** `Access-Control-Allow-Origin: *`；仅对白名单 Origin 回显 ACAO

恶意网页直连 `http://127.0.0.1:17374` 会得到 `403`。

共享文件目录：`tmp/mcp-share/<domain_underscore>/`。

## Cursor MCP 配置

`~/.cursor/mcp.json` 示例：

```json
{
  "mcpServers": {
    "cocos-inspector": {
      "command": "node",
      "args": ["D:/UGit/CososInspectorNew/tools/mcp-cocos-inspector/index.mjs"],
      "env": {
        "COCOS_INSPECTOR_DOMAIN": "play.godeebxp.com",
        "COCOS_PAGE_URL_MATCH": "godeebxp"
      }
    }
  }
}
```

- 设置 `COCOS_INSPECTOR_DOMAIN` 后，未传 `domain` 的工具调用会默认连该域名实例。
- 仅一个实例在线时，即使未设置 env，也会走 **sole-online** 自动解析。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `cocos_inspector_list_bridges` | 列出 registry 中所有实例及健康状态 |
| `cocos_inspector_health` | 指定 `domain` / `pageUrlMatch` / `wsPort` 的健康检查 |
| 其它 `cocos_*` | 可选参数 `domain`、`wsPort`；路由经 `resolveBridgeTarget` |

## 解析优先级

`domain` > `pageUrlMatch`（匹配 registry 或 tab URL）> `COCOS_INSPECTOR_DOMAIN` > **唯一在线实例** > `COCOS_BRIDGE_PORT` > 唯一 registry 项。

多个实例同时在线且未指定域名时，抛出明确错误并提示调用 `cocos_inspector_list_bridges`。

## 典型流程

1. 终端 A：`npm run cocos-bridge -- --domain play.godeebxp.com --page-url-match godeebxp`
2. Chrome 打开试玩页并 F5，确认扩展 MCP 已连接
3. Cursor 重载 MCP 或重启 Cursor
4. 调用 `cocos_inspector_list_bridges` 确认 `extensionConnected: true`
5. 调用 `cocos_export_scene_snapshot` 等工具
