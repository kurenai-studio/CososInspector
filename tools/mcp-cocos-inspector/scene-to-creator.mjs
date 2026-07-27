#!/usr/bin/env node
/**
 * Inspector 场景快照 → Creator 重建（Phase 2：根节点 walk + 设计分辨率 + Sprite 纹理）
 *
 * 纹理走文件通道：桥接 downloadTexture → 写入 Creator assets → HTTP/磁盘，不经 WS 传 base64 大块。
 *
 * 用法:
 *   node tools/mcp-cocos-inspector/scene-to-creator.mjs tmp/godeebxp-scene-snapshot.json \
 *     --project D:/workspace/testAutoCopy \
 *     --scene assets/scene/godeebxp_recovered.scene \
 *     --clear --with-textures --max-nodes 2000 --max-sprites 600
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  bridgeApiCall,
  callBridgeAtPort,
  connectBridgeClientOnly,
  waitForExtension,
} from './bridge-server.mjs';

/** 走持久 WS 客户端；downloadTexture 大图读取消耗较长 */
const inspectorCall = (wsPort, method, argList, opts = {}) =>
  bridgeApiCall(method, argList, {
    ...opts,
    timeoutMs:
      opts.timeoutMs ??
      (method === 'downloadTexture' ? 300_000 : undefined),
  });
import { resolveSharePath, setShareContext, getShareDir } from './shared-fs.mjs';
import {
  buildBindingsFromManifest,
  buildPathToNodeUuidMap,
  patchBitmapFontOnDisk,
  patchCanvasCameraOnDisk,
  patchMasksOnDisk,
  patchSkeletonDataOnDisk,
  patchSpriteFramesOnDisk,
  patchUiSizesOnDisk,
  resetAllSpriteMetaFromManifest,
  resetSpriteMetaTrimOnDisk,
} from './scene-patch-disk.mjs';
import {
  collectUiSizeBindings,
  indexSnapshotNodes,
  lookupPathMap,
  normalizeSpriteFrameMeta,
  parseSpriteSizeMode,
  parseUiFromSnapshotNode,
} from './scene-snapshot-parse.mjs';
import { exportSpineBmfontAssets } from './spine-bmfont-recovery.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const parseArgs = () => {
  const argv = process.argv.slice(2);
  const snapshotPath = argv.find((a) => !a.startsWith('--'));
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const has = (flag) => argv.includes(flag);
  return {
    snapshotPath,
    project: get('--project', process.env.COCOS_PROJECT ?? 'D:/workspace/testAutoCopy'),
    sceneRel: get('--scene', 'assets/scene/godeebxp_recovered.scene'),
    templateRel: get('--template', 'assets/scene/scene.scene'),
    bridge: get('--bridge', process.env.COCOSMCP_BRIDGE ?? 'http://127.0.0.1:3921'),
    wsPort: Number(get('--ws-port', process.env.COCOS_BRIDGE_PORT ?? '17373')),
    pageUrlMatch: get('--page-url-match', process.env.COCOS_PAGE_URL_MATCH ?? 'godeebxp'),
    domain: get('--domain', process.env.COCOS_INSPECTOR_DOMAIN ?? ''),
    assetKey: get('--asset-key', ''),
    maxNodes: Number(get('--max-nodes', '2000')),
    maxSprites: Number(get('--max-sprites', '600')),
    clear: has('--clear'),
    withTextures: has('--with-textures'),
    withSpineFonts: has('--with-spine-fonts'),
    refreshSnapshot: has('--refresh-snapshot'),
    skipTextures: has('--skip-textures'),
    resumeTextures: has('--resume-textures'),
    texturesOnly: has('--textures-only'),
    forceTextures: has('--force-textures'),
    maxSpines: Number(get('--max-spines', '50')),
    maxBmfonts: Number(get('--max-bmfonts', '50')),
    manifestPath: get('--manifest', ''),
    liveSpritesPath: get('--live-sprites', ''),
  };
};

