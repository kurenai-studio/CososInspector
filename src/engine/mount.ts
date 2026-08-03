/**
 * 面板挂载：挂到 <html>，避免试玩页重写 body 时被拆掉；被移除时自动重挂。
 */

export function getInspectorMountParent(): HTMLElement {
  return document.documentElement || document.body;
}

export function mountInspectorRoot(root: HTMLElement): void {
  const parent = getInspectorMountParent();
  if (!parent) {
    throw new Error('documentElement/body 均不可用，无法挂载 Inspector');
  }
  if (root.parentElement !== parent) {
    parent.appendChild(root);
  }

  // 试玩页常清 body / 整页替换子树，盯住 root 被摘掉后重挂
  if ((root as HTMLElement & { __inspMountWatch?: boolean }).__inspMountWatch) {
    return;
  }
  (root as HTMLElement & { __inspMountWatch?: boolean }).__inspMountWatch = true;

  const reattach = (): void => {
    try {
      if (root.isConnected) return;
      const host = getInspectorMountParent();
      if (!host) return;
      host.appendChild(root);
      console.log('[Cocos Inspector] 面板被页面移除，已重新挂载');
    } catch (e) {
      console.error('[Cocos Inspector] 重新挂载失败', e);
    }
  };

  const obs = new MutationObserver(() => {
    if (!root.isConnected) reattach();
  });
  obs.observe(parent, { childList: true, subtree: true });

  // 兜底：定时检查（部分站点用 replaceWith 绕过部分 mutation）
  window.setInterval(reattach, 2000);
}

/** DOM 就绪后再跑（script 注入在 head 时 body 可能仍为 null） */
export function whenDomReady(fn: () => void): void {
  const run = (): void => {
    try {
      fn();
    } catch (e) {
      console.error('[Cocos Inspector] 启动失败', e);
    }
  };
  if (document.documentElement && (document.body || document.readyState !== 'loading')) {
    // 有 html；body 可能稍后才有——仍可挂到 documentElement
    if (document.body || document.documentElement) {
      run();
      return;
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
