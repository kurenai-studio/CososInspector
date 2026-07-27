# HAR 抓包（扩展内置，无需 F12）

## 功能概述

通过 Chrome 扩展的 `chrome.debugger` + CDP `Network` 域抓取带 **response body** 的 HAR，用于喂给 harExplore / 离线资源分析。

解决痛点：

- 不必打开 F12（许多试玩页有反调试）
- 开始录制时自动：**清浏览器缓存** + `setCacheDisabled` + `tabs.reload({ bypassCache: true })`，避免磁盘缓存条目 `size: 0` / 无 base64

## 面板用法（2.x / 3.x）

1. 打开试玩页，等 Inspector 面板出现  
2. 点 **录HAR** → attach debugger → 清缓存 → **强制无缓存刷新**  
3. 等资源加载完（状态栏显示请求数 / 含 body 数 / 图片数）  
4. 点 **停HAR**（或再点录制按钮切换）  
5. 点 **导出HAR** → 浏览器下载 `.har`

注意：

- 录制时地址栏可能出现「正在调试此浏览器」提示，属正常现象  
- 同一标签不要同时开 DevTools（会与 debugger 冲突）  
- 首次使用需在扩展管理页允许 `debugger` 权限（manifest 已声明）

## MCP 工具

| 工具 | 说明 |
|------|------|
| `cocos_har_start` | 开始录制；`reload` 默认 `true` |
| `cocos_har_status` | 查询统计 |
| `cocos_har_stop_export` | 停止并经 share 导出；可 `outPath` 复制到指定路径 |

示例：

```text
cocos_har_start → 等游戏资源加载
cocos_har_status → 确认 imageWithBodyCount > 0
cocos_har_stop_export outPath=tmp/game.har
```

然后用 harExplore `npm run serve` 上传该 HAR 预览纹理。

## 实现位置

| 模块 | 路径 |
|------|------|
| CDP 会话 / HAR 组装 | `src/har/harCapture.ts` |
| background 接线 | `src/background.ts`（`__harStart` / `__harStatus` / `__harStopExport`） |
| 面板桥 | `src/har/harPanel.ts` + content `cocos-har-cmd` |
| MCP | `tools/mcp-cocos-inspector/index.mjs` |

版本：**v3.1.0**
