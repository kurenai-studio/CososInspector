/**
 * 对比 harExplore 识别资源 vs Inspector runtime-dump / cc-reverse 还原资源（PowerOfThor2）
 *
 * 用法:
 *   node compare-harexplore-inspector.mjs
 *   node compare-harexplore-inspector.mjs --har-catalog <catalog.json> --dump <dumpRoot>
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {
    harCatalog:
      'D:/workspace/harExplore/dist/texture-viewer/catalog.json',
    dumpRoot:
      'D:/UGit/CososInspectorNew/tmp/runtime-dump/gameweb3_rsg-games_com',
    tabId: 'power-of-thor2',
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--har-catalog') args.harCatalog = argv[++i];
    else if (argv[i] === '--dump') args.dumpRoot = argv[++i];
    else if (argv[i] === '--tab') args.tabId = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHORT_UUID_RE = /\/([0-9a-f]{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i;

function normUuid(s) {
  const m = String(s || '').match(UUID_RE);
  return m ? m[0].toLowerCase() : '';
}

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

function extractUuidFromPath(p) {
  const m = String(p).match(UUID_RE);
  return m ? m[0].toLowerCase() : '';
}

function loadHarExplore(catalogPath, tabId) {
  const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const tab = (cat.tabs || []).find((t) => t.id === tabId);
  if (!tab) throw new Error(`catalog 中无 tab: ${tabId}`);

  /** @type {Map<string, object>} */
  const byUuid = new Map();

  const add = (uuid, kind, meta) => {
    if (!uuid) return;
    const prev = byUuid.get(uuid) || { uuid, kinds: new Set(), items: [] };
    prev.kinds.add(kind);
    prev.items.push({ kind, ...meta });
    byUuid.set(uuid, prev);
  };

  for (const t of tab.textures || []) {
    const uuid = normUuid(t.fileName) || normUuid(t.path) || normUuid(t.url);
    add(uuid, 'texture', {
      name: t.spineName || t.category || t.fileName,
      bundle: t.bundle,
      path: t.path,
      resourceType: t.resourceType,
    });
  }
  for (const s of tab.spineAssets || []) {
    const uuid = normUuid(s.textureUuid) || normUuid(s.texturePage);
    add(uuid, 'spine-texture', {
      name: s.name,
      bundle: s.bundle,
    });
  }
  for (const a of tab.animationManifest || []) {
    const uuid = normUuid(a.textureFileName) || normUuid(a.textureUrl);
    add(uuid, 'spine-anim', {
      name: a.name || a.id,
      bundle: a.bundle,
      importUrl: a.importUrl,
    });
  }
  for (const a of tab.audioManifest || []) {
    const uuid = normUuid(a.uuid) || normUuid(a.audioUrl) || normUuid(a.url);
    add(uuid, 'audio', {
      name: a.name || a.id,
      path: a.audioUrl || a.url,
    });
  }
  for (const f of tab.fontManifest || []) {
    const uuid = normUuid(f.textureFileName) || normUuid(f.pngUrl);
    add(uuid, 'font', {
      name: f.name || f.id,
      path: f.pngUrl || f.fntUrl,
    });
  }

  // serialize kinds
  const list = [...byUuid.values()].map((v) => ({
    uuid: v.uuid,
    kinds: [...v.kinds],
    sample: v.items[0],
  }));

  return {
    tabId,
    label: tab.label,
    counts: {
      textures: (tab.textures || []).length,
      spineAssets: (tab.spineAssets || []).length,
      animations: (tab.animationManifest || []).length,
      audio: (tab.audioManifest || []).length,
      fonts: (tab.fontManifest || []).length,
      uniqueUuids: list.length,
    },
    byUuid,
    list,
  };
}

