import { logEngine } from '../engine/detect';
import {
  countNodes,
  expandMatchingNodes,
  renderTreeHtml,
} from '../cocos3/treeRender';
import { getPauseState, togglePause } from './gamePause';
import {
  collectNodeInspectorData,
  createNodeInspectorElement,
  hashNodeInspectorData,
  renderNodeInspectorHtml,
} from './nodeInspector';
import {
  buildTreeInfo,
  findNodeById,
  getNodeId,
  getNodeName,
  getSceneRoot,
  hashTree,
  setNodeActive,
} from './sceneTree';
import {
  downloadExtractPng,
  extractSpriteFrame,
  type Cc2SpriteExtractResult,
} from './spriteExtract';

declare const __INSPECTOR_VERSION__: string;

const REFRESH_MS = 500;

/** Cocos Creator 2.x（含 2.4）P0 面板：节点树 + 基础 Inspector + 暂停 */
export class CocosInspector2 {
  private root: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private edgeTab: HTMLButtonElement | null = null;
  private sceneTreeContainer: HTMLElement | null = null;
  private nodeInspectorContainer: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private pauseBtn: HTMLButtonElement | null = null;

  private expandedScene = new Set<string>();
  private selectedId: string | null = null;
  private searchQuery = '';
  private isCollapsed = false;
  private sceneTreeHash = '';
  private inspectorHash = '';
  private updateTimer: number | null = null;
  private spritePreviewToken = 0;
  private lastSpriteExtract: Cc2SpriteExtractResult | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.createUI();
    this.bindTreeEvents();
    this.refreshAll(true);
    this.startAutoRefresh();
    window.postMessage({ type: 'cocos-inspector-ready', engineFamily: '2' }, '*');
    logEngine('已启动 2.x 面板（节点树 + Inspector + 暂停；MCP/纹理 P0 未接入）');
  }

  private createUI(): void {
    this.root = document.createElement('div');
    this.root.className = 'cocos-inspector-root';

    this.edgeTab = document.createElement('button');
    this.edgeTab.type = 'button';
    this.edgeTab.className = 'inspector-edge-tab';
    this.edgeTab.textContent = '节点树';
    this.edgeTab.title = '展开 Cocos Inspector (2.x)';
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
    title.textContent = 'Cocos Inspector 2.x';
    titleRow.appendChild(title);

    const inspectorVersion = document.createElement('span');
    inspectorVersion.className = 'inspector-version';
    inspectorVersion.textContent = `v${__INSPECTOR_VERSION__}`;
    titleRow.appendChild(inspectorVersion);
    titleBlock.appendChild(titleRow);

    const version = document.createElement('span');
    version.className = 'engine-version';
    version.textContent = `引擎 ${window.cc?.ENGINE_VERSION ?? '2.x'}`;
    titleBlock.appendChild(version);
    headerTop.appendChild(titleBlock);

    const mcpHint = document.createElement('div');
    mcpHint.className = 'mcp-status mcp-status--disconnected';
    mcpHint.title = '2.x P0 暂未接入 MCP 桥接';
    mcpHint.innerHTML =
      '<span class="mcp-status-dot" aria-hidden="true"></span><span class="mcp-status-label">MCP · 2.x 暂未接入</span>';
    headerTop.appendChild(mcpHint);

    header.appendChild(headerTop);

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
    this.pauseBtn.title = '暂停/恢复游戏（director.pause）';
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
    toggleBtn.addEventListener('click', () => this.setCollapsed(!this.isCollapsed));
    controls.appendChild(toggleBtn);

    header.appendChild(controls);
    this.panel.appendChild(header);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'inspector-status';
    this.panel.appendChild(this.statusEl);

    const mainBody = document.createElement('div');
    mainBody.className = 'inspector-main';

    this.sceneTreeContainer = document.createElement('div');
    this.sceneTreeContainer.className = 'node-tree-panel';
    mainBody.appendChild(this.sceneTreeContainer);

    this.nodeInspectorContainer = createNodeInspectorElement();
    mainBody.appendChild(this.nodeInspectorContainer);

    this.panel.appendChild(mainBody);
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);
  }

  private setCollapsed(collapsed: boolean): void {
    if (!this.root || this.isCollapsed === collapsed) return;
    this.isCollapsed = collapsed;
    this.root.classList.toggle('is-collapsed', collapsed);

    if (collapsed) {
      this.stopAutoRefresh();
      this.sceneTreeContainer && (this.sceneTreeContainer.innerHTML = '');
      this.panel?.remove();
      return;
    }

    if (this.panel && !this.root.contains(this.panel)) {
      this.root.appendChild(this.panel);
    }
    this.refreshAll(true);
    this.startAutoRefresh();
  }

  private startAutoRefresh(): void {
    if (this.isCollapsed) return;
    this.stopAutoRefresh();
    this.updateTimer = window.setInterval(() => this.refreshAll(false), REFRESH_MS);
  }

  private stopAutoRefresh(): void {
    if (this.updateTimer != null) {
      window.clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
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
        return;
      }
      const scene = getSceneRoot();
      const node = scene ? findNodeById(scene, nodeId) : null;
      console.log(
        `[Active编辑:2.x] ${getNodeName(node ?? {})}(${nodeId}) active=${active}`
      );
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
        if (this.expandedScene.has(id)) this.expandedScene.delete(id);
        else this.expandedScene.add(id);
        this.refreshAll(true);
        return;
      }

      if (row) {
        const id = row.closest('li')?.dataset.uuid;
        if (!id) return;
        this.selectedId = id;
        this.refreshAll(true);
      }
    });
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

    const pauseTag = getPauseState().paused ? ' · 已暂停' : '';
    this.setStatus(
      `2.x 场景树 · ${countNodes(treeInfo)} 个节点 · ${getNodeName(scene)}${pauseTag}`
    );
  }

  private refreshInspector(force: boolean): void {
    const data = collectNodeInspectorData(this.selectedId);
    const nextHash = hashNodeInspectorData(data);
    if (!force && nextHash === this.inspectorHash) return;
    this.inspectorHash = nextHash;

    const title = this.nodeInspectorContainer?.querySelector('.node-inspector-title');
    if (title) {
      title.textContent = data ? `Inspector · ${data.nodeName}` : 'Inspector';
    }
    const body = this.nodeInspectorContainer?.querySelector('.node-inspector-body');
    if (body) body.innerHTML = renderNodeInspectorHtml(data);

    if (data?.hasSprite && data.nodeId) {
      void this.loadSpritePreview(data.nodeId);
    } else {
      this.lastSpriteExtract = null;
    }
  }

  private async loadSpritePreview(nodeId: string): Promise<void> {
    const token = ++this.spritePreviewToken;
    const panel = this.nodeInspectorContainer;
    const meta = panel?.querySelector('.insp-sprite-preview-meta');
    const canvas = panel?.querySelector(
      '.insp-sprite-canvas-2x'
    ) as HTMLCanvasElement | null;
    const btn = panel?.querySelector(
      '.sprite-download-btn-2x'
    ) as HTMLButtonElement | null;

    if (meta) meta.textContent = '提取中…';
    const result = await extractSpriteFrame(nodeId);
    if (token !== this.spritePreviewToken) return;

    if (!result || !canvas) {
      if (meta) meta.textContent = '提取失败（无 DOM 贴图源）';
      this.lastSpriteExtract = null;
      return;
    }

    this.lastSpriteExtract = result;
    const maxSide = 180;
    const scale = Math.min(
      1,
      maxSide / Math.max(result.canvas.width, result.canvas.height)
    );
    canvas.width = Math.max(1, Math.round(result.canvas.width * scale));
    canvas.height = Math.max(1, Math.round(result.canvas.height * scale));
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    ctx?.drawImage(result.canvas, 0, 0, canvas.width, canvas.height);

    if (meta) {
      meta.textContent =
        `${result.method} · ${result.frameSize.w}×${result.frameSize.h}` +
        (result.isRotated ? ' · rotated' : '');
    }

    if (btn && btn.dataset.bound !== '1') {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        if (!this.lastSpriteExtract) return;
        downloadExtractPng(this.lastSpriteExtract);
        this.setStatus(`已下载 ${this.lastSpriteExtract.frameName}.png`);
      });
    }
  }

  private toggleGamePause(): void {
    const result = togglePause();
    if (!result.ok) {
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
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }
}

export function startCocosInspector2(): void {
  new CocosInspector2();
}
