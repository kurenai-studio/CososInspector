# 脚本还原（运行时）

从游戏页面**运行时**提取自定义组件，生成 TypeScript **草稿**（非原始源码）。

## 使用步骤

1. 打开游戏页面，展开 Cocos Inspector
2. 在节点树选中挂有脚本的节点（如 `Canvas` → `MainController`）
3. 底部 Inspector 中，自定义组件标题旁点击 **「还原 TS」**
4. 自动下载 `{ClassName}.recovered.ts`，并尝试复制到剪贴板

## 输出内容

- `@property` 字段列表（从运行时实例读取）
- 类型推断（`number` / `string` / `Node` 等）
- 注释块内的**编译后 JS**（`toString()` + 原型方法），供人工逆向

## 限制

- **不是**原始 `.ts` 源码；逻辑需对照编译代码手工整理
- 若无 `cc.js.getClassByName`，编译代码块可能为空
- 生产包混淆严重时，方法体可读性很差
- 仓库内 FastSpin HAR 提取物**不包含**其他项目的 `MainController`

## HAR 辅助（可选）

若你有该游戏的 HAR，可在提取的 JS 目录中搜索：

```bash
rg "MainController|ccclass.*MainController" ./extracted/
```

有 `.js.map` 时还原质量会高很多。

## 批量运行时 Dump

若要导出**整页已加载**脚本/URL 再离线拆包，用 MCP `cocos_dump_runtime`（见 [runtime-dump-reverse.md](./runtime-dump-reverse.md)），不要只靠单组件「还原 TS」。  
包级逻辑还原的标准与三层产物见 [bundle-logic-recovery.md](./bundle-logic-recovery.md)。

## 实现

- `src/cocos3/scriptRecover.ts`
- Inspector 按钮：`renderableInspector.ts`
