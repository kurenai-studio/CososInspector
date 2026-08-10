/**
 * 单元测试运行器：用 esbuild 把 .test.ts 打包成 CJS，再由 node:test 执行
 * 运行: node tests/run.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const entries = ['tests/movieclip.test.ts'];
const outDir = mkdtempSync(join(tmpdir(), 'cocos-test-'));
const outfile = join(outDir, 'bundle.cjs');

// 给 btoa/atob 提供全局 shim（Node 22+ 已自带，但保险起见）
const banner = `
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
`;

await build({
  entryPoints: entries,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node18'],
  outfile,
  banner: { js: banner },
  logLevel: 'info',
});

const r = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
process.exit(r.status || 0);
