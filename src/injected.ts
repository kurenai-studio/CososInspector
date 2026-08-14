/// <reference path="./types/cocos.d.ts" />

declare const __INSPECTOR_VERSION__: string;

import { log } from './cocos3/detect';
import { installMcpBridge } from './cocos3/mcpBridge';
import { startCocosInspector2 } from './cocos2/panel';
import {
  detectEngineFamily,
  logEngine,
  waitForEngine,
} from './engine/detect';
import { whenDomReady } from './engine/mount';
import {
  bindMcpInstallGuide,
  syncMcpGuideClickable,
} from './engine/mcpInstallGuide';
import { startPixiInspector } from './pixi/panel';
import { startEgretInspector } from './egret/panel';
import { installPixiConsoleHint } from './pixi/runtime';
import {
  collectNodeInspectorData,
  createNodeInspectorElement,
  hashNodeInspectorData,
  renderNodeInspectorHtml,
} from './cocos3/renderableInspector';
import {
  copyRecoveredScript,
  downloadRecoveredScript,
  recoverComponentScript,
} from './cocos3/scriptRecover';
import { downloadSpineExport } from './cocos3/spineExport';
import { downloadBmfontExport } from './cocos3/bmfontExport';
import {
  collectSpriteInspectData,
  drawSpriteTexture,
  enrichSpriteInspectData,
} from './cocos3/spriteInspector';
import {
  getPauseState,
  togglePause,
} from './cocos3/gamePause';
import {
  buildTreeInfo,
  findNodeById,
  getNodeId,
  getSceneRoot,
  hashTree,
  setNodeActive,
} from './cocos3/sceneTree';
import {
  countNodes,
  expandMatchingNodes,
  renderTreeHtml,
} from './cocos3/treeRender';

const REFRESH_MS = 500;

class CocosInspector3 {
  private root: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private edgeTab: HTMLButtonElement | null = null;
  private sceneTreeContainer: HTMLElement | null = null;
  private nodeInspectorContainer: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private mainBody: HTMLElement | null = null;
  private mcpStatusEl: HTMLElement | null = null;
  private pauseBtn: HTMLButtonElement | null = null;

