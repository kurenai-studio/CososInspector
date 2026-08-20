/**
 * 诊断日志环形缓冲：控制台可见 + 反馈导出只带这些行（不含节点树/截图）。
 */

const MAX_LINES = 400;
const PREFIX = '[Cocos Inspector:诊断]';

const lines: string[] = [];
let seq = 0;

const pad = (n: number): string => String(n).padStart(2, '0');

const stamp = (): string => {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    String(d.getMilliseconds()).padStart(3, '0')
  );
};

export const diagLog = (tag: string, detail?: string): void => {
  try {
    seq += 1;
    const body = detail ? `${tag} | ${detail}` : tag;
    const line = `#${seq} ${stamp()} ${body}`;
    lines.push(line);
    while (lines.length > MAX_LINES) lines.shift();
    if (detail) console.log(`${PREFIX} ${tag}`, detail);
    else console.log(`${PREFIX} ${tag}`);
  } catch (error) {
    console.error(`${PREFIX} 写日志失败`, error);
  }
};

export const getDiagLogText = (): string => lines.join('\n');

export const getDiagLogCount = (): number => lines.length;

export const clearDiagLogs = (): void => {
  lines.length = 0;
  seq = 0;
};
