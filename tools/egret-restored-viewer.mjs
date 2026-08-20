#!/usr/bin/env node
/**
 * Egret restored 资源浏览器 v2
 * - 分组 + 大缩略图 + 搜索
 * - 图集/序列帧：Canvas 逐帧动画
 * - 龙骨：优先 DragonBones 运行时骨骼动画；失败则 SubTexture 轮播
 * - 便携包：同目录存在 restored/ 时自动使用；vendor/ 存在则离线加载 Pixi/DB
 *
 *   node tools/egret-restored-viewer.mjs [restoredDir] [port]
 *   打包：node tools/pack-egret-restored-viewer.mjs
 */
import { createServer } from 'node:http';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  createReadStream,
} from 'node:fs';
import { join, extname, dirname, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');
const PACK_RESTORED = join(SCRIPT_DIR, 'restored');
const VENDOR_DIR = join(SCRIPT_DIR, 'vendor');
const RESTORED =
  process.argv[2] ||
  (existsSync(PACK_RESTORED)
    ? PACK_RESTORED
    : join(ROOT, 'tmp/egret-cdn-clues/qp.bydrqp.com/restored'));
const PORT = Number(process.argv[3] || 19528);
const HAS_VENDOR =
  existsSync(join(VENDOR_DIR, 'pixi.min.js')) &&
  existsSync(join(VENDOR_DIR, 'dragonBones.js'));
const PIXI_SRC = HAS_VENDOR
  ? '/vendor/pixi.min.js'
  : 'https://cdn.jsdelivr.net/npm/pixi.js@4.8.9/dist/pixi.min.js';
const DB_SRC = HAS_VENDOR
  ? '/vendor/dragonBones.js'
  : 'https://cdn.jsdelivr.net/npm/dragonbones-pixi@5.6.0/out/dragonBones.js';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.fnt': 'text/plain',
  '.ttf': 'font/ttf',
  '.dbbin': 'application/octet-stream',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.js': 'application/javascript',
  '.html': 'text/html; charset=utf-8',
};

function fileUrl(rel) {
  return (
    '/file/' +
    String(rel)
      .replace(/\\/g, '/')
      .split('/')
      .map(encodeURIComponent)
      .join('/')
  );
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath || '')
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  const full = resolve(root, decoded);
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    return null;
  }
  return full;
}

function listImageInDir(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  const prefer = files.find((f) => /\.webp$/i.test(f));
  if (prefer) return prefer;
  return files.find((f) => /\.(png|jpe?g|gif)$/i.test(f)) || null;
}

function groupOf(pathStr, category) {
  const p = String(pathStr || '').replace(/\\/g, '/');
  const parts = p.split('/').filter(Boolean);
  if (category === 'sheets' || category === 'images') {
    if (parts.length >= 2) return parts.slice(0, -1).join('/');
    return '(root)';
  }
  if (category === 'sounds') {
    return parts.slice(1, -1).join('/') || '(root)';
  }
  if (category === 'dragonbones') return 'dragonbones';
  if (category === 'fonts') return 'fonts';
  return parts[0] || '(root)';
}