/** 从 scene 路径推导资源目录名，如 bountyhunter_recovered.scene → bountyhunter */
const deriveAssetKey = (sceneRel, explicit) => {
  if (explicit) return explicit.replace(/[\\/]+/g, '').trim();
  const base = path.basename(sceneRel || '', path.extname(sceneRel || ''));
  const key = base.replace(/_recovered$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return key || 'godeebxp';
};

/** 对齐 bridge-daemon 的域名隔离 share 目录 */
const applyShareDirForDomain = (domain, wsPort) => {
  if (!domain) return;
  const repoRoot = path.resolve(path.join(__dirname, '../..'));
  const shareDir = path.join(
    repoRoot,
    'tmp',
    'mcp-share',
    String(domain).replace(/\./g, '_')
  );
  setShareContext({
    shareDir,
    domain,
    wsPort: Number(wsPort) || undefined,
    httpPort: Number(wsPort) ? Number(wsPort) + 1 : undefined,
  });
  console.error(`[scene-to-creator] shareDir=${getShareDir()}`);
};

const normalizeProjectKey = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/** 多开 Creator 时按工程路径解析 cocos-meta-mcp 端口，避免连错实例 */
const resolveCreatorBridge = (project, bridgeArg) => {
  const localApp = process.env.LOCALAPPDATA ?? process.env.HOME ?? '';
  const registryPath = path.join(localApp, 'cocos-meta-mcp', 'instances.json');
  const projectKey = normalizeProjectKey(project);
  if (fs.existsSync(registryPath)) {
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const inst = reg.instances?.[projectKey];
    if (inst?.port) {
      const url = `http://127.0.0.1:${inst.port}`;
      if (bridgeArg && !String(bridgeArg).includes(String(inst.port))) {
        console.error(
          `[scene-to-creator] --bridge ${bridgeArg} 与 registry ${url} 不一致，使用 registry（${inst.projectPath}）`
        );
      }
      return { url, projectPath: inst.projectPath, port: inst.port };
    }
  }
  return { url: bridgeArg, projectPath: project, port: null };
};

const execEval = async (bridge, code, timeoutMs = 900_000) => {
  const res = await fetch(`${bridge}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'eval', code }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    throw new Error(JSON.stringify(body));
  }
  return body.result;
};

/** 切换场景前：仅当已 dirty 且当前场景可静默保存时尝试 */
const preflightSaveScene = async (bridge, sceneUrl) => {
  await execEval(
    bridge,
    `try {
      const dirty = await Editor.Message.request('scene', 'query-dirty');
      if (!dirty) return { skipped: true, reason: 'not-dirty' };
    } catch (_) { return { skipped: true, reason: 'query-failed' }; }
    return { skipped: true, reason: 'skip-save-before-rebuild' };`,
    30_000
  );
};

/** 绑定 Sprite 前重置 .meta，避免「Rect exceeds maximum margin」 */
const prepareTextureMetaForScene = async (project, manifest, bridge, assetKey) => {
  const entries = Object.values(manifest ?? {});
  if (!entries.length) return { patched: 0, skipped: 0 };
  const key = assetKey || 'godeebxp';

  let metaReset = resetAllSpriteMetaFromManifest(project, manifest);
  // 绑定前刷新资源库，让 Creator 识别 PNG；再重置 meta 去掉 auto-trim
  const dbUrls = [
    `db://assets/recovered/${key}/sprites`,
    ...new Set(entries.map((e) => e.dbUrl).filter(Boolean)),
  ];
  await execEval(
    bridge,
    `const urls = ${JSON.stringify(dbUrls)};
for (const u of urls) {
  try { await Editor.Message.request('asset-db', 'refresh-asset', u); } catch (_) {}
}
await new Promise((r) => setTimeout(r, 1200));
return { refreshed: urls.length };`,
    120_000
  );
  metaReset = resetAllSpriteMetaFromManifest(project, manifest);
  return metaReset;
};

const findInTree = (node, name) => {
  if (!node) return null;
  if (node.name === name) return node;
  for (const ch of node.children ?? []) {
    const hit = findInTree(ch, name);
    if (hit) return hit;
  }
  return null;
};

const collectSpriteNodes = (node, out = []) => {
  const isSprite = (node.components ?? []).some((c) => c.flags?.isSprite);
  if (isSprite) out.push({ id: node.id, name: node.name, path: node.path });
  for (const ch of node.children ?? []) collectSpriteNodes(ch, out);
  return out;
};

/** 快照与试玩页 listSprites 路径对齐（去 main 前缀、统一 › 空格，兼容乱码分隔符） */
const normalizeSpritePath = (p) =>
  String(p ?? '')
    // UTF-8 › (U+203A) 被按 GBK/CP936 误读时常见为 鈥?
    .replace(/\s*鈥\?\s*/g, ' › ')
    .replace(/\s*鈥\uFFFD\s*/g, ' › ')
    .replace(/\s*[›>／/]\s*/g, ' › ')
    .replace(/^main › /i, '')
    .replace(/^game_scene › /i, '')
    .replace(/\s*›\s*/g, ' › ')
    .trim();

const buildLiveSpritePathMap = (liveSprites = []) => {
  const map = new Map();
  for (const sp of liveSprites) {
    const norm = normalizeSpritePath(sp.path);
    const keys = [
      norm,
      sp.path,
      // 同名节点极多（img_symbol / Background），禁止单独用 name 做键
      norm && sp.frameName ? `${norm}@@${sp.frameName}` : null,
      sp.name && sp.frameName ? `${sp.name}@@${sp.frameName}` : null,
    ].filter(Boolean);
    for (const key of keys) {
      if (!map.has(key)) map.set(key, sp);
    }
  }
  return map;
};

const safeFileStem = (nodeId, name) => {
  const base = `${name || 'sprite'}_${nodeId}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return base.slice(0, 120);
};

const extractDesignResolution = (snapshot) => {
  // 2.x 快照顶栏 designResolution 优先
  const top = snapshot.designResolution;
  if (top?.width > 0 && top?.height > 0) {
    return {
      width: top.width,
      height: top.height,
      canvasTransform: null,
      source: 'snapshot.designResolution',
    };
  }

  const findCanvasHost = (node) => {
    if (!node) return null;
    if (node.name === 'Canvas') return node;
    const hasCanvas = (node.components || []).some((c) =>
      /cc\.Canvas|^Canvas$/i.test(c.typeName || c.shortName || '')
    );
    if (hasCanvas) return node;
    if (node.name === 'GameLayer' && node.uiTransform) return node;
    for (const ch of node.children ?? []) {
      const hit = findCanvasHost(ch);
      if (hit) return hit;
    }
    return null;
  };
  const canvas = findCanvasHost(snapshot.root) || findInTree(snapshot.root, 'Canvas');

  // Canvas 组件行「设计分辨率」
  const canvasComp = canvas?.components?.find((c) =>
    /cc\.Canvas|^Canvas$/i.test(c.typeName || c.shortName || '')
  );
  const designRow = canvasComp?.rows?.find((r) =>
    /设计分辨率|designResolution/i.test(String(r.label ?? ''))
  );
  if (designRow?.value) {
    const m = String(designRow.value).match(
      /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)/
    );
    if (m) {
      return {
        width: +m[1],
        height: +m[2],
        canvasTransform: canvas?.transform ?? null,
        source: 'canvas.rows',
      };
    }
  }

  let width = canvas?.uiTransform?.contentSize?.width;
  let height = canvas?.uiTransform?.contentSize?.height;
  if (!width || !height) {
    const uiComp = canvas?.components?.find((c) => /UITransform/.test(c.typeName || ''));
    const sizeRow = uiComp?.rows?.find(
      (r) => r.label === '内容尺寸' || r.label === 'size'
    );
    const m = String(sizeRow?.value ?? '').match(
      /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)/
    );
    if (m) {
      width = +m[1];
      height = +m[2];
    }
  }
  return {
    width: width ?? 1280,
    height: height ?? 720,
    canvasTransform: canvas?.transform ?? null,
    source: snapshot.engineFamily === '2' ? 'uiTransform|default(2.x)' : 'uiTransform|default',
  };
};

const ensureSceneFile = (project, templateRel, sceneRel, clear) => {
  const abs = path.join(project, sceneRel);
  const metaPath = `${abs}.meta`;
  if (clear && fs.existsSync(abs)) {
    fs.unlinkSync(abs);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  }
  if (fs.existsSync(abs) && fs.statSync(abs).size > 1000 && !clear) {
    return { created: false, abs };
  }
  const tpl = path.join(project, templateRel);
  if (!fs.existsSync(tpl)) throw new Error(`模板 scene 不存在: ${tpl}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let text = fs.readFileSync(tpl, 'utf8');
  const sceneName = path.basename(sceneRel, '.scene');
  text = text.replace(/scene-2d/g, sceneName);
  text = text.replace(/"_name": "scene"/g, `"_name": "${sceneName}"`);
  fs.writeFileSync(abs, text, 'utf8');
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(
      metaPath,
      `${JSON.stringify(
        {
          ver: '1.1.50',
          importer: 'scene',
          imported: true,
          uuid: crypto.randomUUID(),
          files: ['.json'],
          subMetas: {},
          userData: {},
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  }
  return { created: true, abs };
};

const saveManifest = (manifestPath, manifest, stats) => {
  if (!manifestPath) return;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ manifest, stats, savedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
};

/** 批量导出 Sprite PNG 到 Creator 工程目录（pre-trim 读纹理 + share 文件通道） */
const exportSpriteTextures = async (snapshot, args) => {
  const sprites = collectSpriteNodes(snapshot.root);
  const limited = sprites.slice(0, args.maxSprites);
  const snapById = indexSnapshotNodes(snapshot.root);
  const assetsDir = path.join(
    args.project,
    `assets/recovered/${args.assetKey || 'godeebxp'}/sprites`
  );
  fs.mkdirSync(assetsDir, { recursive: true });

  const liveSprites = (() => {
    if (args.liveSpritesPath && fs.existsSync(args.liveSpritesPath)) {
      const raw = JSON.parse(fs.readFileSync(args.liveSpritesPath, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw?.sprites ?? [];
      console.error(`[scene-to-creator] 已加载 live sprites 缓存 ${list.length} 条`);
      return list;
    }
    return null;
  })();
  const liveList =
    liveSprites ??
    (await inspectorCall(args.wsPort, 'listSprites', [], {
      pageUrlMatch: args.pageUrlMatch,
      timeoutMs: 300_000,
    }));
  const liveByPath = buildLiveSpritePathMap(
    Array.isArray(liveList) ? liveList : []
  );
  console.error(
    `[scene-to-creator] 试玩页 Sprite ${liveByPath.size} 条，快照待导 ${limited.length} 条`
  );

  const manifest = {};
  const frameCache = new Map();
  if (args.resumeTextures && args.manifestPath && fs.existsSync(args.manifestPath)) {
    const loaded = loadManifest(args.manifestPath);
    if (loaded?.manifest) {
      Object.assign(manifest, loaded.manifest);
      for (const entry of Object.values(loaded.manifest)) {
        if (!entry?.rel) continue;
        const key = [
          entry.frameName ?? '',
          `${entry.width}x${entry.height}`,
          entry.spriteFrame?.originalSize?.w ?? '',
          entry.spriteFrame?.originalSize?.h ?? '',
          entry.spriteFrame?.offset?.x ?? '',
          entry.spriteFrame?.offset?.y ?? '',
          entry.spriteFrame?.isRotated ? 'r1' : 'r0',
        ].join('|');
        frameCache.set(key, entry);
      }
      console.error(
        `[scene-to-creator] 续导 manifest 已有 ${Object.keys(manifest).length} 条`
      );
    }
  }
const writeDownloadedTexture = (dl, abs) => {
  if (dl.sharePath) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(resolveSharePath(dl.sharePath), abs);
    return;
  }
  if (dl.base64) {
    fs.writeFileSync(abs, Buffer.from(dl.base64, 'base64'));
    return;
  }
  throw new Error('downloadTexture 响应缺少 sharePath/base64');
};

  let ok = Object.keys(manifest).length;
  let fail = 0;

  for (let i = 0; i < limited.length; i += 1) {
    const sp = limited[i];
    if (!args.forceTextures && manifest[sp.id]?.rel) continue;
    const snapNode = snapById[sp.id];
    const snapFrame =
      snapNode?.spriteFrame?.frameName ||
      snapNode?.components?.find((c) => c.flags?.isSprite)?.rows?.find(
        (r) => r.label === '贴图'
      )?.value ||
      '';
    const pathKey = normalizeSpritePath(sp.path);
    const liveSp =
      liveByPath.get(pathKey) ??
      liveByPath.get(sp.path) ??
      (snapFrame ? liveByPath.get(`${pathKey}@@${snapFrame}`) : null) ??
      (snapFrame ? liveByPath.get(`${sp.name}@@${snapFrame}`) : null);
    if (!liveSp?.id) {
      fail += 1;
      console.error(
        `[scene-to-creator] 纹理跳过 ${sp.name}(${sp.id}) path=${sp.path}: 试玩页无对应 Sprite`
      );
      continue;
    }
    try {
      const dl = await inspectorCall(
        args.wsPort,
        'downloadTexture',
        [liveSp.id, { delivery: 'share', wsPort: args.wsPort }],
        { pageUrlMatch: args.pageUrlMatch }
      );
      if (!dl?.ok) {
        fail += 1;
        console.error(
          `[scene-to-creator] 纹理失败 ${sp.name}(${sp.id}) live=${liveSp.id}: ${
            dl?.error ?? 'unknown'
          }`
        );
        continue;
      }
      const spriteFrame = normalizeSpriteFrameMeta(snapById[sp.id], dl.detail);
      const fw = dl.width;
      const fh = dl.height;
      const frameKey = [
        dl.detail?.frameName ?? '',
        `${fw}x${fh}`,
        spriteFrame?.originalSize?.w ?? '',
        spriteFrame?.originalSize?.h ?? '',
        spriteFrame?.offset?.x ?? '',
        spriteFrame?.offset?.y ?? '',
        spriteFrame?.isRotated ? 'r1' : 'r0',
      ].join('|');
      let entry = frameCache.get(frameKey);
      if (!entry) {
        const stem = safeFileStem(sp.id, dl.detail?.frameName || sp.name);
        const rel = `assets/recovered/${args.assetKey || 'godeebxp'}/sprites/${stem}.png`;
        entry = {
          rel,
          dbUrl: `db://${rel.replace(/\\/g, '/')}`,
          width: fw,
          height: fh,
          frameName: dl.detail?.frameName ?? sp.name,
          spriteFrame,
        };
        frameCache.set(frameKey, entry);
      }
      const abs = path.join(args.project, entry.rel);
      writeDownloadedTexture(dl, abs);
      const metaAbs = `${abs}.meta`;
      if (fs.existsSync(metaAbs)) {
        resetSpriteMetaTrimOnDisk(metaAbs, abs);
      }
      const hadManifest = !!manifest[sp.id];
      manifest[sp.id] = {
        ...entry,
        nodePath: sp.path,
        nodeName: sp.name,
        spriteFrame: spriteFrame ?? entry.spriteFrame,
      };
      if (!hadManifest) ok += 1;
      if ((i + 1) % 50 === 0 || i + 1 === limited.length) {
        if (args.manifestPath) {
          saveManifest(args.manifestPath, manifest, {
            total: limited.length,
            ok,
            fail,
            uniqueFiles: frameCache.size,
          });
        }
        console.error(
          `[scene-to-creator] 纹理导出 ${i + 1}/${limited.length} ok=${ok} fail=${fail}`
        );
      }
    } catch (e) {
      fail += 1;
      console.error(
        `[scene-to-creator] 纹理失败 ${sp.path}: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  return { manifest, stats: { total: limited.length, ok, fail, uniqueFiles: frameCache.size } };
};

const loadManifest = (manifestPath) => {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { manifest: raw.manifest ?? {}, stats: raw.stats ?? {} };
};

const buildCreatorScript = (snapshot, sceneUrl, design, manifest, maxNodes, assetKey, spineManifest, bmfontManifest) => {
  const rootPayload = JSON.stringify(snapshot.root);
  const manifestPayload = JSON.stringify(manifest);
  const spinePayload = JSON.stringify(spineManifest ?? {});
  const bmfontPayload = JSON.stringify(bmfontManifest ?? {});
  const designPayload = JSON.stringify(design);
  const spritesDb = `db://assets/recovered/${assetKey || 'godeebxp'}/sprites`;
  const spineDb = `db://assets/recovered/${assetKey || 'godeebxp'}/spine`;
  const bmfontDb = `db://assets/recovered/${assetKey || 'godeebxp'}/bmfont`;

  return `
const sceneUrl = ${JSON.stringify(sceneUrl)};
const sceneRel = sceneUrl.replace(/^db:\\/\\//, '');
const maxNodes = ${maxNodes};
const rootData = ${rootPayload};
const textureManifest = ${manifestPayload};
const spineManifest = ${spinePayload};
const bmfontManifest = ${bmfontPayload};
const design = ${designPayload};

await Editor.Message.request('asset-db', 'refresh-asset', sceneUrl);
await Editor.Message.request('asset-db', 'refresh-asset', ${JSON.stringify(spritesDb)});
try { await Editor.Message.request('asset-db', 'refresh-asset', ${JSON.stringify(spineDb)}); } catch (_) {}
try { await Editor.Message.request('asset-db', 'refresh-asset', ${JSON.stringify(bmfontDb)}); } catch (_) {}
await new Promise((r) => setTimeout(r, 800));
let sceneInfo = await Editor.Message.request('asset-db', 'query-asset-info', sceneUrl);
if (!sceneInfo?.uuid) {
  sceneInfo = await Editor.Message.request('asset-db', 'query-asset-info', sceneRel);
}
if (!sceneInfo?.uuid) {
  throw new Error('scene asset 未就绪: ' + sceneUrl);
}
await Editor.Message.request('scene', 'open-scene', sceneInfo.uuid);

function findNode(tree, name) {
  if (!tree) return null;
  if (tree.name === name) return tree;
  for (const c of tree.children || []) {
    const r = findNode(c, name);
    if (r) return r;
  }
  return null;
}

function collectRemoveOrder(node, out) {
  if (!node) return;
  for (const c of node.children || []) collectRemoveOrder(c, out);
  if (node.uuid) out.push(node.uuid);
}

let tree = null;
for (let i = 0; i < 30; i++) {
  tree = await Editor.Message.request('scene', 'query-node-tree');
  if (tree?.uuid) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (!tree?.uuid) throw new Error('scene tree 未就绪');
const sceneUuid = tree.uuid;
const removeList = [];
for (const ch of tree.children || []) collectRemoveOrder(ch, removeList);
for (const u of removeList) {
  try { await Editor.Message.request('scene', 'remove-node', { uuid: u }); } catch (_) {}
}

tree = await Editor.Message.request('scene', 'query-node-tree');

const sfUuidCache = {};
const assetUuidCache = {};
async function resolveSpriteFrame(dbUrl) {
  if (sfUuidCache[dbUrl]) return sfUuidCache[dbUrl];
  await Editor.Message.request('asset-db', 'refresh-asset', dbUrl);
  const info = await Editor.Message.request('asset-db', 'query-asset-info', dbUrl);
  const sub = info?.subAssets?.f9941?.uuid;
  if (!sub) throw new Error('no spriteFrame subAsset: ' + dbUrl);
  sfUuidCache[dbUrl] = sub;
  return sub;
}

async function resolveAssetUuid(dbUrl) {
  if (assetUuidCache[dbUrl]) return assetUuidCache[dbUrl];
  try {
    await Editor.Message.request('asset-db', 'refresh-asset', dbUrl);
  } catch (_) {}
  const info = await Editor.Message.request('asset-db', 'query-asset-info', dbUrl);
  if (!info?.uuid) throw new Error('asset uuid 缺失: ' + dbUrl);
  assetUuidCache[dbUrl] = info.uuid;
  return info.uuid;
}

async function queryHasComponent(nodeUuid, compPath) {
  try {
    const dump = await Editor.Message.request('scene', 'query-property', {
      uuid: nodeUuid,
      path: compPath,
    });
    return dump != null;
  } catch (_) {
    return false;
  }
}

async function ensureComponent(nodeUuid, component) {
  if (await queryHasComponent(nodeUuid, component)) return;
  try {
    await Editor.Message.request('scene', 'create-component', {
      uuid: nodeUuid,
      component,
    });
  } catch (_) {}
}

async function setVec3(uuid, path, v) {
  await Editor.Message.request('scene', 'set-property', {
    uuid,
    path,
    dump: { type: 'cc.Vec3', value: { x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 } },
  });
}

async function setSize(uuid, path, w, h) {
  await Editor.Message.request('scene', 'set-property', {
    uuid,
    path,
    dump: { type: 'cc.Size', value: { width: w, height: h } },
  });
}

async function setVec2(uuid, path, x, y) {
  await Editor.Message.request('scene', 'set-property', {
    uuid,
    path,
    dump: { type: 'cc.Vec2', value: { x, y } },
  });
}

async function applyTransform(nodeUuid, ch) {
  if (!ch.transform) return;
  const p = ch.transform.position || {};
  const s = ch.transform.scale || { x: 1, y: 1, z: 1 };
  const e = ch.transform.euler || {};
  try {
    await setVec3(nodeUuid, 'position', p);
    await setVec3(nodeUuid, 'scale', s);
    await setVec3(nodeUuid, 'eulerAngles', e);
  } catch (_) {}
}

function parseUiFromNode(ch) {
  const ut = ch.uiTransform?.contentSize;
  if (ut && Number.isFinite(ut.width) && Number.isFinite(ut.height)) return ch.uiTransform;
  const uiComp = (ch.components || []).find((c) => /UITransform/.test(c.typeName || ''));
  if (uiComp?.rows) {
    const sizeRow = uiComp.rows.find((r) =>
      r.label === '内容尺寸' || r.label === 'size' || r.label === 'contentSize'
    );
    const anchorRow = uiComp.rows.find((r) =>
      r.label === '锚点' || r.label === 'anchor' || r.label === 'anchorPoint'
    );
    const m = String(sizeRow?.value ?? '').match(/(\\d+(?:\\.\\d+)?)\\s*[×x]\\s*(\\d+(?:\\.\\d+)?)/);
    if (m) {
      let ax = 0.5;
      let ay = 0.5;
      if (anchorRow?.value) {
        const p = String(anchorRow.value).split(',').map((s) => parseFloat(s.trim()));
        if (p.length >= 2) {
          ax = p[0];
          ay = p[1];
        }
      }
      return { contentSize: { width: +m[1], height: +m[2] }, anchorPoint: { x: ax, y: ay } };
    }
  }
  const sp = (ch.components || []).find((c) => c.flags?.isSprite);
  const sizeModeRow = sp?.rows?.find((r) =>
    r.label === '尺寸模式' || r.label === 'sizeMode'
  );
  const sizeMode = parseInt(String(sizeModeRow?.value ?? ''), 10);
  if (sp?.rows && sizeMode !== 2) {
    const texRow = sp.rows.find((r) =>
      r.label === '纹理' || r.label === '贴图' || r.label === 'texture' || r.label === 'spriteFrame'
    );
    const m = String(texRow?.value ?? '').match(/(\\d+(?:\\.\\d+)?)\\s*[×x]\\s*(\\d+(?:\\.\\d+)?)/);
    if (m) {
      return { contentSize: { width: +m[1], height: +m[2] }, anchorPoint: { x: 0.5, y: 0.5 } };
    }
  }
  const tex = textureManifest[ch.id];
  if (tex && Number.isFinite(tex.width) && Number.isFinite(tex.height) && sizeMode !== 2) {
    return { contentSize: { width: tex.width, height: tex.height }, anchorPoint: { x: 0.5, y: 0.5 } };
  }
  return null;
}

function parseSpriteSizeMode(ch) {
  if (ch.spriteFrame && Number.isFinite(ch.spriteFrame.sizeMode)) {
    return ch.spriteFrame.sizeMode;
  }
  const sp = (ch.components || []).find((c) => c.flags?.isSprite);
  if (!sp?.rows) return null;
  const row = sp.rows.find((r) => r.label === '尺寸模式' || r.label === 'sizeMode');
  const v = parseInt(String(row?.value ?? ''), 10);
  return Number.isFinite(v) ? v : null;
}

function findRow(rows, labels) {
  if (!rows?.length) return null;
  const set = new Set(labels.map((l) => String(l).toLowerCase()));
  return rows.find((r) => set.has(String(r.label ?? '').toLowerCase())) || null;
}

function parseLabelFromNode(ch) {
  const lab = (ch.components || []).find(
    (c) => /Label/.test(c.typeName || '') && !/RichText/.test(c.typeName || '')
  );
  if (!lab?.rows?.length) return null;
  const textRow = findRow(lab.rows, ['文本', 'string']);
  const fontRow = findRow(lab.rows, ['字号', 'fontSize']);
  const lineRow = findRow(lab.rows, ['行高', 'lineHeight']);
  const colorRow = findRow(lab.rows, ['颜色', 'color']);
  const overflowRow = findRow(lab.rows, ['溢出', 'overflow']);
  let text = String(textRow?.value ?? '');
  if (text === '(空)') text = '';
  if (text.endsWith('…')) text = text.slice(0, -1);
  const fontSize = parseFloat(String(fontRow?.value ?? ''));
  const lineHeight = parseFloat(String(lineRow?.value ?? ''));
  const overflow = parseInt(String(overflowRow?.value ?? ''), 10);
  let color = null;
  if (colorRow?.value && colorRow.value !== '-') {
    const m = String(colorRow.value).match(
      /(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*(?:,\\s*(\\d+))?/
    );
    if (m) color = { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 255 };
  }
  return {
    string: text,
    fontSize: Number.isFinite(fontSize) ? fontSize : null,
    lineHeight: Number.isFinite(lineHeight) ? lineHeight : null,
    overflow: Number.isFinite(overflow) ? overflow : null,
    color,
  };
}

function parseWidgetFromNode(ch) {
  const w = (ch.components || []).find((c) => /Widget/.test(c.typeName || ''));
  if (!w?.rows?.length) return null;
  const edge = (labels) => {
    const row = findRow(w.rows, labels);
    if (!row || row.value === '-' || row.value == null) return { enabled: false, value: 0 };
    const v = parseFloat(String(row.value));
    return { enabled: true, value: Number.isFinite(v) ? v : 0 };
  };
  return {
    left: edge(['左', 'left']),
    right: edge(['右', 'right']),
    top: edge(['上', 'top']),
    bottom: edge(['下', 'bottom']),
    alignHCenter: findRow(w.rows, ['水平居中'])?.value === '是',
    alignVCenter: findRow(w.rows, ['垂直居中'])?.value === '是',
  };
}

function parseSpineCompsFromNode(ch) {
  const list = [];
  let localIdx = 0;
  for (const c of ch.components || []) {
    const isSp =
      c.flags?.isSpine ||
      (/Spine|Skeleton/.test(c.typeName || '') &&
        !/Sprite/.test(c.typeName || ''));
    if (!isSp) continue;
    const spineIndex =
      typeof c.flags?.spineIndex === 'number' && c.flags.spineIndex >= 0
        ? c.flags.spineIndex
        : localIdx;
    const animRow = findRow(c.rows || [], [
      '动画',
      'animation',
      'defaultAnimation',
    ]);
    list.push({
      spineIndex,
      animation:
        animRow?.value && animRow.value !== '-' ? String(animRow.value) : '',
    });
    localIdx += 1;
  }
  return list;
}

function parseSpineFromNode(ch) {
  return parseSpineCompsFromNode(ch)[0] || null;
}

function lookupManifestEntry(manifest, nodeId, index = 0) {
  return (
    manifest[`${nodeId}#${index}`] ??
    (index === 0 ? manifest[nodeId] : null) ??
    null
  );
}

