#!/usr/bin/env node
/**
 * 对标准 Cocos 构建目录或 runtime-dump/build 调用 cc-reverse。
 *
 *   node cc-reverse-runner.mjs --path <buildDir> [--output <out>] [--key <xxtea>]
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    return fallback;
  };
  const has = (flag) => argv.includes(flag);
  return {
    path: get('--path', ''),
    output: get('--output', ''),
    key: get('--key', ''),
    versionHint: get('--version-hint', '3.x'),
    assetsOnly: has('--assets-only'),
    scriptsOnly: has('--scripts-only'),
    verbose: has('--verbose'),
  };
}

function resolveCcReverseBin() {
  try {
    const pkg = require.resolve('cc-reverse/package.json');
    const bin = join(dirname(pkg), 'bin', 'cc-reverse.js');
    if (existsSync(bin)) return bin;
  } catch {
    /* not installed next to this package */
  }
  try {
    const rootPkg = require.resolve('cc-reverse/package.json', {
      paths: [join(__dirname, '../..'), process.cwd()],
    });
    const bin = join(dirname(rootPkg), 'bin', 'cc-reverse.js');
    if (existsSync(bin)) return bin;
  } catch {
    /* ignore */
  }
  return null;
}

export function runCcReverse(options) {
  const input = resolve(options.path || '');
  if (!input || !existsSync(input)) {
    return { ok: false, error: `输入目录不存在: ${input}` };
  }
  const output = resolve(
    options.output || join(input, '..', 'cc-reverse-output'),
  );
  mkdirSync(output, { recursive: true });

  const bin = resolveCcReverseBin();
  if (!bin) {
    return {
      ok: false,
      error:
        '未找到 cc-reverse。请在 tools/mcp-cocos-inspector 执行: npm install cc-reverse',
    };
  }

  const args = [bin, '--path', input, '--output', output];
  if (options.versionHint) {
    args.push('--version-hint', options.versionHint);
  }
  if (options.key) args.push('--key', options.key);
  if (options.assetsOnly) args.push('--assets-only');
  if (options.scriptsOnly) args.push('--scripts-only');
  if (options.verbose) args.push('--verbose');

  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  const reportPath = join(output, 'RECOVERY_REPORT.md');
  const report = existsSync(reportPath)
    ? require('fs').readFileSync(reportPath, 'utf8')
    : '';

  writeFileSync(
    join(output, '_runner-log.json'),
    JSON.stringify(
      {
        status: r.status,
        args,
        stdout: (r.stdout || '').slice(-8000),
        stderr: (r.stderr || '').slice(-8000),
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    ok: r.status === 0,
    status: r.status,
    input,
    output,
    reportPath: existsSync(reportPath) ? reportPath : null,
    reportPreview: report.slice(0, 4000),
    stdoutTail: (r.stdout || '').slice(-2000),
    stderrTail: (r.stderr || '').slice(-2000),
    error: r.status === 0 ? undefined : `cc-reverse exit ${r.status}`,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.path) {
    console.error('用法: node cc-reverse-runner.mjs --path <buildDir> [--output <out>]');
    process.exit(2);
  }
  const res = runCcReverse(args);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