  private expandedScene = new Set<string>();
  private selectedId: string | null = null;
  private searchQuery = '';
  private isCollapsed = false;
  private sceneTreeHash = '';
  private inspectorHash = '';
  private spritePreviewToken = 0;
  private updateTimer: number | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.createUI();
    this.bindTreeEvents();
    this.bindInspectorEvents();
    this.refreshAll(true);
    this.startAutoRefresh();
    installMcpBridge();
    window.postMessage({ type: 'cocos-inspector-ready' }, '*');
    log('已启动（全量场景树 + Inspector）');
  }

  private createUI(): void {
    this.root = document.createElement('div');
    this.root.className = 'cocos-inspector-root';

    this.edgeTab = document.createElement('button');
    this.edgeTab.type = 'button';
    this.edgeTab.className = 'inspector-edge-tab';
    this.edgeTab.textContent = '节点树';
    this.edgeTab.title = '展开 Cocos Inspector';
    this.edgeTab.setAttribute('aria-label', '展开面板');
    this.edgeTab.addEventListener('click', () => this.setCollapsed(false));
    this.root.appendChild(this.edgeTab);

    this.panel = document.createElement('div');
    this.panel.className = 'cocos-inspector-panel';

    const header = document.createElement('div');
    header.className = 'cocos-inspector-header';

    const headerTop = document.createElement('div');
    headerTop.className = 'inspector-header-top';

    const titleBlock = document.createElement('div');
    titleBlock.className = 'inspector-header-title-block';

    const titleRow = document.createElement('div');
    titleRow.className = 'inspector-title-row';

    const title = document.createElement('h3');
    title.textContent = 'Cocos Inspector 3';
    titleRow.appendChild(title);

    const inspectorVersion = document.createElement('span');
    inspectorVersion.className = 'inspector-version';
    inspectorVersion.textContent = `v${__INSPECTOR_VERSION__}`;
    titleRow.appendChild(inspectorVersion);

    titleBlock.appendChild(titleRow);

    const version = document.createElement('span');
    version.className = 'engine-version';
    version.textContent = `引擎 ${window.cc.ENGINE_VERSION ?? '3.x'}`;
    titleBlock.appendChild(version);

    headerTop.appendChild(titleBlock);

    this.mcpStatusEl = document.createElement('div');
    this.mcpStatusEl.className = 'mcp-status mcp-status--disconnected';
    this.mcpStatusEl.innerHTML =
      '<span class="mcp-status-dot" aria-hidden="true"></span><span class="mcp-status-label">MCP</span>';
    this.updateMcpStatus('disconnected', 17373);
    headerTop.appendChild(this.mcpStatusEl);
    if (this.panel) bindMcpInstallGuide(this.mcpStatusEl, this.panel);

    header.appendChild(headerTop);

    window.addEventListener('message', (ev) => {
      if (ev.source !== window || ev.data?.type !== 'cocos-mcp-status') return;
      this.updateMcpStatus(ev.data.status ?? 'disconnected', ev.data.port ?? 17373);
    });

    const controls = document.createElement('div');
    controls.className = 'inspector-controls';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'refresh-btn';
    refreshBtn.textContent = '刷新';
    refreshBtn.addEventListener('click', () => this.refreshAll(true));
    controls.appendChild(refreshBtn);

    this.pauseBtn = document.createElement('button');
    this.pauseBtn.type = 'button';
    this.pauseBtn.className = 'pause-btn';
    this.pauseBtn.textContent = '暂停';
    this.pauseBtn.title =
      '暂停/恢复游戏（director.pause），便于停住后查看节点属性';
    this.pauseBtn.addEventListener('click', () => this.toggleGamePause());
    controls.appendChild(this.pauseBtn);

    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.className = 'search-input';
    this.searchInput.placeholder = '搜索节点名称…';
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput?.value.trim().toLowerCase() ?? '';
      this.refreshAll(true);
    });
    controls.appendChild(this.searchInput);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'header-toggle-btn';
    toggleBtn.textContent = '收起';
    toggleBtn.title = '收起面板';
    toggleBtn.addEventListener('click', () => this.toggleCollapse());
    controls.appendChild(toggleBtn);

    header.appendChild(controls);
    this.panel.appendChild(header);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'inspector-status';
    this.panel.appendChild(this.statusEl);

    this.mainBody = document.createElement('div');
    this.mainBody.className = 'inspector-main';

    this.sceneTreeContainer = document.createElement('div');
    this.sceneTreeContainer.className = 'node-tree-panel';
    this.mainBody.appendChild(this.sceneTreeContainer);

    this.nodeInspectorContainer = createNodeInspectorElement();
    this.mainBody.appendChild(this.nodeInspectorContainer);

    this.panel.appendChild(this.mainBody);
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);
  }

  private stopAutoRefresh(): void {
    if (this.updateTimer !== null) {
      window.clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  private updateMcpStatus(
    status: 'connecting' | 'connected' | 'disconnected',
    port: number
  ): void {
    if (this.isCollapsed || !this.mcpStatusEl) return;

    const labels: Record<typeof status, string> = {
      connecting: '连接中',
      connected: '已连接',
      disconnected: '未连接',
    };

    this.mcpStatusEl.className = `mcp-status mcp-status--${status}`;
    const label = this.mcpStatusEl.querySelector('.mcp-status-label');
    if (label) label.textContent = `MCP · ${labels[status]}`;

    const hints: Record<typeof status, string> = {
      connecting: `正在连接本机桥接 ws://127.0.0.1:${port} …`,
      connected: `已连接 Cursor MCP 桥接（端口 ${port}）`,
      disconnected: `未连接 MCP。请在 Cursor 启用 cocos-inspector MCP，并确认端口 ${port} 可用。`,
    };
    this.mcpStatusEl.title =
      status === 'disconnected'
        ? '未连接 MCP。点击查看安装指引'
        : hints[status];
    syncMcpGuideClickable(this.mcpStatusEl, status);
  }

  private toggleCollapse(): void {
    this.setCollapsed(!this.isCollapsed);
  }

  /** 收起：从 DOM 移除面板、清空树、停止定时刷新，仅保留边缘标签 */
  private detachPanel(): void {
    if (this.sceneTreeContainer) {
      this.sceneTreeContainer.innerHTML = '';
    }
    if (this.nodeInspectorContainer) {
      const body = this.nodeInspectorContainer.querySelector('.node-inspector-body');
      if (body) {
        body.innerHTML =
          '<div class="node-inspector-empty">选中节点以查看 Inspector</div>';
      }
      const title = this.nodeInspectorContainer.querySelector('.node-inspector-title');
      if (title) title.textContent = 'Inspector';
    }
    this.inspectorHash = '';
    this.spritePreviewToken += 1;
    if (this.statusEl) {
      this.statusEl.textContent = '';
    }
    this.sceneTreeHash = '';
    this.panel?.remove();
  }

  private setCollapsed(collapsed: boolean): void {
    if (!this.root || this.isCollapsed === collapsed) return;

    this.isCollapsed = collapsed;
    this.root.classList.toggle('is-collapsed', collapsed);

    if (collapsed) {
      this.stopAutoRefresh();
      this.detachPanel();
      log('面板已收起，停止渲染');
      return;
    }

    if (this.panel && !this.root.contains(this.panel)) {
      this.root.appendChild(this.panel);
    }

    const headerBtn = this.panel?.querySelector(
      '.header-toggle-btn'
    ) as HTMLButtonElement | null;
    if (headerBtn) {
      headerBtn.textContent = '收起';
      headerBtn.title = '收起面板';
    }

    this.refreshAll(true);
    this.startAutoRefresh();
    log('面板已展开，恢复渲染');
  }

  private startAutoRefresh(): void {
    if (this.isCollapsed) return;
    this.stopAutoRefresh();
    this.updateTimer = window.setInterval(
      () => this.refreshAll(false),
      REFRESH_MS
    );
  }

  private bindTreeEvents(): void {
    this.sceneTreeContainer?.addEventListener('change', (event: Event) => {
      const target = event.target as HTMLElement;
      const toggle = target.closest('.node-active-toggle') as HTMLInputElement | null;
      if (!toggle || toggle.type !== 'checkbox') return;

      event.stopPropagation();
      const nodeId = toggle.dataset.uuid;
      if (!nodeId) return;

      const active = toggle.checked;
      const ok = setNodeActive(nodeId, active);
      if (!ok) {
        toggle.checked = !active;
        console.warn(`[Active编辑] 切换失败 nodeId=${nodeId}`);
        return;
      }

      const scene = getSceneRoot();
      const node = scene ? findNodeById(scene, nodeId) : null;
      const nodeName = node?.name ?? '(unknown)';
      console.log(`[Active编辑] ${nodeName}(${nodeId}) active=${active}`);
      this.refreshAll(true);
    });

    this.sceneTreeContainer?.addEventListener('click', (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.node-active-toggle')) return;

      const toggle = target.closest('.node-toggle');
      const row = target.closest('.node-tree-item');

      if (toggle) {
        const li = toggle.closest('li');
        const id = li?.dataset.uuid;
        if (!id) return;

        if (this.expandedScene.has(id)) {
          this.expandedScene.delete(id);
        } else {
          this.expandedScene.add(id);
        }
        this.refreshAll(true);
        return;
      }

      if (row) {
        const li = row.closest('li');
        const id = li?.dataset.uuid;
        if (!id) return;
        this.selectedId = id;
        this.refreshAll(true);
      }
    });
  }

  private bindInspectorEvents(): void {
    this.nodeInspectorContainer?.addEventListener('click', (event: Event) => {
      const target = event.target as HTMLElement;

      const spineBtn = target.closest(
        '.insp-export-spine-btn'
      ) as HTMLButtonElement | null;
      if (spineBtn) {
        event.stopPropagation();
        if (!this.selectedId) return;
        const idx = Number(spineBtn.dataset.spineIdx ?? '0');
        void this.exportSpine(idx);
        return;
      }

      const bmfontBtn = target.closest(
        '.insp-export-bmfont-btn'
      ) as HTMLButtonElement | null;
      if (bmfontBtn) {
        event.stopPropagation();
        if (!this.selectedId) return;
        const idx = Number(bmfontBtn.dataset.bmfontIdx ?? '0');
        void this.exportBmfont(idx);
        return;
      }

      const btn = target.closest('.insp-recover-btn') as HTMLButtonElement | null;
      if (!btn) return;

      event.stopPropagation();
      const className = btn.dataset.class;
      if (!className || !this.selectedId) return;

      const recovered = recoverComponentScript(this.selectedId, className);
      if (!recovered) {
        this.setStatus(`脚本还原失败: ${className}`);
        console.warn(
          `[脚本还原] 未找到 ${className} on node ${this.selectedId}`
        );
        return;
      }

      downloadRecoveredScript(recovered);
      void copyRecoveredScript(recovered);
      this.setStatus(
        `已导出 ${className}.recovered.ts（并尝试复制到剪贴板）`
      );
    });
  }

  private async exportSpine(spineIndex: number): Promise<void> {
    if (!this.selectedId) return;
    this.setStatus('Spine 导出中（内存读纹理，文件名对齐 atlas）…');

    const result = await downloadSpineExport(this.selectedId, spineIndex);
    if (!result.ok) {
      this.setStatus(`Spine 导出失败: ${result.error ?? '未知错误'}`);
      console.warn('[Spine导出]', result.log.join('\n'));
      return;
    }

    const texCount = result.files.filter((f) =>
      /\.(png|jpe?g|webp)$/i.test(f.path)
    ).length;
    const pageHint =
      texCount > 1 ? ` · ${texCount} 页纹理（见 IMPORT_README.txt）` : '';
    this.setStatus(`已下载 ${result.zipName} · ${result.files.length} 个文件${pageHint}`);
    console.log('[Spine导出]', result.log.join('\n'));
  }

  private async exportBmfont(bmfontIndex: number): Promise<void> {
    if (!this.selectedId) return;
    this.setStatus('BMFont 导出中（内存读图集，重建 .fnt）…');

    const result = await downloadBmfontExport(this.selectedId, bmfontIndex);
    if (!result.ok) {
      this.setStatus(`BMFont 导出失败: ${result.error ?? '未知错误'}`);
      console.warn('[BMFont导出]', result.log.join('\n'));
      return;
    }

    const texCount = result.files.filter((f) =>
      /\.(png|jpe?g|webp)$/i.test(f.path)
    ).length;
    const texHint = texCount > 0 ? ` · ${texCount} 张图集` : '';
    this.setStatus(
      `已下载 ${result.zipName} · ${result.files.length} 个文件${texHint}`
    );
    console.log('[BMFont导出]', result.log.join('\n'));
  }

  private refreshAll(force: boolean): void {
    if (this.isCollapsed) return;

    const scene = getSceneRoot();
    if (!scene) {
      this.setStatus('未找到场景（cc.director.getScene 为空）');
      if (this.sceneTreeContainer) {
        this.sceneTreeContainer.innerHTML =
          '<div class="empty-scene">等待场景加载…</div>';
      }
      return;
    }

    const treeInfo = buildTreeInfo(scene);
    const treeOnlyHash = hashTree(treeInfo);
    const treeChanged = force || treeOnlyHash !== this.sceneTreeHash;

    if (treeChanged) {
      this.sceneTreeHash = treeOnlyHash;

      if (this.searchQuery) {
        expandMatchingNodes(treeInfo, this.searchQuery, this.expandedScene);
      }

      const sceneRootId = getNodeId(scene);

      if (this.sceneTreeContainer) {
        this.sceneTreeContainer.innerHTML = `<ul class="node-tree">${renderTreeHtml(
          treeInfo,
          {
            expanded: this.expandedScene,
            selectedId: this.selectedId,
            searchQuery: this.searchQuery,
            isRoot: true,
            sceneRootId,
          }
        )}</ul>`;
      }
    }

    this.refreshInspector(force || treeChanged);
    this.syncPauseButton();

    const nodeCount = countNodes(treeInfo);
    const pauseTag = getPauseState().paused ? ' · 已暂停' : '';
    this.setStatus(
      `场景树 · ${nodeCount} 个节点 · ${scene.name || 'Scene'}${pauseTag}`
    );
  }

  private toggleGamePause(): void {
    const result = togglePause('director');
    if (!result.ok) {
      console.error(`[暂停游戏] 切换失败: ${result.error}`);
      this.setStatus(`暂停失败: ${result.error}`);
      return;
    }
    this.syncPauseButton();
    this.refreshAll(true);
  }

  private syncPauseButton(): void {
    if (!this.pauseBtn) return;
    const paused = getPauseState().paused;
    this.pauseBtn.textContent = paused ? '继续' : '暂停';
    this.pauseBtn.classList.toggle('pause-btn--active', paused);
    this.pauseBtn.title = paused
      ? '恢复游戏（director.resume）'
      : '暂停游戏（director.pause），便于停住后查看节点属性';
  }

  private refreshInspector(force: boolean): void {
    const data = collectNodeInspectorData(this.selectedId);
    const nextHash = hashNodeInspectorData(data);
    if (!force && nextHash === this.inspectorHash) return;
    this.inspectorHash = nextHash;

    const title = this.nodeInspectorContainer?.querySelector(
      '.node-inspector-title'
    );
    if (title) {
      title.textContent = data
        ? `Inspector · ${data.nodeName}`
        : 'Inspector';
    }

    const body = this.nodeInspectorContainer?.querySelector(
      '.node-inspector-body'
    );
    if (!body) return;

    body.innerHTML = renderNodeInspectorHtml(data);

    const hasSprite = data?.components.some((c) => c.isSprite);
    if (hasSprite && this.selectedId) {
      const token = ++this.spritePreviewToken;
      void this.loadSpritePreview(this.selectedId, token);
    }
  }

  private async loadSpritePreview(
    nodeId: string,
    token: number
  ): Promise<void> {
    try {
      const base = collectSpriteInspectData(nodeId);
      if (!base || token !== this.spritePreviewToken) return;

      const enriched = await enrichSpriteInspectData(base, nodeId);
      if (token !== this.spritePreviewToken || this.selectedId !== nodeId) {
        return;
      }

      const root = this.nodeInspectorContainer?.querySelector(
        '[data-sprite-preview]'
      ) as HTMLElement | null;
      if (!root) return;

      const loading = root.querySelector('.insp-sprite-loading') as HTMLElement | null;
      const legacyCanvas = root.querySelector(
        '.insp-sprite-canvas-legacy'
      ) as HTMLCanvasElement | null;
      const engineCanvas = root.querySelector(
        '.insp-sprite-canvas-engine'
      ) as HTMLCanvasElement | null;
      const legacyMeta = root.querySelector(
        '.insp-texture-legacy-meta'
      ) as HTMLElement | null;
      const engineMeta = root.querySelector(
        '.insp-texture-engine-meta'
      ) as HTMLElement | null;
      const legacyEmpty = root.querySelector(
        '.insp-texture-legacy-empty'
      ) as HTMLElement | null;
      const engineEmpty = root.querySelector(
        '.insp-texture-engine-empty'
      ) as HTMLElement | null;

      if (!legacyCanvas || !engineCanvas) return;

      const legacyDrawn = drawSpriteTexture(legacyCanvas, enriched, 'legacy');
      const engineDrawn = drawSpriteTexture(engineCanvas, enriched, 'engine');

      if (loading) loading.style.display = 'none';

      legacyCanvas.style.display = legacyDrawn ? 'block' : 'none';
      engineCanvas.style.display = engineDrawn ? 'block' : 'none';

      if (legacyMeta) {
        legacyMeta.textContent = legacyDrawn
          ? `${enriched.extractMethod} · ${enriched.pixels?.imageData.width ?? 0}×${enriched.pixels?.imageData.height ?? 0}`
          : enriched.extractError ?? '失败';
      }
      if (engineMeta) {
        engineMeta.textContent = engineDrawn
          ? `${enriched.engineExtractMethod} · ${enriched.enginePixels?.imageData.width ?? 0}×${enriched.enginePixels?.imageData.height ?? 0}`
          : enriched.engineExtractError ?? '失败';
      }
      if (legacyEmpty) {
        legacyEmpty.textContent = legacyDrawn ? '' : (enriched.extractError ?? '无预览');
        legacyEmpty.style.display = legacyDrawn ? 'none' : 'block';
      }
      if (engineEmpty) {
        engineEmpty.textContent = engineDrawn
          ? ''
          : (enriched.engineExtractError ?? '无预览');
        engineEmpty.style.display = engineDrawn ? 'none' : 'block';
      }
    } catch (error) {
      const scene = getSceneRoot();
      const node = scene ? findNodeById(scene, nodeId) : null;
      const nodeName = node?.name ?? nodeId;
      console.warn(`[Inspector] ${nodeName}(${nodeId}) 贴图预览失败`, error);
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) {
      this.statusEl.textContent = text;
    }
  }
}

function bootInspector(): void {
  // 仅当 popup 开启 Pixi 时挂钩，避免普通页被 console 包装
  if (window.__cocosInspectorPixiEnabled === true) {
    installPixiConsoleHint();
  }

  const start = (family: '2' | '3' | 'egret' | 'pixi'): void => {
    try {
      logEngine(`准备启动面板 engineFamily=${family}`);
      if (family === '3') new CocosInspector3();
      else if (family === '2') startCocosInspector2();
      else if (family === 'egret') startEgretInspector();
      else startPixiInspector();
    } catch (e) {
      console.error(`[Cocos Inspector] 启动 ${family} 面板失败`, e);
    }
  };

  whenDomReady(() => {
    const family = detectEngineFamily();
    if (family) {
      start(family);
      return;
    }
    waitForEngine((ready) => start(ready));
  });
}

bootInspector();