async function ensureComponentCount(nodeUuid, component, count) {
  if (count <= 0) return;
  await ensureComponent(nodeUuid, component);
  for (let i = 1; i < count; i += 1) {
    try {
      await Editor.Message.request('scene', 'create-component', {
        uuid: nodeUuid,
        component,
      });
    } catch (_) {}
  }
}

async function applyLabel(nodeUuid, ch) {
  const lab = parseLabelFromNode(ch);
  if (!lab) return false;
  await ensureComponent(nodeUuid, 'cc.Label');
  try {
    await Editor.Message.request('scene', 'set-property', {
      uuid: nodeUuid,
      path: 'cc.Label.string',
      dump: { value: lab.string },
    });
  } catch (_) {}
  if (lab.fontSize != null) {
    try {
      await Editor.Message.request('scene', 'set-property', {
        uuid: nodeUuid,
        path: 'cc.Label.fontSize',
        dump: { value: lab.fontSize },
      });
    } catch (_) {}
  }
  if (lab.lineHeight != null) {
    try {
      await Editor.Message.request('scene', 'set-property', {
        uuid: nodeUuid,
        path: 'cc.Label.lineHeight',
        dump: { value: lab.lineHeight },
      });
    } catch (_) {}
  }
  if (lab.overflow != null) {
    try {
      await Editor.Message.request('scene', 'set-property', {
        uuid: nodeUuid,
        path: 'cc.Label.overflow',
        dump: { value: lab.overflow },
      });
    } catch (_) {}
  }
  if (lab.color) {
    try {
      await Editor.Message.request('scene', 'set-property', {
        uuid: nodeUuid,
        path: 'cc.Label.color',
        dump: {
          type: 'cc.Color',
          value: lab.color,
        },
      });
    } catch (_) {}
  }
  const fontEntry = lookupManifestEntry(bmfontManifest, ch.id, 0);
  if (fontEntry?.dbUrl) {
    try {
      const fontUuid = await resolveAssetUuid(fontEntry.dbUrl);
      await Editor.Message.request('scene', 'set-property', {
        uuid: nodeUuid,
        path: 'cc.Label.font',
        dump: { type: 'cc.BitmapFont', value: { uuid: fontUuid } },
      });
      labelFontBindings.push({
        nodeUuid,
        fontUuid,
        bmfontIndex: 0,
        path: ch.path || ch.name,
      });
    } catch (_) {}
  }
  // 同节点额外 BMFont Label（index>0）仅记绑定，交磁盘补丁
  for (const c of ch.components || []) {
    if (!c.flags?.isBmfont) continue;
    const idx = c.flags.bmfontIndex ?? 0;
    if (idx === 0) continue;
    const extra = lookupManifestEntry(bmfontManifest, ch.id, idx);
    if (!extra?.dbUrl) continue;
    try {
      const fontUuid = await resolveAssetUuid(extra.dbUrl);
      await ensureComponentCount(nodeUuid, 'cc.Label', idx + 1);
      labelFontBindings.push({
        nodeUuid,
        fontUuid,
        bmfontIndex: idx,
        path: ch.path || ch.name,
      });
    } catch (_) {}
  }
  return true;
}

