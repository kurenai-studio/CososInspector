/** 商店扩展不含 MCP 服务端；未连接时点击指示灯展示安装指引。 */

export const MCP_REPO_URL = 'https://github.com/shinjiyu/CososInspector';

const GUIDE_CLASS = 'mcp-install-guide';

export const hideMcpInstallGuide = (): void => {
  document.querySelectorAll(`.${GUIDE_CLASS}`).forEach((el) => el.remove());
};

export const syncMcpGuideClickable = (
  statusEl: HTMLElement,
  status: string
): void => {
  const disconnected = status === 'disconnected';
  statusEl.classList.toggle('mcp-status--clickable', disconnected);
  statusEl.setAttribute('role', disconnected ? 'button' : 'status');
  if (!disconnected) hideMcpInstallGuide();
};

export const showMcpInstallGuide = (host: HTMLElement): void => {
  try {
    hideMcpInstallGuide();

    const card = document.createElement('div');
    card.className = GUIDE_CLASS;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '安装 MCP 桥接');

    const title = document.createElement('div');
    title.className = 'mcp-install-guide-title';
    title.textContent = '安装 Cursor MCP';
    card.appendChild(title);

    const lead = document.createElement('p');
    lead.className = 'mcp-install-guide-lead';
    lead.textContent =
      '商店扩展不含 MCP。请克隆仓库并启动本机桥，Cursor 才能控制试玩页。';
    card.appendChild(lead);

    const link = document.createElement('a');
    link.className = 'mcp-install-guide-link';
    link.href = MCP_REPO_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = MCP_REPO_URL;
    card.appendChild(link);

    const steps = document.createElement('ol');
    steps.className = 'mcp-install-guide-steps';
    [
      'git clone 上述仓库，根目录 npm install',
      'cd tools/mcp-cocos-inspector && npm install',
      '回到仓库根目录执行 npm run cocos-bridge（保持终端不关）',
      'Cursor MCP 指向 tools/mcp-cocos-inspector/index.mjs',
      '试玩页 F5，本指示灯变绿即可',
    ].forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      steps.appendChild(li);
    });
    card.appendChild(steps);

    const actions = document.createElement('div');
    actions.className = 'mcp-install-guide-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'mcp-install-guide-copy';
    copyBtn.textContent = '复制仓库地址';
    copyBtn.addEventListener('click', () => {
      void copyRepoUrl(copyBtn);
    });
    actions.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mcp-install-guide-close';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', () => hideMcpInstallGuide());
    actions.appendChild(closeBtn);

    card.appendChild(actions);
    host.appendChild(card);
  } catch (error) {
    console.error('[MCP指引] 展示安装指引失败', error);
  }
};

export const bindMcpInstallGuide = (
  statusEl: HTMLElement,
  host: HTMLElement
): void => {
  statusEl.addEventListener('click', () => {
    try {
      if (!statusEl.classList.contains('mcp-status--disconnected')) {
        hideMcpInstallGuide();
        return;
      }
      const existing = host.querySelector(`.${GUIDE_CLASS}`);
      if (existing) {
        existing.remove();
        return;
      }
      showMcpInstallGuide(host);
    } catch (error) {
      console.error('[MCP指引] 点击处理失败', error);
    }
  });
};

const copyRepoUrl = async (btn: HTMLButtonElement): Promise<void> => {
  try {
    await navigator.clipboard.writeText(MCP_REPO_URL);
    btn.textContent = '已复制';
    window.setTimeout(() => {
      btn.textContent = '复制仓库地址';
    }, 1500);
  } catch (error) {
    console.warn('[MCP指引] 复制失败，改为打开仓库', error);
    window.open(MCP_REPO_URL, '_blank', 'noopener,noreferrer');
  }
};
