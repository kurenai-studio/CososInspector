# 节点树功能文档

## 功能概述

节点树功能是 Cocos Inspector 的核心功能之一，它允许用户查看和操作 Cocos 游戏场景中的节点树结构。通过这个功能，用户可以直观地了解场景的构成，选择特定节点进行检查和修改。

## 主要功能

### 1. 节点树结构显示

- **场景根节点显示**: 显示当前场景的根节点
- **子节点层级关系**: 以树形结构展示节点的层级关系
- **节点基本信息**: 显示节点名称、激活状态等基本信息
- **节点类型标识**: 通过图标区分不同类型的节点

### 2. 节点展开与折叠

- **交互式展开/折叠**: 点击箭头图标展开或折叠子节点
- **记忆展开状态**: 刷新时保持节点的展开状态
- **批量展开/折叠**: 支持展开/折叠特定层级的所有节点

### 3. 节点选择

- **单击选择**: 单击节点可选中该节点
- **高亮显示**: 被选中的节点在树中高亮显示
- **视觉反馈**: 选中节点时在游戏视图中显示节点边界框

### 4. 节点搜索

- **节点名称搜索**: 根据节点名称进行搜索
- **实时过滤**: 在输入搜索内容时实时过滤节点树
- **搜索结果高亮**: 高亮显示匹配的搜索结果

### 5. 节点状态指示与 Active 编辑

- **激活状态指示**: 非激活节点名称显示删除线并降低透明度
- **行内 Active 勾选**: 每个节点行前有 checkbox，可直接切换 `node.active`（场景根除外）
- **即时生效**: 勾选后立即写入引擎并刷新树视图

### 6. 全量场景树

- **完整层级**: 显示场景下所有节点，不做 Sprite 过滤或路径压缩
- **子节点排序**: 按名称字母序排列

### 7. 收起后零渲染

- **收起面板**时从 DOM 移除主面板、清空节点树 HTML、停止 500ms 自动刷新
- 页面仅保留右侧 **「节点树」** 边缘标签，不影响游戏性能
- **点击标签**重新挂载面板并刷新场景树

### 8. 工具栏（v3.3.34）

主干 2.x / 3.x 面板工具栏：

- **刷新** / **暂停** / **拾取** / **下载** / 节点搜索 / **收起**
- 「收起」固定在工具栏右侧，`flex-shrink: 0`，不再被裁切
- **拾取**：十字光标 + capture 拦截点击；悬停画包围盒；点击选中并展开祖先
  （Esc 取消）
  - 3.x **2D**：UI 相机 `screenToWorld` + `UITransform` 世界盒
  - 3.x **3D**（v3.3.36）：场景透视相机射线 vs `MeshRenderer` AABB，
    青色线框；小块 UI 优先，整屏 Canvas 不抢 3D 命中
  - 2.x：`getBoundingBoxToWorld`
- **下载**（Chrome 目录选择，复用已有导出，不含龙骨/图集裁剪）：
  - 选中节点纹理 PNG
  - 选中节点子树 Sprite PNG
  - 选中节点 Spine zip / BMFont zip
  - 整场景 Sprite PNG
- **MCP 未连接**：点击右上角指示灯弹出安装指引（GitHub 仓库 + 本机桥步骤）
- **已从面板移除**：「标准」粒度、「扫描 DC」、「清除」、「资源」
  （试玩页兼容性差；源码仍留在 `perfScan.ts` / `assetPanel.ts`，面板不再暴露入口）

### 9. 节点 Inspector（全部组件）

主面板**底部**显示 Inspector，选中节点后列出该节点上**全部 Component**（不做可渲染过滤）。

