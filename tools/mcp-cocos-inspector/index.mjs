#!/usr/bin/env node
/**
 * MCP ↔ Cocos Inspector 3
 *
 * 默认：本机 WebSocket 桥接（普通 Chrome + 扩展，无需 --remote-debugging-port）
 * 可选：COCOS_USE_CDP=1 时使用 Chrome 远程调试（9222）
 */

import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  connectBridgeClientOnly,
  startBridge,
  bridgeApiCall,
  callBridgeAtPort,
  bridgeCaptureVisibleTab,
  bridgeGetStatus,
  waitForExtension,
  isBridgeRunning,
  getDaemonMeta,
} from './bridge-server.mjs';
import { writeReplacementPackToDisk } from './export-pack-lib.mjs';
import { startShareHttp } from './share-http.mjs';
import {
  listBridgesWithHealth,
  resolveBridgeTarget,
} from './bridge-resolve.mjs';
import { bridgeRegistryPath } from './bridge-registry.mjs';
import {
  stageInputFile,
  shareFileUrl,
  writeShareOutput,
  resolveSharePath,
  getShareHttpPort,
  getShareDir,
} from './shared-fs.mjs';
import {
  captureTabScreenshot,
  ensureConnected,
  getConnectedPageUrl,
  invokeInPage,
} from './cdp.mjs';

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const useCdp = process.env.COCOS_USE_CDP === '1';

function connOpts(args) {
  return {
    domain: args?.domain,
    pageUrlMatch: args?.pageUrlMatch ?? process.env.COCOS_PAGE_URL_MATCH,
    wsPort: args?.wsPort != null ? Number(args.wsPort) : undefined,
    port: args?.cdpPort ? Number(args.cdpPort) : undefined,
  };
}

