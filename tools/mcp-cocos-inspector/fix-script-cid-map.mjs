#!/usr/bin/env node
/**
 * 自研后处理：Prefab 脚本 CID → 原 UUID，并生成可注册 TypeScript stub。
 *
 * - 扫描 scripts-split/*-restored 的 _RF.push(cid, mod)
 * - decompressUUID（与 Creator Editor.Utils.UUID 一致）
 * - 写入/更新 assets 下脚本：优先 *.ts stub（保留 UUID），去掉不可编译的 .logic.js 外壳
 * - 原稿备份到 <工程>/_logic-bak/
 *
 * 用法:
 *   node fix-script-cid-map.mjs <工程scripts根> \
 *     --restored-root <dump>/scripts-split \
 *     [--dry-run]
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const restoredIdx = args.indexOf('--restored-root');
const scriptsRootArg = args.find((a, i) => !a.startsWith('-') && i !== restoredIdx + 1);
const restoredRootArg = restoredIdx >= 0 ? args[restoredIdx + 1] : null;

if (!scriptsRootArg || !restoredRootArg) {
  console.error(
    '用法: node fix-script-cid-map.mjs <工程scripts根> --restored-root <scripts-split> [--dry-run]'
  );
  process.exit(1);
}

const scriptsRoot = path.resolve(scriptsRootArg);
const restoredRoot = path.resolve(restoredRootArg);
const bakRoot = path.join(path.dirname(scriptsRoot), '_logic-bak');

if (!fs.existsSync(scriptsRoot) || !fs.existsSync(restoredRoot)) {
  console.error('路径不存在');
  process.exit(1);
}

const Base64KeyChars =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const AsciiTo64 = new Array(128);
for (let i = 0; i < 128; ++i) AsciiTo64[i] = 0;
for (let i = 0; i < 64; ++i) AsciiTo64[Base64KeyChars.charCodeAt(i)] = i;

/**
 * @param {string} s
 */
function decompressUuid(s) {
  if (typeof s !== 'string') return s;
  let body = s;
  if (body.length === 23) {
    const hex = [];
    for (let i = 5; i < 23; i += 2) {
      const t = AsciiTo64[body.charCodeAt(i)];
      const o = AsciiTo64[body.charCodeAt(i + 1)];
      hex.push((t >> 2).toString(16));
      hex.push((((3 & t) << 2) | (o >> 4)).toString(16));
      hex.push((15 & o).toString(16));
    }
    body = body.slice(0, 5) + hex.join('');
  } else if (body.length === 22) {
    const hex = [];
    for (let i = 2; i < 22; i += 2) {
      const t = AsciiTo64[body.charCodeAt(i)];
      const o = AsciiTo64[body.charCodeAt(i + 1)];
      hex.push((t >> 2).toString(16));
      hex.push((((3 & t) << 2) | (o >> 4)).toString(16));
      hex.push((15 & o).toString(16));
    }
    body = body.slice(0, 2) + hex.join('');
  } else {
    return s;
  }
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    body.slice(12, 16),
    body.slice(16, 20),
    body.slice(20),
  ].join('-');
}

/**
 * @param {string} dir
 * @param {(f: string) => void} fn
 */
function walkFiles(dir, fn) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() || e.isSymbolicLink()) walkFiles(f, fn);
    else fn(f);
  }
}

const RF_RE =
  /_RF\.push\(\s*\{\}\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
const CCCLASS_RE =
  /(?:ccclass|_decorator\.ccclass)\s*\(\s*['"]([^'"]+)['"]\s*\)/;
const CCCLASS_ALT_RE =
  /\bm\s*\(\s*['"]([A-Za-z][^'"]*[A-Za-z0-9])['"]\s*\)/;

/**
 * kebab/dot/path → 合法 PascalCase 标识符
 * @param {string} name
 */
function toPascalIdent(name) {
  const base = String(name || 'RecoveredScript')
    .split(/[/.]/)
    .pop();
  const parts = String(base)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/);
  let id = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  if (!id) id = 'RecoveredScript';
  if (/^[0-9]/.test(id)) id = `C${id}`;
  return id;
}

/**
 * @param {string} className
 */
function ccclassLiteral(className) {
  return className || 'RecoveredScript';
}

function collectRfMap() {
  /** @type {Map<string, any>} */
  const byCid = new Map();
  const restoredDirs = fs
    .readdirSync(restoredRoot)
    .filter((n) => n.endsWith('-restored'));

  for (const dirName of restoredDirs) {
    const bundle = dirName.replace(/-restored$/, '');
    const base = path.join(restoredRoot, dirName);
    walkFiles(base, (f) => {
      if (!f.endsWith('.js')) return;
      const text = fs.readFileSync(f, 'utf8');
      RF_RE.lastIndex = 0;
      let m;
      while ((m = RF_RE.exec(text))) {
        const cid = m[1];
        if (byCid.has(cid)) continue;
        const mod = m[2];
        const restoredRel = path.relative(base, f).replace(/\\/g, '/');
        const cm = text.match(CCCLASS_RE) || text.match(CCCLASS_ALT_RE);
        const className = cm ? cm[1] : toPascalIdent(path.basename(f, '.js'));
        const uuid = decompressUuid(cid);
        if (!uuid || uuid.length < 30) continue;
        byCid.set(cid, {
          cid,
          mod,
          restoredRel,
          bundle,
          className,
          uuid,
        });
      }
    });
  }
  return byCid;
}

