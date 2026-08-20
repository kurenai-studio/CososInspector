# UI 控制功能文档

## 功能概述

UI 控制功能提供了 Cocos Inspector 的用户界面交互元素和操作方式，确保用户能够方便地使用和控制检查器的各项功能。该功能包括检查器面板的布局控制、交互元素设计、快捷键支持以及界面主题等多个方面，旨在提供直观且高效的调试体验。

## 主要功能

### 1. 检查器面板控制

- **面板展开/折叠**: 支持一键展开或折叠检查器面板
- **面板大小调整**: 支持拖拽调整检查器面板宽度
- **面板位置设置**: 支持配置检查器面板的显示位置
- **面板样式定制**: 支持自定义面板的视觉样式

### 2. 同步模式控制

- **自动/手动切换**: 支持在自动更新和手动更新模式之间切换
- **刷新按钮**: 在手动模式下提供刷新按钮
- **强制刷新按钮**: 提供强制完全刷新选项
- **模式状态显示**: 显示当前的同步模式状态

### 3. 快捷键支持

- **查看器切换**: 使用快捷键快速显示/隐藏检查器面板
- **刷新操作**: 使用快捷键触发刷新操作
- **节点导航**: 使用快捷键在节点树中导航
- **功能切换**: 使用快捷键快速切换不同功能

### 4. 状态指示器

- **更新状态**: 显示当前检查器的更新状态
- **错误提示**: 显示出现的错误信息
- **性能警告**: 在性能问题时显示警告
- **操作反馈**: 提供用户操作的视觉反馈
- **反馈 BUG**: 标题栏「反馈」导出诊断日志（本地 txt，详见 [bug-feedback.md](./bug-feedback.md)）

### 5. 上下文菜单

- **节点上下文菜单**: 右键点击节点显示操作菜单
- **组件上下文菜单**: 右键点击组件显示操作菜单
- **快捷操作**: 提供常用操作的快捷方式
- **功能扩展**: 支持通过上下文菜单访问扩展功能

## 技术实现

### 检查器面板创建与控制

检查器面板的创建与基本控制：

```typescript
private createUI(): void {
  this.container = document.createElement('div');
  this.container.className = 'cocos-inspector';

  // 添加CSS样式
  const style = document.createElement('style');
  style.textContent = `
    /* 基本样式 */
    .cocos-inspector {
      position: fixed;
      top: 0;
      right: 0;
      width: 600px;
      height: 100%;
      background-color: #252526;
      color: #cccccc;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 12px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      box-shadow: -2px 0 5px rgba(0, 0, 0, 0.3);
      transition: transform 0.3s ease;
    }

    /* 折叠按钮样式 */
    .collapse-btn {
      position: absolute;
      left: -20px;
      top: 50%;
      width: 20px;
      height: 40px;
      background-color: #252526;
      cursor: pointer;
      border-radius: 3px 0 0 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: -2px 0 5px rgba(0, 0, 0, 0.3);
    }
    .collapse-btn::before {
      content: "◀";
      color: #cccccc;
    }
    .cocos-inspector.collapsed .collapse-btn::before {
      content: "▶";
    }

    /* 更多样式... */
  `;
  document.head.appendChild(style);

  // 添加折叠按钮
  const collapseBtn = document.createElement('div');
  collapseBtn.className = 'collapse-btn';
  collapseBtn.addEventListener('click', () => this.toggleCollapse());
  this.container.appendChild(collapseBtn);

  // 创建头部、内容区等
  // ...

  document.body.appendChild(this.container);
}
```

### 面板折叠/展开控制

支持检查器面板的折叠与展开：

```typescript
private toggleCollapse(): void {
  if (!this.container) return;

  this.isCollapsed = !this.isCollapsed;

  if (this.isCollapsed) {
    // 记住当前宽度并折叠
    this.lastWidth = this.container.offsetWidth;
    this.container.style.transform = `translateX(${this.lastWidth}px)`;
    this.container.classList.add('collapsed');
  } else {
    // 展开到之前的宽度
    this.container.style.transform = 'translateX(0)';
    this.container.classList.remove('collapsed');
  }

  // 存储折叠状态
  localStorage.setItem('cocos-inspector-collapsed', this.isCollapsed.toString());
}
```

### 同步模式切换

自动/手动同步模式的切换实现：

```typescript
private setSyncMode(mode: SyncMode): void {
  if (this.syncMode === mode) return;

  this.syncMode = mode;

  // 更新UI状态
  const container = this.container;
  if (!container) return;

  const autoBtn = container.querySelector('[data-mode="auto"]');
  const manualBtn = container.querySelector('[data-mode="manual"]');

  if (autoBtn && manualBtn) {
    if (mode === SyncMode.AUTO) {
      autoBtn.classList.add('active');
      manualBtn.classList.remove('active');
      this.startAutoUpdate();
    } else {
      autoBtn.classList.remove('active');
      manualBtn.classList.add('active');
      this.stopAutoUpdate();
    }
  }

  // 存储同步模式设置
  localStorage.setItem('cocos-inspector-sync-mode', mode);

  console.log(`[Cocos Inspector] 同步模式已切换为: ${mode === SyncMode.AUTO ? '自动' : '手动'}`);
}
```

