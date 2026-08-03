/**
 * 用真实探针验证 Eternal Dusk 能否截到 Application
 */
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('D:/workspace/harExplore/package.json');
const { chromium } = require('playwright');

// 从 earlyProbeSource.ts 抽源码太麻烦，直接读构建后的 pixi-probe.js
const probePath = 'D:/UGit/CososInspectorNew/dist/pixi-probe.js';

const URL =
  'https://eternal-dusk.slotmill.com/?currency=EUR&language=en&org=SlotMill&homeurl=https://slotmill.com';

async function main() {
  if (!fs.existsSync(probePath)) {
    console.error('missing', probePath, '- run npm run build first');
    process.exit(1);
  }
  const probeCode = fs.readFileSync(probePath, 'utf8');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 在任何脚本前注入探针
  await page.addInitScript({ content: probeCode });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('canvas', { timeout: 60000 });
  await page.waitForTimeout(8000);

  const result = await page.evaluate(() => ({
    hint: !!window.__cocosInspectorPixiHint,
    lib: !!window.__cocosInspectorPixiLib,
    host: !!window.__cocosInspectorPixiHost,
    hasRequire: typeof window.__webpack_require__ === 'function',
    hasM: !!(window.__webpack_require__ && window.__webpack_require__.m),
    app: !!(window.__PIXI_APP__ && window.__PIXI_APP__.stage),
    children: window.__PIXI_APP__?.stage?.children?.length ?? null,
    appsLen: (window.__cocosInspectorPixiApps || []).length,
    stageName: window.__PIXI_STAGE__?.constructor?.name ?? null,
  }));

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.app) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