async function fetchBridgeStatus(target) {
  if (isBridgeRunning() && getDaemonMeta()?.wsPort === target.wsPort) {
    return bridgeGetStatus();
  }
  const httpPort = target.httpPort ?? target.wsPort + 1;
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/status`);
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return res.json();
}

async function waitExt(opts, maxMs = 60_000) {
  const target = await resolveBridgeTarget(connOpts(opts ?? {}));
  await waitForExtension(maxMs, target.wsPort);
  return target;
}

async function cdpApiCall(method, argList, opts) {
  const argsJson = JSON.stringify(argList ?? []);
  return invokeInPage(
    `const api = window.__cocosInspectorApi;
     if (!api) throw new Error('__cocosInspectorApi 未就绪');
     const fn = api[${JSON.stringify(method)}];
     if (typeof fn !== 'function') throw new Error('未知 API: ${method}');
     return await fn(...${argsJson});`,
    opts
  );
}

const BRIDGE_TIMEOUT_BY_METHOD = {
  downloadTexture: 300_000,
  downloadSpine: 300_000,
  downloadBmfont: 180_000,
  downloadDragonBones: 300_000,
  listSprites: 180_000,
  listSpines: 120_000,
  listBmfonts: 120_000,
  listDragonBones: 120_000,
  exportSceneSnapshot: 300_000,
};

async function apiCall(method, argList, opts) {
  if (useCdp) return cdpApiCall(method, argList, opts);
  const target = await resolveBridgeTarget(connOpts(opts ?? {}));
  const callOpts = {
    pageUrlMatch: opts?.pageUrlMatch ?? target.pageUrlMatch ?? '',
    timeoutMs: BRIDGE_TIMEOUT_BY_METHOD[method] ?? opts?.timeoutMs,
  };
  if (isBridgeRunning() && getDaemonMeta()?.wsPort === target.wsPort) {
    return bridgeApiCall(method, argList, callOpts);
  }
  return callBridgeAtPort(target.wsPort, method, argList, callOpts);
}

function writeBase64File(outPath, base64) {
  const dir = dirname(outPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, Buffer.from(base64, 'base64'));
}

const server = new Server(
  {
    name: 'cocos-inspector',
    version: '0.1.0',
  },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'cocos_inspector_list_bridges',
      description:
        '列出本机 Inspector 桥接实例（registry 主键=试玩 URL 域名）。多开时先调用此工具',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cocos_inspector_health',
      description: '指定域名的 Inspector 桥接健康检查',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: '如 play.godeebxp.com' },
          pageUrlMatch: { type: 'string' },
          wsPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_list_tabs',
      description:
        '桥接模式：扩展是否已连接 + 浏览器 http 标签；CDP 模式需 COCOS_USE_CDP=1',
      inputSchema: {
        type: 'object',
        properties: {
          cdpPort: { type: 'number', description: '仅 CDP 模式' },
        },
      },
    },
    {
      name: 'cocos_page_info',
      description: '当前试玩页：URL、引擎版本、场景名、是否暂停',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_pause_game',
      description:
        '暂停试玩页游戏（默认 cc.director.pause），便于停住后查看节点属性',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['director', 'game', 'both'],
            description: '默认 director；部分游戏自管 ticker 可试 both',
          },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_resume_game',
      description: '恢复试玩页游戏（director.resume / game.resume）',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_toggle_pause',
      description: '切换试玩页暂停/继续',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['director', 'game', 'both'],
          },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_list_sprites',
      description:
        '列出所有带贴图的 Sprite 节点（nodeId、名称、帧名、路径）。用于 Cursor 判断 UI 纹理',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_list_spines',
      description: '列出场景中 Spine 组件（同节点多组件拆成多条，含 spineIndex）',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_list_bmfonts',
      description: '列出 BMFont Label（同节点多组件拆成多条，含 bmfontIndex）',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_list_dragon_bones',
      description:
        '列出场景与缓存中的 DragonBones 资源（Egret 引擎：ArmatureDisplay 节点 + 工厂 _dragonBonesDataMap）',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_list_resources',
      description:
        '列出 RES 清单中的资源（含运行时已加载但未在 alias 的图源 URL）。Egret 专用',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '上限，默认 100' },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_download_resource',
      description:
        '下载原始资源文件字节（.dbbin/.json/.png/.jpg 等）。优先 RES.config 解析 + 页内 fetch；失败时从已解码 HTMLImageElement 整图导出',
      inputSchema: {
        type: 'object',
        properties: {
          nameOrUrl: { type: 'string', description: '资源别名（如 eff_bkbyH5_loading_ske_dbbin）或完整 URL' },
          nodeId: { type: 'string', description: '可选：fetch 失败时优先从此节点回退整图导出' },
          outPath: { type: 'string', description: '输出文件路径（可选）' },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
        required: ['nameOrUrl'],
      },
    },
    {
      name: 'cocos_download_spine',
      description:
        '从试玩页导出 Spine zip（骨架+atlas+纹理）。默认 share 通道；可 outPath 落盘',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          outPath: { type: 'string', description: '输出 .zip 路径（可选）' },
          spineIndex: { type: 'number' },
          delivery: { type: 'string', enum: ['share', 'inline'] },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'cocos_download_bmfont',
      description:
        '从试玩页导出 BMFont zip（.fnt+png）。默认 share 通道；可 outPath 落盘',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          outPath: { type: 'string', description: '输出 .zip 路径（可选）' },
          bmfontIndex: { type: 'number' },
          delivery: { type: 'string', enum: ['share', 'inline'] },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'cocos_download_dragon_bones',
      description:
        '导出 DragonBones 资源为 zip（_ske.json + _tex.json + 纹理 png + runtime_summary）。Egret 引擎专用，nodeId 可为场景节点 id 或 egret-db-cache-{name}',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'listDragonBones 返回的 id' },
          outPath: { type: 'string', description: '输出 .zip 路径（可选）' },
          delivery: { type: 'string', enum: ['share', 'inline'] },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'cocos_get_scene_tree',
      description:
        '轻量场景树（id/name/active/children），不含组件详情。需试玩页扩展已连桥接',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_export_scene_snapshot',
      description:
        '导出完整场景快照 JSON（节点树+Transform+组件摘要）。可写 outPath 落盘，供 Creator 重建',
      inputSchema: {
        type: 'object',
        properties: {
          outPath: { type: 'string', description: '保存 .json 路径（可选）' },
          maxNodes: { type: 'number', description: '最大节点数，默认 3000' },
          includeComponents: {
            type: 'boolean',
            description: '是否含组件详情，默认 true',
          },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_get_sprite',
      description: '获取单个 Sprite 元数据（frameRect、isRotated、尺寸等）',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'cocos_download_texture',
      description: '提取节点纹理 PNG 并保存到本地路径',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          outPath: { type: 'string', description: '输出 .png 路径' },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
          mode: {
            type: 'string',
            enum: ['originalCanvas', 'frame', 'scale'],
            description:
              '导出模式：originalCanvas（trim 默认）、frame（仅帧像素）、scale（拉伸遗留）',
          },
          delivery: {
            type: 'string',
            enum: ['share', 'inline'],
            description:
              'share（默认）：试玩页 PUT 到共享 out/，WS 只返 sharePath；inline：WS 返 base64',
          },
        },
        required: ['nodeId', 'outPath'],
      },
    },
    {
      name: 'cocos_replace_texture',
      description:
        '替换节点 Sprite。优先 imagePath（落盘共享目录，信道只传路径）；否则 imageBase64',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          imagePath: {
            type: 'string',
            description: '本地图片路径，写入 tmp/mcp-share/in/ 后经 HTTP 拉取',
          },
          imageBase64: { type: 'string' },
          mime: { type: 'string' },
          filename: { type: 'string' },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'cocos_texture_extract_logs',
      description:
        '读取试玩页纹理提取诊断日志（localStorage 环形缓冲，不经浏览器 console）',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回条数，默认 100' },
          since: {
            type: 'number',
            description: '仅返回该 Unix 毫秒时间戳之后的日志',
          },
          nodeUUID: { type: 'string', description: '按节点 UUID 过滤' },
          clear: {
            type: 'boolean',
            description: '为 true 时先清空再返回（默认 false）',
          },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_revert_texture',
      description: '还原节点为上传替换前的 SpriteFrame',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'cocos_list_replacements',
      description: '列出当前页已记录的替换对',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_export_replacement_pack',
      description:
        '从试玩页导出替换包 zip（与扩展面板一致）；可写 outZip 路径，或落盘 tmp 后由 repack-web 上传',
      inputSchema: {
        type: 'object',
        properties: {
          outDir: { type: 'string', description: '输出目录（解压写入，可选）' },
          outZip: { type: 'string', description: '直接保存 .zip 路径' },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
      },
    },
    {
      name: 'cocos_repack_super_html',
      description: '对本机试玩 HTML 执行 super-html 重打包（Node 脚本）',
      inputSchema: {
        type: 'object',
        properties: {
          html: { type: 'string', description: '原版试玩 .html 路径' },
          packDir: { type: 'string', description: '替换包目录' },
          out: { type: 'string', description: '输出 html 路径' },
          dryRun: { type: 'boolean' },
        },
        required: ['html', 'packDir'],
      },
    },
    {
      name: 'cocos_screenshot',
      description:
        '截屏：game=游戏 Canvas；node=单节点；tab=整页标签（含 UI，经 CDP）',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['game', 'node', 'tab'],
            description: '默认 game',
          },
          nodeId: { type: 'string', description: 'kind=node 时必填' },
          outPath: { type: 'string', description: '保存 png 路径' },
          maxSize: { type: 'number', description: 'node 模式最大边' },
          pageUrlMatch: { type: 'string' },
          domain: { type: 'string', description: '试玩页域名，如 play.godeebxp.com' },
          wsPort: { type: 'number' },
          cdpPort: { type: 'number' },
        },
        required: ['outPath'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const opts = connOpts(args ?? {});

  try {
    if (name === 'cocos_inspector_list_bridges') {
      const listed = await listBridgesWithHealth();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                registryPath: bridgeRegistryPath(),
                onlineCount: listed.onlineCount,
                instances: listed.instances,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === 'cocos_inspector_health') {
      const target = await resolveBridgeTarget(connOpts(args ?? {}));
      let status = null;
      try {
        status = await fetchBridgeStatus(target);
      } catch (e) {
        status = { error: e instanceof Error ? e.message : String(e) };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                resolvedBy: target.resolvedBy,
                domain: target.domain,
                wsPort: target.wsPort,
                httpPort: target.httpPort,
                pageUrlMatch: target.pageUrlMatch,
                online: target.online,
                extensionConnected: target.extensionConnected,
                status,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === 'cocos_list_tabs') {
      if (useCdp) {
        const CDP = (await import('chrome-remote-interface')).default;
        const port = Number(args?.cdpPort ?? process.env.COCOS_CDP_PORT ?? 9222);
        const targets = await CDP.List({ port });
        const pages = targets
          .filter((t) => t.type === 'page')
          .map((t) => ({ title: t.title, url: t.url, id: t.id }));
        return {
          content: [
            { type: 'text', text: JSON.stringify({ mode: 'cdp', port, pages }, null, 2) },
          ],
        };
      }
      const target = await resolveBridgeTarget(opts);
      const st = await fetchBridgeStatus(target).catch(() => ({}));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                mode: 'bridge',
                resolvedBy: target.resolvedBy,
                domain: target.domain,
                wsPort: target.wsPort,
                httpPort: target.httpPort,
                extensionConnected: st?.extensionConnected ?? false,
                tabs: st?.tabs ?? [],
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === 'cocos_page_info') {
      if (useCdp) await ensureConnected(opts);
      const info = await apiCall('getPageInfo', [], opts);
      let st = null;
      if (!useCdp) {
        const target = await resolveBridgeTarget(opts);
        st = await fetchBridgeStatus(target).catch(() => ({}));
      }
      const connectedPage = useCdp
        ? getConnectedPageUrl()
        : info?.pageUrl ?? st?.tabs?.find((t) => t.url)?.url;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                mode: useCdp ? 'cdp' : 'bridge',
                extensionConnected: st?.extensionConnected ?? false,
                connectedPage,
                ...info,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === 'cocos_pause_game') {
      const res = await apiCall(
        'pauseGame',
        [args.mode ?? 'director'],
        opts
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res?.ok,
      };
    }

    if (name === 'cocos_resume_game') {
      const res = await apiCall('resumeGame', [], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res?.ok,
      };
    }

    if (name === 'cocos_toggle_pause') {
      const res = await apiCall(
        'togglePause',
        args.mode ? [args.mode] : [],
        opts
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res?.ok,
      };
    }

    if (name === 'cocos_list_sprites') {
      const list = await apiCall('listSprites', [], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
      };
    }

    if (name === 'cocos_list_spines') {
      const list = await apiCall('listSpines', [], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
      };
    }

    if (name === 'cocos_list_bmfonts') {
      const list = await apiCall('listBmfonts', [], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
      };
    }

    if (name === 'cocos_list_dragon_bones') {
      const list = await apiCall('listDragonBones', [], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
      };
    }

    if (name === 'cocos_list_resources') {
      const limit = args.limit != null ? Number(args.limit) : 100;
      const list = await apiCall('listResources', [limit], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
      };
    }

    if (name === 'cocos_download_resource') {
      const dlOpts = args.nodeId ? { nodeId: args.nodeId } : undefined;
      const res = await apiCall('downloadResource', [args.nameOrUrl, dlOpts], opts);
      if (!res?.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          isError: true,
        };
      }
      const outPath = args.outPath ? resolve(args.outPath) : null;
      let shareRel = res.sharePath ?? null;
      if (res.delivery === 'share' && res.sharePath) {
        if (outPath) {
          mkdirSync(dirname(outPath), { recursive: true });
          copyFileSync(resolveSharePath(res.sharePath), outPath);
        }
      } else if (res.base64) {
        const filename = res.filename ?? args.nameOrUrl.replace(/[^\w.-]/g, '_');
        shareRel = writeShareOutput(filename, res.base64);
        if (outPath) writeBase64File(outPath, res.base64);
      } else {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ok: false, error: '响应无 sharePath/base64' }, null, 2) },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                delivery: res.delivery,
                shareDir: getShareDir(),
                sharePath: shareRel,
                shareUrl: res.shareUrl ?? (shareRel ? shareFileUrl(shareRel) : undefined),
                saved: outPath ?? undefined,
                filename: res.filename,
                bytes: res.detail?.bytes,
                mime: res.detail?.mime,
                sourceUrl: res.detail?.sourceUrl,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === 'cocos_get_scene_tree') {
      await waitExt(opts);
      const tree = await apiCall('getSceneTree', [], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }],
      };
    }

    if (name === 'cocos_export_scene_snapshot') {
      await waitExt(opts);
      const snapOpts = {
        maxNodes: args?.maxNodes != null ? Number(args.maxNodes) : undefined,
        includeComponents: args?.includeComponents !== false,
      };
      const snapshot = await apiCall('exportSceneSnapshot', [snapOpts], opts);
      if (!snapshot) {
        return {
          content: [{ type: 'text', text: '场景未就绪或 exportSceneSnapshot 返回空' }],
          isError: true,
        };
      }
      if (args?.outPath) {
        const outPath = resolve(args.outPath);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { saved: outPath, stats: snapshot.stats, sceneName: snapshot.sceneName },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
      };
    }

    if (name === 'cocos_get_sprite') {
      const res = await apiCall('getSpriteDetail', [args.nodeId], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
      };
    }

    if (name === 'cocos_download_texture') {
      const target = await resolveBridgeTarget(connOpts(opts ?? {}));
      const delivery = args.delivery ?? 'share';
      const dlOpts = {
        ...(args.mode ? { mode: args.mode } : {}),
        delivery,
        wsPort: target.wsPort,
      };
      const res = await apiCall('downloadTexture', [args.nodeId, dlOpts], opts);
      if (!res?.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          isError: true,
        };
      }
      const outPath = args.outPath ? resolve(args.outPath) : null;
      let shareRel = res.sharePath ?? null;

      if (res.delivery === 'share' && res.sharePath) {
        if (outPath) {
          mkdirSync(dirname(outPath), { recursive: true });
          copyFileSync(resolveSharePath(res.sharePath), outPath);
        }
      } else if (res.base64) {
        shareRel = writeShareOutput(res.filename ?? `${args.nodeId}.png`, res.base64);
        if (outPath) writeBase64File(outPath, res.base64);
      } else {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, error: '响应无 sharePath/base64' }, null, 2),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                delivery: res.delivery ?? delivery,
                shareDir: getShareDir(),
                sharePath: shareRel,
                shareUrl: res.shareUrl ?? (shareRel ? shareFileUrl(shareRel) : undefined),
                saved: outPath ?? undefined,
                width: res.width,
                height: res.height,
                filename: res.filename,
                extractMethod: res.detail?.extractMethod,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === 'cocos_download_spine' || name === 'cocos_download_bmfont' || name === 'cocos_download_dragon_bones') {
      const target = await resolveBridgeTarget(connOpts(opts ?? {}));
      const delivery = args.delivery ?? 'share';
      const method =
        name === 'cocos_download_spine' ? 'downloadSpine'
          : name === 'cocos_download_bmfont' ? 'downloadBmfont'
          : 'downloadDragonBones';
      const dlOpts = {
        delivery,
        wsPort: target.wsPort,
        ...(name === 'cocos_download_spine' && args.spineIndex != null
          ? { spineIndex: Number(args.spineIndex) }
          : {}),
        ...(name === 'cocos_download_bmfont' && args.bmfontIndex != null
          ? { bmfontIndex: Number(args.bmfontIndex) }
          : {}),
      };
      const res = await apiCall(method, [args.nodeId, dlOpts], opts);
      if (!res?.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          isError: true,
        };
      }
      const outPath = args.outPath ? resolve(args.outPath) : null;
      let shareRel = res.sharePath ?? null;
      if (res.delivery === 'share' && res.sharePath) {
        if (outPath) {
          mkdirSync(dirname(outPath), { recursive: true });
          copyFileSync(resolveSharePath(res.sharePath), outPath);
        }
      } else if (res.base64) {
        const zipName = res.zipName ?? `${args.nodeId}.zip`;
        shareRel = writeShareOutput(zipName, res.base64);
        if (outPath) writeBase64File(outPath, res.base64);
      } else if (res.zipBase64) {
        // Egret 骨骼导出：直接 inline base64 zip
        const zipName = res.zipName ?? `${args.nodeId}.zip`;
        shareRel = writeShareOutput(zipName, res.zipBase64);
        if (outPath) writeBase64File(outPath, res.zipBase64);
      } else {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, error: '响应无 sharePath/base64/zipBase64' }, null, 2),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                delivery: res.delivery ?? delivery,
                shareDir: getShareDir(),
                sharePath: shareRel,
                shareUrl: res.shareUrl ?? (shareRel ? shareFileUrl(shareRel) : undefined),
                saved: outPath ?? undefined,
                zipName: res.zipName,
                fileCount: res.fileCount ?? res.files?.length,
                log: res.log,
                reason: res.reason,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === 'cocos_replace_texture') {
      let res;
      if (args.imagePath) {
        const rel = stageInputFile(resolve(args.imagePath));
        res = await apiCall(
          'replaceTextureFromShare',
          [
            args.nodeId,
            rel,
            {
              mime: args.mime,
              filename: args.filename,
              shareBaseUrl: `http://127.0.0.1:${getShareHttpPort()}`,
            },
          ],
          opts
        );
      } else if (args.imageBase64) {
        res = await apiCall(
          'replaceTexture',
          [
            args.nodeId,
            args.imageBase64,
            { mime: args.mime, filename: args.filename },
          ],
          opts
        );
      } else {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: '需要 imagePath 或 imageBase64',
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: res?.ok === false,
      };
    }

    if (name === 'cocos_texture_extract_logs') {
      if (args?.clear) {
        await apiCall('clearTextureExtractLogs', [], opts);
      }
      const logOpts = {
        limit: args?.limit != null ? Number(args.limit) : undefined,
        since: args?.since != null ? Number(args.since) : undefined,
        nodeUUID: args?.nodeUUID ?? undefined,
      };
      const res = await apiCall('getTextureExtractLogs', [logOpts], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
      };
    }

    if (name === 'cocos_revert_texture') {
      const res = await apiCall('revertTexture', [args.nodeId], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: res?.ok === false,
      };
    }

    if (name === 'cocos_list_replacements') {
      const list = await apiCall('listReplacements', [], opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
      };
    }

    if (name === 'cocos_export_replacement_pack') {
      if (!useCdp) await waitExt(opts);
      const opts = connOpts(args);
      const zipRes = await apiCall('exportReplacementPack', [], opts);
      if (!zipRes?.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify(zipRes, null, 2) }],
          isError: true,
        };
      }
      const outZip = args?.outZip
        ? resolve(args.outZip)
        : resolve(
            repoRoot,
            'tmp',
            zipRes.data.zipName ?? `cocos-replacements.zip`
          );
      writeBase64File(outZip, zipRes.data.zipBase64);
      const summary = {
        savedZip: outZip,
        zipName: zipRes.data.zipName,
        replacementCount: zipRes.data.replacementCount,
        repackCommand: zipRes.data.repackCommand,
        repackWeb: 'http://127.0.0.1:8787 — 上传该 zip 打包',
      };
      if (args?.outDir) {
        const pack = await writeReplacementPackToDisk({
          pageUrlMatch: opts.pageUrlMatch,
          outDir: resolve(args.outDir),
        });
        Object.assign(summary, { unpackedDir: pack.outDir });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    }

    if (name === 'cocos_repack_super_html') {
      const html = resolve(args.html);
      const packDir = resolve(args.packDir);
      const out = args.out ? resolve(args.out) : '';
      const script = join(repoRoot, 'tools/repack-super-html.mjs');
      const argv = [script, '--html', html, '--pack', packDir];
      if (out) argv.push('--out', out);
      if (args.dryRun) argv.push('--dry-run');

      const result = await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, argv, {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => {
          resolvePromise({ code, stdout, stderr });
        });
        child.on('error', reject);
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: result.code !== 0,
      };
    }

    if (name === 'cocos_screenshot') {
      const kind = args?.kind ?? 'game';
      const outPath = resolve(args.outPath);
      let base64;
      let meta = {};

      if (kind === 'tab') {
        if (useCdp) {
          await ensureConnected(opts);
          base64 = await captureTabScreenshot(opts);
          meta = { kind: 'tab', mode: 'cdp', connectedPage: getConnectedPageUrl() };
        } else {
          const res = await bridgeCaptureVisibleTab(opts.pageUrlMatch);
          if (!res?.ok) {
            return {
              content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
              isError: true,
            };
          }
          base64 = res.base64;
          meta = { kind: 'tab', mode: 'bridge' };
        }
      } else if (kind === 'node') {
        if (!args.nodeId) throw new Error('kind=node 需要 nodeId');
        const res = await apiCall(
          'captureNodeScreenshot',
          [args.nodeId, args.maxSize ?? 512],
          opts
        );
        if (!res?.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
            isError: true,
          };
        }
        base64 = res.base64;
        meta = res;
      } else {
        const res = await apiCall('captureGameScreenshot', [], opts);
        if (!res?.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
            isError: true,
          };
        }
        base64 = res.base64;
        meta = res;
      }

      writeBase64File(outPath, base64);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ saved: outPath, ...meta }, null, 2),
          },
        ],
      };
    }

    return {
      content: [{ type: 'text', text: `未知工具: ${name}` }],
      isError: true,
    };
  } catch (e) {
    return {
      content: [
        {
          type: 'text',
          text: e instanceof Error ? e.message : String(e),
        },
      ],
      isError: true,
    };
  }
});

