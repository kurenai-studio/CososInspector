/**
 * 反馈 BUG：只导出诊断日志（本地 txt / 复制），不上报服务器。
 */

import { diagLog, getDiagLogCount, getDiagLogText } from './diagLog';
import { MCP_REPO_URL } from './mcpInstallGuide';

declare const __INSPECTOR_VERSION__: string;

const DIALOG_CLASS = 'insp-bug-feedback';

export const hideBugFeedback = (): void => {
  document.querySelectorAll(`.${DIALOG_CLASS}`).forEach((el) => el.remove());
};

const buildReport = (userNote: string): string => {
  const note = userNote.trim() || '(用户未填写描述)';
  return [
    '=== Cocos Inspector Bug Report (logs only) ===',
    `generatedAt: ${new Date().toISOString()}`,
    `inspectorVersion: ${__INSPECTOR_VERSION__}`,
    `page: ${location.href}`,
    `userAgent: ${navigator.userAgent}`,
    `logLines: ${getDiagLogCount()}`,
    '',
    '--- user note ---',
    note,
    '',
    '--- diag logs ---',
    getDiagLogText() || '(empty)',
    '',
    `repo: ${MCP_REPO_URL}`,
  ].join('\n');
};

const downloadText = (text: string): void => {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `cocos-inspector-bug-${ts}.txt`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
};

const copyText = async (text: string, btn: HTMLButtonElement): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = '已复制';
    window.setTimeout(() => {
      btn.textContent = old;
    }, 1500);
  } catch (error) {
    console.warn('[Cocos Inspector:诊断] 复制失败', error);
    btn.textContent = '复制失败';
  }
};

export const showBugFeedback = (host: HTMLElement): void => {
  try {
    hideBugFeedback();
    diagLog('feedback:open', `logs=${getDiagLogCount()}`);

    const card = document.createElement('div');
    card.className = DIALOG_CLASS;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '反馈 BUG');

    const title = document.createElement('div');
    title.className = 'insp-bug-feedback-title';
    title.textContent = '反馈 BUG（仅诊断日志）';
    card.appendChild(title);

    const lead = document.createElement('p');
    lead.className = 'insp-bug-feedback-lead';
    lead.textContent =
      `只打包本地日志（${getDiagLogCount()} 行），不含节点树/截图。` +
      '复现「F12 变手机模式」后点下载，把 txt 发给我们即可。';
    card.appendChild(lead);

    const note = document.createElement('textarea');
    note.className = 'insp-bug-feedback-note';
    note.rows = 4;
    note.placeholder = '可选：简述现象 / 复现步骤…';
    card.appendChild(note);

    const preview = document.createElement('pre');
    preview.className = 'insp-bug-feedback-preview';
    preview.textContent = getDiagLogText() || '(暂无日志，请先复现问题)';
    card.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'insp-bug-feedback-actions';

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'insp-bug-feedback-download';
    downloadBtn.textContent = '下载日志包';
    downloadBtn.addEventListener('click', () => {
      try {
        const report = buildReport(note.value);
        diagLog('feedback:download', `bytes=${report.length}`);
        downloadText(report);
        downloadBtn.textContent = '已下载';
        window.setTimeout(() => {
          downloadBtn.textContent = '下载日志包';
        }, 1500);
      } catch (error) {
        console.error('[Cocos Inspector:诊断] 下载失败', error);
      }
    });
    actions.appendChild(downloadBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'insp-bug-feedback-copy';
    copyBtn.textContent = '复制日志';
    copyBtn.addEventListener('click', () => {
      void copyText(buildReport(note.value), copyBtn);
    });
    actions.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'insp-bug-feedback-close';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', () => hideBugFeedback());
    actions.appendChild(closeBtn);

    card.appendChild(actions);
    host.appendChild(card);
  } catch (error) {
    console.error('[Cocos Inspector:诊断] 展示反馈面板失败', error);
  }
};

/** 在 header controls 末尾（收起前）挂「反馈」按钮 */
export const appendBugFeedbackButton = (
  controls: HTMLElement,
  panelHost: HTMLElement
): void => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'insp-bug-feedback-btn';
  btn.textContent = '反馈';
  btn.title = '导出诊断日志（本地 txt）';
  btn.addEventListener('click', () => {
    try {
      const existing = panelHost.querySelector(`.${DIALOG_CLASS}`);
      if (existing) {
        existing.remove();
        return;
      }
      showBugFeedback(panelHost);
    } catch (error) {
      console.error('[Cocos Inspector:诊断] 反馈按钮失败', error);
    }
  });
  controls.appendChild(btn);
};
