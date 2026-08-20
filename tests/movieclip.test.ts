/**
 * MovieClip 导出 + skeletonCommon 纯函数单元测试
 * 运行: node tests/run.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _getMovieClipDataForTest,
  _getAnimsFromMcDataForTest,
  _buildFrameManifestForTest,
  _uniqueTextureKeysForTest,
} from '../src/egret/movieClipExport';
import {
  sanitizeFilename,
  runtimeSummaryJson,
  pushSkeletonData,
  bytesToBase64,
  type SkeletonExportFile,
} from '../src/egret/skeletonCommon';

// ---------- sanitizeFilename ----------
test('sanitizeFilename: 清洗路径分隔符与空白', () => {
  assert.equal(sanitizeFilename('hero/run.png'), 'hero_run.png');
  assert.equal(sanitizeFilename('a<b>c:"d|e/f'), 'a_b_c_d_e_f');
  assert.equal(sanitizeFilename('  spaces  here'), '_spaces_here');
  assert.equal(sanitizeFilename(''), 'skeleton');
  assert.equal(sanitizeFilename(null as unknown as string), 'skeleton');
  assert.equal(sanitizeFilename('____'), '_');
});

// ---------- runtimeSummaryJson ----------
test('runtimeSummaryJson: 输出含 note 前缀 + 元数据', () => {
  const text = runtimeSummaryJson({
    engine: 'Egret',
    kind: 'spine',
    name: 'hero',
    hasSkeletonRaw: true,
    anims: ['walk', 'run'],
  });
  const obj = JSON.parse(text);
  assert.equal(obj.note, '运行时摘要：非原始 Spine/DragonBones 工程文件，仅供对照；缺原始 json/skel 时无法完整还原。');
  assert.equal(obj.engine, 'Egret');
  assert.equal(obj.name, 'hero');
  assert.deepEqual(obj.anims, ['walk', 'run']);
  assert.equal(obj.hasSkeletonRaw, true);
});

test('runtimeSummaryJson: 异常输入不抛错', () => {
  const circular: any = {};
  circular.self = circular;
  const text = runtimeSummaryJson({
    engine: 'Egret',
    kind: 'spine',
    name: 'x',
    extra: circular,
  });
  assert.ok(text.includes('runtime summary failed') || text.length > 0);
});

// ---------- bytesToBase64 ----------
test('bytesToBase64: 标准 base64 编码', () => {
  const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const b64 = bytesToBase64(bytes);
  assert.equal(b64, btoa('Hello'));
  assert.equal(atob(b64), 'Hello');
});

test('bytesToBase64: 空数组返回空字符串', () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
});

// ---------- pushSkeletonData ----------
test('pushSkeletonData: 字符串 → text 文件', () => {
  const out: SkeletonExportFile[] = [];
  const ok = pushSkeletonData(out, '{"a":1}', 'skeleton.json', 'application/json');
  assert.equal(ok, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'skeleton.json');
  assert.equal(out[0].text, '{"a":1}');
  assert.equal(out[0].bytes, 7);
});

test('pushSkeletonData: ArrayBuffer → .skel base64', () => {
  const out: SkeletonExportFile[] = [];
  const buf = new ArrayBuffer(4);
  new Uint8Array(buf).set([1, 2, 3, 4]);
  const ok = pushSkeletonData(out, buf, 'ske.json', 'application/json');
  assert.equal(ok, true);
  assert.equal(out.length, 1);
  assert.match(out[0].name, /\.skel$/);
  assert.equal(out[0].dataBase64, bytesToBase64(new Uint8Array(buf)));
  assert.equal(out[0].bytes, 4);
});

test('pushSkeletonData: TypedArray → .skel base64', () => {
  const out: SkeletonExportFile[] = [];
  const arr = new Uint8Array([10, 20, 30]);
  const ok = pushSkeletonData(out, arr, 'ske.json', 'application/json');
  assert.equal(ok, true);
  assert.match(out[0].name, /\.skel$/);
  assert.equal(out[0].dataBase64, bytesToBase64(arr));
});

test('pushSkeletonData: 骨架对象 → JSON 文本', () => {
  const out: SkeletonExportFile[] = [];
  const obj = { skeleton: { hash: 'abc', spine: '3.8' }, bones: [] };
  const ok = pushSkeletonData(out, obj, 'skeleton.json', 'application/json');
  assert.equal(ok, true);
  assert.equal(out[0].text, JSON.stringify(obj, null, 2));
});

test('pushSkeletonData: 普通对象（无骨架字段）→ 拒绝', () => {
  const out: SkeletonExportFile[] = [];
  const ok = pushSkeletonData(out, { foo: 1 }, 'x.json', 'application/json');
  assert.equal(ok, false);
  assert.equal(out.length, 0);
});

test('pushSkeletonData: null/空值 → 拒绝', () => {
  const out: SkeletonExportFile[] = [];
  assert.equal(pushSkeletonData(out, null, 'x', 'application/json'), false);
  assert.equal(pushSkeletonData(out, undefined, 'x', 'application/json'), false);
  assert.equal(pushSkeletonData(out, '', 'x', 'application/json'), false);
  assert.equal(pushSkeletonData(out, new ArrayBuffer(0), 'x', 'application/json'), false);
});

// ---------- MovieClip _getMovieClipDataForTest ----------
test('_getMovieClipDataForTest: 优先 movieClipData 字段', () => {
  const node = { movieClipData: { frames: [], textures: {} } };
  const d = _getMovieClipDataForTest(node);
  assert.equal(d, node.movieClipData);
});

test('_getMovieClipDataForTest: 回退 _movieClipData 字段', () => {
  const node = { _movieClipData: { frames: [{ texture: 'a' }] } };
  const d = _getMovieClipDataForTest(node);
  assert.equal(d, node._movieClipData);
  assert.equal(d.frames!.length, 1);
});

test('_getMovieClipDataForTest: 无字段返回 null', () => {
  assert.equal(_getMovieClipDataForTest({}), null);
  assert.equal(_getMovieClipDataForTest(null), null);
});

// ---------- MovieClip _getAnimsFromMcDataForTest ----------
test('_getAnimsFromMcDataForTest: 从 mcData.labels 取动画名', () => {
  const data = {
    mcData: {
      labels: {
        walk: { frame: 1, end: 5 },
        run: { frame: 6, end: 12 },
        idle: { frame: 13, end: 20 },
      },
    },
  };
  const anims = _getAnimsFromMcDataForTest(data);
  assert.deepEqual(anims.sort(), ['idle', 'run', 'walk']);
});

test('_getAnimsFromMcDataForTest: 无 labels 返回空数组', () => {
  assert.deepEqual(_getAnimsFromMcDataForTest({}), []);
  assert.deepEqual(_getAnimsFromMcDataForTest({ mcData: {} }), []);
  assert.deepEqual(_getAnimsFromMcDataForTest(null), []);
});

test('_getAnimsFromMcDataForTest: 过滤空 key', () => {
  const data = { mcData: { labels: { '': 1, walk: 2 } } };
  assert.deepEqual(_getAnimsFromMcDataForTest(data), ['walk']);
});

// ---------- MovieClip _buildFrameManifestForTest ----------
test('_buildFrameManifestForTest: 提取帧序号 + texture key + offset', () => {
  const frames = [
    { texture: 'f0', x: 0, y: 0 },
    { texture: 'f1', x: 10, y: 5 },
    { texture: 'f0', x: 0, y: 0 },
  ];
  const m = _buildFrameManifestForTest(frames);
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { frame: 0, textureKey: 'f0', x: 0, y: 0 });
  assert.deepEqual(m[1], { frame: 1, textureKey: 'f1', x: 10, y: 5 });
  assert.deepEqual(m[2], { frame: 2, textureKey: 'f0', x: 0, y: 0 });
});

test('_buildFrameManifestForTest: 空帧返回空数组', () => {
  assert.deepEqual(_buildFrameManifestForTest([]), []);
  assert.deepEqual(_buildFrameManifestForTest(undefined), []);
});

test('_buildFrameManifestForTest: 缺字段用默认值 0', () => {
  const m = _buildFrameManifestForTest([{ texture: 'a' }, {}]);
  assert.equal(m[0].x, 0);
  assert.equal(m[0].y, 0);
  assert.equal(m[1].textureKey, null);
  assert.equal(m[1].x, 0);
  assert.equal(m[1].y, 0);
});

// ---------- MovieClip _uniqueTextureKeysForTest ----------
test('_uniqueTextureKeysForTest: 去重保持首次出现顺序', () => {
  const frames = [
    { texture: 'a' },
    { texture: 'b' },
    { texture: 'a' },
    { texture: 'c' },
    { texture: 'b' },
  ];
  assert.deepEqual(_uniqueTextureKeysForTest(frames), ['a', 'b', 'c']);
});

test('_uniqueTextureKeysForTest: 跳过空 key', () => {
  const frames = [
    { texture: '' },
    { texture: 'a' },
    { texture: null },
    { texture: 'b' },
  ];
  assert.deepEqual(_uniqueTextureKeysForTest(frames), ['a', 'b']);
});

test('_uniqueTextureKeysForTest: 空输入返回空数组', () => {
  assert.deepEqual(_uniqueTextureKeysForTest([]), []);
  assert.deepEqual(_uniqueTextureKeysForTest(undefined), []);
});
