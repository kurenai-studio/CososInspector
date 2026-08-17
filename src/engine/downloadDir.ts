/** Chrome 目录选择 + 写入（与 Egret 下载共用同一套 File System Access API） */

export type DirHandle = FileSystemDirectoryHandle;

const sanitizeSegment = (raw: string): string => {
  const s = raw.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_');
  return s.replace(/^\.+/, '') || 'file';
};

export const sanitizeFilename = (name: string): string =>
  sanitizeSegment(name);

/** 已占用名去重：foo.png → foo_2.png */
export const uniqueFilename = (used: Set<string>, name: string): string => {
  const safe = sanitizeFilename(name);
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  let i = 2;
  let out = `${stem}_${i}${ext}`;
  while (used.has(out)) {
    i += 1;
    out = `${stem}_${i}${ext}`;
  }
  used.add(out);
  return out;
};

export const base64ToBlob = (b64: string, type = 'image/png'): Blob => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
};

export const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('canvas.toBlob 失败'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });

export const pickDirectory = async (): Promise<DirHandle | null> => {
  const fn = (
    window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: string }) => Promise<DirHandle>;
    }
  ).showDirectoryPicker;
  if (typeof fn !== 'function') {
    throw new Error('当前浏览器不支持目录选择（需 Chrome/Edge 117+）');
  }
  try {
    return await fn.call(window, { mode: 'readwrite' });
  } catch {
    return null;
  }
};

export const writeFileToDir = async (
  dir: DirHandle,
  filename: string,
  data: BlobPart
): Promise<void> => {
  const parts = filename.split(/[\\/]/).filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) throw new Error('空文件名');

  let cur = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    const name = sanitizeSegment(parts[i]);
    cur = await cur.getDirectoryHandle(name, { create: true });
  }

  const safeName = sanitizeSegment(parts[parts.length - 1]);
  const fh = await cur.getFileHandle(safeName, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
  } finally {
    await w.close();
  }
};

export const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
};