- 顶部 **Node** 区块显示 **位置**（`node.position`，本地坐标 x/y/z）
- **UITransform** 首行同样显示位置，便于对照 Creator
- 面板标题旁显示扩展版本号（如 `v2.1.0`），下方为引擎版本
- 常见组件（Sprite、Label、UITransform、Widget 等）展示专用字段
- 其余组件展示公开属性（最多 16 项）
- Sprite 组件额外异步加载贴图预览
- 自定义组件旁 **「还原 TS」**：从运行时导出 `.recovered.ts` 草稿（见 `docs/features/script-recover.md`）
- **sp.Skeleton** 旁 **「导出 Spine」**：从内存导出 json/atlas/纹理 zip，多页 atlas 纹理名与 `.atlas` 页一致（见 `docs/features/spine-export.md`）

### 10. 游戏暂停（看属性）

工具栏 **「暂停」/「继续」**：调用 `cc.director.pause()` / `resume()`，停住后可继续点节点看 Inspector（位置等）。

- 状态栏会追加 `· 已暂停`
- MCP：`cocos_pause_game` / `cocos_resume_game` / `cocos_toggle_pause`（可选 `mode`: `director` | `game` | `both`）
- `cocos_page_info` 返回 `paused` / `pause` 字段
- **限制**：部分 Slots 自管 setTimeout/ticker，可能不完全跟随 director；可试 `mode: both`

## 技术实现

### 节点树生成

```typescript
// src/cocos3/sceneTree.ts — 全量树数据
const treeInfo = buildTreeInfo(scene);

// src/cocos3/treeRender.ts — 渲染 HTML（含 active checkbox）
renderTreeHtml(treeInfo, {
  expanded: expandedScene,
  selectedId,
  searchQuery,
  isRoot: true,
  sceneRootId: getNodeId(scene),
});
```

Active 切换：

```typescript
// src/cocos3/sceneTree.ts
export function setNodeActive(nodeId: string, active: boolean): boolean {
  const scene = getSceneRoot();
  const node = scene && findNodeById(scene, nodeId);
  if (!node || node === scene) return false;
  node.active = active;
  return true;
}
```

### 增量更新机制

为了提高性能，节点树采用了增量更新机制，只更新发生变化的部分：

```typescript
private updateNodeTreeIncremental(scene: cc.Node): void {
  try {
    // 检查场景结构是否发生变化
    if (!this.hasSceneStructureChanged(scene)) {
      console.log('[增量更新:树] 场景结构未变化，跳过更新');
      return;
    }

    // 生成节点哈希值并进行比对
    // 只更新发生变化的节点分支
    // ...
  } catch (error) {
    console.error('[增量更新:树] 更新失败:', error);
    // 回退到完全刷新
    this.forceRefreshTree();
  }
}
```

## 用户交互处理

节点树支持以下用户交互操作：

1. **点击节点**: 选中节点，显示其详细信息
2. **点击展开/折叠图标**: 展开或折叠子节点
3. **右键节点**: 显示上下文菜单（开发中）

## 配置选项

节点树功能提供以下配置选项：

| 配置项         | 默认值 | 说明                     |
| -------------- | ------ | ------------------------ |
| 自动展开层级   | 2      | 初始化时自动展开的层级数 |
| 节点排序方式   | 按名称 | 子节点的排序方式         |
| 显示非激活节点 | 是     | 是否显示非激活状态的节点 |

## 性能优化

为了确保在节点数量较多时保持良好的性能，节点树功能实现了以下优化措施：

1. **增量更新**: 只更新发生变化的节点，减少 DOM 操作
2. **延迟加载**: 大型节点树采用延迟加载机制
3. **虚拟滚动**: 只渲染可视区域内的节点（计划中）
4. **更新节流**: 控制更新频率，避免频繁更新

## 已知问题和限制

1. 当场景节点超过 5000 个时，可能出现性能下降
2. 特殊的节点名称（包含 HTML 特殊字符）可能导致显示问题
3. 极深层级的节点树（超过 20 层）可能影响用户体验

## 未来计划

1. 添加节点搜索功能
2. 实现节点拖拽重排功能
3. 支持自定义节点过滤器
4. 添加节点路径复制功能
