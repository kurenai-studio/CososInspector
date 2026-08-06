/**
 * 理解层改写（可读优先，不保证可运行）：
 * - inheritsLoose → class extends
 * - 保留伪装饰器 @ccclass / @property（从编译痕迹还原）
 * - 抽出同文件 enum / 数据类，避免方法体悬空引用
 * - 外壳临时量可丢；方法体仍引用的短名 → 映射到真实 export 名
 *
 * 用法:
 *   node logicize-scripts.mjs <restoredFile|restoredDir> [--out <dir>]
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from 'fs';
import { join, dirname, basename, relative, resolve } from 'path';
import { format } from 'prettier';

function parseArgs(argv) {
  const args = { input: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (!argv[i].startsWith('-') && !args.input) args.input = argv[i];
  }
  return args;
}

function extractBalanced(code, openIdx, openCh = '{', closeCh = '}') {
  if (code[openIdx] !== openCh) return null;
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
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return { start: openIdx, end: i + 1, text: code.slice(openIdx, i + 1) };
      }
    }
  }
  return null;
}

function parseHeader(text) {
  const moduleId = (text.match(/\/\/ module: (.+)/) || [])[1] || '';
  const exportsLine = (text.match(/\/\/ exports: (.+)/) || [])[1] || '';
  const out = (text.match(/\/\/ out: (.+)/) || [])[1] || '';
  const deps = [...text.matchAll(/\/\/\s+\[(\d+)\]\s+(.+)/g)].map((m) => ({
    i: Number(m[1]),
    id: m[2].trim(),
  }));
  const exports = exportsLine
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { moduleId, exports, out, deps };
}

function stripRfNoise(body) {
  return body
    .replace(/cclegacy\._RF\.push\([^;]+;/g, '')
    .replace(/cclegacy\._RF\.pop\(\);?/g, '')
    .replace(/__export\s*\(\s*['"][^'"]+['"]\s*,/g, '(')
    .replace(/assertThisInitialized\s*\(\s*(\w+)\s*\)/g, '$1')
    // 仅 this 上下文改 super（回调里的 t.prototype.x.call(o) 保留原样便于对照）
    .replace(
      /(\w+)\.prototype\.(\w+)\.call\s*\(\s*this\s*(?:,\s*)?/g,
      'super.$2(',
    )
    .replace(/!0/g, 'true')
    .replace(/!1/g, 'false')
    .replace(/\bvoid 0\b/g, 'undefined');
}

/** property 配置：shortVar → { type, tooltip, raw } */
function collectPropertyConfigs(text) {
  const map = new Map();
  // F({ type, tooltip })
  const reObj =
    /\(([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\(\s*(\{[\s\S]*?\})\s*\)/g;
  let m;
  while ((m = reObj.exec(text))) {
    const raw = m[2];
    if (!/type\s*:|tooltip\s*:|override\s*:|visible\s*:|serializable\s*:/.test(raw)) {
      continue;
    }
    const type = (raw.match(/type\s*:\s*([^,\n}]+)/) || [])[1]?.trim() || '';
    const tooltip =
      (raw.match(/tooltip\s*:\s*['"]([^'"]+)['"]/) || [])[1] || '';
    map.set(m[1], {
      type,
      tooltip,
      raw: raw.replace(/\s+/g, ' ').trim(),
      override: /override\s*:\s*true/.test(raw),
      visible: (raw.match(/visible\s*:\s*(true|false)/) || [])[1],
      serializable: (raw.match(/serializable\s*:\s*(true|false)/) || [])[1],
    });
  }
  // S(sp.Skeleton) / S(Node) 无 options 对象
  const reType =
    /\(([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\(\s*((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*\)/g;
  while ((m = reType.exec(text))) {
    if (map.has(m[1])) continue;
    if (/^(true|false|null|undefined|\d+)$/.test(m[2])) continue;
    map.set(m[1], { type: m[2], tooltip: '', raw: m[2] });
  }
  return map;
}

function collectFields(text, propConfigs) {
  /** @type {Array<{name:string,type:string,tooltip:string,init:string,decorator:object}>} */
  const fields = [];
  const seen = new Set();

  // 字段名 + property 短变量：'winNotify', [h], {
  const descRe =
    /['"]([A-Za-z_$][\w$]*)['"]\s*,\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*,\s*\{/g;
  let m;
  while ((m = descRe.exec(text))) {
    const name = m[1];
    if (seen.has(name)) continue;
    // 避免误伤其它 ['x', [y], { 结构：要求前文不远有 applyDecoratedDescriptor
    const head = text.slice(Math.max(0, m.index - 80), m.index);
    if (!/applyDecoratedDescriptor|property/.test(head) && !propConfigs.has(m[2])) {
      continue;
    }
    seen.add(name);
    const cfg = propConfigs.get(m[2]) || {};
    fields.push({
      name,
      type: cfg.type || 'any',
      tooltip: cfg.tooltip || '',
      init: 'null',
      decorator: { ...cfg },
    });
  }

  const initRe =
    /initializerDefineProperty\s*\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g;
  while ((m = initRe.exec(text))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    fields.push({
      name: m[1],
      type: 'any',
      tooltip: '',
      init: 'null',
      decorator: {},
    });
  }

  const privRe = /\w+\.(_[A-Za-z]\w*)\s*=\s*([^,;\n]+)/g;
  while ((m = privRe.exec(text))) {
    if (seen.has(m[1])) continue;
    if (!/null|false|true|0|\[\]|\{\}/.test(m[2])) continue;
    seen.add(m[1]);
    fields.push({
      name: m[1],
      type: 'any',
      tooltip: '运行时私有字段',
      init: m[2].trim().replace(/\)+$/g, ''),
      decorator: null,
    });
  }
  return fields;
}

/** TS enum 编译形态 → { name, members:[{key,value}] } */
function extractEnums(text) {
  const enums = [];
  const re =
    /__export\s*\(\s*['"]([A-Z][\w]*)['"]\s*,\s*\(\s*function\s*\(\s*\w+\s*\)\s*\{([\s\S]*?)\}\s*\)\s*\(\s*\{\s*\}\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    const body = m[2];
    const members = [];
    const memRe =
      /\w+\.([A-Za-z_$][\w$]*)\s*=\s*(\d+)/g;
    let mm;
    while ((mm = memRe.exec(body))) {
      members.push({ key: mm[1], value: Number(mm[2]) });
    }
    if (members.length) enums.push({ name, members });
  }
  return enums;
}

/** __export('Foo', function(){ this.x = ... }) 数据类 */
function extractDataClasses(text) {
  const list = [];
  const re =
    /__export\s*\(\s*['"]([A-Z][\w]*)['"]\s*,\s*function\s*\(\s*\)\s*\{([\s\S]*?)\}\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    const body = m[2];
    // 排除被当成「仅函数、无 this.」的空壳
    const fields = [];
    const fr = /this\.([A-Za-z_$][\w$]*)\s*=\s*([^,;\n]+)/g;
    let fm;
    while ((fm = fr.exec(body))) {
      fields.push({
        name: fm[1],
        init: fm[2].trim().replace(/\)+$/g, ''),
      });
    }
    if (fields.length) list.push({ name, fields });
  }
  return list;
}

/**
 * 短名别名：var L = ( __export(class), __export(Enum) )
 * 或方法体引用 L.xxx 且 Enum 含 xxx
 */
function collectEnumAliases(text, enums, methodBodiesJoined) {
  /** @type {Map<string,string>} short -> EnumName */
  const map = new Map();
  for (const en of enums) {
    // Ident = ( ... __export('EnumName', (function
    const re = new RegExp(
      `([A-Za-z_$][\\w$]*)\\s*=\\s*\\([\\s\\S]{0,8000}?__export\\s*\\(\\s*['"]${en.name}['"]`,
      'm',
    );
    const m = text.match(re);
    if (m && m[1] !== en.name) map.set(m[1], en.name);
  }
  // 回退：单字母短名出现在 case X.member，且唯一 enum 含该 member
  const used = [
    ...methodBodiesJoined.matchAll(/\b([a-zA-Z_$])\s*\.\s*([A-Za-z_$][\w$]*)/g),
  ];
  for (const u of used) {
    const short = u[1];
    const member = u[2];
    if (map.has(short)) continue;
    const hits = enums.filter((e) => e.members.some((mem) => mem.key === member));
    if (hits.length === 1) map.set(short, hits[0].name);
  }
  return map;
}

function rewriteAliasesInBody(body, aliasMap) {
  let s = body;
  for (const [short, long] of aliasMap) {
    if (short === long) continue;
    const re = new RegExp(`\\b${short}\\.`, 'g');
    s = s.replace(re, `${long}.`);
  }
  return s;
}

/** 方法体里用到的标识符（粗扫描，去掉字符串内容） */
function scanReferencedIdents(methodBodies) {
  const stripped = methodBodies
    .replace(/`(?:\\.|[^`])*`/g, ' ')
    .replace(/'(?:\\.|[^'])*'/g, ' ')
    .replace(/"(?:\\.|[^"])*"/g, ' ');
  const set = new Set();
  const re = /\b([A-Za-z_$][\w$]*)\b/g;
  let m;
  while ((m = re.exec(stripped))) set.add(m[1]);
  return set;
}

const COMPILER_TEMP_HINT =
  /^(applyDecoratedDescriptor|inheritsLoose|initializerDefineProperty|assertThisInitialized|cclegacy|_decorator|__export)$/;

function formatPropertyDecorator(field) {
  if (field.decorator === null) return ''; // 私有字段
  const d = field.decorator || {};
  const parts = [];
  if (d.type) parts.push(`type: ${d.type}`);
  if (d.tooltip) parts.push(`tooltip: '${d.tooltip}'`);
  if (d.override) parts.push('override: true');
  if (d.visible != null) parts.push(`visible: ${d.visible}`);
  if (d.serializable != null) parts.push(`serializable: ${d.serializable}`);
  if (!parts.length && field.type && field.type !== 'any') {
    parts.push(`type: ${field.type}`);
  }
  if (!parts.length) return '  // @property\n';
  return `  // @property({ ${parts.join(', ')} })\n`;
}

function formatEnumBlock(en) {
  const lines = en.members.map((mem) => `  ${mem.key} = ${mem.value},`);
  return [
    `/** @logic enum（由 TS 编译形态还原） */`,
    `export const ${en.name} = Object.freeze({`,
    ...en.members.map((mem) => `  ${mem.key}: ${mem.value},`),
    `});`,
    `// 双向：${en.members.map((mem) => `${en.name}[${mem.value}] === '${mem.key}'`).join('; ')}`,
    '',
  ].join('\n');
}

function formatDataClassBlock(dc) {
  const fields = dc.fields
    .map((f) => `  ${f.name} = ${f.init};`)
    .join('\n');
  return [
    `/** @logic 数据类（原 __export 构造函数） */`,
    `export class ${dc.name} {`,
    fields,
    `}`,
    '',
  ].join('\n');
}

function findClassName(text, header) {
  // 优先 ccclass 名
  const cc = text.match(
    /(?:ccclass|_decorator\.ccclass|\b[a-z]\()\s*\(\s*['"]([A-Z][\w]*)['"]/,
  );
  if (cc) return cc[1];
  const m = text.match(/__export\s*\(\s*['"]([A-Z][\w]*)['"]/);
  if (m) return m[1];
  if (header.exports[0] && /^[A-Z]/.test(header.exports[0])) {
    return header.exports[0];
  }
  return 'UnknownClass';
}

function findSuperClass(text) {
  const m =
    text.match(
      /\)\s*\(\s*([A-Z][\w]*)\s*\)\s*\)\s*(?:\.(?:DELAY|FADE|prototype)|,|\|\||\))/,
    ) ||
    text.match(
      /inheritsLoose\s*\([^)]+\)[\s\S]{0,400}?\)\s*\(\s*([A-Z][\w]*)\s*\)/,
    );
  return m ? m[1] : 'Component';
}

function extractMethods(text) {
  /** @type {Array<{name:string,params:string,body:string}>} */
  const methods = [];
  const re =
    /\(\s*([A-Za-z_$])\.([A-Za-z_$][\w$]*)\s*=\s*function\s*(\([^)]*\))\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[2];
    if (['call', 'apply', 'bind', 'push', 'pop'].includes(name)) continue;
    const braceIdx = text.indexOf('{', m.index + m[0].length - 1);
    const block = extractBalanced(text, braceIdx);
    if (!block) continue;
    methods.push({
      name,
      params: m[3],
      body: block.text.slice(1, -1),
    });
  }
  return methods;
}

function extractStatics(text) {
  const statics = [];
  const seen = new Set();
  const patterns = [
    /\b[A-Za-z_$][\w$]*\.([A-Z][A-Z0-9_]*)\s*=\s*([^,;\n]+)/g,
    /\)\.([A-Z][A-Z0-9_]*)\s*=\s*([^,;\n]+)/g,
  ];
  for (const re2 of patterns) {
    let m;
    while ((m = re2.exec(text))) {
      if (seen.has(m[1])) continue;
      if (/prototype|length|name/.test(m[1])) continue;
      if (!/TIME|DELAY|FADE|MS|COUNT|MAX|MIN|KEY|SCROLL/.test(m[1])) continue;
      seen.add(m[1]);
      statics.push({
        name: m[1],
        value: m[2].trim().replace(/\)+$/g, ''),
      });
    }
  }
  return statics;
}

function summarizeFlow(text, className, methods, fields, enums, aliases) {
  const lines = [];
  lines.push(`@logic 理解层稿：${className}（过激改写，不保证可运行）`);
  if (fields.length) {
    lines.push(
      `@fields ${fields
        .filter((f) => !f.name.startsWith('_'))
        .map((f) => f.name)
        .join(', ')}`,
    );
  }
  if (methods.length) {
    lines.push(`@methods ${methods.map((m) => m.name).join(', ')}`);
  }
  if (enums.length) {
    lines.push(`@enums ${enums.map((e) => e.name).join(', ')}`);
  }
  if (aliases.size) {
    lines.push(
      `@aliases ${[...aliases.entries()].map(([a, b]) => `${a}→${b}`).join(', ')}`,
    );
  }
  const workers = [
    ...text.matchAll(/setWorker\s*\(\s*new\s+([A-Z][\w]*)/g),
  ].map((m) => m[1]);
  const statuses = [
    ...text.matchAll(/new\s+([A-Z][\w]*Status[A-Za-z]*)/g),
  ].map((m) => m[1]);
  if (workers.length) {
    lines.push(`@workers ${[...new Set(workers)].join(', ')}`);
  }
  if (statuses.length > 3) {
    lines.push(
      `@statusChain 注册了 ${[...new Set(statuses)].length} 种 Status（见 initFlow）`,
    );
  }
  if (/show|hide|_showButton/.test(methods.map((m) => m.name).join(','))) {
    lines.push(
      '@flow show → 播雷电动画/背景循环 → rollingScore → 显示领取按钮 → hide 淡出',
    );
  }
  lines.push(
    '@note 外壳编译临时量已剥离；方法体仍引用的符号经 enum/alias 保留；对照 *-restored',
  );
  return lines;
}

function lightCleanMethodBody(body) {
  return stripRfNoise(body).trim();
}

function hasComponentClass(text, methods, fields) {
  return (
    methods.length > 0 ||
    fields.some((f) => f.decorator !== null) ||
    /inheritsLoose\s*\(/.test(text) ||
    /_decorator\.ccclass|ccclass\s*\(/.test(text)
  );
}

function buildLogicSource(text, header, relOut) {
  const propConfigs = collectPropertyConfigs(text);
  const fields = collectFields(text, propConfigs);
  const enums = extractEnums(text);
  const dataClasses = extractDataClasses(text);

  let methods = extractMethods(text).filter(
    (m) =>
      !['push', 'pop', 'call', 'apply'].includes(m.name) && m.body.length > 0,
  );
  const byName = new Map();
  for (const m of methods) {
    const prev = byName.get(m.name);
    if (!prev || m.body.length > prev.body.length) byName.set(m.name, m);
  }
  methods = [...byName.values()];

  const methodBodiesJoined = methods.map((m) => m.body).join('\n');
  const aliasMap = collectEnumAliases(text, enums, methodBodiesJoined);
  const referenced = scanReferencedIdents(methodBodiesJoined);

  // 方法体仍引用某 enum 短名 → 保证 alias 存在
  for (const [short, long] of [...aliasMap.entries()]) {
    if (!referenced.has(short) && !methodBodiesJoined.includes(`${short}.`)) {
      // 仍保留映射，rewrite 无害
    }
    if (COMPILER_TEMP_HINT.test(short)) aliasMap.delete(short);
  }

  const emitClass = hasComponentClass(text, methods, fields);
  const className = emitClass
    ? findClassName(text, header)
    : header.exports[0] || enums[0]?.name || dataClasses[0]?.name || 'Module';
  const superClass = emitClass ? findSuperClass(text) : '';
  const statics = extractStatics(text);

  const summary = summarizeFlow(
    text,
    className,
    methods,
    fields,
    enums,
    aliasMap,
  );
  const depLines = header.deps
    .slice(0, 30)
    .map((d) => `//   [${d.i}] ${d.id}`);

  const parts = [
    '/**',
    ...summary.map((l) => ` * ${l}`),
    emitClass ? ` * @extends ${superClass}` : '',
    ` * @source ${header.moduleId || header.out || relOut}`,
    ' */',
    '',
    '// deps (忠实层对照):',
    ...depLines,
    '',
  ];

  // 先输出 enum / 数据类（供 class 方法引用）
  for (const en of enums) {
    // 若 enum 名与主 class 同名则跳过（极少见）
    if (emitClass && en.name === className) continue;
    parts.push(formatEnumBlock(en));
  }
  for (const dc of dataClasses) {
    if (emitClass && dc.name === className) continue;
    parts.push(formatDataClassBlock(dc));
  }

  if (emitClass) {
    const fieldLines = fields.map((f) => {
      const deco = formatPropertyDecorator(f);
      const tip = f.tooltip ? ` // ${f.tooltip}` : '';
      return `${deco}  ${f.name} = ${f.init};${tip}`;
    });

    const methodBlocks = methods.map((m) => {
      let body = lightCleanMethodBody(m.body);
      body = rewriteAliasesInBody(body, aliasMap);
      return [
        `  /** @logic 方法 ${m.name} */`,
        `  ${m.name}${m.params} {`,
        body
          .split('\n')
          .map((l) => (l ? `    ${l}` : ''))
          .join('\n'),
        `  }`,
      ].join('\n');
    });

    const staticLines = statics.map((s) => `  static ${s.name} = ${s.value};`);

    parts.push(`// @ccclass('${className}')`);
    parts.push(`export class ${className} extends ${superClass} {`);
    if (staticLines.length) parts.push(staticLines.join('\n'), '');
    if (fieldLines.length) parts.push(fieldLines.join('\n'), '');
    if (methodBlocks.length) parts.push(methodBlocks.join('\n\n'));
    parts.push('}', '', `export default ${className};`, '');
  } else if (enums.length === 1 && !dataClasses.length) {
    parts.push(`export default ${enums[0].name};`, '');
  } else if (dataClasses.length === 1 && !enums.length) {
    parts.push(`export default ${dataClasses[0].name};`, '');
  }

  // 悬空引用：排除成员访问（.Sound）与 bindings 已导入名
  if (emitClass && methods.length) {
    const defined = new Set([
      className,
      superClass,
      ...enums.map((e) => e.name),
      ...dataClasses.map((d) => d.name),
      ...fields.map((f) => f.name),
      ...aliasMap.values(),
      'this',
      'super',
      'true',
      'false',
      'null',
      'undefined',
      'Math',
      'Number',
      'Object',
      'Array',
      'String',
      'console',
      'parseInt',
      'parseFloat',
      'Node',
      'Button',
      'UIOpacity',
      'Vec3',
      'tween',
      'sp',
      'Component',
    ]);
    for (const [s, l] of aliasMap) {
      defined.add(s);
      defined.add(l);
    }
    for (const b of text.matchAll(/=>\s*([A-Za-z_$][\w$]*)/g)) {
      defined.add(b[1]);
    }
    for (const b of text.matchAll(/dep\[\d+\]\.([A-Za-z_$][\w$]*)/g)) {
      defined.add(b[1]);
    }
    const dangling = [];
    const body = methodBodiesJoined;
    for (const id of referenced) {
      if (id.length <= 1) continue;
      if (/^[a-z]/.test(id)) continue;
      if (defined.has(id)) continue;
      if (COMPILER_TEMP_HINT.test(id)) continue;
      // 仅作为 .id 成员出现则忽略
      const asValue = new RegExp(`(?<!\\.)\\b${id}\\b`);
      if (!asValue.test(body)) continue;
      if (!new RegExp(`\\b${id}\\.`).test(body) && !new RegExp(`\\bnew\\s+${id}\\b`).test(body)) {
        // 既不是 Foo.x 也不是 new Foo — 可能是 case Foo / 调用
        if (!new RegExp(`\\b${id}\\b`).test(body)) continue;
      }
      dangling.push(id);
    }
    if (dangling.length) {
      parts.unshift(
        `/* @dangling 可能未还原的引用: ${[...new Set(dangling)].join(', ')} */`,
      );
    }
  }

  return parts
    .filter((p, i, arr) => !(p === '' && arr[i - 1] === ''))
    .join('\n');
}

async function processFile(absIn, absOut, relOut) {
  const text = readFileSync(absIn, 'utf8');
  const header = parseHeader(text);
  let code = buildLogicSource(text, header, relOut);
  try {
    code = await format(code, {
      parser: 'babel',
      printWidth: 100,
      singleQuote: true,
      semi: true,
      trailingComma: 'all',
    });
  } catch (e) {
    code = `/* prettier failed: ${e.message} */\n${code}`;
  }
  mkdirSync(dirname(absOut), { recursive: true });
  writeFileSync(absOut, code, 'utf8');
  return { in: absIn, out: absOut, relOut };
}

function listJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    // 跳过清单；保留 _entry/_virtual 目录
    if (name.startsWith('_') && name.endsWith('.json')) continue;
    if (name === '_restore-manifest.json' || name === '_logic-manifest.json') {
      continue;
    }
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listJsFiles(p));
    else if (name.endsWith('.js') && !name.startsWith('_')) out.push(p);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      '用法: node logicize-scripts.mjs <file|dir> [--out dir]',
    );
    process.exit(1);
  }
  const input = resolve(args.input);
  const files = existsSync(input) && statSync(input).isDirectory()
    ? listJsFiles(input)
    : [input];

  // 默认：restored → logic 同级目录
  let outRoot = args.out
    ? resolve(args.out)
    : resolve(
        dirname(input),
        statSync(input).isDirectory()
          ? `${basename(input).replace(/-restored$/, '')}-logic`
          : 'logic-out',
      );

  // 若输入是单文件且在 restored 树下，保持相对路径
  const baseForRel = statSync(input).isDirectory()
    ? input
    : dirname(input);

  const results = [];
  for (const f of files) {
    const rel = relative(baseForRel, f).replace(/\\/g, '/');
    const absOut = join(outRoot, rel.replace(/\.js$/i, '.logic.js'));
    results.push(await processFile(f, absOut, rel));
  }

  writeFileSync(
    join(outRoot, '_logic-manifest.json'),
    JSON.stringify(
      {
        outRoot,
        count: results.length,
        files: results.map((r) => r.relOut || relative(outRoot, r.out)),
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
        outRoot,
        count: results.length,
        sample: results.slice(0, 10).map((r) => relative(outRoot, r.out)),
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
