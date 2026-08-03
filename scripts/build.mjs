import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
).version;
const dist = join(root, 'dist');
const minify = process.argv.includes('--minify');
const watch = process.argv.includes('--watch');

mkdirSync(dist, { recursive: true });

const minifyFlag = minify ? ['--minify'] : [];

async function build() {
  let esbuildMod = null;
  try {
    esbuildMod = await import('esbuild');
  } catch {
    /* 使用 npx 回退 */
  }

  const common = {
    bundle: true,
    format: 'iife',
    target: ['chrome90'],
    sourcemap: true,
    minify,
    logLevel: 'info',
    define: {
      __INSPECTOR_VERSION__: JSON.stringify(pkgVersion),
    },
  };

  if (esbuildMod) {
    const esbuild = esbuildMod.default ?? esbuildMod;
    const ctx = await esbuild.context({
      ...common,
      entryPoints: {
        content: join(root, 'src/content.ts'),
        injected: join(root, 'src/injected.ts'),
        background: join(root, 'src/background.ts'),
        'pixi-probe': join(root, 'src/pixi/earlyProbe.entry.ts'),
      },
      outdir: dist,
    });
    if (watch) {
      await ctx.watch();
      console.log('watching…');
    } else {
      await ctx.rebuild();
      await ctx.dispose();
    }
  } else {
    console.log('本地未安装 esbuild，使用 npx esbuild…');
    if (watch) {
      console.warn('npx 模式不支持 --watch，请先 npm install');
    }
    for (const [name, entry] of [
      ['content', 'src/content.ts'],
      ['injected', 'src/injected.ts'],
      ['background', 'src/background.ts'],
      ['pixi-probe', 'src/pixi/earlyProbe.entry.ts'],
    ]) {
      const r = spawnSync(
        'npx',
        [
          '--yes',
          'esbuild',
          entry,
          '--bundle',
          `--outfile=dist/${name}.js`,
          '--format=iife',
          `--define:__INSPECTOR_VERSION__=${JSON.stringify(pkgVersion)}`,
          ...minifyFlag,
        ],
        { cwd: root, stdio: 'inherit', shell: true }
      );
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
  }

  // Chrome 要求扩展资源为合法 UTF-8；避免 copy 带入 GBK 残片
  const cssSrc = join(root, 'src/styles/inspector.css');
  const cssDst = join(dist, 'inspector.css');
  const cssBuf = readFileSync(cssSrc);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(cssBuf);
  } catch (e) {
    throw new Error(
      `src/styles/inspector.css 不是合法 UTF-8，无法打包扩展: ${e.message}`
    );
  }
  writeFileSync(cssDst, cssBuf);
  console.log('build ok → dist/');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
