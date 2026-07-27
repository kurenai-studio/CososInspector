# Cocos Creator 2.x（含 2.4）支持

> 状态：**P0 已落地**（节点树 / 基础 Inspector / 暂停）。纹理导出、MCP、场景复刻仍仅 3.x。

## 能力矩阵

| 能力 | 3.x | 2.x P0 |
|------|-----|--------|
| 环境检测与面板挂载 | ✓ | ✓ |
| 全量节点树 + Active 切换 | ✓ | ✓ |
| 节点基础属性 Inspector | ✓ | ✓（位置/尺寸/锚点/缩放 + 常见组件摘要） |
| 暂停 / 继续 | ✓ | ✓ |
| Sprite 纹理导出 / 引擎对齐 | ✓ | ✗（P1） |
| MCP 桥接 / 场景快照 | ✓ | ✗（P2） |
| 场景复刻 | ✓ | ✗（P3，且目标仍为 Creator 3 工程） |

## 代码入口

- 统一检测：`src/engine/detect.ts`（`detectEngineFamily` → `'2' | '3'`）
- 启动分流：`src/injected.ts` → `bootInspector()`
- 2.x 实现：`src/cocos2/`（`sceneTree` / `nodeInspector` / `gamePause` / `panel`）

## 验收

1. 打开任意 **Cocos Creator 2.4** 试玩页，加载本扩展  
2. 面板标题为 `Cocos Inspector 2.x`，引擎版本显示 `2.4.x`  
3. 节点树可展开、搜索、勾选 Active  
4. 选中节点可见位置/尺寸等；暂停按钮可停住画面  

## 后续

见设计方案阶段 P1–P3：纹理提取、MCP 快照字段对齐、复刻映射。
