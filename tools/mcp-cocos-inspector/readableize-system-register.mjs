/**
 * 对已拆好的 System.register 模块做可读化：
 * - 抽出 execute 函数体
 * - 根据 setters 生成 import 注释/伪 import
 * - prettier 格式化
 * - 轻量替换 !0/!1/void 0
 *
 * 用法:
 *   node readableize-system-register.mjs <splitDir> [--out <dir>]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { createRequire } from 'module';
import { format } from 'prettier';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { input: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (!argv[i].startsWith('-') && !args.input) args.input = argv[i];
  }
  return args;
}

function extractBalanced(code, openIdx) {
  // openIdx points at '{'
  if (code[openIdx] !== '{') return null;
  let depth = 0;
  let inStr = null;
  let escape = false;
  for (let i = openIdx; i < code.length; i += 1) {
    const ch = code[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start: openIdx, end: i + 1, text: code.slice(openIdx, i + 1) };
    }
  }
  return null;
}

function findExecuteBody(registerCode) {
  const marker = 'execute:';
  const idx = registerCode.indexOf(marker);
  if (idx < 0) return null;
  let i = idx + marker.length;
  while (i < registerCode.length && /\s/.test(registerCode[i])) i += 1;
  // function(){ or function (){
  if (!registerCode.startsWith('function', i)) return null;
  i += 'function'.length;
  while (i < registerCode.length && /\s/.test(registerCode[i])) i += 1;
  if (registerCode[i] === '(') {
    // skip params
    let depth = 0;
    let inStr = null;
    let escape = false;
    for (; i < registerCode.length; i += 1) {
      const ch = registerCode[i];
      if (inStr) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
  }
  while (i < registerCode.length && /\s/.test(registerCode[i])) i += 1;
  if (registerCode[i] !== '{') return null;
  const body = extractBalanced(registerCode, i);
  if (!body) return null;
  // strip outer braces
  return body.text.slice(1, -1);
}

function parseHeaderMeta(text) {
  const mod = text.match(/\/\* module: ([^*]+) \*\//);
  const deps = text.match(/\/\* deps: (\[[\s\S]*?\]) \*\//);
  let depList = [];
  if (deps) {
    try {
      depList = JSON.parse(deps[1]);
    } catch {
      /* ignore */
    }
  }
  return {
    moduleId: mod ? mod[1].trim() : '',
    deps: depList,
  };
}

function parseExportNames(executeBody) {
  const names = [];
  const re = /\bt\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(executeBody))) names.push(m[1]);
  // also e("Name" for other minifier letters - export fn is first arg of factory
  // Pattern: <letter>("ClassName",
  const re2 = /(?:^|[;{])\s*[a-z]\(\s*["']([A-Za-z_][\w]*)["']\s*,/g;
  while ((m = re2.exec(executeBody))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function lightClean(src) {
  return src
    .replace(/!0/g, 'true')
    .replace(/!1/g, 'false')
    .replace(/\bvoid 0\b/g, 'undefined');
}

function buildImportBlock(deps) {
  if (!deps.length) return '';
  const lines = deps.map((d, i) => `// dep[${i}]: ${d}`);
  return `${lines.join('\n')}\n\n`;
}

async function readableizeOne(text, fileName) {
  const meta = parseHeaderMeta(text);
  const registerMatch = text.match(/System\.register[\s\S]*$/);
  const registerCode = registerMatch ? registerMatch[0] : text;
  let body = findExecuteBody(registerCode);
  if (!body) {
    // fallback: whole file prettier
    body = registerCode;
  }
  body = lightClean(body);
  const exports = parseExportNames(body);
  const header = [
    `// readableized from System.register`,
    meta.moduleId ? `// module: ${meta.moduleId}` : '',
    exports.length ? `// exports: ${exports.join(', ')}` : '',
    `// source-file: ${fileName}`,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const importBlock = buildImportBlock(meta.deps);
  let code = `${header}\n${importBlock}${body}\n`;
  try {
    code = await format(code, {
      parser: 'babel',
      printWidth: 100,
      singleQuote: true,
      semi: true,
      trailingComma: 'all',
    });
  } catch (e) {
    // prettier fail → keep raw with note
    code = `${header}\n${importBlock}/* prettier failed: ${e.message} */\n${body}\n`;
  }
  return { code, exports, moduleId: meta.moduleId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      '用法: node readableize-system-register.mjs <splitDir> [--out <dir>]',
    );
    process.exit(1);
  }
  const inputDir = resolve(args.input);
  const outDir = resolve(args.out || `${inputDir}-readable`);
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(inputDir).filter(
    (f) => f.endsWith('.js') && f !== '_manifest.json',
  );
  const summary = [];
  for (const f of files) {
    const text = readFileSync(join(inputDir, f), 'utf8');
    const { code, exports, moduleId } = await readableizeOne(text, f);
    writeFileSync(join(outDir, f), code, 'utf8');
    summary.push({ file: f, moduleId, exports });
  }
  writeFileSync(
    join(outDir, '_readable-manifest.json'),
    JSON.stringify({ count: summary.length, modules: summary }, null, 2),
    'utf8',
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        count: summary.length,
        sample: summary.filter((s) => s.exports?.length).slice(0, 15),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
