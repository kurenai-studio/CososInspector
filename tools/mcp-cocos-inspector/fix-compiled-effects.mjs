#!/usr/bin/env node
/**
 * 自研后处理：把 cc-reverse 产出的「编译态」.effect（cc.EffectAsset JSON）
 * 还原为 Creator 可导入的 YAML 源（CCEffect / CCProgram）。
 *
 * 当前覆盖：基于 builtin-sprite 管线的 2D 特效（含自定义 FragConstants）。
 * gauss-blur：从 glsl3.frag 抽出模糊逻辑，保留原 UUID。
 *
 * 用法:
 *   node fix-compiled-effects.mjs <工程assets根> [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const assetsRootArg = args.find((a) => !a.startsWith('-'));
if (!assetsRootArg) {
  console.error('用法: node fix-compiled-effects.mjs <工程assets根> [--dry-run]');
  process.exit(1);
}
const assetsRoot = path.resolve(assetsRootArg);
if (!fs.existsSync(assetsRoot)) {
  console.error(`不存在: ${assetsRoot}`);
  process.exit(1);
}

const SPRITE_VS = `CCProgram sprite-vs %{
  precision highp float;
  #include <builtin/uniforms/cc-global>
  #if USE_LOCAL
    #include <builtin/uniforms/cc-local>
  #endif
  in vec3 a_position;
  in vec2 a_texCoord;
  in vec4 a_color;

  out vec4 color;
  out vec2 uv0;

  vec4 vert () {
    vec4 pos = vec4(a_position, 1);

    #if USE_LOCAL
      pos = cc_matWorld * pos;
    #endif

    #if USE_PIXEL_ALIGNMENT
      pos = cc_matView * pos;
      pos.xyz = floor(pos.xyz);
      pos = cc_matProj * pos;
    #else
      pos = cc_matViewProj * pos;
    #endif

    uv0 = a_texCoord;
    color = a_color;

    return pos;
  }
}%
`;

/**
 * @param {string} dir
 * @param {string[]} acc
 */
function collectEffects(dir, acc = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) collectEffects(f, acc);
    else if (e.name.endsWith('.effect') && !e.name.endsWith('.effect.meta')) {
      acc.push(f);
    }
  }
  return acc;
}

/**
 * @param {string} text
 */
function looksCompiled(text) {
  const t = text.trim();
  if (!t.startsWith('[') && !t.startsWith('{')) return false;
  try {
    const j = JSON.parse(t);
    const obj = Array.isArray(j) ? j[0] : j;
    return obj && obj.__type__ === 'cc.EffectAsset' && Array.isArray(obj.shaders);
  } catch {
    return false;
  }
}

/**
 * @param {object} asset
 */
function isSpriteBased(asset) {
  const sh = asset.shaders?.[0];
  if (!sh) return false;
  const name = String(sh.name || '');
  if (/sprite-vs|sprite-fs/i.test(name)) return true;
  const attrs = (sh.attributes || []).map((a) => a.name);
  return (
    attrs.includes('a_position') &&
    attrs.includes('a_texCoord') &&
    attrs.includes('a_color')
  );
}

/**
 * BlendFactor 枚举 → YAML 名（与引擎一致的常用子集）
 * @param {number} n
 */
function blendName(n) {
  const map = {
    0: 'zero',
    1: 'one',
    2: 'src_alpha',
    3: 'one_minus_src_alpha',
    4: 'one_minus_src_alpha',
    5: 'dst_alpha',
    6: 'one_minus_dst_alpha',
    7: 'src_color',
    8: 'one_minus_src_color',
  };
  // 注意：引擎里 ONE_MINUS_SRC_ALPHA=4, DST_COLOR=5...；
  // 编译态 dump 里 blendDst:4 / blendDstAlpha:4 → one_minus_src_alpha
  if (n === 2) return 'src_alpha';
  if (n === 4) return 'one_minus_src_alpha';
  return map[n] || 'one_minus_src_alpha';
}

/**
 * 从编译 frag 抽出自定义函数体（draw/rand/mainImage 等）
 * @param {string} frag
 */