/**
 * @param {string} logicPath  .logic.js 路径（可能已不存在）
 */
function readExistingFields(logicPath) {
  const candidates = [
    logicPath,
    logicPath.replace(/\.logic\.js$/i, '.ts'),
    path.join(bakRoot, path.relative(scriptsRoot, logicPath)),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    const fields = [];
    const re = /^\s{2}([A-Za-z_][\w]*)\s*=/gm;
    let m;
    while ((m = re.exec(text))) {
      if (m[1] !== 'constructor') fields.push(m[1]);
    }
    if (fields.length) return [...new Set(fields)].slice(0, 40);
  }
  return [];
}

/**
 * @param {{ccName:string, ident:string, fields:string[], sourceNote:string, cid:string, mod:string}} opts
 */
function buildStub(opts) {
  const fieldLines = opts.fields
    .map((f) => `  @property\n  ${f}: any = null;`)
    .join('\n\n');
  // 显式 _RF.push：工程经 symlink/junction 时 packer 常不注入 uuid，导致 Prefab CID 找不到类
  return `/**
 * @stub Prefab CID 绑定用可注册外壳（逻辑见 *-restored / _logic-bak）
 * @source ${opts.sourceNote}
 */
import { _decorator, Component, cclegacy } from 'cc';
const { ccclass, property } = _decorator;

cclegacy._RF.push({}, '${opts.cid}', '${opts.mod}', undefined);

@ccclass('${opts.ccName}')
export class ${opts.ident} extends Component {
${fieldLines || '  // (no fields)'}
}

export default ${opts.ident};

cclegacy._RF.pop();
`;
}

/**
 * 删除旧 .logic.js 及其 meta（避免双份）
 * @param {string} logicPath
 */
function removeLogicJs(logicPath) {
  for (const p of [logicPath, `${logicPath}.meta`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

const rfMap = collectRfMap();
const report = {
  dryRun,
  rfCount: rfMap.size,
  matched: 0,
  tsWritten: 0,
  uuidUpdated: 0,
  missingSource: 0,
  uuidCollision: 0,
  errors: [],
  samples: [],
};

/** @type {Map<string, string>} */
const uuidOwner = new Map();

for (const entry of rfMap.values()) {
  const relNoExt = entry.restoredRel.replace(/\.js$/i, '');
  const logicPath = path.join(scriptsRoot, entry.bundle, `${relNoExt}.logic.js`);
  const tsPath = path.join(scriptsRoot, entry.bundle, `${relNoExt}.ts`);
  const tsMetaPath = `${tsPath}.meta`;

  const hasLogic = fs.existsSync(logicPath);
  const hasTs = fs.existsSync(tsPath);
  if (!hasLogic && !hasTs) {
    report.missingSource++;
    continue;
  }
  report.matched++;

  if (uuidOwner.has(entry.uuid) && uuidOwner.get(entry.uuid) !== tsPath) {
    report.uuidCollision++;
    report.errors.push({
      cid: entry.cid,
      error: `UUID 冲突 ${entry.uuid}`,
      other: uuidOwner.get(entry.uuid),
    });
    continue;
  }
  uuidOwner.set(entry.uuid, tsPath);

  // 备份 logic 原稿
  if (hasLogic) {
    const bak = path.join(bakRoot, path.relative(scriptsRoot, logicPath));
    if (!dryRun && !fs.existsSync(bak)) {
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(logicPath, bak);
    }
  }

  const fields = readExistingFields(hasLogic ? logicPath : tsPath);
  const ident = toPascalIdent(entry.className || entry.mod);
  const ccName = ccclassLiteral(entry.className || ident);
  const stub = buildStub({
    ccName,
    ident,
    fields,
    sourceNote: `${entry.bundle}/${entry.restoredRel} cid=${entry.cid}`,
    cid: entry.cid,
    mod: entry.mod || ident,
  });

  let meta = {
    ver: '1.0.8',
    importer: 'typescript',
    imported: false,
    uuid: entry.uuid,
    files: [],
    subMetas: {},
    userData: {},
  };
  if (hasTs && fs.existsSync(tsMetaPath)) {
    meta = {
      ...JSON.parse(fs.readFileSync(tsMetaPath, 'utf8')),
      ...meta,
      uuid: entry.uuid,
    };
  } else if (hasLogic && fs.existsSync(`${logicPath}.meta`)) {
    const old = JSON.parse(fs.readFileSync(`${logicPath}.meta`, 'utf8'));
    meta = {
      ...old,
      ver: '1.0.8',
      importer: 'typescript',
      imported: false,
      uuid: entry.uuid,
      files: [],
    };
  }

  const uuidChanged = true;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(tsPath), { recursive: true });
    fs.writeFileSync(tsPath, stub);
    fs.writeFileSync(tsMetaPath, `${JSON.stringify(meta, null, 2)}\n`);
    if (hasLogic) removeLogicJs(logicPath);
    report.tsWritten++;
    report.uuidUpdated++;
  } else {
    report.tsWritten++;
    if (uuidChanged) report.uuidUpdated++;
  }

  if (report.samples.length < 10) {
    report.samples.push({
      cid: entry.cid,
      uuid: entry.uuid,
      ccName,
      ident,
      ts: path.relative(scriptsRoot, tsPath).replace(/\\/g, '/'),
    });
  }
}

console.log(JSON.stringify(report, null, 2));
