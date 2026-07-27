/** 试玩页经 HTTP PUT 写入桥接共享目录（与换皮 in/out 通道对称） */

const DEFAULT_SHARE_HTTP_PORTS = [17374, 17375];

const sanitizeShareName = (name: string): string =>
  name.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_') || 'file.bin';

/** 探测本机 share-http 基址（优先 /api/status） */
export const resolveShareHttpBase = async (
  wsPort = 17373
): Promise<string> => {
  const ports = [...new Set([...DEFAULT_SHARE_HTTP_PORTS, wsPort + 1])];
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) return `http://127.0.0.1:${port}`;
    } catch {
      /* try next */
    }
  }
  return `http://127.0.0.1:17374`;
};

/** 任意字节 → PUT out/xxx，WS 只传 sharePath */
export const uploadBytesToShare = async (
  bytes: Uint8Array,
  filename: string,
  wsPort = 17373,
  contentType = 'application/octet-stream'
): Promise<
  | { ok: true; sharePath: string; shareUrl: string; shareHttpBase: string }
  | { ok: false; error: string }
> => {
  const base = await resolveShareHttpBase(wsPort);
  const safeName = sanitizeShareName(filename);
  const sharePath = `out/${Date.now()}-${safeName}`;

  try {
    const res = await fetch(`${base}/${sharePath}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
    });
    if (!res.ok) {
      return { ok: false, error: `共享目录 PUT 失败 HTTP ${res.status}` };
    }
    return {
      ok: true,
      sharePath,
      shareUrl: `${base}/${sharePath}`,
      shareHttpBase: base,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

/** base64 PNG → PUT out/xxx.png，WS 只传 sharePath 时用 */
export const uploadPngBase64ToShare = async (
  base64: string,
  filename: string,
  wsPort = 17373
): Promise<
  | { ok: true; sharePath: string; shareUrl: string; shareHttpBase: string }
  | { ok: false; error: string }
> => {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }
    const safe =
      filename.endsWith('.png') || filename.endsWith('.PNG')
        ? filename
        : `${filename}.png`;
    return uploadBytesToShare(bytes, safe, wsPort, 'image/png');
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

/** Blob → share（Spine/BMFont zip） */
export const uploadBlobToShare = async (
  blob: Blob,
  filename: string,
  wsPort = 17373,
  contentType = 'application/zip'
): Promise<
  | { ok: true; sharePath: string; shareUrl: string; shareHttpBase: string }
  | { ok: false; error: string }
> => {
  try {
    const ab = await blob.arrayBuffer();
    return uploadBytesToShare(new Uint8Array(ab), filename, wsPort, contentType);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};