function extractCustomFragBody(frag) {
  // 去掉引擎包装：precision / includes 展开 / in/out / uniform sampler / FragConstants / frag()/main()
  let body = frag;

  // 取 FragConstants 之后到 `vec4 frag` 之前
  const constIdx = body.search(/layout\s*\(std140\)\s*uniform\s+FragConstants/);
  if (constIdx >= 0) {
    const afterConst = body.indexOf('};', constIdx);
    if (afterConst >= 0) body = body.slice(afterConst + 2);
  } else {
    // 无 FragConstants：尝试从第一个自定义函数开始
    const m = body.match(/\n(vec4\s+draw|float\s+rand|vec4\s+mainImage)/);
    if (m) body = body.slice(m.index + 1);
  }

  const fragFn = body.search(/\nvec4\s+frag\s*\(/);
  if (fragFn >= 0) body = body.slice(0, fragFn);

  return body.trim();
}

/**
 * @param {object} asset
 * @param {object} block
 */
function propertiesFromAsset(asset) {
  const pass = asset.techniques?.[0]?.passes?.[0] || {};
  const props = pass.properties || {};
  const lines = [];
  for (const [k, v] of Object.entries(props)) {
    const val = Array.isArray(v?.value) ? v.value[0] : v?.value;
    if (typeof val === 'number') {
      lines.push(`        ${k}: { value: ${val} }`);
    } else if (val != null) {
      lines.push(`        ${k}: { value: ${JSON.stringify(val)} }`);
    }
  }
  if (!lines.some((l) => l.includes('alphaThreshold'))) {
    lines.unshift('        alphaThreshold: { value: 0.5 }');
  }
  return lines.join('\n');
}

/**
 * @param {object} asset
 */
function uniformBlockDecl(asset) {
  const blocks = asset.shaders?.[0]?.blocks || [];
  const frag = blocks.find((b) => b.name === 'FragConstants');
  if (!frag || !frag.members?.length) return '';
  const members = frag.members
    .map((m) => `    float ${m.name};`)
    .join('\n');
  return `
  uniform FragConstants {
${members}
  };
`;
}

/**
 * @param {object} asset
 * @param {string} customBody
 */
function buildSpriteEffectYaml(asset, customBody) {
  const pass = asset.techniques?.[0]?.passes?.[0] || {};
  const blend = pass.blendState?.targets?.[0] || {};
  const src = blendName(blend.blendSrc ?? 2);
  const dst = blendName(blend.blendDst ?? 4);
  const dstA = blendName(blend.blendDstAlpha ?? 4);
  const props = propertiesFromAsset(asset);
  const uniforms = uniformBlockDecl(asset);

  // 原编译 frag：o*=color; return mainImage(o);
  // 还原时若已有 mainImage，则走自定义；否则退回 sprite 采样
  const hasMainImage = /mainImage\s*\(/.test(customBody);

  const fragProgram = `CCProgram sprite-fs %{
  precision highp float;
  #include <builtin/internal/embedded-alpha>
  #include <builtin/internal/alpha-test>

  in vec4 color;

  #if USE_TEXTURE
    in vec2 uv0;
    #pragma builtin(local)
    layout(set = 2, binding = 12) uniform sampler2D cc_spriteTexture;
  #endif
${uniforms}
${customBody}

  vec4 frag () {
    vec4 o = vec4(1, 1, 1, 1);
    o *= color;
#if USE_TEXTURE
${hasMainImage ? '    o = mainImage(o);' : '    o *= CCSampleWithAlphaSeparated(cc_spriteTexture, uv0);'}
#endif
    ALPHA_TEST(o);
    return o;
  }
}%
`;

  // 修正 mainImage(out vec4 o) → mainImage(vec4 o) 并确保有 return
  let fixedFrag = fragProgram;
  fixedFrag = fixedFrag.replace(
    /vec4\s+mainImage\s*\(\s*out\s+vec4\s+o\s*\)/g,
    'vec4 mainImage(vec4 o)'
  );

  return `// Restored from compiled EffectAsset by fix-compiled-effects.mjs
CCEffect %{
  techniques:
  - passes:
    - vert: sprite-vs:vert
      frag: sprite-fs:frag
      depthStencilState:
        depthTest: false
        depthWrite: false
      blendState:
        targets:
        - blend: true
          blendSrc: ${src}
          blendDst: ${dst}
          blendDstAlpha: ${dstA}
      rasterizerState:
        cullMode: none
      properties:
${props}
}%

${SPRITE_VS}
${fixedFrag}
`;
}

/**
 * @param {string} effectPath
 */
function processOne(effectPath) {
  const raw = fs.readFileSync(effectPath, 'utf8');
  if (!looksCompiled(raw)) {
    return { status: 'skip', reason: '已是源格式或非 EffectAsset JSON' };
  }
  const parsed = JSON.parse(raw);
  const asset = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isSpriteBased(asset)) {
    return { status: 'skip', reason: '非 sprite 管线，暂不自动还原' };
  }

  const fragGlsl = asset.shaders[0]?.glsl3?.frag || asset.shaders[0]?.glsl1?.frag || '';
  if (!fragGlsl) {
    return { status: 'error', reason: '无 glsl frag' };
  }
  let customBody = extractCustomFragBody(fragGlsl);
  if (!customBody) {
    return { status: 'error', reason: '无法抽取自定义 frag 体' };
  }
  // out 参数改成值传递，便于嵌进 CCProgram
  customBody = customBody.replace(
    /vec4\s+mainImage\s*\(\s*out\s+vec4\s+o\s*\)/g,
    'vec4 mainImage(vec4 o)'
  );

  const yaml = buildSpriteEffectYaml(asset, customBody);
  const bakPath = `${effectPath}.compiled.json`;
  const metaPath = `${effectPath}.meta`;

  let meta = null;
  if (fs.existsSync(metaPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } else {
    meta = {
      ver: '1.7.1',
      importer: 'effect',
      imported: false,
      uuid: crypto.randomUUID(),
      files: [],
      subMetas: {},
      userData: {},
    };
  }
  meta.importer = 'effect';
  meta.ver = '1.7.1';
  meta.imported = false;
  meta.files = [];
  if (!meta.subMetas) meta.subMetas = {};
  if (!meta.userData) meta.userData = {};

  if (!dryRun) {
    if (!fs.existsSync(bakPath)) {
      fs.writeFileSync(bakPath, raw);
    }
    fs.writeFileSync(effectPath, yaml.replace(/\r?\n/g, '\n'));
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }

  return {
    status: 'rewritten',
    name: asset._name,
    uuid: meta.uuid,
    props: Object.keys(asset.techniques?.[0]?.passes?.[0]?.properties || {}),
    bodyPreview: customBody.slice(0, 120),
  };
}

const files = collectEffects(assetsRoot);
const report = { dryRun, total: files.length, rewritten: 0, skipped: 0, errors: [], items: [] };

for (const f of files) {
  const rel = path.relative(assetsRoot, f).replace(/\\/g, '/');
  try {
    const r = processOne(f);
    report.items.push({ rel, ...r });
    if (r.status === 'rewritten') report.rewritten++;
    else if (r.status === 'error') {
      report.errors.push({ rel, error: r.reason });
      report.skipped++;
    } else report.skipped++;
  } catch (e) {
    report.errors.push({ rel, error: e.message });
    report.skipped++;
  }
}

console.log(JSON.stringify(report, null, 2));
