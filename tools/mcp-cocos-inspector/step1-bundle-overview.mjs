import { connectBridgeClientOnly, bridgeApiCall, waitForExtension } from './bridge-server.mjs';

await connectBridgeClientOnly(17373);
await waitForExtension(15_000, 17373);

const page = await bridgeApiCall('getPageInfo', [], {
  pageUrlMatch: 'gameweb3',
  timeoutMs: 20_000,
});
const dump = await bridgeApiCall(
  'dumpRuntime',
  [
    {
      includeModuleSources: false,
      includeClassSources: false,
      includeResourceUrls: true,
      includeBundleConfigs: true,
    },
  ],
  { pageUrlMatch: 'gameweb3', timeoutMs: 120_000 },
);

if (!dump?.ok) {
  console.error(dump);
  process.exit(1);
}

const bundles = (dump.bundles || []).map((b) => {
  const c = b.config || {};
  let assetCount = 0;
  if (Array.isArray(c.uuids)) assetCount = c.uuids.length;
  else if (c.assetInfos?._map) assetCount = Object.keys(c.assetInfos._map).length;

  let scenes = [];
  if (c.scenes?._map) scenes = Object.keys(c.scenes._map);
  else if (c.scenes && typeof c.scenes === 'object') scenes = Object.keys(c.scenes);

  return {
    name: b.name,
    base: b.base,
    hasConfig: !!b.config,
    hasPreloadScript: c.hasPreloadScript,
    deps: c.deps || [],
    assetCount,
    scenes,
    indexJsUrl: b.base
      ? `${String(b.base).replace(/\/?$/, '/') }index.js`
      : null,
    configUrl: b.base
      ? `${String(b.base).replace(/\/?$/, '/') }config.json`
      : null,
  };
});

const reMain =
  /PowerOfThor2\/(index|application)\.js|src\/chunks|remote\/[^/]+\/index\.js|cocos-js\/(cc|_virtual)/i;
const mainJs = (dump.jsUrls || []).filter((u) => reMain.test(u));

console.log(
  JSON.stringify(
    {
      step: 1,
      analogy:
        '类似 Unity 先列出 AssetBundle 里有什么，而不是一上来拆包',
      page: {
        url: page?.pageUrl,
        scene: page?.sceneName,
        engine: page?.engineVersion,
      },
      bundleCount: bundles.length,
      bundles,
      mainJsCount: mainJs.length,
      mainJs,
      next: '② 选一个 bundle（如 slotgame）拉 config 看路径表 + HEAD/GET index.js 确认有无脚本包',
    },
    null,
    2,
  ),
);
