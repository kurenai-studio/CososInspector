# 资源加载状态浮窗

> **v3.3.32**：主干工具栏已去掉「资源」入口。源码仍保留，面板不再暴露。
> 多数试玩包 `cc.assetManager` 不完整，浮窗兼容性差。

## 功能概述

在 Cocos 游戏页面内提供独立浮窗，实时查看 `cc.assetManager` 下的资源缓存与 Bundle 信息，便于排查加载中资源、引用泄漏与 Bundle 依赖。

## 入口与交互

- **v3.3.32 起无面板入口**（原工具栏「资源」按钮已移除）
- 浮窗可 **拖拽标题栏** 移动位置
- **↻** 手动刷新；打开后 **每 1.5s** 自动刷新
- 收起主 Inspector 面板时浮窗自动关闭

## 数据展示

### 摘要行

- 资源总数、Bundle 数量
- 已加载 / 加载中数量
- 管线任务数（`pipeline.taskNum`）

### 资源列表

| 列 | 说明 |
|----|------|
| 名称 | `asset.name`，悬停显示 UUID |
| 类型 | 资源类名（如 `SpriteFrame`） |
| 状态 | 已加载 / 加载中 / 失败 / 未知 |
| 引用 | `refCount` |
| Bundle | 所属 Bundle 名（若能解析） |

默认按引用计数降序；最多显示 500 条，可搜索过滤。

### Bundle 列表

| 列 | 说明 |
|----|------|
| 名称 | Bundle 名 |
| Base | `bundle.base` |
| 资源数 | 配置内资源数量 |
| 依赖 | `deps` 列表 |

## 技术实现

- `src/cocos3/assetInventory.ts` — 遍历 `assetManager.assets` / `bundles`
- `src/cocos3/assetPanel.ts` — 浮窗 UI、拖拽、刷新
- `src/injected.ts` — v3.3.32 起不再挂工具栏按钮

```typescript
const inv = collectAssetInventory();
// inv.summary / inv.assets / inv.bundles
```

## 限制

1. 依赖引擎已初始化 `cc.assetManager`
2. Bundle 与 UUID 的映射为启发式，部分资源可能显示空 Bundle
3. 大型项目资源过多时仅展示前 500 条（可搜索缩小范围）
