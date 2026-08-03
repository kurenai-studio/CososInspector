/* global chrome */
(function () {
  const KEY = 'pixiEnabled';
  const DEFAULT = false;
  const box = document.getElementById('pixi-enabled');
  const status = document.getElementById('status');
  const ver = document.getElementById('ver');

  try {
    const man = chrome.runtime.getManifest();
    if (ver && man?.version) ver.textContent = 'v' + man.version;
  } catch (_) {}

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  chrome.storage.sync.get({ [KEY]: DEFAULT }, (res) => {
    if (chrome.runtime.lastError) {
      setStatus('读取失败：' + (chrome.runtime.lastError.message || ''));
      return;
    }
    const on = res?.[KEY] === true;
    box.checked = on;
    setStatus(on ? 'Pixi 探测：开（请刷新试玩页）' : 'Pixi 探测：关（推荐默认）');
  });

  box.addEventListener('change', () => {
    const on = !!box.checked;
    chrome.storage.sync.set({ [KEY]: on }, () => {
      if (chrome.runtime.lastError) {
        setStatus('保存失败：' + (chrome.runtime.lastError.message || ''));
        box.checked = !on;
        return;
      }
      setStatus(
        on
          ? '已开启 — 请硬刷新 Pixi 试玩页后再用'
          : '已关闭 — 普通网页不再注入 Pixi 探针'
      );
    });
  });
})();