/** 捕鱼业务分类（路径 + 名称启发式） */
function classifyBiz(item) {
  const s = `${item.path || ''} ${item.name || ''} ${item.group || ''}`.toLowerCase();
  const cat = item.category || '';

  if (cat === 'sounds' || item.kind === 'sound') {
    if (/(^|\/)bgm(\/|$)|\/bgm\//i.test(s) || s.includes('sounds/bgm')) return '音频-BGM';
    if (/\/vo(\/|$)|bossvo|fishvo|\/vo\//i.test(s) || s.includes('sounds/vo')) return '音频-语音';
    if (/sfx|battle|fishdead|fishhit|fishappear|gun|shot|special/i.test(s)) {
      return '音频-战斗';
    }
    if (/\/ui(\/|$)|sounds\/ui/i.test(s)) return '音频-UI';
    return '音频-其它';
  }

  if (cat === 'fonts' || item.kind === 'font') return '字体';

  // 子弹 / 渔网（先于炮台：net_spirit 含 spirit）
  if (
    /\/game\/net\b|\/net\/|ui_shot|\/shot\/|bullet|yuwang|fishnet|wang_|eff_net_|net_spirit/i.test(
      s
    )
  ) {
    return '子弹渔网';
  }

  // 炮台
  if (
    /gunfire|gun_effect|\/gun\/|eff_gun_|cannon|paotai|turret|gunprivilege|\bgun_/i.test(
      s
    )
  ) {
    return '炮台';
  }

  // 受击 / 爆点（避免匹配 beijing 背景）
  if (
    /baodian|yu_baodian|dianji|fishdead|fishhit|zhongdan|hit_flash|dead_flash|受击|爆点/i.test(
      s
    )
  ) {
    return '受击特效';
  }

  // 中奖 / 大奖 / 爆币 / 暴富
  if (
    /bigwin|baobi|baofu|baojiang|jackpot|get_award|award_|prize|coin_bao|coinloose|phoneaward|zhongjiang|win_eff|caishen|treasure|actgetbigrwd|sqzxdj|爆币|大奖|暴富/i.test(
      s
    )
  ) {
    return '中奖特效';
  }

  // Boss / 特殊鱼演出
  if (
    /\/specialfish\/|\/showfish\/|boss|_boss_|heilong|divine|special_fish|ui_specialfish/i.test(
      s
    )
  ) {
    return 'Boss特殊鱼';
  }

  // 鱼本体（图集/序列帧）
  if (
    /\/game\/fish\b|\/ui_fish\b|\/fish\/\d|\/fish\/fish_|fish_\d|\/fish\/12frame|\/fish\/24frame|eff_.*fish_/i.test(
      s
    )
  ) {
    return '鱼';
  }

  // 大厅 / 活动 UI
  if (/\/lobby\b|hall_|ui_lobby|\/dt_|peakmatch|seasonpass|activity|baoliandeng|bld_|活动|大厅/i.test(s)) {
    return '大厅活动';
  }

  // 道具 / 宠物
  if (/\/prop\b|daoju|energyprop|petSystem|petActivity|allPet|道具|宠物/i.test(s)) {
    return '道具宠物';
  }

  // 场景 / 背景（含 beijing 命名）
  if (/scene|background|beijing|bg_|room_bg|loading_bg|ui_jpg|incompressible/i.test(s)) {
    return '场景背景';
  }

  // 通用战斗 UI
  if (/\/ui_game\b|\/new_game\b|battle|战斗|roomplay|activeskill/i.test(s)) {
    return '战斗UI';
  }

  return '其它';
}

const BIZ_ORDER = [
  '鱼',
  '炮台',
  '子弹渔网',
  '受击特效',
  '中奖特效',
  'Boss特殊鱼',
  '战斗UI',
  '大厅活动',
  '道具宠物',
  '场景背景',
  '字体',
  '音频-BGM',
  '音频-战斗',
  '音频-语音',
  '音频-UI',
  '音频-其它',
  '其它',
];

function withBiz(item) {
  item.biz = classifyBiz(item);
  return item;
}

function buildCatalog() {
  const manifestPath = join(RESTORED, 'manifest.json');
  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {}
  }

  const sheets = [];
  for (const s of manifest?.sheets || []) {
    if (!s.dir) continue;
    const abs = join(RESTORED, s.dir);
    const tex =
      s.texture || (existsSync(abs) ? listImageInDir(abs) : null);
    if (!tex) continue;
    const dir = s.dir.replace(/\\/g, '/');
    const jsonRel = s.json ? dir + '/' + s.json : null;
    sheets.push(
      withBiz({
        id: dir,
        name: s.name,
        category: 'sheets',
        kind: 'sheet',
        group: groupOf(dir, 'sheets'),
        thumb: fileUrl(dir + '/' + tex),
        texture: fileUrl(dir + '/' + tex),
        json: jsonRel ? fileUrl(jsonRel) : null,
        path: dir,
        anim: true,
      })
    );
  }

  const images = [];
  for (const im of manifest?.images || []) {
    if (!im.path || !/\.(webp|png|jpe?g|gif)$/i.test(im.path)) continue;
    const path = im.path.replace(/\\/g, '/');
    images.push(
      withBiz({
        id: path,
        name: im.name,
        category: 'images',
        kind: 'image',
        group: groupOf(path, 'images'),
        thumb: fileUrl(path),
        path,
        anim: false,
      })
    );
  }

  const fonts = [];
  for (const f of manifest?.fonts || []) {
    const dir = String(f.dir || '').replace(/\\/g, '/');
    const abs = join(RESTORED, dir);
    const img = existsSync(abs) ? listImageInDir(abs) : null;
    fonts.push(
      withBiz({
        id: dir,
        name: f.name,
        category: 'fonts',
        kind: 'font',
        group: 'fonts',
        thumb: img ? fileUrl(dir + '/' + img) : null,
        files: f.files || [],
        path: dir,
        anim: false,
      })
    );
  }

  const dragonbones = [];
  for (const d of manifest?.dragonbones || []) {
    const dir = String(d.dir || '').replace(/\\/g, '/');
    const abs = join(RESTORED, dir);
    const files = d.files || (existsSync(abs) ? readdirSync(abs) : []);
    const img =
      files.find((x) => /\.(webp|png|jpe?g)$/i.test(x)) ||
      (existsSync(abs) ? listImageInDir(abs) : null);
    const ske = files.find((x) => /_ske\.(dbbin|json)$/i.test(x));
    const texJson = files.find((x) => /_tex\.json$/i.test(x));
    dragonbones.push(
      withBiz({
        id: dir,
        name: d.name,
        category: 'dragonbones',
        kind: 'dragonbones',
        group: 'dragonbones',
        thumb: img ? fileUrl(dir + '/' + img) : null,
        texture: img ? fileUrl(dir + '/' + img) : null,
        ske: ske ? fileUrl(dir + '/' + ske) : null,
        texJson: texJson ? fileUrl(dir + '/' + texJson) : null,
        files,
        path: dir,
        anim: true,
      })
    );
  }

  const sounds = [];
  const walkSound = (d, prefix = 'sounds') => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = (prefix + '/' + e.name).replace(/\\/g, '/');
      if (e.isDirectory()) walkSound(p, rel);
      else if (/\.(mp3|wav|ogg)$/i.test(e.name)) {
        sounds.push(
          withBiz({
            id: rel,
            name: e.name.replace(/\.[^.]+$/, ''),
            category: 'sounds',
            kind: 'sound',
            group: groupOf(rel, 'sounds'),
            thumb: null,
            audio: fileUrl(rel),
            path: rel,
            anim: false,
          })
        );
      }
    }
  };
  walkSound(join(RESTORED, 'sounds'));

  return {
    restored: RESTORED,
    bizOrder: BIZ_ORDER,
    tabs: { sheets, images, dragonbones, fonts, sounds },
  };
}

