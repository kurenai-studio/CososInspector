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
import { downloadSpineExport } from './spineExport';
import { downloadBmfontExport } from './bmfontExport';
import { installMcpBridge } from './mcpBridge';
import { callHarCmd, formatHarStats } from '../har/harPanel';

declare const __INSPECTOR_VERSION__: string;

const REFRESH_MS = 500;

/** Cocos Creator 2.x（含 2.4）面板：节点树 + Inspector + 暂停 + MCP P2 */
export class CocosInspector2 {
  private root: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private edgeTab: HTMLButtonElement | null = null;
  private sceneTreeContainer: HTMLElement | null = null;
  private nodeInspectorContainer: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private pauseBtn: HTMLButtonElement | null = null;
  private mcpStatusEl: HTMLElement | null = null;
  private harRecordBtn: HTMLButtonElement | null = null;
  private harExportBtn: HTMLButtonElement | null = null;
  private harRecording = false;
  private harPollTimer: number | null = null;

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
    this.bindInspectorEvents();
    installMcpBridge();
    this.refreshAll(true);
    this.startAutoRefresh();
    window.postMessage({ type: 'cocos-inspector-ready', engineFamily: '2' }, '*');
    logEngine('已启动 2.x 面板（含 Spine/BMFont 导出）');
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

    this.mcpStatusEl = document.createElement('div');
    this.mcpStatusEl.className = 'mcp-status mcp-status--disconnected';
    this.mcpStatusEl.innerHTML =
      '<span class="mcp-status-dot" aria-hidden="true"></span><span class="mcp-status-label">MCP</span>';
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
    this.pauseBtn.title = '暂停/恢复游戏（director.pause）';
    this.pauseBtn.addEventListener('click', () => this.toggleGamePause());
    controls.appendChild(this.pauseBtn);

    this.harRecordBtn = document.createElement('button');
    this.harRecordBtn.type = 'button';
    this.harRecordBtn.className = 'har-record-btn';
    this.harRecordBtn.textContent = '录HAR';
    this.harRecordBtn.title =
      '开始/停止 HAR 抓包（扩展 CDP，无需 F12；会禁缓存并可能显示调试条）';
    this.harRecordBtn.addEventListener('click', () => void this.toggleHarRecord());
    controls.appendChild(this.harRecordBtn);

    this.harExportBtn = document.createElement('button');
    this.harExportBtn.type = 'button';
    this.harExportBtn.className = 'har-export-btn';
    this.harExportBtn.textContent = '导出HAR';
    this.harExportBtn.title = '导出当前已抓取的 HAR（含 response body）';
    this.harExportBtn.addEventListener('click', () => void this.exportHar());
    controls.appendChild(this.harExportBtn);

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
      connected: `已连接 Cursor MCP 桥接（端口 ${port}，2.x P2）`,
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
      }
    });
  }

  private async exportSpine(spineIndex: number): Promise<void> {
    if (!this.selectedId) return;
    this.setStatus('正在导出 Spine…');
    const result = await downloadSpineExport(this.selectedId, spineIndex);
    if (!result.ok) {
      this.setStatus(`Spine 导出失败: ${result.error ?? '未知错误'}`);
      return;
    }
    this.setStatus(`已下载 ${result.zipName}（${result.files.length} 文件）`);
  }

  private async exportBmfont(bmfontIndex: number): Promise<void> {
    if (!this.selectedId) return;
    this.setStatus('正在导出 BMFont…');
    const result = await downloadBmfontExport(this.selectedId, bmfontIndex);
    if (!result.ok) {
      this.setStatus(`BMFont 导出失败: ${result.error ?? '未知错误'}`);
      return;
    }
    this.setStatus(`已下载 ${result.zipName}（${result.files.length} 文件）`);
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

  private syncHarButtons(): void {
    if (this.harRecordBtn) {
      this.harRecordBtn.textContent = this.harRecording ? '停HAR' : '录HAR';
      this.harRecordBtn.classList.toggle(
        'har-record-btn--active',
        this.harRecording
      );
    }
  }

  private startHarPoll(): void {
    this.stopHarPoll();
    this.harPollTimer = window.setInterval(() => {
      void callHarCmd('status').then((res) => {
        if (!res?.ok || !res.stats) return;
        this.harRecording = !!res.stats.recording;
        this.syncHarButtons();
        if (this.harRecording) {
          this.setStatus(`HAR 录制中 · ${formatHarStats(res.stats)}`);
        }
      });
    }, 1500);
  }

  private stopHarPoll(): void {
    if (this.harPollTimer != null) {
      window.clearInterval(this.harPollTimer);
      this.harPollTimer = null;
    }
  }

  private async toggleHarRecord(): Promise<void> {
    try {
      if (this.harRecording) {
        const res = await callHarCmd('stop');
        this.harRecording = false;
        this.stopHarPoll();
        this.syncHarButtons();
        if (!res?.ok) {
          this.setStatus(`停止 HAR 失败: ${res?.error ?? 'unknown'}`);
          return;
        }
        this.setStatus(`HAR 已停止 · ${formatHarStats(res.stats)}`);
        return;
      }
      const res = await callHarCmd('start', { reload: true });
      if (!res?.ok) {
        this.setStatus(`开始 HAR 失败: ${res?.error ?? 'unknown'}`);
        return;
      }
      this.harRecording = true;
      this.syncHarButtons();
      this.startHarPoll();
      this.setStatus(
        `HAR 录制中（已清缓存并强制刷新）· ${formatHarStats(res.stats)}`
      );
    } catch (e) {
      this.setStatus(
        `HAR 操作失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async exportHar(): Promise<void> {
    try {
      this.setStatus('正在导出 HAR…');
      const res = await callHarCmd('export', { stop: false });
      if (!res?.ok) {
        this.setStatus(`导出 HAR 失败: ${res?.error ?? 'unknown'}`);
        return;
      }
      this.setStatus(
        `HAR 已下载 ${res.filename ?? ''} · ${formatHarStats(res.stats)}`
      );
    } catch (e) {
      this.setStatus(
        `导出 HAR 失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }
}

export function startCocosInspector2(): void {
  new CocosInspector2();
}