async function applyWidget(nodeUuid, ch) {
  const w = parseWidgetFromNode(ch);
  if (!w) return false;
  await ensureComponent(nodeUuid, 'cc.Widget');
  const setBool = async (path, v) => {
    try {
      await Editor.Message.request('scene', 'set-property', {
        uuid: nodeUuid,
        path,
        dump: { value: !!v },
      });
    } catch (_) {}
  };
  const setNum = async (path, v) => {
    try {
      await Editor.Message.request('scene', 'set-property', {
        uuid: nodeUuid,
        path,
        dump: { value: v },
      });
    } catch (_) {}
  };
  await setBool('cc.Widget.isAlignLeft', w.left.enabled);
  await setBool('cc.Widget.isAlignRight', w.right.enabled);
  await setBool('cc.Widget.isAlignTop', w.top.enabled);
  await setBool('cc.Widget.isAlignBottom', w.bottom.enabled);
  await setBool('cc.Widget.isAlignHorizontalCenter', !!w.alignHCenter);
  await setBool('cc.Widget.isAlignVerticalCenter', !!w.alignVCenter);
  if (w.left.enabled) await setNum('cc.Widget.left', w.left.value);
  if (w.right.enabled) await setNum('cc.Widget.right', w.right.value);
  if (w.top.enabled) await setNum('cc.Widget.top', w.top.value);
  if (w.bottom.enabled) await setNum('cc.Widget.bottom', w.bottom.value);
  return true;
}

