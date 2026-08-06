/**
 * L3 可读化 + 目录还原：
 * - 解析 System.register setters → 还原短变量名
 * - 用 dump 的 ClassName（含 Anim/widgets/…）恢复目录
 * - prettier 格式化
 *
 * 用法:
 *   node restore-scripts-l3.mjs <splitDir> [--out <dir>] [--dump <manifest.json>]
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'fs';
import { join, dirname, basename, resolve, relative } from 'path';
import { createRequire } from 'module';
import { format } from 'prettier';

const require = createRequire(import.meta.url);
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;

function parseArgs(argv) {
  const args = { input: null, out: null, dump: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--dump') args.dump = argv[++i];
    else if (!argv[i].startsWith('-') && !args.input) args.input = argv[i];
  }
  return args;
}

function extractBalanced(code, openIdx) {
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
      if (depth === 0) {
        return { start: openIdx, end: i + 1, text: code.slice(openIdx, i + 1) };
      }
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
  if (!registerCode.startsWith('function', i)) return null;
  i += 'function'.length;
  while (i < registerCode.length && /\s/.test(registerCode[i])) i += 1;
  if (registerCode[i] === '(') {
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
  return body ? body.text.slice(1, -1) : null;
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
  return { moduleId: mod ? mod[1].trim() : '', deps: depList };
}

/** 从 setters 数组文本解析 shortName -> importedProp */
function parseSetterBindings(registerCode) {
  const factoryParamMatch = registerCode.match(
    /System\.register\s*\(\s*(?:["'][^"']+["']|\w+)\s*,\s*\[[\s\S]*?\]\s*,\s*\(\s*function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/,
  );
  const exportFn = factoryParamMatch ? factoryParamMatch[1] : 't';

  const m = registerCode.match(/setters:\s*\[/);
  if (!m) {
    return {
      renameMap: { [exportFn]: '__export' },
      bindingNotes: [],
    };
  }
  const start = m.index + m[0].length - 1; // '['
  let depth = 0;
  let inStr = null;
  let escape = false;
  let end = -1;
  for (let i = start; i < registerCode.length; i += 1) {
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
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    return {
      renameMap: { [exportFn]: '__export' },
      bindingNotes: [],
    };
  }
  const arrText = registerCode.slice(start, end + 1);

  const renameMap = { [exportFn]: '__export' };
  const bindingNotes = [];
  const parts = [];
  let i = 1;
  while (i < arrText.length - 1) {
    while (i < arrText.length && /[\s,]/.test(arrText[i])) i += 1;
    if (i >= arrText.length - 1) break;
    if (arrText.startsWith('null', i)) {
      parts.push(null);
      i += 4;
      continue;
    }
    if (arrText.startsWith('function', i)) {
      const brace = arrText.indexOf('{', i);
      if (brace < 0) break;
      const block = extractBalanced(arrText, brace);
      if (!block) break;
      parts.push(arrText.slice(i, block.end));
      i = block.end;
      continue;
    }
    i += 1;
  }

  for (let pi = 0; pi < parts.length; pi += 1) {
    const fn = parts[pi];
    if (!fn) continue;
    const assigns = [
      ...fn.matchAll(
        /([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/g,
      ),
    ];
    for (const a of assigns) {
      const shortName = a[1];
      const prop = a[2];
      if (shortName === exportFn) continue; // 不覆盖导出函数形参
      let longName = prop;
      if (renameMap[shortName] && renameMap[shortName] !== longName) {
        longName = `${prop}_d${pi}`;
      }
      renameMap[shortName] = longName;
      bindingNotes.push({
        depIndex: pi,
        short: shortName,
        prop,
        long: longName,
      });
    }
  }
  return { renameMap, bindingNotes };
}

function lightClean(src) {
  return src
    .replace(/!0/g, 'true')
    .replace(/!1/g, 'false')
    .replace(/\bvoid 0\b/g, 'undefined');
}

function applyRenames(body, renameMap) {
  const keys = Object.keys(renameMap).sort((a, b) => b.length - a.length);
  if (!keys.length) return body;
  try {
    const wrapped = `function __execute(){\n${body}\n}`;
    const ast = parser.parse(wrapped, {
      sourceType: 'script',
      errorRecovery: true,
    });
    traverse(ast, {
      Identifier(path) {
        const name = path.node.name;
        const next = renameMap[name];
        if (!next) return;
        if (path.parent.type === 'MemberExpression'
          && path.parent.property === path.node
          && !path.parent.computed) {
          return;
        }
        if (path.parent.type === 'ObjectProperty'
          && path.parent.key === path.node
          && !path.parent.computed) {
          return;
        }
        // 有本地绑定则不改（避免 function e() 被改成 helpers 名）
        const binding = path.scope.getBinding(name);
        if (binding) return;
        path.node.name = next;
      },
    });
    const out = generate(ast, { compact: false, comments: true }).code;
    const m = out.match(/^function __execute\(\)\s*\{([\s\S]*)\}\s*$/);
    return m ? m[1].replace(/^\n/, '').replace(/\n$/, '') : body;
  } catch {
    return body;
  }
}

function kebabToPascal(kebab) {
  return String(kebab || '')
    .replace(/\.js$/i, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function normalizeKey(s) {
  return String(s || '')
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/i, '')
    .replace(/\.js$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildClassPathMap(dumpPath) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!dumpPath || !existsSync(dumpPath)) return map;
  try {
    const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
    for (const c of dump.classes || []) {
      const full = c.className || '';
      const short = full.includes('/') ? full.split('/').pop() : full;
      if (!short) continue;
      map.set(normalizeKey(short), full.replace(/\\/g, '/'));
      map.set(normalizeKey(full), full.replace(/\\/g, '/'));
    }
  } catch {
    /* ignore */
  }
  return map;
}

/** 无 dump 路径时，按命名启发式归目录（非原仓，仅便于浏览） */
function guessFolder(exports, fileBase) {
  const names = [...exports, fileBase, kebabToPascal(fileBase)].join(' ');
  const lower = `${names} ${fileBase}`.toLowerCase();

  // 接口文件优先（i-xxx）
  if (/^i-/.test(fileBase)) return 'interfaces';

  if (
    /buyfeature|extrabet|marqueedisplay|marqueeanim|reelshake|lastfreetimes|totalmultiplier|widgetanimation|(?<![a-z])widget(?!s)/i.test(
      names,
    )
  ) {
    return 'widgets';
  }
  if (/animationmanager|bonusanimationplayer/i.test(names)) return 'Anim';
  if (/exbutton|extransition|uiextension/i.test(lower)) return 'UIExtension';
  if (/uicolorsetting/i.test(lower)) return 'UI';
  if (/msgitemdisplay/i.test(lower)) return 'marquee';

  if (/-worker(?:\.js)?$|-work(?:\.js)?$/.test(fileBase)) return 'workers';
  if (/-status(?:\.js)?$/.test(fileBase)) return 'status';
  if (/loading/.test(lower)) return 'loading';
  if (/sound|music|bgm/.test(lower)) return 'sound';
  if (/symbol/.test(lower)) return 'symbol';
  if (/reel/.test(lower)) return 'reel';
  if (/board|rolling-score|win-record/.test(lower)) return 'boards';
  // 与 dump 中 Anim/ 对齐（Windows 大小写不敏感，避免 anim/Anim 混用）
  if (/-anim|animation|bigwin|character-play|thunder-play|scene-shake/.test(lower)) {
    return 'Anim';
  }
  if (/game-flow|game-scene|controller|prepare-game|cascading|free-game|drop-all|check-/.test(lower)) {
    return 'game';
  }
  if (/babelhelpers|rollupplugin/i.test(fileBase)) return '_helpers';
  if (/^index\d*$/i.test(fileBase) || fileBase === 'slotgame' || /^anon_/.test(fileBase)) {
    return '_entry';
  }
  return null;
}

function pickLeafName(exports, fileBase, classPathMap) {
  const pascal = kebabToPascal(fileBase);
  const pascalKey = normalizeKey(pascal);
  for (const ex of exports) {
    if (normalizeKey(ex) === pascalKey) return ex;
  }
  // 文件名是 controller，导出里常有枚举打头——优先最长且包含文件主干的类名
  let best = null;
  for (const ex of exports) {
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(ex)) continue;
    const k = normalizeKey(ex);
    if (k.includes(pascalKey) || pascalKey.includes(k)) {
      if (!best || ex.length > best.length) best = ex;
    }
  }
  if (best) return best;
  for (const ex of exports) {
    if (/^[A-Z][A-Za-z0-9_]*$/.test(ex)) return ex;
  }
  const hit = classPathMap.get(pascalKey);
  if (hit) return hit.includes('/') ? hit.split('/').pop() : hit;
  return fileBase;
}

function resolveOutRelPath(moduleId, exports, fileBase, classPathMap) {
  // 1) dump 类路径（widgets/Foo）——最接近原工程目录
  for (const ex of exports) {
    const hit = classPathMap.get(normalizeKey(ex));
    if (hit && hit.includes('/')) return `${hit}.js`;
  }
  const pascal = kebabToPascal(fileBase);
  const hit2 = classPathMap.get(normalizeKey(pascal));
  if (hit2 && hit2.includes('/')) return `${hit2}.js`;

  // 2) 命名启发式目录 + 类名/原文件名
  const folder = guessFolder(exports, fileBase);
  const leaf = pickLeafName(exports, fileBase, classPathMap);
  if (folder) return `${folder}/${leaf}.js`;

  // 3) dump 仅有短类名 → 放根下
  if (hit2) return `${hit2}.js`;
  for (const ex of exports) {
    const hit = classPathMap.get(normalizeKey(ex));
    if (hit && !hit.includes('/')) return `${hit}.js`;
  }

  // 4) 保留 virtual 模块名
  const vm = String(moduleId || '').match(
    /chunks:\/\/\/_virtual\/(.+?)(?:\.ts)?$/i,
  );
  if (vm) return `_virtual/${vm[1].replace(/\.ts$/i, '')}.js`;

  return `_virtual/${fileBase}.js`;
}

function parseExportsFromBody(body) {
  const names = [];
  const re = /__export\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(body))) names.push(m[1]);
  // 未 rename 时：导出函数 t("ClassName" / o("ClassName"（仅大写开头，避免 o(e,'prop')）
  const re2 = /\b[a-z]\(\s*['"]([A-Z][A-Za-z0-9_]*)['"]/g;
  while ((m = re2.exec(body))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function parseRfScriptName(body) {
  const m = body.match(
    /_RF\.push\(\s*\{\s*\}\s*,\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/,
  );
  return m ? m[1] : '';
}

async function processOne(text, fileName, classPathMap) {
  const meta = parseHeaderMeta(text);
  const registerMatch = text.match(/System\.register[\s\S]*$/);
  const registerCode = registerMatch ? registerMatch[0] : text;
  const { renameMap, bindingNotes } = parseSetterBindings(registerCode);
  let body = findExecuteBody(registerCode) || registerCode;
  body = lightClean(body);
  // rename 前先抽导出名（避免单字母导出函数误判）
  const exportsBefore = parseExportsFromBody(body);
  body = applyRenames(body, renameMap);

  const exportsAfter = parseExportsFromBody(body);
  const exports = [...new Set([...exportsBefore, ...exportsAfter])];
  const rfName = parseRfScriptName(body);
  const fileBase = basename(fileName, '.js');
  const relPath = resolveOutRelPath(
    meta.moduleId,
    exports.length ? exports : rfName ? [kebabToPascal(rfName)] : [],
    fileBase,
    classPathMap,
  );

  const header = [
    '// restored L3: System.register unwrap + setter rename + path hint',
    meta.moduleId ? `// module: ${meta.moduleId}` : '',
    exports.length ? `// exports: ${exports.join(', ')}` : '',
    `// out: ${relPath}`,
    '',
    '// deps:',
    ...meta.deps.map((d, i) => `//   [${i}] ${d}`),
    '// bindings:',
    ...bindingNotes
      .slice(0, 40)
      .map((b) => `//   ${b.short} <- dep[${b.depIndex}].${b.prop} => ${b.long}`),
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');

  let code = `${header}\n${body}\n`;
  try {
    code = await format(code, {
      parser: 'babel',
      printWidth: 100,
      singleQuote: true,
      semi: true,
      trailingComma: 'all',
    });
  } catch (e) {
    code = `${header}\n/* prettier failed: ${e.message} */\n${body}\n`;
  }
  return { code, relPath, exports, moduleId: meta.moduleId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      '用法: node restore-scripts-l3.mjs <splitDir> [--out dir] [--dump manifest.json]',
    );
    process.exit(1);
  }
  const inputDir = resolve(args.input);
  const outDir = resolve(
    args.out || join(dirname(inputDir), `${basename(inputDir)}-restored`),
  );
  const dumpPath =
    args.dump ||
    resolve(inputDir, '../../manifest.json'); // runtime-dump/.../manifest.json 常见相对位置

  const classPathMap = buildClassPathMap(
    existsSync(dumpPath)
      ? dumpPath
      : resolve(
          'D:/UGit/CososInspectorNew/tmp/runtime-dump/gameweb3_rsg-games_com/manifest.json',
        ),
  );

  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inputDir).filter(
    (f) => f.endsWith('.js') && !f.startsWith('_'),
  );
  const summary = [];
  for (const f of files) {
    const text = readFileSync(join(inputDir, f), 'utf8');
    const { code, relPath, exports, moduleId } = await processOne(
      text,
      f,
      classPathMap,
    );
    const abs = join(outDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, code, 'utf8');
    summary.push({ from: f, to: relPath, exports, moduleId });
  }
  writeFileSync(
    join(outDir, '_restore-manifest.json'),
    JSON.stringify(
      {
        outDir,
        count: summary.length,
        classPathHints: classPathMap.size,
        modules: summary,
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
        outDir,
        count: summary.length,
        classPathHints: classPathMap.size,
        dirs: [
          ...new Set(
            summary.map((s) => dirname(s.to).replace(/\\/g, '/')),
          ),
        ],
        sample: summary.filter((s) => s.to.includes('/')).slice(0, 20),
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
