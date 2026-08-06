const base =
  'https://gameresource3.rsg-games.com/WebUI3/content/PowerOfThor2/remote/slotgame/';
const referer =
  'https://gameweb3.rsg-games.com/Web/SlotGame5?dir=PowerOfThor2';
const headers = {
  'User-Agent': 'Mozilla/5.0',
  Referer: referer,
};

const cfgRes = await fetch(`${base}config.json`, {
  headers,
  signal: AbortSignal.timeout(60_000),
});
const cfg = cfgRes.ok ? await cfgRes.json() : null;

const indexRes = await fetch(`${base}index.js`, {
  headers,
  signal: AbortSignal.timeout(60_000),
});
let indexInfo = {
  url: `${base}index.js`,
  ok: indexRes.ok,
  status: indexRes.status,
};
if (indexRes.ok) {
  const text = await indexRes.text();
  indexInfo = {
    ...indexInfo,
    bytes: text.length,
    registerCount: (text.match(/System\.register\s*\(/g) || []).length,
    rfPushCount: (text.match(/_RF\.push/g) || []).length,
    virtualModuleSamples: [
      ...text.matchAll(/System\.register\("([^"]+)"/g),
    ]
      .slice(0, 8)
      .map((m) => m[1]),
    head: text.slice(0, 160).replace(/\n/g, ' '),
  };
}

const paths = cfg?.paths || {};
const types = cfg?.types || [];
const typeHist = {};
for (const v of Object.values(paths)) {
  if (!Array.isArray(v)) continue;
  const t = types[v[1]] || `type#${v[1]}`;
  typeHist[t] = (typeHist[t] || 0) + 1;
}

console.log(
  JSON.stringify(
    {
      step: 2,
      game: 'PowerOfThor2',
      page: referer,
      bundle: 'slotgame',
      base,
      config: cfg
        ? {
            name: cfg.name,
            hasPreloadScript: cfg.hasPreloadScript,
            deps: cfg.deps,
            uuidCount: cfg.uuids?.length,
            pathCount: Object.keys(paths).length,
            packCount: Object.keys(cfg.packs || {}).length,
            redirectPairs: Array.isArray(cfg.redirect)
              ? cfg.redirect.length / 2
              : 0,
            scenes: cfg.scenes,
            importBase: cfg.importBase,
            nativeBase: cfg.nativeBase,
            typeHistogram: typeHist,
          }
        : { error: cfgRes.status },
      indexJs: indexInfo,
      next:
        '③ 按需下载 slotgame import/native；④ 对 index.js 做 System.register 拆分',
    },
    null,
    2,
  ),
);