async function applySpinePlaceholder(nodeUuid, ch) {
  const comps = parseSpineCompsFromNode(ch);
  const hasManifest0 = !!lookupManifestEntry(spineManifest, ch.id, 0);
  if (!comps.length && !hasManifest0) return false;

  const work = comps.length
    ? comps
    : [{ spineIndex: 0, animation: '' }];
  const maxNeeded = Math.max(...work.map((c) => c.spineIndex)) + 1;
  await ensureComponentCount(nodeUuid, 'sp.Skeleton', maxNeeded);

  for (const item of work) {
    const entry = lookupManifestEntry(spineManifest, ch.id, item.spineIndex);
    if (entry?.dbUrl) {
      try {
        const skelUuid = await resolveAssetUuid(entry.dbUrl);
        if (item.spineIndex === 0) {
          try {
            await Editor.Message.request('scene', 'set-property', {
              uuid: nodeUuid,
              path: 'sp.Skeleton.skeletonData',
              dump: { type: 'sp.SkeletonData', value: { uuid: skelUuid } },
            });
          } catch (_) {}
        }
        spineBindings.push({
          nodeUuid,
          skelUuid,
          spineIndex: item.spineIndex,
          path: ch.path || ch.name,
        });
      } catch (_) {}
    }
    if (item.animation && item.spineIndex === 0) {
      try {
        await Editor.Message.request('scene', 'set-property', {
          uuid: nodeUuid,
          path: 'sp.Skeleton.defaultAnimation',
          dump: { value: item.animation },
        });
      } catch (_) {}
    }
  }
  return true;
}

