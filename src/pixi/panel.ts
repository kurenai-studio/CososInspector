/**
 * PixiJS Inspector 面板（MVP）：stage 树 + 暂停 + MCP
 */
import { logEngine } from '../engine/detect';
import { mountInspectorRoot } from '../engine/mount';
import {
  countNodes,
  expandMatchingNodes,
  renderTreeHtml,
} from '../cocos3/treeRender';
import { getPauseState, togglePause } from './gamePause';
import { installMcpBridge } from './mcpBridge';
import { getPixiVersion } from './runtime';
import {
  buildTreeInfo,
  findDisplayById,
  getDisplayId,
  getDisplayName,
  getSceneRoot,
  hashTree,
  setNodeActive,
} from './sceneTree';
import { collectSpriteList } from './sprites';

declare const __INSPECTOR_VERSION__: string;

const REFRESH_MS = 1500;

export class PixiInspector {
  private root: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private edgeTab: HTMLButtonElement | null = null;
  private sceneTreeContainer: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private pauseBtn: HTMLButtonElement | null = null;
  private mcpStatusEl: HTMLElement | null = null;

  private expandedScene = new Set<string>();
  private selectedId: string | null = null;
  private searchQuery = '';
  private isCollapsed = false;
  private sceneTreeHash = '';
  private updateTimer: number | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    try {
      this.createUI();
      this.bindTreeEvents();
      installMcpBridge();
      this.refreshAll(true);
      this.startAutoRefresh();
      window.postMessage(
        { type: 'cocos-inspector-ready', engineFamily: 'pixi' },
        '*'
      );
      logEngine('已启动 PixiJS 面板（MVP）');
    } catch (e) {
      console.error('[Cocos Inspector] Pixi 面板初始化失败', e);
    }
  }

  private createUI(): void {
    this.root = document.createElement('div');
    this.root.className = 'cocos-inspector-root';

    this.edgeTab = document.createElement('button');
    this.edgeTab.type = 'button';
    this.edgeTab.className = 'inspector-edge-tab';
    this.edgeTab.textContent = '节点树';
    this.edgeTab.title = '展开 Pixi Inspector';
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
    title.textContent = 'Pixi Inspector';
    titleRow.appendChild(title);

    const inspectorVersion = document.createElement('span');
    inspectorVersion.className = 'inspector-version';
    inspectorVersion.textContent = `v${__INSPECTOR_VERSION__}`;
    titleRow.appendChild(inspectorVersion);
    titleBlock.appendChild(titleRow);

    const version = document.createElement('span');
    version.className = 'engine-version';
    version.textContent = `引擎 ${getPixiVersion()}`;
    titleBlock.appendChild(version);
    headerTop.appendChild(titleBlock);

    this.mcpStatusEl = document.createElement('div');
    this.mcpStatusEl.className = 'mcp-status mcp-status--disconnected';
    this.mcpStatusEl.innerHTML =
      '<span class="mcp-status-dot" aria-hidden="true"></span>' +
      '<span class="mcp-status-label">MCP</span>';
    this.updateMcpStatus('disconnected', 17373);
    headerTop.appendChild(this.mcpStatusEl);
    header.appendChild(headerTop);

    window.addEventListener('message', (ev) => {
      if (ev.source !== window || ev.data?.type !== 'cocos-mcp-status') return;
      this.updateMcpStatus(
        ev.data.status ?? 'disconnected',
        ev.data.port ?? 17373
      );
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
    this.pauseBtn.title = '暂停/恢复（app.ticker.stop/start）';
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

    this.detailEl = document.createElement('div');
    this.detailEl.className = 'node-inspector';
    this.detailEl.innerHTML =
      '<div class="node-inspector-title">Inspector</div>' +
      '<div class="node-inspector-body"><div class="empty-inspector">选择节点</div></div>';
    mainBody.appendChild(this.detailEl);

    this.panel.appendChild(mainBody);
    this.root.appendChild(this.panel);
    mountInspectorRoot(this.root);
  }

  private updateMcpStatus(
    status: 'connected' | 'disconnected' | string,
    port: number
  ): void {
    if (!this.mcpStatusEl) return;
    const labels: Record<string, string> = {
      connected: '已连接',
      disconnected: '未连接',
    };
    this.mcpStatusEl.className = `mcp-status mcp-status--${status}`;
    const label = this.mcpStatusEl.querySelector('.mcp-status-label');
    if (label) label.textContent = `MCP · ${labels[status] ?? status}`;
    const hints: Record<string, string> = {
      connected: `已连接 Cursor MCP 桥接（端口 ${port}，Pixi MVP）`,
      disconnected:
        `未连接 MCP。请在 Cursor 启用 cocos-inspector MCP，并确认端口 ${port} 可用。`,
    };
    this.mcpStatusEl.title = hints[status] ?? `MCP 状态: ${status}`;
  }

  private setCollapsed(collapsed: boolean): void {
    if (!this.root || this.isCollapsed === collapsed) return;
    this.isCollapsed = collapsed;
    this.root.classList.toggle('is-collapsed', collapsed);

    if (collapsed) {
      this.stopAutoRefresh();
      if (this.sceneTreeContainer) this.sceneTreeContainer.innerHTML = '';
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
      const node = scene ? findDisplayById(scene, nodeId) : null;
      console.log(
        `[Active编辑:pixi] ${getDisplayName(node ?? {})}(${nodeId}) visible=${active}`
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
      const apps = window.__cocosInspectorPixiApps?.length ?? 0;
      this.setStatus(
        apps > 0
          ? `已捕获 ${apps} 个 app 但 stage 未就绪…`
          : '未找到 Pixi stage（探针截获中 / 或需 __PIXI_APP__）'
      );
      if (this.sceneTreeContainer) {
        this.sceneTreeContainer.innerHTML =
          '<div class="empty-scene">等待 Pixi Application…' +
          '<br/><small>已尝试 hook Application/Renderer.prototype.render；' +
          '硬刷新后再等 1～2 秒。Console 查 window.__PIXI_APP__</small></div>';
      }
      return;
    }

    const treeInfo = buildTreeInfo(scene, this.expandedScene);
    const treeOnlyHash = hashTree(treeInfo);
    const treeChanged = force || treeOnlyHash !== this.sceneTreeHash;

    if (treeChanged) {
      this.sceneTreeHash = treeOnlyHash;
      if (this.searchQuery) {
        expandMatchingNodes(treeInfo, this.searchQuery, this.expandedScene);
      }
      const sceneRootId = getDisplayId(scene);
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

    this.refreshDetail();
    this.syncPauseButton();

    const sprites = collectSpriteList();
    const pauseTag = getPauseState().paused ? ' · 已暂停' : '';
    this.setStatus(
      `Pixi stage · ${countNodes(treeInfo)} 节点 · ${sprites.length} sprite` +
        ` · ${getDisplayName(scene)}${pauseTag}`
    );
  }

  private refreshDetail(): void {
    const title = this.detailEl?.querySelector('.node-inspector-title');
    const body = this.detailEl?.querySelector('.node-inspector-body');
    if (!body) return;

    const root = getSceneRoot();
    if (!root || !this.selectedId) {
      if (title) title.textContent = 'Inspector';
      body.innerHTML = '<div class="empty-inspector">选择节点</div>';
      return;
    }

    const node = findDisplayById(root, this.selectedId);
    if (!node) {
      if (title) title.textContent = 'Inspector';
      body.innerHTML = '<div class="empty-inspector">节点已消失</div>';
      return;
    }

    const name = getDisplayName(node);
    if (title) title.textContent = `Inspector · ${name}`;
    const t = node.texture;
    const tex =
      t?.label ||
      t?.textureCacheIds?.[0] ||
      t?.baseTexture?.resource?.url ||
      t?.baseTexture?.resource?.src ||
      '';
    const rows = [
      ['id', this.selectedId],
      ['ctor', node.constructor?.name || ''],
      ['visible', String(node.visible !== false)],
      ['x/y', `${node.x ?? 0}, ${node.y ?? 0}`],
      ['w/h', `${node.width ?? 0} × ${node.height ?? 0}`],
      ['alpha', String(node.alpha ?? 1)],
      ['texture', tex || '(none)'],
    ];
    body.innerHTML = rows
      .map(
        ([k, v]) =>
          `<div class="insp-row"><span class="insp-key">${k}</span>` +
          `<span class="insp-val">${escapeHtml(String(v))}</span></div>`
      )
      .join('');
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function startPixiInspector(): void {
  new PixiInspector();
}
