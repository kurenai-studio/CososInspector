/**
 * 将 Cocos 3.x bundle index.js（多段 System.register）拆成多文件。
 * 用法: node split-system-register.mjs <index.js> [--out <dir>]
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join, basename, resolve } from 'path';
import { fileURLToPath } from 'url';

function parseArgs(argv) {
  const args = { input: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (!argv[i].startsWith('-') && !args.input) args.input = argv[i];
  }
  return args;
}

function safeFileName(moduleId) {
  let s = String(moduleId || 'unknown');
  // chunks:///_virtual/foo.ts → foo
  const m = s.match(/\/_virtual\/([^/?#]+)/);
  if (m) s = m[1];
  s = s.replace(/^chunks:\/\/\/?/, '');
  s = s.replace(/\.ts$/i, '');
  s = s.replace(/[^a-zA-Z0-9._\-]+/g, '_');
  return s.slice(0, 120) || 'module';
}

/**
 * 从 start（指向 'System.register' 的 S）切出完整调用到匹配的右括号。
 * 用字符串/括号扫描，避免正则对大文件翻车。
 */
function extractRegisterCall(code, start) {
  const head = 'System.register';
  if (!code.startsWith(head, start)) return null;
  let i = start + head.length;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  if (code[i] !== '(') return null;
  i += 1; // after (

  let depth = 1;
  let inStr = null; // ' " `
  let escape = false;
  const bodyStart = i;

  while (i < code.length) {
    const ch = code[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        const end = i + 1; // include )
        // optional trailing ;
        let j = end;
        while (j < code.length && /\s/.test(code[j])) j += 1;
        if (code[j] === ';') j += 1;
        return {
          start,
          end: j,
          call: code.slice(start, j),
        };
      }
    }
    i += 1;
  }
  return null;
}

function parseModuleId(call) {
  const m = call.match(/^System\.register\s*\(\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

function parseDeps(call) {
  const m = call.match(
    /^System\.register\s*\(\s*["'][^"']+["']\s*,\s*(\[[\s\S]*?\])\s*,/,
  );
  if (!m) return [];
  try {
    // deps 数组一般是字符串字面量，可用 JSON
    return JSON.parse(m[1].replace(/'/g, '"'));
  } catch {
    return [];
  }
}

function splitSystemRegister(code) {
  const modules = [];
  let from = 0;
  while (from < code.length) {
    const idx = code.indexOf('System.register', from);
    if (idx === -1) break;
    // 避免匹配到注释里的偶发词：后面应是 (
    let k = idx + 'System.register'.length;
    while (k < code.length && /\s/.test(code[k])) k += 1;
    if (code[k] !== '(') {
      from = idx + 1;
      continue;
    }
    const extracted = extractRegisterCall(code, idx);
    if (!extracted) {
      from = idx + 1;
      continue;
    }
    const id = parseModuleId(extracted.call);
    const deps = parseDeps(extracted.call);
    modules.push({
      id: id || `anon_${modules.length}`,
      deps,
      code: extracted.call.trim() + (extracted.call.trim().endsWith(';') ? '' : ';'),
      start: extracted.start,
      end: extracted.end,
    });
    from = extracted.end;
  }
  return modules;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      '用法: node split-system-register.mjs <index.js> [--out <dir>]',
    );
    process.exit(1);
  }
  const input = resolve(args.input);
  if (!existsSync(input)) {
    console.error('文件不存在:', input);
    process.exit(1);
  }
  const outDir =
    args.out ||
    join(dirname(input), `${basename(input, '.js')}-split`);

  const code = readFileSync(input, 'utf8');
  const modules = splitSystemRegister(code);
  mkdirSync(outDir, { recursive: true });

  const usedNames = new Map();
  const manifest = [];
  for (const mod of modules) {
    let name = safeFileName(mod.id);
    const n = (usedNames.get(name) || 0) + 1;
    usedNames.set(name, n);
    if (n > 1) name = `${name}__${n}`;
    const file = `${name}.js`;
    const header = `/* module: ${mod.id} */\n/* deps: ${JSON.stringify(mod.deps)} */\n`;
    writeFileSync(join(outDir, file), header + mod.code + '\n', 'utf8');
    manifest.push({
      file,
      id: mod.id,
      deps: mod.deps,
      bytes: mod.code.length,
    });
  }

  writeFileSync(
    join(outDir, '_manifest.json'),
    JSON.stringify(
      {
        source: input,
        moduleCount: modules.length,
        modules: manifest,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: input,
        outDir,
        moduleCount: modules.length,
        sample: manifest.slice(0, 12).map((m) => ({
          file: m.file,
          id: m.id,
          bytes: m.bytes,
        })),
      },
      null,
      2,
    ),
  );
}

main();