function recordUiBinding(out, nodeUuid, ui) {
  const w = ui?.contentSize?.width;
  const h = ui?.contentSize?.height;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  out.push({ nodeUuid, width: w, height: h });
}

/** 仅 set-property 改尺寸；Canvas 子节点 create-node 时已自带 UITransform，勿重复 add */
async function ensureLayoutUi(nodeUuid, ch) {
  const ui = parseUiFromNode(ch);
  if (!ui) return;
  await applyUiTransform(nodeUuid, ui);
}

async function applyUiTransform(nodeUuid, ui) {
  if (!ui?.contentSize) return;
  try {
    await setSize(
      nodeUuid,
      'cc.UITransform.contentSize',
      ui.contentSize.width,
      ui.contentSize.height
    );
    if (ui.anchorPoint) {
      await setVec2(
        nodeUuid,
        'cc.UITransform.anchorPoint',
        ui.anchorPoint.x,
        ui.anchorPoint.y
      );
    }
  } catch (_) {}
}

async function applyCanvasDesign(nodeUuid, ch) {
  try {
    await Editor.Message.request('scene', 'create-component', {
      uuid: nodeUuid,
      component: 'cc.Canvas',
    });
  } catch (_) {}
  const ui =
    parseUiFromNode(ch) || {
      contentSize: { width: design.width, height: design.height },
      anchorPoint: { x: 0.5, y: 0.5 },
    };
  await applyUiTransform(nodeUuid, ui);
}

async function applySprite(nodeUuid, nodeId, ch, nodePath) {
  const tex = textureManifest[nodeId];
  if (!tex?.dbUrl) return null;
  const ui = parseUiFromNode(ch);
  await ensureComponent(nodeUuid, 'cc.Sprite');
  const sfUuid = await resolveSpriteFrame(tex.dbUrl);
  await Editor.Message.request('scene', 'set-property', {
    uuid: nodeUuid,
    path: 'cc.Sprite.spriteFrame',
    dump: { type: 'cc.SpriteFrame', value: { uuid: sfUuid } },
  });
  const sizeMode = parseSpriteSizeMode(ch);
  if (sizeMode !== null) {
    try {
      await Editor.Message.request('scene', 'set-property', {
        uuid: nodeUuid,
        path: 'cc.Sprite.sizeMode',
        dump: { value: sizeMode },
      });
    } catch (_) {}
  }
  if (ui) await applyUiTransform(nodeUuid, ui);
  return {
    nodeId,
    nodeUuid,
    sfUuid,
    path: nodePath,
    width: ui?.contentSize?.width ?? tex.width,
    height: ui?.contentSize?.height ?? tex.height,
    sizeMode,
  };
}

const created = [];
const spritesBound = [];
const spriteBindings = [];
const uiSizeBindings = [];
const labelsApplied = [];
const widgetsApplied = [];
const spinesApplied = [];
const spineBindings = [];
const labelFontBindings = [];
let count = 0;

async function walk(src, parentUuid, depth) {
  if (count >= maxNodes) return;
  for (const ch of src.children || []) {
    if (count >= maxNodes) break;

    const nodeUuid = await Editor.Message.request('scene', 'create-node', {
      parent: parentUuid,
      name: ch.name,
    });
    count += 1;
    created.push(ch.path || ch.name);

    await applyTransform(nodeUuid, ch);

    if (ch.active === false) {
      try {
        await Editor.Message.request('scene', 'set-property', {
          uuid: nodeUuid,
          path: 'active',
          dump: { value: false },
        });
      } catch (_) {}
    }

    const hasCanvasComp = (ch.components || []).some((c) =>
      /cc\.Canvas|^Canvas$/i.test(c.typeName || c.shortName || '')
    );
    const isCanvas =
      depth === 0 && (ch.name === 'Canvas' || ch.name === 'GameLayer' || hasCanvasComp);
    const isCamera =
      /^(UI)?Camera$/i.test(ch.name || '') ||
      (ch.components || []).some((c) => /cc\.Camera/.test(c.typeName || ''));
    const hasUi = !!ch.uiTransform || (ch.components || []).some((c) => /UITransform|Widget|Canvas/.test(c.typeName || ''));
    const hasSprite = (ch.components || []).some((c) => c.flags?.isSprite);
    const uiParsed = parseUiFromNode(ch);

    if (isCamera) {
      await ensureComponent(nodeUuid, 'cc.Camera');
      try {
        await Editor.Message.request('scene', 'set-property', {
          uuid: nodeUuid,
          path: 'cc.Camera.projection',
          dump: { value: 0 },
        });
        await Editor.Message.request('scene', 'set-property', {
          uuid: nodeUuid,
          path: 'cc.Camera.orthoHeight',
          dump: { value: design.height / 2 },
        });
        await Editor.Message.request('scene', 'set-property', {
          uuid: nodeUuid,
          path: 'cc.Camera.priority',
          dump: { value: 0 },
        });
      } catch (_) {}
    } else if (isCanvas) {
      await applyCanvasDesign(nodeUuid, ch);
      recordUiBinding(uiSizeBindings, nodeUuid, parseUiFromNode(ch) || {
        contentSize: { width: design.width, height: design.height },
      });
    } else if (hasSprite && textureManifest[ch.id]) {
      const bound = await applySprite(nodeUuid, ch.id, ch, ch.path || ch.name);
      if (bound) {
        spritesBound.push(ch.path || ch.name);
        spriteBindings.push(bound);
        recordUiBinding(uiSizeBindings, nodeUuid, {
          contentSize: { width: bound.width, height: bound.height },
        });
      }
    } else if (hasSprite) {
      await ensureComponent(nodeUuid, 'cc.Sprite');
      if (uiParsed) {
        await applyUiTransform(nodeUuid, uiParsed);
        recordUiBinding(uiSizeBindings, nodeUuid, uiParsed);
      }
    } else if (hasUi || uiParsed) {
      await ensureLayoutUi(nodeUuid, ch);
      recordUiBinding(uiSizeBindings, nodeUuid, uiParsed);
    }

    // Label / Widget / Spine 占位（可与 Sprite 同节点）
    if (await applyLabel(nodeUuid, ch)) labelsApplied.push(ch.path || ch.name);
    if (await applyWidget(nodeUuid, ch)) widgetsApplied.push(ch.path || ch.name);
    if (await applySpinePlaceholder(nodeUuid, ch)) spinesApplied.push(ch.path || ch.name);

    await walk(ch, nodeUuid, depth + 1);
  }
}

