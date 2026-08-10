/**
 * Egret Inspector 面板（MVP）：stage 显示对象树 + 暂停 + MCP
 * 结构与 pixi/panel.ts 对齐：挂 documentElement、hash 比对、收起即停轮询
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
import { getEgretVersion, type EgretDisplayObject } from './runtime';
import {
  buildTreeInfo,
  findDisplayById,
  getDisplayId,
  getDisplayName,
  getSceneRoot,
  getPathToNode,
  hashTree,
  setNodeActive,
} from './sceneTree';
import { collectSpriteList } from './sprites';
import { startPickMode, stopPickMode, isPickModeActive } from './nodePicker';
import { getTextureSourceUrl, getNodeTexture } from './textureExtract';
import { listDragonBonesUrls } from './dragonBonesExport';
import { listSceneSpriteUrls, collectSceneAtlasInfo, type AtlasInfo } from './sceneAssetsExport';
import { collectResourceList } from './resources';

declare const __INSPECTOR_VERSION__: string;

const REFRESH_MS = 1500;

export class EgretInspector {
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
  private isPickMode = false;
  private pickBtn: HTMLButtonElement | null = null;
  private downloadBtn: HTMLButtonElement | null = null;
  private downloadMenu: HTMLElement | null = null;
  private isDownloading = false;

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
        { type: 'cocos-inspector-ready', engineFamily: 'egret' },
        '*'
      );
      logEngine('已启动 Egret 面板（MVP）');
    } catch (e) {
      console.error('[Cocos Inspector] Egret 面板初始化失败', e);
    }
  }

  private createUI(): void {
    this.root = document.createElement('div');
    this.root.className = 'cocos-inspector-root';

    this.edgeTab = document.createElement('button');
    this.edgeTab.type = 'button';
    this.edgeTab.className = 'inspector-edge-tab';
    this.edgeTab.textContent = '节点树';
    this.edgeTab.title = '展开 Egret Inspector';
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
    title.textContent = 'Egret Inspector';
    titleRow.appendChild(title);

    const inspectorVersion = document.createElement('span');
    inspectorVersion.className = 'inspector-version';
    inspectorVersion.textContent = `v${__INSPECTOR_VERSION__}`;
    titleRow.appendChild(inspectorVersion);
    titleBlock.appendChild(titleRow);

    const version = document.createElement('span');
    version.className = 'engine-version';
    version.textContent = `引擎 ${getEgretVersion()}`;
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
    this.pauseBtn.title = '暂停/恢复（egret.ticker.pause/resume）';
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

    this.pickBtn = document.createElement('button');
    this.pickBtn.type = 'button';
    this.pickBtn.className = 'pick-btn';
    this.pickBtn.textContent = '拾取';
    this.pickBtn.title = '点击页面元素 → 自动定位到节点树';
    this.pickBtn.addEventListener('click', () => this.togglePickMode());
    controls.appendChild(this.pickBtn);

    this.downloadBtn = document.createElement('button');
    this.downloadBtn.type = 'button';
    this.downloadBtn.className = 'download-btn';
    this.downloadBtn.textContent = '下载';
    this.downloadBtn.title = '导出资源到本地目录';
    this.downloadBtn.addEventListener('click', () => this.toggleDownloadMenu());
    controls.appendChild(this.downloadBtn);

    this.downloadMenu = document.createElement('div');
    this.downloadMenu.className = 'download-menu';
    this.downloadMenu.style.display = 'none';
    const dlItems: Array<{ key: string; label: string }> = [
      { key: 'scene', label: '整场景下载原图' },
      { key: 'scene-atlas', label: '整场景图集还原（按 sprite 裁剪）' },
      { key: 'node-texture', label: '选中节点纹理 PNG' },
      { key: 'node-dragonbones', label: '选中节点龙骨 zip' },
      { key: 'resources', label: '资源 URL 清单 JSON' },
    ];
    for (const it of dlItems) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'download-menu-item';
      b.textContent = it.label;
      b.dataset.key = it.key;
      b.addEventListener('click', () => {
        this.onDownload(it.key).catch((e) => {
          this.setStatus(`下载失败: ${e instanceof Error ? e.message : String(e)}`);
        });
      });
      this.downloadMenu.appendChild(b);
    }
    controls.appendChild(this.downloadMenu);

    document.addEventListener('click', (ev) => {
      if (this.isCollapsed) return;
      const target = ev.target as Node;
      if (this.downloadMenu?.contains(target)) return;
      if (this.downloadBtn === target) return;
      this.hideDownloadMenu();
    });

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
      connected: `已连接 Cursor MCP 桥接（端口 ${port}，Egret MVP）`,
      disconnected:
        `未连接 MCP。请在 Cursor 启用 cocos-inspector MCP，并确认端口 ${port} 可用。`,
    };
    this.mcpStatusEl.title = hints[status] ?? `MCP 状态: ${status}`;
  }

  private togglePickMode(): void {
    if (this.isPickMode) {
      this.stopPickModeInternal();
    } else {
      this.startPickModeInternal();
    }
  }

  private startPickModeInternal(): void {
    if (this.isPickMode) return;
    this.isPickMode = true;
    this.pickBtn?.classList.add('pick-btn--active');
    if (this.pickBtn) this.pickBtn.textContent = '取消拾取';
    if (!isPickModeActive()) {
      startPickMode((nodeId) => this.onNodePicked(nodeId));
    }
  }

  private stopPickModeInternal(): void {
    if (!this.isPickMode) return;
    this.isPickMode = false;
    this.pickBtn?.classList.remove('pick-btn--active');
    if (this.pickBtn) this.pickBtn.textContent = '拾取';
    stopPickMode();
  }

  private toggleDownloadMenu(): void {
    if (!this.downloadMenu) return;
    const open = this.downloadMenu.style.display !== 'none';
    this.downloadMenu.style.display = open ? 'none' : 'flex';
  }

  private hideDownloadMenu(): void {
    if (this.downloadMenu) this.downloadMenu.style.display = 'none';
  }

  private async pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
    const fn = (window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (typeof fn !== 'function') {
      throw new Error('当前浏览器不支持目录选择（需 Chrome/Edge 117+）');
    }
    try {
      return await fn.call(window, { mode: 'readwrite' });
    } catch {
      return null; // 用户取消
    }
  }

  private async writeFileToDir(
    dir: FileSystemDirectoryHandle,
    filename: string,
    data: BlobPart
  ): Promise<void> {
    // filename 可能含子目录（如 images/bg.png）→ 拆分 + 创建子目录
    const parts = filename.split(/[\\/]/).filter(Boolean);
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = await (cur as unknown as {
        getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<FileSystemDirectoryHandle>;
      }).getDirectoryHandle(parts[i], { create: true });
    }
    const safeName = parts[parts.length - 1].replace(/[/\\?%*:|"<>]/g, '_');
    const fh = await (cur as unknown as {
      getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<{
        createWritable: () => Promise<{ write: (d: BlobPart) => Promise<void>; close: () => Promise<void> }>;
      }>;
    }).getFileHandle(safeName, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  /** fetch CDN URL → blob → 写入目录；返回字节数 */
  private async fetchAndWrite(
    url: string,
    dir: FileSystemDirectoryHandle,
    filename: string
  ): Promise<number> {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
    const blob = await res.blob();
    const bytes = blob.size;
    await this.writeFileToDir(dir, filename, blob);
    return bytes;
  }

  /** 加载 HTMLImageElement（src 可以是 http/cdn 或 blob:URL） */
  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`图片加载失败: ${src.slice(0, 80)}`));
      img.src = src;
    });
  }

  /** canvas drawImage 裁剪 sprite 区域 → PNG Blob */
  private cropSprite(
    img: HTMLImageElement,
    x: number,
    y: number,
    w: number,
    h: number
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w));
        canvas.height = Math.max(1, Math.round(h));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas 2D 上下文不可用'));
          return;
        }
        ctx.drawImage(
          img,
          x, y, w, h,
          0, 0, canvas.width, canvas.height
        );
        canvas.toBlob(
          (b) => {
            if (b) resolve(b);
            else reject(new Error('toBlob 返回 null'));
          },
          'image/png'
        );
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Windows 文件名非法字符替换为 _ */
  private safeName(name: string): string {
    const cleaned = (name || 'sprite').trim().replace(/[\\/:*?"<>|]/g, '_');
    return cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned;
  }

  private async onDownload(key: string): Promise<void> {
    this.hideDownloadMenu();
    if (this.isDownloading) {
      this.setStatus('正在下载，请等待…');
      return;
    }

    const dir = await this.pickDirectory();
    if (!dir) return; // 用户取消

    this.isDownloading = true;
    this.downloadBtn && (this.downloadBtn.disabled = true);
    this.setStatus(`下载中（${key}）… 选定目录: ${dir.name}`);

    try {
      const written: string[] = [];
      const errors: string[] = [];

      if (key === 'scene') {
        const items = listSceneSpriteUrls();
        if (items.length === 0) throw new Error('场景中无 Sprite 资源');
        this.setStatus(`下载场景 ${items.length} 张图到 ${dir.name} …`);
        let okN = 0;
        // 限流并发 8
        const concurrency = 8;
        let idx = 0;
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
          while (idx < items.length) {
            const cur = items[idx++];
            try {
              await this.fetchAndWrite(cur.url, dir, `images/${cur.name}`);
              written.push(cur.name);
              okN++;
              if (okN % 5 === 0 || okN === items.length) {
                this.setStatus(`下载中 ${okN}/${items.length} …`);
              }
            } catch (e) {
              errors.push(`${cur.name}: ${(e as Error).message}`);
            }
          }
        });
        await Promise.all(workers);
      } else if (key === 'scene-atlas') {
        // 图集还原：收 collectSceneAtlasInfo → 下载原图 → canvas 按 sprite 区域裁剪 → 写 sprites/
        const atlases: AtlasInfo[] = collectSceneAtlasInfo();
        if (atlases.length === 0) throw new Error('场景中无图集 sprite');
        const totalSprites = atlases.reduce((s, a) => s + a.sprites.length, 0);
        this.setStatus(`发现 ${atlases.length} 个图集 · ${totalSprites} 个 sprite，开始还原到 ${dir.name} …`);

        // 写 manifest 备份（含图集 URL + sprite 区域，便于离线重做）
        const manifest = atlases.map((a) => ({
          url: a.url,
          filename: a.filename,
          sprites: a.sprites.map((s) => ({ name: s.name, x: s.x, y: s.y, w: s.w, h: s.h, nodeId: s.nodeId })),
        }));
        await this.writeFileToDir(dir, 'atlas-manifest.json', JSON.stringify(manifest, null, 2));

        // 逐图集处理（顺序，避免一次性 fetch 太多大图）
        let spriteDone = 0;
        const errors2: string[] = [];
        for (const atlas of atlases) {
          // fetch 原图 → Image
          let img: HTMLImageElement;
          try {
            const res = await fetch(atlas.url, { mode: 'cors', credentials: 'omit' });
            if (!res.ok) { errors2.push(`${atlas.filename}: HTTP ${res.status}`); continue; }
            const blob = await res.blob();
            const urlObj = URL.createObjectURL(blob);
            img = await this.loadImage(urlObj);
            URL.revokeObjectURL(urlObj);
          } catch (e) {
            errors2.push(`${atlas.filename}: ${(e as Error).message}`);
            continue;
          }
          // 写原图备份
          try {
            const res2 = await fetch(atlas.url, { mode: 'cors', credentials: 'omit' });
            if (res2.ok) {
              const blob2 = await res2.blob();
              await this.writeFileToDir(dir, `images/${atlas.filename}`, blob2);
            }
          } catch { /* ignore */ }

          // 裁剪每个 sprite
          for (const sp of atlas.sprites) {
            try {
              const png = await this.cropSprite(img, sp.x, sp.y, sp.w, sp.h);
              await this.writeFileToDir(dir, `sprites/${this.safeName(sp.name)}.png`, png);
              spriteDone++;
              if (spriteDone % 10 === 0 || spriteDone === totalSprites) {
                this.setStatus(`图集还原 ${spriteDone}/${totalSprites} …`);
              }
            } catch (e) {
              errors2.push(`sprite ${sp.name}: ${(e as Error).message}`);
            }
          }
        }
        written.push(`sprites/ (${spriteDone} 个)`, 'images/', 'atlas-manifest.json');
        if (errors2.length) {
          this.setStatus(`图集还原完成: ${spriteDone}/${totalSprites} sprite → 目录 ${dir.name} · 失败 ${errors2.length}`);
        } else {
          this.setStatus(`图集还原完成: ${spriteDone}/${totalSprites} sprite → 目录 ${dir.name}`);
        }
        return;
      } else if (key === 'node-texture') {
        const node = this.getSelectedNode();
        if (!node) throw new Error('请先选中节点');
        const tex = getNodeTexture(node);
        if (!tex) throw new Error('选中节点无 texture');
        const url = getTextureSourceUrl(tex);
        if (!url) throw new Error('选中节点的纹理无 CDN URL（可能是 canvas 绘制）');
        const name = getDisplayName(node) || getDisplayId(node);
        const filename = `${name}_${getDisplayId(node)}_${url.split('/').pop()?.split('?')[0] || 'image.png'}`;
        await this.fetchAndWrite(url, dir, filename);
        written.push(filename);
      } else if (key === 'node-dragonbones') {
        const node = this.getSelectedNode();
        if (!node) throw new Error('请先选中节点');
        const id = getDisplayId(node);
        const r = listDragonBonesUrls(id);
        if (!r.ok || !r.urls || r.urls.length === 0) {
          throw new Error(r.error || `龙骨 ${id} 未找到 URL`);
        }
        const baseName = r.armatureName || id;
        this.setStatus(`下载龙骨 ${baseName} ${r.urls.length} 个文件到 ${dir.name} …`);
        for (const u of r.urls) {
          try {
            await this.fetchAndWrite(u.url, dir, `dragonbones/${baseName}/${u.name}`);
            written.push(u.name);
          } catch (e) {
            errors.push(`${u.name}: ${(e as Error).message}`);
          }
        }
      } else if (key === 'resources') {
        const list = collectResourceList(2000);
        const json = JSON.stringify(list, null, 2);
        await this.writeFileToDir(dir, 'resources.json', json);
        written.push('resources.json');
      } else {
        throw new Error(`未知下载类型: ${key}`);
      }

      const summary =
        written.length === 0
          ? errors.length
            ? '（无文件下载成功）'
            : '（无文件）'
          : written.length <= 5
          ? written.join(', ')
          : `${written.slice(0, 5).join(', ')} 等 ${written.length} 个`;
      const errSummary = errors.length
        ? ` · 失败 ${errors.length}: ${errors.slice(0, 2).join('; ')}`
        : '';
      this.setStatus(`下载完成: ${summary} → 目录 ${dir.name}${errSummary}`);
    } catch (e) {
      this.setStatus(`下载失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.isDownloading = false;
      this.downloadBtn && (this.downloadBtn.disabled = false);
    }
  }

  private getSelectedNode(): EgretDisplayObject | null {
    const root = getSceneRoot();
    if (!root || !this.selectedId) return null;
    return findDisplayById(root, this.selectedId);
  }

  private onNodePicked(nodeId: string): void {
    this.selectedId = nodeId;
    const root = getSceneRoot();
    if (root) {
      const path = getPathToNode(root, nodeId);
      if (path) {
        for (const id of path) this.expandedScene.add(id);
      }
    }
    this.stopPickModeInternal();
    this.refreshAll(true);
    // 拾取后自动滚动到节点位置（center）
    requestAnimationFrame(() => this.scrollSelectedIntoView());
  }

  private scrollSelectedIntoView(): void {
    if (!this.sceneTreeContainer) return;
    const sel = this.sceneTreeContainer.querySelector(
      'li.node-tree-item.selected, li[data-uuid].selected'
    ) as HTMLElement | null;
    if (sel) {
      sel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
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
        `[Active编辑:egret] ${getDisplayName(node ?? {})}(${nodeId}) visible=${active}`
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
      this.setStatus('未找到 Egret stage（egret.sys.$TempStage 为空）');
      if (this.sceneTreeContainer) {
        this.sceneTreeContainer.innerHTML =
          '<div class="empty-scene">等待 Egret 舞台就绪…</div>';
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
      `Egret stage · ${countNodes(treeInfo)} 节点 · ${sprites.length} 贴图` +
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
    body.innerHTML = buildDetailRows(node, this.selectedId)
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

function buildDetailRows(
  node: EgretDisplayObject,
  nodeId: string
): Array<[string, string]> {
  const exmlId = typeof node.id === 'string' ? node.id : '';
  const t = getNodeTexture(node);
  const tex = t
    ? `${t.$bitmapWidth ?? t.textureWidth ?? 0}×${t.$bitmapHeight ?? t.textureHeight ?? 0}` +
      (t.$bitmapX || t.$bitmapY ? ` @(${t.$bitmapX ?? 0},${t.$bitmapY ?? 0})` : '')
    : '(none)';
  const rows: Array<[string, string]> = [
    ['id', nodeId],
    ['ctor', node.constructor?.name || ''],
  ];
  if (exmlId) rows.push(['ExmlId', exmlId]);
  rows.push(
    ['visible', String(node.visible !== false)],
    ['x/y', `${node.x ?? 0}, ${node.y ?? 0}`],
    ['w/h', `${node.width ?? 0} × ${node.height ?? 0}`],
    ['scale', `${node.scaleX ?? 1}, ${node.scaleY ?? 1}`],
    ['rotation', String(node.rotation ?? 0)],
    ['alpha', String(node.alpha ?? 1)],
    ['texture', tex]
  );
  return rows;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function startEgretInspector(): void {
  new EgretInspector();
}