function loadInspectorDump(dumpRoot) {
  const remote = join(
    dumpRoot,
    'downloads/WebUI3/content/PowerOfThor2/remote',
  );
  const recovered = join(dumpRoot, 'cc-reverse-bundle-test/assets');
  const bundles = ['internal', 'main', 'resources', 'slotgame', 'freegame'];

  /** @type {Map<string, object>} */
  const byUuid = new Map();

  const add = (uuid, source, meta) => {
    if (!uuid) return;
    const prev = byUuid.get(uuid) || {
      uuid,
      sources: new Set(),
      bundles: new Set(),
      files: [],
    };
    prev.sources.add(source);
    if (meta.bundle) prev.bundles.add(meta.bundle);
    if (meta.file) prev.files.push(meta.file);
    byUuid.set(uuid, prev);
  };

  let configUuidCount = 0;
  let nativeFileCount = 0;
  let importFileCount = 0;
  let recoveredNativeish = 0;

  for (const b of bundles) {
    const base = join(remote, b);
    const cfgPath = join(base, 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      for (const u of cfg.uuids || []) {
        // uuids 可能是压缩形式；保留能解出的标准 UUID
        const uuid = normUuid(u);
        if (uuid) {
          configUuidCount += 1;
          add(uuid, 'config', { bundle: b });
        } else if (typeof u === 'string' && u.length >= 22) {
          // 尝试 cocos decompress
          try {
            let decompress = null;
            try {
              ({ decompressCocosUuid: decompress } = require(
                'D:/workspace/harExplore/packages/core/src/engines/cocos/cocos-uuid.mjs',
              ));
            } catch {
              /* optional */
            }
            if (decompress) {
              const full = normUuid(decompress(u));
              if (full) {
                configUuidCount += 1;
                add(full, 'config-compressed', { bundle: b, compressed: u });
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
    }

    for (const f of walkFiles(join(base, 'native'))) {
      nativeFileCount += 1;
      const uuid = extractUuidFromPath(f);
      add(uuid, 'download-native', {
        bundle: b,
        file: f.replace(/\\/g, '/'),
      });
    }
    for (const f of walkFiles(join(base, 'import'))) {
      importFileCount += 1;
      const uuid = extractUuidFromPath(f);
      add(uuid, 'download-import', {
        bundle: b,
        file: f.replace(/\\/g, '/'),
      });
    }
  }

  for (const f of walkFiles(recovered)) {
    const uuid = extractUuidFromPath(f);
    if (!uuid) continue;
    recoveredNativeish += 1;
    // 从路径猜 bundle
    const rel = f.replace(/\\/g, '/');
    const bm = rel.match(/\/assets\/(slotgame|resources|freegame|internal|main)\//);
    add(uuid, 'cc-reverse', {
      bundle: bm ? bm[1] : '',
      file: rel,
    });
  }

  const list = [...byUuid.values()].map((v) => ({
    uuid: v.uuid,
    sources: [...v.sources],
    bundles: [...v.bundles],
    fileCount: v.files.length,
  }));

  return {
    dumpRoot,
    counts: {
      configStandardUuids: configUuidCount,
      nativeFiles: nativeFileCount,
      importFiles: importFileCount,
      recoveredUuidFiles: recoveredNativeish,
      uniqueUuids: list.length,
    },
    byUuid,
    list,
  };
}

function compare(har, insp) {
  const onlyHar = [];
  const onlyInsp = [];
  const both = [];

  for (const [uuid, h] of har.byUuid) {
    if (insp.byUuid.has(uuid)) {
      both.push({
        uuid,
        harKinds: [...h.kinds],
        inspSources: [...insp.byUuid.get(uuid).sources],
        inspBundles: [...insp.byUuid.get(uuid).bundles],
        harSample: h.items[0],
      });
    } else {
      onlyHar.push({
        uuid,
        kinds: [...h.kinds],
        sample: h.items[0],
      });
    }
  }
  for (const [uuid, i] of insp.byUuid) {
    if (!har.byUuid.has(uuid)) {
      onlyInsp.push({
        uuid,
        sources: [...i.sources],
        bundles: [...i.bundles],
      });
    }
  }

  // harExplore 偏「可见媒体」；Inspector 含大量 SpriteFrame/Prefab 等
  // 再做一个：har 集合 vs Inspector download-native 子集
  const inspNative = new Set(
    [...insp.byUuid.entries()]
      .filter(([, v]) => v.sources.has('download-native'))
      .map(([u]) => u),
  );
  const harVsNative = {
    both: 0,
    onlyHar: 0,
    onlyNative: 0,
  };
  for (const u of har.byUuid.keys()) {
    if (inspNative.has(u)) harVsNative.both += 1;
    else harVsNative.onlyHar += 1;
  }
  for (const u of inspNative) {
    if (!har.byUuid.has(u)) harVsNative.onlyNative += 1;
  }

  return {
    overlap: {
      both: both.length,
      onlyHarExplore: onlyHar.length,
      onlyInspector: onlyInsp.length,
      harCoverageOfInspector:
        insp.byUuid.size === 0
          ? 0
          : Number(((both.length / insp.byUuid.size) * 100).toFixed(1)),
      inspectorCoverageOfHar:
        har.byUuid.size === 0
          ? 0
          : Number(((both.length / har.byUuid.size) * 100).toFixed(1)),
    },
    harVsDownloadNative: harVsNative,
    samples: {
      both: both.slice(0, 15),
      onlyHarExplore: onlyHar.slice(0, 20),
      onlyInspector: onlyInsp.slice(0, 20),
    },
  };
}

function toMarkdown(har, insp, cmp) {
  const lines = [];
  lines.push('# harExplore vs Inspector Bundle 资源对比（PowerOfThor2）');
  lines.push('');
  lines.push(`- harExplore tab: **${har.label}** (\`${har.tabId}\`)`);
  lines.push(`- Inspector dump: \`${insp.dumpRoot}\``);
  lines.push(`- 对齐键: **UUID**（路径/文件名中的标准 UUID）`);
  lines.push('');
  lines.push('## 规模');
  lines.push('');
  lines.push('| 来源 | 项 | 数量 |');
  lines.push('|---|---|---:|');
  lines.push(`| harExplore | textures | ${har.counts.textures} |`);
  lines.push(`| harExplore | spineAssets | ${har.counts.spineAssets} |`);
  lines.push(`| harExplore | animations | ${har.counts.animations} |`);
  lines.push(`| harExplore | audio | ${har.counts.audio} |`);
  lines.push(`| harExplore | fonts | ${har.counts.fonts} |`);
  lines.push(`| harExplore | **unique UUID** | **${har.counts.uniqueUuids}** |`);
  lines.push(`| Inspector | download native 文件 | ${insp.counts.nativeFiles} |`);
  lines.push(`| Inspector | download import 文件 | ${insp.counts.importFiles} |`);
  lines.push(`| Inspector | cc-reverse 含 UUID 文件 | ${insp.counts.recoveredUuidFiles} |`);
  lines.push(`| Inspector | **unique UUID** | **${insp.counts.uniqueUuids}** |`);
  lines.push('');
  lines.push('## 交集（全量 UUID）');
  lines.push('');
  lines.push(`| 集合 | 数量 |`);
  lines.push(`|---|---:|`);
  lines.push(`| 两边都有 | ${cmp.overlap.both} |`);
  lines.push(`| 仅 harExplore | ${cmp.overlap.onlyHarExplore} |`);
  lines.push(`| 仅 Inspector | ${cmp.overlap.onlyInspector} |`);
  lines.push(
    `| Inspector 覆盖 har | ${cmp.overlap.inspectorCoverageOfHar}% |`,
  );
  lines.push(
    `| har 覆盖 Inspector | ${cmp.overlap.harCoverageOfInspector}% |`,
  );
  lines.push('');
  lines.push('## 更合理的对比：harExplore vs download-native');
  lines.push('');
  lines.push(
    'harExplore 主要从 HAR 识别**可见媒体**（图/音/Spine/字体）；Inspector 还含 Prefab/SpriteFrame/Material 等。',
  );
  lines.push('');
  lines.push(`| 集合 | 数量 |`);
  lines.push(`|---|---:|`);
  lines.push(`| 两边都有 | ${cmp.harVsDownloadNative.both} |`);
  lines.push(`| 仅 harExplore | ${cmp.harVsDownloadNative.onlyHar} |`);
  lines.push(`| 仅 Inspector native | ${cmp.harVsDownloadNative.onlyNative} |`);
  lines.push('');
  lines.push('## 样例：仅 harExplore');
  lines.push('');
  for (const x of cmp.samples.onlyHarExplore.slice(0, 10)) {
    lines.push(
      `- \`${x.uuid}\` · ${x.kinds.join(',')} · ${x.sample?.name || ''}`,
    );
  }
  lines.push('');
  lines.push('## 样例：两边都有');
  lines.push('');
  for (const x of cmp.samples.both.slice(0, 10)) {
    lines.push(
      `- \`${x.uuid}\` · har:${x.harKinds.join(',')} · insp:${x.inspSources.join(',')}`,
    );
  }
  lines.push('');
  lines.push('## 结论提示');
  lines.push('');
  lines.push(
    '- 若「har vs native」两边都有 ≈ har unique UUID，说明 Inspector 下载覆盖了 HAR 识别到的媒体。',
  );
  lines.push(
    '- 「仅 Inspector」很大是正常的：config 路径里还有大量非 HAR 流量资源（SpriteFrame/Prefab 等）。',
  );
  lines.push(
    '- 「仅 harExplore」需检查：是否未进 native 下载、扩展名探测失败、或 UUID 压缩未解。',
  );
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const har = loadHarExplore(resolve(args.harCatalog), args.tabId);
  const insp = loadInspectorDump(resolve(args.dumpRoot));
  const cmp = compare(har, insp);

  const outDir =
    args.out ||
    join(resolve(args.dumpRoot), 'compare-harexplore');
  mkdirSync(outDir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    harExplore: { tabId: har.tabId, label: har.label, counts: har.counts },
    inspector: { dumpRoot: insp.dumpRoot, counts: insp.counts },
    overlap: cmp.overlap,
    harVsDownloadNative: cmp.harVsDownloadNative,
    samples: cmp.samples,
  };

  writeFileSync(
    join(outDir, 'compare-report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
  writeFileSync(
    join(outDir, 'compare-report.md'),
    toMarkdown(har, insp, cmp),
    'utf8',
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        harUnique: har.counts.uniqueUuids,
        inspUnique: insp.counts.uniqueUuids,
        both: cmp.overlap.both,
        onlyHar: cmp.overlap.onlyHarExplore,
        onlyInsp: cmp.overlap.onlyInspector,
        harVsNative: cmp.harVsDownloadNative,
        md: join(outDir, 'compare-report.md'),
      },
      null,
      2,
    ),
  );
}

main();