await walk(rootData, sceneUuid, 0);

try {
  await Editor.Message.request('scene', 'save-scene');
} catch (_) {}

const abs = path.join(Editor.Project.path, sceneRel);
const diskSize = fs.existsSync(abs) ? fs.statSync(abs).size : 0;

return {
  ok: true,
  sceneUuid,
  design,
  createdCount: created.length,
  spritesBoundCount: spritesBound.length,
  labelsAppliedCount: labelsApplied.length,
  widgetsAppliedCount: widgetsApplied.length,
  spinesAppliedCount: spinesApplied.length,
  spineBindings,
  labelFontBindings,
  spriteBindings,
  uiSizeBindings,
  createdSample: created.slice(0, 15),
  spritesBoundSample: spritesBound.slice(0, 15),
  labelsSample: labelsApplied.slice(0, 10),
  widgetsSample: widgetsApplied.slice(0, 10),
  spinesSample: spinesApplied.slice(0, 10),
  diskSize,
};
`;
};

const parseSpriteSizeModeFromNode = parseSpriteSizeMode;

const enrichBindingsMeta = (bindings, snapById) => {
  for (const b of bindings) {
    const ch = snapById[b.nodeId];
    if (!ch) continue;
    const sm =
      ch.spriteFrame?.sizeMode != null && Number.isFinite(ch.spriteFrame.sizeMode)
        ? ch.spriteFrame.sizeMode
        : parseSpriteSizeModeFromNode(ch);
    if (sm !== null) b.sizeMode = sm;
  }
  return bindings;
};

const collectMaskTargets = (snapshotRoot, pathMap) => {
  const targets = [];
  const walk = (n) => {
    const maskComp = (n.components || []).find((c) => /Mask/.test(c.typeName || ''));
    if (maskComp) {
      const typeRow = maskComp.rows?.find(
        (r) => r.label === '类型' || r.label === 'type' || r.label === '_type'
      );
      const maskType = parseInt(String(typeRow?.value ?? '0'), 10);
      const nodeUuid = lookupPathMap(pathMap, n.path);
      if (nodeUuid) {
        targets.push({
          nodeUuid,
          maskType: Number.isFinite(maskType) ? maskType : 0,
        });
      }
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(snapshotRoot);
  return targets;
};

const refreshSnapshotFromPage = async (args, outPath) => {
  const snap = await inspectorCall(
    args.wsPort,
    'exportSceneSnapshot',
    [{ maxNodes: args.maxNodes, includeComponents: true }],
    { pageUrlMatch: args.pageUrlMatch }
  );
  if (!snap?.root) throw new Error('exportSceneSnapshot 返回空');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snap, null, 2), 'utf8');
  return snap;
};

const main = async () => {
  const args = parseArgs();
  if (!args.snapshotPath) {
    console.error(
      '用法: node scene-to-creator.mjs <snapshot.json> [--clear] [--with-textures] [--project PATH] [--scene assets/scene/x.scene]'
    );
    process.exit(1);
  }

  const bridgeInfo = resolveCreatorBridge(args.project, args.bridge);
  args.bridge = bridgeInfo.url;
  args.assetKey = deriveAssetKey(args.sceneRel, args.assetKey);
  applyShareDirForDomain(args.domain, args.wsPort);
  console.error(
    `[scene-to-creator] Creator 桥接 ${args.bridge} 工程 ${bridgeInfo.projectPath ?? args.project} assetKey=${args.assetKey}`
  );

  await connectBridgeClientOnly(args.wsPort);
  console.error(`[scene-to-creator] Inspector WS 客户端 ws://127.0.0.1:${args.wsPort}`);

  if (
    args.refreshSnapshot ||
    (args.withTextures && !args.skipTextures) ||
    args.withSpineFonts
  ) {
    console.error(
      `[scene-to-creator] 等待试玩页扩展连接桥接（请在 ${args.pageUrlMatch || '试玩'} 页 F5 刷新）…`
    );
    const st = await waitForExtension(120_000, args.wsPort);
    console.error(
      `[scene-to-creator] 扩展已连接 domain=${st.domain ?? '(待上报)'} tabs=${st.tabs?.length ?? 0}`
    );
  }

  let snapAbs = path.resolve(args.snapshotPath);
  let snapshot;
  if (args.refreshSnapshot) {
    console.error('[scene-to-creator] 从试玩页重新导出快照…');
    snapshot = await refreshSnapshotFromPage(args, snapAbs);
  } else {
    snapshot = JSON.parse(fs.readFileSync(snapAbs, 'utf8'));
  }

  const design = extractDesignResolution(snapshot);
  console.error(
    `[scene-to-creator] 设计分辨率 ${design.width}x${design.height}` +
      ` engineFamily=${snapshot.engineFamily ?? '?'} source=${design.source ?? '?'}` +
      ` page=${snapshot.pageUrl?.slice(0, 80)}…`
  );

  let textureResult = { manifest: {}, stats: { total: 0, ok: 0, fail: 0, uniqueFiles: 0 } };
  const manifestPath = args.manifestPath
    ? path.resolve(args.manifestPath)
    : path.resolve(path.dirname(snapAbs), `${args.assetKey}-texture-manifest.json`);

  if (args.withTextures && !args.skipTextures) {
    console.error('[scene-to-creator] 导出 Sprite 纹理到工程目录（文件通道）…');
    const exportArgs = {
      ...args,
      manifestPath,
      resumeTextures: args.resumeTextures || fs.existsSync(manifestPath),
    };
    textureResult = await exportSpriteTextures(snapshot, exportArgs);
    saveManifest(manifestPath, textureResult.manifest, textureResult.stats);
    console.error('[scene-to-creator] 纹理统计', textureResult.stats);
    if (args.texturesOnly) {
      console.log(JSON.stringify({ ok: true, texturesOnly: true, ...textureResult.stats }, null, 2));
      return;
    }
  } else if (args.withTextures && args.skipTextures) {
    const loaded = loadManifest(manifestPath);
    if (!loaded) throw new Error(`manifest 不存在: ${manifestPath}`);
    textureResult = loaded;
    console.error('[scene-to-creator] 复用 manifest', textureResult.stats);
  }

  let spineBm = {
    spineManifest: {},
    bmfontManifest: {},
    stats: { spineOk: 0, spineFail: 0, bmOk: 0, bmFail: 0, spineUnique: 0, bmUnique: 0 },
  };
  if (args.withSpineFonts) {
    console.error('[scene-to-creator] 导出 Spine/BMFont 到工程目录…');
    spineBm = await exportSpineBmfontAssets(snapshot, args, inspectorCall);
    const spineManPath = path.resolve(
      path.dirname(snapAbs),
      `${args.assetKey}-spine-manifest.json`
    );
    const bmManPath = path.resolve(
      path.dirname(snapAbs),
      `${args.assetKey}-bmfont-manifest.json`
    );
    saveManifest(spineManPath, spineBm.spineManifest, spineBm.stats);
    saveManifest(bmManPath, spineBm.bmfontManifest, spineBm.stats);
    console.error('[scene-to-creator] Spine/BMFont 统计', spineBm.stats);
  }

  const sceneUrl = args.sceneRel.startsWith('db://')
    ? args.sceneRel
    : `db://${args.sceneRel.replace(/\\/g, '/')}`;

  const disk = ensureSceneFile(args.project, args.templateRel, args.sceneRel, args.clear);
  if (disk.created || args.clear) {
    console.error('[scene-to-creator] 等待 Creator 导入 scene…');
    await execEval(
      args.bridge,
      `await Editor.Message.request('asset-db', 'refresh-asset', ${JSON.stringify(sceneUrl)}); await new Promise(r=>setTimeout(r,600)); return { ok: true };`
    );
  }
  const code = buildCreatorScript(
    snapshot,
    sceneUrl,
    design,
    textureResult.manifest,
    args.maxNodes,
    args.assetKey,
    spineBm.spineManifest,
    spineBm.bmfontManifest
  );

  console.error('[scene-to-creator] Creator 重建节点树…');
  await preflightSaveScene(args.bridge, sceneUrl);
  if (args.withTextures && Object.keys(textureResult.manifest).length) {
    const preMeta = await prepareTextureMetaForScene(
      args.project,
      textureResult.manifest,
      args.bridge,
      args.assetKey
    );
    console.error('[scene-to-creator] 纹理 .meta 预重置（绑定前）', preMeta);
  }
  const result = await execEval(args.bridge, code);

  let diskPatch = null;
  if (args.withTextures && Object.keys(textureResult.manifest).length) {
    console.error('[scene-to-creator] 磁盘补丁 SpriteFrame + UITransform + Mask…');
    const pathMap = buildPathToNodeUuidMap(disk.abs);
    const snapById = indexSnapshotNodes(snapshot.root);
    let bindings =
      result.spriteBindings?.length > 0
        ? result.spriteBindings
        : buildBindingsFromManifest(
            textureResult.manifest,
            pathMap,
            args.project
          );
    bindings = enrichBindingsMeta(bindings, snapById);
    const sfPatch = patchSpriteFramesOnDisk(disk.abs, bindings);
    const uiBindings = collectUiSizeBindings(snapshot.root, pathMap);
    const uiPatch = patchUiSizesOnDisk(disk.abs, uiBindings);
    const maskTargets = collectMaskTargets(snapshot.root, pathMap);
    const maskPatch = patchMasksOnDisk(disk.abs, maskTargets);
    const camPatch = patchCanvasCameraOnDisk(
      disk.abs,
      design.height,
      design.width
    );
    const metaReset = resetAllSpriteMetaFromManifest(args.project, textureResult.manifest);
    console.error('[scene-to-creator] 纹理 .meta 最终重置', metaReset);
    console.error('[scene-to-creator] 磁盘补丁完成。请关闭场景(不保存)后重新打开');
    diskPatch = { bindings: bindings.length, sfPatch, uiPatch, maskPatch, camPatch, metaReset };
  } else {
    const pathMap = buildPathToNodeUuidMap(disk.abs);
    const maskTargets = collectMaskTargets(snapshot.root, pathMap);
    if (maskTargets.length) {
      const maskPatch = patchMasksOnDisk(disk.abs, maskTargets);
      diskPatch = { maskPatch };
    }
  }

  if (args.withSpineFonts) {
    // Creator 导入后重读 .meta uuid
    for (const e of Object.values(spineBm.spineManifest)) {
      if (e.primaryAbs) e.skelUuid = e.skelUuid || (() => {
        try {
          const meta = JSON.parse(fs.readFileSync(`${e.primaryAbs}.meta`, 'utf8'));
          return meta.uuid ?? null;
        } catch {
          return null;
        }
      })();
    }
    for (const e of Object.values(spineBm.bmfontManifest)) {
      if (e.primaryAbs) e.fontUuid = e.fontUuid || (() => {
        try {
          const meta = JSON.parse(fs.readFileSync(`${e.primaryAbs}.meta`, 'utf8'));
          return meta.uuid ?? null;
        } catch {
          return null;
        }
      })();
    }
    const pathMapOnce = buildPathToNodeUuidMap(disk.abs);
    const uniqSpine = new Map();
    for (const e of Object.values(spineBm.spineManifest)) {
      const idx = e.spineIndex ?? e.index ?? 0;
      const k = `${e.nodePath || e.nodeId}#${idx}`;
      if (!uniqSpine.has(k)) uniqSpine.set(k, e);
    }
    const uniqFont = new Map();
    for (const e of Object.values(spineBm.bmfontManifest)) {
      const idx = e.bmfontIndex ?? e.index ?? 0;
      const k = `${e.nodePath || e.nodeId}#${idx}`;
      if (!uniqFont.has(k)) uniqFont.set(k, e);
    }
    const spineBind =
      result.spineBindings?.length > 0
        ? result.spineBindings
        : [...uniqSpine.values()]
            .map((e) => {
              const nodeUuid = lookupPathMap(pathMapOnce, e.nodePath);
              if (!nodeUuid || !e.skelUuid) return null;
              return {
                nodeUuid,
                skelUuid: e.skelUuid,
                spineIndex: e.spineIndex ?? e.index ?? 0,
              };
            })
            .filter(Boolean);
    const fontBind =
      result.labelFontBindings?.length > 0
        ? result.labelFontBindings
        : [...uniqFont.values()]
            .map((e) => {
              const nodeUuid = lookupPathMap(pathMapOnce, e.nodePath);
              if (!nodeUuid || !e.fontUuid) return null;
              return {
                nodeUuid,
                fontUuid: e.fontUuid,
                bmfontIndex: e.bmfontIndex ?? e.index ?? 0,
              };
            })
            .filter(Boolean);
    const skPatch = patchSkeletonDataOnDisk(disk.abs, spineBind);
    const fontPatch = patchBitmapFontOnDisk(disk.abs, fontBind);
    diskPatch = { ...(diskPatch || {}), skPatch, fontPatch };
    console.error('[scene-to-creator] Spine/BMFont 磁盘补丁', { skPatch, fontPatch });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        snapshot: snapAbs,
        sceneUrl,
        sceneFile: disk.abs,
        sceneReset: args.clear || disk.created,
        design,
        textures: textureResult.stats,
        spineBmfont: spineBm.stats,
        diskPatch,
        ...result,
      },
      null,
      2
    )
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