async function ensureBridgeReady() {
  if (useCdp) return;

  const defaultPort = Number(process.env.COCOS_BRIDGE_PORT ?? 17373);
  let target = null;
  try {
    target = await resolveBridgeTarget({});
  } catch (e) {
    console.error(
      `[cocos-inspector] 实例解析: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const wsPort = target?.wsPort ?? defaultPort;
  const httpPort = target?.httpPort ?? getShareHttpPort();

  try {
    await startShareHttp(httpPort);
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
  }

  try {
    await connectBridgeClientOnly(wsPort);
    console.error(
      `[cocos-inspector] 已连接桥接 ws://127.0.0.1:${wsPort}` +
        (target
          ? ` (${target.resolvedBy}${target.domain ? `, ${target.domain}` : ''})`
          : '')
    );
    return;
  } catch {
    /* 该端口无守护进程 */
  }

  if (
    target?.resolvedBy === 'registry-offline' ||
    (target?.domain && target.resolvedBy !== 'env-wsPort')
  ) {
    console.error(
      `[cocos-inspector] 请先启动守护进程: npm run cocos-bridge -- --domain ${target.domain}` +
        (target.pageUrlMatch ? ` --page-url-match ${target.pageUrlMatch}` : '')
    );
    return;
  }

  await startBridge(wsPort, target
    ? {
        domain: target.domain,
        pageUrlMatch: target.pageUrlMatch,
        wsPort,
        httpPort,
        shareDir: target.shareDir,
      }
    : undefined);
  try {
    await startShareHttp(httpPort);
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
  }
  console.error(
    `[cocos-inspector] 本进程已监听桥接 ws://127.0.0.1:${wsPort}；请重载扩展并 F5 试玩页`
  );
}

await ensureBridgeReady();

const transport = new StdioServerTransport();
await server.connect(transport);
