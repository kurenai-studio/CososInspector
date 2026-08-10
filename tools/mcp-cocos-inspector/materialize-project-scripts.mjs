#!/usr/bin/env node
/**
 * 把 export-full/scripts 下指向 scripts-split/*-logic 的 symlink
 * 落成工程内真实目录（assets/scripts），让 Creator 能为脚本注入 _RF.push(uuid)。
 *
 * 用法:
 *   node materialize-project-scripts.mjs <export-full工程根>
 */
import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(process.argv[2] || '');
if (!projectRoot || !fs.existsSync(projectRoot)) {
  console.error('用法: node materialize-project-scripts.mjs <export-full工程根>');
  process.exit(1);
}

const assets = path.join(projectRoot, 'assets');
const oldJunction = path.join(assets, '_scripts');
const oldScripts = path.join(projectRoot, 'scripts');
const dest = path.join(assets, 'scripts');

/**
 * @param {string} src
 * @param {string} dst
 */
function copyRecursive(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    const abs = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(src), target);
    if (fs.existsSync(abs)) copyRecursive(abs, dst);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// 源：优先读旧 junction/scripts（会跟随到 *-logic）
const source = fs.existsSync(oldJunction)
  ? oldJunction
  : fs.existsSync(oldScripts)
    ? oldScripts
    : null;

if (!source) {
  console.error('找不到 _scripts / scripts 源');
  process.exit(1);
}

// 删旧 junction / 旧 dest
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || st.isFile()) {
    fs.unlinkSync(p);
    return;
  }
  for (const n of fs.readdirSync(p)) rmrf(path.join(p, n));
  fs.rmdirSync(p);
}

if (fs.existsSync(dest)) {
  console.log('移除已有 assets/scripts ...');
  rmrf(dest);
}

console.log('复制', source, '->', dest);
copyRecursive(source, dest);

// 去掉旧 _scripts junction，避免双份
if (fs.existsSync(oldJunction)) {
  const st = fs.lstatSync(oldJunction);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(oldJunction);
    console.log('已删除 assets/_scripts junction');
  } else {
    console.log('assets/_scripts 不是 junction，保留（请手工确认）');
  }
}

// 写 directory meta
const meta = {
  ver: '1.2.0',
  importer: 'directory',
  imported: false,
  uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567801',
  files: [],
  subMetas: {},
  userData: {},
};
fs.writeFileSync(`${dest}.meta`, `${JSON.stringify(meta, null, 2)}\n`);

// 统计
let ts = 0;
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.meta')) ts++;
  }
}
walk(dest);

// 确认无 symlink
let symlinks = 0;
function walkLink(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isSymbolicLink()) symlinks++;
    if (e.isDirectory() && !e.isSymbolicLink()) walkLink(f);
  }
}
walkLink(dest);

console.log(
  JSON.stringify(
    {
      dest,
      tsCount: ts,
      remainingSymlinks: symlinks,
      realpathSample: fs.realpathSync(
        path.join(dest, 'resources', 'UI', 'UIColorSetting.ts')
      ),
    },
    null,
    2
  )
);
