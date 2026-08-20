# 反馈 BUG（诊断日志）

## 功能概述

面板标题栏提供 **「反馈」** 按钮，仅导出本机诊断日志（环形缓冲），用于远端用户复现后把日志包发回排查。不上报服务器、不采集节点树/截图。

## 使用步骤

1. 保持 Inspector 面板展开，按远端步骤复现问题（例如：开着面板按 F12）
2. 点标题栏 **反馈**
3. 可选填写现象说明
4. 点 **下载日志包**（或复制日志），把 `cocos-inspector-bug-*.txt` 发回

## 自动采集内容

| 类型 | 说明 |
|------|------|
| 环境快照 | 扩展版本、引擎族、URL host/path、inner/outer/screen、dpr、visualViewport |
| 启发式标记 | `suspectDevToolsDock`、`suspectNarrowMobileLayout`、pointer/hover、maxTouchPoints |
| 按键 | F12 / Ctrl+Shift+I\|J / Ctrl+Shift+M，以及其后 250ms/1s/3s 的视口快照 |
| 面板 | 展开/收起 |
| 其它 | visibilitychange、resize（去抖） |

控制台前缀：`[Cocos Inspector:诊断]`。

## 隐私

仅在用户主动点「下载/复制」时生成本地文本；详见 `docs/privacy.md`。

## 实现

- `src/engine/diagLog.ts` — 环形缓冲
- `src/engine/viewportWatch.ts` — F12/视口监视
- `src/engine/bugFeedback.ts` — UI 与导出
- 四引擎面板 header 共用按钮
