/** 拾取 / 下载工具栏 DOM（Cocos 2.x / 3.x 共用） */

export type DownloadMenuItem = { key: string; label: string };

export const COCOS_DOWNLOAD_ITEMS: DownloadMenuItem[] = [
  { key: 'node-texture', label: '选中节点纹理 PNG' },
  { key: 'node-subtree', label: '选中节点子树 Sprite PNG' },
  { key: 'node-spine', label: '选中节点 Spine zip' },
  { key: 'node-bmfont', label: '选中节点 BMFont zip' },
  { key: 'scene-sprites', label: '整场景 Sprite PNG' },
];

export const createPickDownloadDom = (): {
  pickBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
  downloadMenu: HTMLDivElement;
} => {
  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'pick-btn';
  pickBtn.textContent = '拾取';
  pickBtn.title = '点击画面节点，定位到节点树（Esc 取消）';

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'download-btn';
  downloadBtn.textContent = '下载';
  downloadBtn.title = '导出纹理 / Spine / BMFont 到本地目录';

  const downloadMenu = document.createElement('div');
  downloadMenu.className = 'download-menu';
  downloadMenu.style.display = 'none';

  return { pickBtn, downloadBtn, downloadMenu };
};

export const fillDownloadMenu = (
  menu: HTMLElement,
  items: DownloadMenuItem[],
  onItem: (key: string) => void
): void => {
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'download-menu-item';
    b.textContent = it.label;
    b.dataset.key = it.key;
    b.addEventListener('click', () => onItem(it.key));
    menu.appendChild(b);
  }
};

export const placeDownloadMenu = (
  menu: HTMLElement,
  btn: HTMLElement
): void => {
  const rect = btn.getBoundingClientRect();
  menu.style.display = 'block';
  menu.style.left = `${Math.max(8, rect.right - 280)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
};

export const isInspectorEventTarget = (ev: Event): boolean => {
  const t = ev.target;
  if (!(t instanceof Element)) return false;
  return !!t.closest(
    [
      '.cocos-inspector-root',
      '.download-menu',
      '.mcp-install-guide',
      '#cocos-inspector-bounds-overlay',
      '#cocos-inspector-pick-overlay',
    ].join(',')
  );
};