### 快捷键支持

为检查器添加快捷键支持：

```typescript
private setupKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    // 按 Alt+I 切换Inspector的显示/隐藏
    if (e.altKey && e.key === 'i') {
      this.toggleCollapse();
      e.preventDefault();
    }

    // 按 Alt+R 手动刷新
    if (e.altKey && e.key === 'r') {
      this.updateTree();
      e.preventDefault();
    }

    // 按 Alt+F 强制完全刷新
    if (e.altKey && e.key === 'f') {
      this.forceRefreshTree();
      e.preventDefault();
    }

    // 按 Alt+M 切换同步模式
    if (e.altKey && e.key === 'm') {
      this.setSyncMode(this.syncMode === SyncMode.AUTO ? SyncMode.MANUAL : SyncMode.AUTO);
      e.preventDefault();
    }

    // 按 Esc 关闭打开的对话框
    if (e.key === 'Escape') {
      const dialogs = document.querySelectorAll('.modal-background');
      dialogs.forEach(dialog => {
        if (dialog.parentNode) {
          dialog.parentNode.removeChild(dialog);
        }
      });
    }
  });
}
```

### 状态指示器实现

更新和错误状态指示器：

```typescript
private showUpdatingIndicator(): void {
  if (!this.container) return;

  // 移除可能存在的旧指示器
  this.hideUpdatingIndicator();

  // 创建新的更新指示器
  const indicator = document.createElement('div');
  indicator.className = 'updating-indicator';
  indicator.textContent = '正在更新...';
  indicator.dataset.timestamp = Date.now().toString();

  this.container.appendChild(indicator);

  // 设置自动隐藏定时器
  setTimeout(() => {
    if (indicator && indicator.parentNode) {
      indicator.parentNode.removeChild(indicator);
    }
  }, 3000);
}

private hideUpdatingIndicator(): void {
  if (!this.container) return;

  const indicators = this.container.querySelectorAll('.updating-indicator');
  indicators.forEach(indicator => {
    if (indicator.parentNode) {
      indicator.parentNode.removeChild(indicator);
    }
  });
}

private showErrorIndicator(message: string): void {
  if (!this.container) return;

  // 移除可能存在的旧指示器
  this.hideErrorIndicator();

  // 创建错误指示器
  const indicator = document.createElement('div');
  indicator.className = 'error-indicator';
  indicator.textContent = `错误: ${message}`;
  indicator.title = message;

  // 添加关闭按钮
  const closeBtn = document.createElement('span');
  closeBtn.className = 'error-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    this.hideErrorIndicator();
  });

  indicator.appendChild(closeBtn);
  this.container.appendChild(indicator);
}
```

## 用户交互流程

### 基本操作流程

1. **启动流程**:

   - 页面加载完成后自动初始化检查器
   - 检查器默认在右侧展开状态
   - 自动检测 Cocos 场景并显示节点树

2. **节点选择流程**:

   - 在节点树中点击节点
   - 节点高亮显示，详细信息面板更新
   - 在游戏视图中显示节点边界框

3. **属性编辑流程**:
   - 选中节点，在详细信息面板查看属性
   - 修改属性值
   - 游戏场景即时更新

### UI 反馈机制

检查器提供多种视觉反馈，确保用户了解当前状态和操作结果：

- **高亮效果**: 选中项使用高亮背景色
- **悬停效果**: 鼠标悬停在可交互元素上显示悬停效果
- **动画过渡**: 使用 CSS 过渡动画提供平滑的视觉体验
- **加载指示**: 在耗时操作时显示加载动画
- **状态图标**: 使用图标指示组件和节点状态

## 主题样式

检查器提供两种主题样式：

1. **暗色主题** (默认):

   - 背景色: #252526
   - 前景色: #cccccc
   - 高亮色: #0e639c

2. **亮色主题**:
   - 背景色: #f3f3f3
   - 前景色: #333333
   - 高亮色: #007acc

主题切换功能计划在未来版本中实现。

## 已知问题和限制

1. 在某些浏览器上，检查器面板的拖拽调整可能不流畅
2. 在某些游戏实现中，快捷键可能与游戏本身的快捷键冲突
3. 在移动设备上，UI 布局可能不够优化
4. 大型场景下，节点树的展开/折叠动画可能不流畅

## 未来计划

1. 添加主题切换功能
2. 改进移动设备上的 UI 体验
3. 添加更多快捷键和操作方式
4. 实现检查器面板的位置自定义
5. 添加更多视觉反馈和动画效果
