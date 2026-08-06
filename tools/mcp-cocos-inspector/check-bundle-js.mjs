const root =
  'https://gameresource3.rsg-games.com/WebUI3/content/PowerOfThor2/remote/';
const headers = {
  Referer: 'https://gameweb3.rsg-games.com/',
  'User-Agent': 'Mozilla/5.0',
};
const names = ['internal', 'main', 'resources', 'slotgame', 'freegame'];
const rows = [];

for (const name of names) {
  const cfgRes = await fetch(`${root}${name}/config.json`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const jsRes = await fetch(`${root}${name}/index.js`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const cfg = cfgRes.ok ? await cfgRes.json() : null;
  let bytes = 0;
  let registers = 0;
  let rf = 0;
  if (jsRes.ok) {
    const t = await jsRes.text();
    bytes = t.length;
    let i = 0;
    while ((i = t.indexOf('System.register(', i)) !== -1) {
      registers += 1;
      i += 1;
    }
    i = 0;
    while ((i = t.indexOf('_RF.push', i)) !== -1) {
      rf += 1;
      i += 1;
    }
  }
  rows.push({
    name,
    hasPreloadScript: cfg?.hasPreloadScript ?? null,
    indexJsKB: Math.round((bytes / 1024) * 10) / 10,
    systemRegister: registers,
    rfPush: rf,
    verdict:
      registers > 1
        ? '有业务模块代码'
        : bytes > 500
          ? '有 JS 但几乎无模块（可能空壳/引导）'
          : '基本无代码',
  });
}

console.log(JSON.stringify(rows, null, 2));
