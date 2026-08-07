/**
 * Egret 骨骼导出公共工具
 * 参考插件 inspector.js 的 ne/oe/pe/mt 函数链
 */

export interface SkeletonExportFile {
  name: string;
  mime: string;
  text?: string;
  dataBase64?: string;
  url?: string;
  bytes?: number;
}

export interface SkeletonExportResult {
  ok: boolean;
  zipName: string;
  zipBase64?: string;
  files: SkeletonExportFile[];
  log: string[];
  error?: string;
  reason?: string;
}

const B64_CHUNK = 0x8000;

/** 把 Uint8Array 转 base64（分块避免栈溢出，等价参考插件 ne()） */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + B64_CHUNK, bytes.length));
    out += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(out);
}

/** 文件名清洗：去掉路径分隔符等非法字符 */
export function sanitizeFilename(name: string): string {
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*\s]+/g, '_')
    .replace(/_+/g, '_');
  return cleaned || 'skeleton';
}

/** 生成 runtime_summary.json 文本，标注"非原始工程文件，仅供对照" */
export function runtimeSummaryJson(meta: {
  engine: string;
  kind: 'spine' | 'dragonBones';
  name: string;
  [k: string]: unknown;
}): string {
  try {
    return JSON.stringify(
      {
        note:
          '运行时摘要：非原始 Spine/DragonBones 工程文件，仅供对照；缺原始 json/skel 时无法完整还原。',
        ...meta,
      },
      null,
      2
    );
  } catch {
    return '{"note":"runtime summary failed"}';
  }
}

/**
 * 通用骨架数据写入：等价参考插件 mt()
 *   string → json/text
 *   ArrayBuffer / TypedArray → .skel base64
 *   object 含 skeleton/bones/animations/armature/frameRate/name → JSON
 */
export function pushSkeletonData(
  out: SkeletonExportFile[],
  data: unknown,
  name: string,
  mime: string
): boolean {
  if (data == null) return false;
  if (typeof data === 'string' && data.length > 0) {
    out.push({ name, mime, text: data, bytes: data.length });
    return true;
  }
  if (data instanceof ArrayBuffer && data.byteLength > 0) {
    const b64 = bytesToBase64(new Uint8Array(data));
    const skelName = name.replace(/\.json$/i, '.skel');
    out.push({
      name: skelName,
      mime: 'application/octet-stream',
      dataBase64: b64,
      bytes: data.byteLength,
    });
    return true;
  }
  if (ArrayBuffer.isView(data) && data.byteLength > 0) {
    const b64 = bytesToBase64(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
    const skelName = name.replace(/\.json$/i, '.skel');
    out.push({
      name: skelName,
      mime: 'application/octet-stream',
      dataBase64: b64,
      bytes: data.byteLength,
    });
    return true;
  }
  if (typeof data === 'object' && data !== null) {
    const obj = data as {
      skeleton?: unknown;
      bones?: unknown;
      animations?: unknown;
      armature?: unknown;
      frameRate?: number;
      name?: string;
    };
    if (
      obj.skeleton ||
      obj.bones ||
      obj.animations ||
      obj.armature ||
      obj.frameRate != null ||
      obj.name
    ) {
      try {
        const text = JSON.stringify(data, null, 2);
        out.push({ name, mime: 'application/json', text, bytes: text.length });
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}