let catalogCache = null;
let catalogAt = 0;
function getCatalog() {
  if (!catalogCache || Date.now() - catalogAt > 8000) {
    catalogCache = buildCatalog();
    catalogAt = Date.now();
  }
  return catalogCache;
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Egret Restored Viewer</title>
<style>
:root {
  --bg:#0b0f14; --panel:#151b26; --line:#2a3548; --text:#e8eef8;
  --muted:#8b9bb0; --accent:#4aa3ff; --chip:#1a2332; --ok:#3dd68c;
}
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:"Segoe UI","PingFang SC",sans-serif}
header{display:flex;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);background:#101722}
header h1{margin:0;font-size:15px;white-space:nowrap}
header .meta{flex:1;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
input[type=search],select{padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--chip);color:var(--text)}
input[type=search]{width:min(280px,36vw)}
.tabs{display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.tab{border:1px solid var(--line);background:var(--chip);color:var(--muted);border-radius:999px;padding:6px 12px;cursor:pointer;font-size:13px}
.tab.active{color:#fff;border-color:#3b6ea8;background:#1a3354}
.main{flex:1;min-height:0;display:grid;grid-template-columns:220px 1fr 560px}
.modebar{display:flex;gap:6px;align-items:center;padding:0 14px 8px;flex-wrap:wrap}
.modebar .label{color:var(--muted);font-size:12px;margin-right:4px}
.mode{border:1px solid var(--line);background:var(--chip);color:var(--muted);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px}
.mode.active{color:#fff;border-color:#3b6ea8;background:#1a3354}
.groups{border-right:1px solid var(--line);overflow:auto;background:#101722;padding:8px}
.groups .gtitle{color:var(--muted);font-size:11px;padding:4px 10px 8px;text-transform:none}
.groups button{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--muted);padding:7px 10px;border-radius:8px;cursor:pointer;font-size:12px}
.groups button:hover,.groups button.active{background:#1a3354;color:#fff}
.groups .gcount{float:right;opacity:.7}
.card .biz{position:absolute;right:6px;top:6px;font-size:10px;padding:2px 6px;border-radius:999px;background:#1a2a1a;color:#9f9;border:1px solid #345}
.gridwrap{overflow:auto;padding:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px;align-content:start}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;min-height:180px}
.card:hover,.card.sel{border-color:#4a7ab8;box-shadow:0 0 0 1px #4a7ab844}
.card .thumb{height:120px;background:#070b10;display:grid;place-items:center;position:relative;overflow:hidden}
.card .thumb img,.card .thumb canvas{max-width:100%;max-height:100%;object-fit:contain}
.card .badge{position:absolute;left:6px;top:6px;font-size:10px;padding:2px 6px;border-radius:999px;background:#123;color:#9cf;border:1px solid #345}
.card .name{padding:8px 10px 4px;font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .sub{padding:0 10px 10px;font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side{border-left:1px solid var(--line);background:#101722;padding:12px;overflow:auto}
.side h2{margin:0 0 6px;font-size:15px;word-break:break-all}
.side .path{color:var(--muted);font-size:11px;word-break:break-all;margin-bottom:10px}
.preview{background:#070b10;border:1px solid var(--line);border-radius:10px;min-height:520px;height:min(62vh,640px);display:grid;place-items:center;overflow:hidden}
.preview canvas,.preview img{max-width:100%;max-height:100%;width:auto;height:auto}
.preview canvas.pixi-view{width:100%!important;height:100%!important;object-fit:contain}
.toolbar{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap;align-items:center}
.toolbar button,.toolbar label{border:1px solid var(--line);background:var(--chip);color:var(--text);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px}
.toolbar button.active{background:#1a3354;border-color:#4a7ab8}
.files{font-size:12px;color:var(--muted);line-height:1.6;margin-top:8px}
.empty{color:var(--muted);padding:30px;text-align:center}
.ph{font-size:32px;color:#445}
@media(max-width:1100px){.main{grid-template-columns:1fr 480px}.groups{display:none}}
</style>
</head>
<body>
<header>
  <h1>Egret Restored Viewer</h1>
  <div class="meta" id="meta">loading…</div>
  <input id="q" type="search" placeholder="搜索名称 / 路径 / 业务" />
</header>
<div class="tabs" id="tabs"></div>
<div class="modebar" id="modebar"></div>
<div class="main">
  <aside class="groups" id="groups"></aside>
  <div class="gridwrap"><div class="grid" id="grid"></div></div>
  <aside class="side" id="side"><div class="empty">点选资源预览；图集/龙骨支持动画</div></aside>
</div>
<script src="${PIXI_SRC}"></script>
<script src="${DB_SRC}"></script>
<script>
const TAB_LABEL = { sheets:'图集/序列帧', images:'散图', dragonbones:'龙骨', fonts:'字体', sounds:'音频' };
let catalog=null, tab='sheets', group='(all)', groupMode='biz', selected=null, raf=0, player=null;

async function load(){
  catalog = await (await fetch('/api/catalog')).json();
  document.getElementById('meta').textContent =
    Object.keys(TAB_LABEL).map(k => TAB_LABEL[k].split('/')[0]+' '+catalog.tabs[k].length).join(' · ');
  renderModebar(); renderTabs(); renderGroups(); renderGrid();
}

function renderModebar(){
  const el=document.getElementById('modebar'); el.innerHTML='';
  const label=document.createElement('span'); label.className='label'; label.textContent='左侧分组';
  el.appendChild(label);
  for (const [k,t] of [['biz','业务分类'],['path','路径']]){
    const b=document.createElement('button');
    b.className='mode'+(groupMode===k?' active':'');
    b.textContent=t;
    b.onclick=()=>{ groupMode=k; group='(all)'; selected=null; stopPlayer(); renderModebar(); renderGroups(); renderGrid(); resetSide(); };
    el.appendChild(b);
  }
}

function renderTabs(){
  const el=document.getElementById('tabs'); el.innerHTML='';
  for (const k of Object.keys(TAB_LABEL)){
    const b=document.createElement('button');
    b.className='tab'+(k===tab?' active':'');
    b.textContent=TAB_LABEL[k]+' ('+catalog.tabs[k].length+')';
    b.onclick=()=>{ tab=k; group='(all)'; selected=null; stopPlayer(); renderTabs(); renderGroups(); renderGrid(); resetSide(); };
    el.appendChild(b);
  }
}

function groupKey(it){
  return groupMode==='biz' ? (it.biz||'其它') : (it.group||'(root)');
}

function groupsOfTab(){
  const map=new Map();
  for (const it of catalog.tabs[tab]){
    const g=groupKey(it);
    map.set(g,(map.get(g)||0)+1);
  }
  const entries=[...map.entries()];
  if (groupMode==='biz'){
    const order=catalog.bizOrder||[];
    entries.sort((a,b)=>{
      const ia=order.indexOf(a[0]), ib=order.indexOf(b[0]);
      const oa=ia<0?999:ia, ob=ib<0?999:ib;
      if (oa!==ob) return oa-ob;
      return b[1]-a[1]||a[0].localeCompare(b[0]);
    });
  } else {
    entries.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  }
  return entries;
}

function renderGroups(){
  const el=document.getElementById('groups'); el.innerHTML='';
  const title=document.createElement('div');
  title.className='gtitle';
  title.textContent=groupMode==='biz'?'捕鱼业务':'路径分组';
  el.appendChild(title);
  const all=document.createElement('button');
  all.className=group==='(all)'?'active':'';
  all.innerHTML='全部 <span class="gcount">'+catalog.tabs[tab].length+'</span>';
  all.onclick=()=>{group='(all)'; renderGroups(); renderGrid();};
  el.appendChild(all);
  const list=groupMode==='biz'?groupsOfTab():groupsOfTab().slice(0,80);
  for (const [g,n] of list){
    const b=document.createElement('button');
    b.className=g===group?'active':'';
    b.title=g;
    const label=groupMode==='biz'?g:g.split('/').slice(-2).join('/');
    b.innerHTML='<span>'+escapeHtml(label)+'</span><span class="gcount">'+n+'</span>';
    b.onclick=()=>{group=g; renderGroups(); renderGrid();};
    el.appendChild(b);
  }
}

function filtered(){
  const q=document.getElementById('q').value.trim().toLowerCase();
  return (catalog.tabs[tab]||[]).filter(it=>{
    if (group!=='(all)' && groupKey(it)!==group) return false;
    if (!q) return true;
    return (it.name||'').toLowerCase().includes(q)
      || (it.path||'').toLowerCase().includes(q)
      || (it.biz||'').toLowerCase().includes(q)
      || (it.group||'').toLowerCase().includes(q);
  });
}

function renderGrid(){
  const grid=document.getElementById('grid');
  const list=filtered();
  if (!list.length){ grid.innerHTML='<div class="empty">没有匹配项</div>'; return; }
  const show=list.slice(0,600);
  grid.innerHTML='';
  for (const item of show){
    const card=document.createElement('div');
    card.className='card'+(selected&&selected.id===item.id?' sel':'');
    card.title=(item.biz||'')+' · '+item.path;
    const thumb=document.createElement('div'); thumb.className='thumb';
    if (item.anim){
      const badge=document.createElement('div'); badge.className='badge'; badge.textContent='动画';
      thumb.appendChild(badge);
    }
    if (item.biz){
      const biz=document.createElement('div'); biz.className='biz'; biz.textContent=item.biz;
      thumb.appendChild(biz);
    }
    if (item.thumb){
      const img=document.createElement('img');
      img.loading='lazy'; img.alt=item.name; img.src=item.thumb;
      img.onerror=()=>{ thumb.querySelectorAll('img').forEach(x=>x.remove()); const ph=document.createElement('div'); ph.className='ph'; ph.textContent='!'; thumb.appendChild(ph); };
      thumb.appendChild(img);
    } else if (item.audio){
      const ph=document.createElement('div'); ph.className='ph'; ph.textContent='♪'; thumb.appendChild(ph);
    } else {
      const ph=document.createElement('div'); ph.className='ph'; ph.textContent='·'; thumb.appendChild(ph);
    }
    const name=document.createElement('div'); name.className='name'; name.textContent=item.name;
    const sub=document.createElement('div'); sub.className='sub';
    sub.textContent=groupMode==='biz'
      ? ((item.group||'').split('/').slice(-2).join('/')||item.path)
      : (item.biz||item.group||'');
    card.append(thumb,name,sub);
    card.onclick=()=>select(item);
    grid.appendChild(card);
  }
  if (list.length>600){
    const tip=document.createElement('div'); tip.className='empty';
    tip.textContent='显示 600 / '+list.length+'，用左侧分组或搜索缩小';
    grid.appendChild(tip);
  }
}

function resetSide(){
  document.getElementById('side').innerHTML='<div class="empty">点选资源预览；图集/龙骨支持动画</div>';
}

function stopPlayer(){
  if (raf) cancelAnimationFrame(raf);
  raf=0;
  if (player && player.destroy) try{ player.destroy(); }catch{}
  player=null;
}

async function select(item){
  selected=item; stopPlayer(); renderGrid();
  const side=document.getElementById('side');
  side.innerHTML =
    '<h2>'+escapeHtml(item.name)+'</h2>'+
    '<div class="path"><b>业务</b> '+escapeHtml(item.biz||'其它')+'</div>'+
    '<div class="path">'+escapeHtml(item.path||'')+'</div>'+
    '<div class="preview" id="preview"></div>'+
    '<div class="toolbar" id="toolbar"></div>'+
    (item.files&&item.files.length ? '<div class="files"><b>文件</b><br>'+item.files.map(escapeHtml).join('<br>')+'</div>':'');

  const preview=document.getElementById('preview');
  const toolbar=document.getElementById('toolbar');

  if (item.kind==='sound'){
    preview.innerHTML='<audio controls autoplay src="'+item.audio+'" style="width:90%"></audio>';
    return;
  }
  if (item.kind==='sheet' && item.json){
    await playSheet(item, preview, toolbar);
    return;
  }
  if (item.kind==='dragonbones'){
    await playDragonBones(item, preview, toolbar);
    return;
  }
  if (item.thumb){
    preview.innerHTML='<img src="'+item.thumb+'" alt="" />';
  } else {
    preview.innerHTML='<div class="empty">无可预览图</div>';
  }
}

async function playSheet(item, preview, toolbar){
  try{
    const meta=await (await fetch(item.json)).json();
    const subs=meta.SubTexture||meta.subTexture;
    // DragonBones 贴图 JSON（本批 Boss 特效多为这种）
    if (Array.isArray(subs) && subs.length){
      await playSubTextureList(subs, item.texture, preview, toolbar, '图集 SubTexture');
      return;
    }
    const frames=meta.frames;
    if (!frames || typeof frames!=='object'){
      preview.innerHTML='<img src="'+(item.texture||item.thumb)+'" />';
      toolbar.innerHTML='<span style="color:var(--muted);font-size:12px">无 frames / SubTexture，仅静态贴图</span>';
      return;
    }
    const keys=Object.keys(frames).sort((a,b)=>{
      const na=Number(a), nb=Number(b);
      if (!Number.isNaN(na)&&!Number.isNaN(nb)) return na-nb;
      return String(a).localeCompare(String(b), undefined, {numeric:true});
    });
    if (!keys.length){ preview.innerHTML='<img src="'+item.texture+'" />'; return; }

    const img=await loadImage(item.texture);
    const canvas=document.createElement('canvas');
    const ctx=canvas.getContext('2d');
    preview.innerHTML=''; preview.appendChild(canvas);

    let idx=0, playing=true, fps=12, last=0;
    const draw=()=>{
      const fr=frames[keys[idx]];
      const sw=fr.sourceW||fr.w||fr.width, sh=fr.sourceH||fr.h||fr.height;
      const fw=fr.w||fr.width, fh=fr.h||fr.height;
      const scale = Math.min(1, 520 / Math.max(sw,1), 520 / Math.max(sh,1));
      const dw = Math.max(1, Math.round(sw * scale));
      const dh = Math.max(1, Math.round(sh * scale));
      canvas.width=dw; canvas.height=dh;
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0,0,dw,dh);
      ctx.drawImage(
        img, fr.x, fr.y, fw, fh,
        Math.round((fr.offX||0)*scale), Math.round((fr.offY||0)*scale),
        Math.round(fw*scale), Math.round(fh*scale)
      );
    };
    draw();

    toolbar.innerHTML='';
    const btn=document.createElement('button');
    btn.textContent='暂停';
    btn.onclick=()=>{ playing=!playing; btn.textContent=playing?'暂停':'播放'; if(playing) loop(performance.now()); };
    const tip=document.createElement('span');
    tip.style.cssText='color:var(--muted);font-size:12px';
    tip.textContent=keys.length+' 帧 · '+fps+' fps';
    const slower=document.createElement('button'); slower.textContent='减速';
    slower.onclick=()=>{ fps=Math.max(2,fps-2); tip.textContent=keys.length+' 帧 · '+fps+' fps'; };
    const faster=document.createElement('button'); faster.textContent='加速';
    faster.onclick=()=>{ fps=Math.min(30,fps+2); tip.textContent=keys.length+' 帧 · '+fps+' fps'; };
    toolbar.append(btn, slower, faster, tip);

    const loop=(t)=>{
      if (!playing) return;
      raf=requestAnimationFrame(loop);
      if (t-last < 1000/fps) return;
      last=t; idx=(idx+1)%keys.length; draw();
    };
    raf=requestAnimationFrame(loop);
    player={ destroy(){ playing=false; } };
  }catch(e){
    console.warn('playSheet failed', e);
    preview.innerHTML=item.texture||item.thumb
      ? '<img src="'+(item.texture||item.thumb)+'" />'
      : '<div class="empty">预览失败</div>';
    toolbar.innerHTML='<span style="color:#f88;font-size:12px">'+escapeHtml(String(e&&e.message||e))+'</span>';
  }
}

function sortSubTextures(subs){
  return [...subs].sort((a,b)=>{
    const na=String(a.name||''), nb=String(b.name||'');
    const ma=na.match(/^(.*?)(\\d+)$/), mb=nb.match(/^(.*?)(\\d+)$/);
    if (ma && mb && ma[1]===mb[1]) return Number(ma[2])-Number(mb[2]);
    return na.localeCompare(nb, undefined, {numeric:true});
  });
}

function groupSubTextures(subs){
  const map=new Map();
  for (const fr of sortSubTextures(subs)){
    const name=String(fr.name||'');
    const m=name.match(/^(.*?)_?(\\d+)$/);
    const key=m ? m[1].replace(/_+$/,'') || name : name;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(fr);
  }
  return map;
}

async function playSubTextureList(subs, textureUrl, preview, toolbar, label){
  const groups=groupSubTextures(subs);
  const groupKeys=[...groups.keys()].sort((a,b)=>{
    const ga=groups.get(a), gb=groups.get(b);
    return (gb.length-ga.length) || a.localeCompare(b);
  });
  let gKey=groupKeys[0];
  let list=groups.get(gKey);
  const img=await loadImage(textureUrl);
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d');
  preview.innerHTML=''; preview.appendChild(canvas);
  let idx=0, playing=true, fps=12, last=0;

  const draw=()=>{
    const fr=list[idx];
    const fw=fr.frameWidth||fr.width||1;
    const fh=fr.frameHeight||fr.height||1;
    const fx=fr.frameX||0, fy=fr.frameY||0;
    const pad=8;
    const scale=Math.min(1, 520/Math.max(fw,1), 520/Math.max(fh,1));
    canvas.width=Math.max(1, Math.round(fw*scale)+pad*2);
    canvas.height=Math.max(1, Math.round(fh*scale)+pad*2);
    ctx.imageSmoothingEnabled=true;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(
      img, fr.x||0, fr.y||0, fr.width, fr.height,
      pad + Math.round((-fx)*scale), pad + Math.round((-fy)*scale),
      Math.round((fr.width||1)*scale), Math.round((fr.height||1)*scale)
    );
  };
  draw();

  const refreshTip=()=>{
    tip.textContent=(label||'SubTexture')+' · '+gKey+' · '+list.length+' 帧 · '+fps+' fps';
  };
  toolbar.innerHTML='';
  const btn=document.createElement('button'); btn.textContent='暂停';
  btn.onclick=()=>{playing=!playing; btn.textContent=playing?'暂停':'播放'; if(playing) loop(performance.now());};
  const slower=document.createElement('button'); slower.textContent='减速';
  slower.onclick=()=>{ fps=Math.max(2,fps-2); refreshTip(); };
  const faster=document.createElement('button'); faster.textContent='加速';
  faster.onclick=()=>{ fps=Math.min(30,fps+2); refreshTip(); };
  const tip=document.createElement('span'); tip.style.cssText='color:var(--muted);font-size:12px';
  toolbar.append(btn, slower, faster, tip);
  if (groupKeys.length>1){
    const sel=document.createElement('select');
    for (const k of groupKeys){
      const opt=document.createElement('option');
      opt.value=k; opt.textContent=k+' ('+groups.get(k).length+')';
      if (k===gKey) opt.selected=true;
      sel.appendChild(opt);
    }
    sel.onchange=()=>{
      gKey=sel.value; list=groups.get(gKey); idx=0; refreshTip(); draw();
    };
    toolbar.appendChild(sel);
  }
  refreshTip();

  const loop=(t)=>{
    if(!playing) return;
    raf=requestAnimationFrame(loop);
    if(t-last<1000/fps) return;
    last=t; idx=(idx+1)%list.length; draw();
  };
  raf=requestAnimationFrame(loop);
  player={ destroy(){ playing=false; } };
}

async function playDragonBones(item, preview, toolbar){
  toolbar.innerHTML='<span style="color:var(--muted);font-size:12px">加载龙骨…</span>';
  // 1) 尝试骨骼动画
  const ok = await tryDbSkeletal(item, preview, toolbar);
  if (ok) return;
  // 2) SubTexture 轮播
  await playDbSubtextures(item, preview, toolbar);
}

async function tryDbSkeletal(item, preview, toolbar){
  try{
    if (!window.PIXI || !window.dragonBones) return false;
    if (!item.ske || !item.texJson || !item.texture) return false;
    const [skeBuf, texJson, texImg] = await Promise.all([
      fetch(item.ske).then(r=>r.arrayBuffer()),
      fetch(item.texJson).then(r=>r.json()),
      loadImage(item.texture),
    ]);
    const box = preview.getBoundingClientRect();
    const size = Math.max(480, Math.floor(Math.min(box.width || 520, box.height || 520)));
    const app = new PIXI.Application(size, size, {
      transparent: true,
      antialias: true,
      forceCanvas: false,
      roundPixels: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoResize: false,
    });
    app.view.className = 'pixi-view';
    preview.innerHTML=''; preview.appendChild(app.view);

    const factory = dragonBones.PixiFactory.factory;
    let dbData;
    if (/\\.json$/i.test(item.ske)) {
      const text = new TextDecoder().decode(skeBuf);
      dbData = factory.parseDragonBonesData(JSON.parse(text));
    } else {
      dbData = factory.parseDragonBonesData(skeBuf);
    }
    const baseTex = new PIXI.BaseTexture(texImg);
    baseTex.scaleMode = PIXI.SCALE_MODES.LINEAR;
    factory.parseTextureAtlasData(texJson, baseTex);
    if (!dbData) return false;
    const names = dbData.armatureNames || [];
    const armName = names[0];
    if (!armName) return false;
    const armature = factory.buildArmatureDisplay(armName);
    if (!armature) return false;
    armature.x = size / 2;
    armature.y = size * 0.62;
    // 自适应缩放，避免过小发糊/过大出框
    try {
      const b = armature.getLocalBounds();
      const bw = Math.max(b.width || 1, 1);
      const bh = Math.max(b.height || 1, 1);
      const sc = Math.min((size * 0.82) / bw, (size * 0.82) / bh, 2.5);
      armature.scale.set(sc);
    } catch (e) {
      armature.scale.set(1.2);
    }
    app.stage.addChild(armature);
    const anims = (armature.animation && armature.animation.animationNames) || [];
    if (anims.length) armature.animation.play(anims[0], 0);

    // 用真实耗时推进，避免 delta 帧系数导致卡顿/加速
    let lastTs = performance.now();
    const tickerFn = function(){
      const now = performance.now();
      let dt = (now - lastTs) * 0.001;
      lastTs = now;
      if (dt > 0.05) dt = 0.05; // 掉帧时钳制，减少抖动
      try { factory.dragonBones.advanceTime(dt); } catch (e) {}
    };
    if (app.ticker) {
      app.ticker.maxFPS = 60;
      app.ticker.add(tickerFn);
    } else {
      PIXI.ticker.shared.add(tickerFn);
    }

    toolbar.innerHTML='';
    const tip=document.createElement('span');
    tip.style.cssText='color:var(--muted);font-size:12px';
    tip.textContent='骨骼动画'+(anims.length?(' · '+anims.join(', ')):' · '+armName);
    toolbar.appendChild(tip);
    for (const a of anims.slice(0,8)){
      const b=document.createElement('button');
      b.textContent=a;
      b.onclick=()=>armature.animation.play(a,0);
      toolbar.appendChild(b);
    }
    player={ destroy(){
      try{ if(app.ticker) app.ticker.remove(tickerFn); }catch{}
      try{ app.destroy(true); }catch{}
    } };
    return true;
  }catch(e){
    console.warn('db skeletal failed', e);
    return false;
  }
}

async function playDbSubtextures(item, preview, toolbar){
  if (!item.texJson || !item.texture){
    preview.innerHTML=item.thumb?'<img src="'+item.thumb+'" />':'<div class="empty">缺少贴图</div>';
    toolbar.innerHTML='<span style="color:var(--muted);font-size:12px">无法解析龙骨，仅静态图</span>';
    return;
  }
  try{
    const tex=await (await fetch(item.texJson)).json();
    const subs=tex.SubTexture||tex.subTexture||[];
    if (!subs.length){
      preview.innerHTML='<img src="'+item.texture+'" />';
      return;
    }
    await playSubTextureList(subs, item.texture, preview, toolbar, 'SubTexture 轮播');
  }catch(e){
    console.warn('playDbSubtextures failed', e);
    preview.innerHTML='<img src="'+item.texture+'" />';
    toolbar.innerHTML='<span style="color:#f88;font-size:12px">'+escapeHtml(String(e&&e.message||e))+'</span>';
  }
}

function loadImage(src){
  return new Promise((res,rej)=>{
    const img=new Image();
    img.onload=()=>res(img);
    img.onerror=()=>rej(new Error('image load fail '+src));
    img.src=src;
  });
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));}

document.getElementById('q').addEventListener('input', ()=>renderGrid());
load();
</script>
</body>
</html>`;

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

const server = createServer((req, res) => {
  try {
    const u = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    if (u.pathname === '/' || u.pathname === '/index.html') {
      send(res, 200, 'text/html; charset=utf-8', HTML);
      return;
    }
    if (u.pathname === '/api/catalog') {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(getCatalog()));
      return;
    }
    if (u.pathname.startsWith('/vendor/')) {
      const rel = u.pathname.slice('/vendor/'.length);
      const full = safeJoin(VENDOR_DIR, rel);
      if (!full || !existsSync(full) || !statSync(full).isFile()) {
        send(res, 404, 'text/plain', 'vendor not found');
        return;
      }
      const ext = extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/javascript',
        'Cache-Control': 'public, max-age=86400',
      });
      createReadStream(full).pipe(res);
      return;
    }
    if (u.pathname.startsWith('/file/')) {
      const rel = u.pathname.slice('/file/'.length);
      const full = safeJoin(RESTORED, rel);
      if (!full || !existsSync(full) || !statSync(full).isFile()) {
        send(res, 404, 'text/plain', 'not found');
        return;
      }
      const ext = extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      });
      createReadStream(full).pipe(res);
      return;
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'text/plain', String(e && e.message || e));
  }
});

if (!existsSync(RESTORED)) {
  console.error('restored 目录不存在:', RESTORED);
  process.exit(1);
}

server.on('error', (e) => {
  console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[viewer] http://127.0.0.1:${PORT}/`);
  console.log(`[viewer] 局域网: http://<本机IP>:${PORT}/  (已监听 0.0.0.0)`);
  console.log(`[viewer] root ${RESTORED}`);
  console.log(`[viewer] vendor ${HAS_VENDOR ? VENDOR_DIR : '(cdn)'}`);
});
