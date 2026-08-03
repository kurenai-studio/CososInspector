import fs from 'fs';

const dir = 'D:/UGit/CososInspectorNew/tmp';
for (const f of fs.readdirSync(dir)) {
  const st = fs.statSync(`${dir}/${f}`);
  console.log(f, st.size);
}

const s = fs.readFileSync(`${dir}/main.1f93276b28095d53d172.js`, 'utf8');
const pats = [
  'new Application',
  'Application(',
  'autoDetectRenderer',
  'Ticker.shared',
  'webpackChunketernal_dusk',
  '@pixi/',
  'pixi.js',
  '.stage=',
  'render(this.stage',
  'renderer.render',
];
for (const p of pats) {
  const count = s.split(p).length - 1;
  const idx = s.indexOf(p);
  console.log('---', p, 'count=', count);
  if (idx >= 0) {
    console.log(JSON.stringify(s.slice(Math.max(0, idx - 60), idx + 100)));
  }
}

const init = fs.readFileSync(`${dir}/init.7f1c94c6172f8e517a3a.js`, 'utf8');
console.log('init len', init.length);
console.log(init.slice(0, 500));
