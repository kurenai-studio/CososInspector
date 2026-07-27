/**
 * 基于 chrome.debugger (CDP Network) 组装 HAR 1.2。
 * 强制 setCacheDisabled，避免磁盘缓存条目 size=0 / 无 body。
 */

export type HarCaptureStats = {
  recording: boolean;
  tabId: number | null;
  requestCount: number;
  finishedCount: number;
  withBodyCount: number;
  imageWithBodyCount: number;
  failedBodyCount: number;
  bytesCaptured: number;
  startedAt: string | null;
  lastError: string | null;
};

type PendingEntry = {
  requestId: string;
  startedDateTime: string;
  wallTime: number;
  timestamp: number;
  method: string;
  url: string;
  requestHeaders: Array<{ name: string; value: string }>;
  postData?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders: Array<{ name: string; value: string }>;
  encodedDataLength?: number;
  finished?: boolean;
  bodyText?: string;
  bodyEncoding?: 'base64';
  bodyError?: string;
};

const MAX_BODY_BYTES = 25 * 1024 * 1024;

function headersFromCdp(
  headers: Record<string, string> | undefined
): Array<{ name: string; value: string }> {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function isImageMime(mime: string | undefined, url: string): boolean {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|$)/i.test(url);
}

export type DebuggerSend = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>;

export class HarCaptureSession {
  tabId: number;
  recording = false;
  startedAt: string | null = null;
  lastError: string | null = null;
  pageUrl = '';
  pageTitle = '';
  private entries = new Map<string, PendingEntry>();
  private bodyFetchQueue: Promise<void> = Promise.resolve();
  private send: DebuggerSend;

  constructor(tabId: number, send: DebuggerSend) {
    this.tabId = tabId;
    this.send = send;
  }

  getStats(): HarCaptureStats {
    let withBodyCount = 0;
    let imageWithBodyCount = 0;
    let failedBodyCount = 0;
    let finishedCount = 0;
    let bytesCaptured = 0;
    for (const e of this.entries.values()) {
      if (e.finished) finishedCount += 1;
      if (e.bodyText) {
        withBodyCount += 1;
        bytesCaptured += e.bodyText.length;
        if (isImageMime(e.mimeType, e.url)) imageWithBodyCount += 1;
      } else if (e.bodyError) {
        failedBodyCount += 1;
      }
    }
    return {
      recording: this.recording,
      tabId: this.tabId,
      requestCount: this.entries.size,
      finishedCount,
      withBodyCount,
      imageWithBodyCount,
      failedBodyCount,
      bytesCaptured,
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }

  async start(pageUrl: string, pageTitle: string): Promise<void> {
    this.pageUrl = pageUrl;
    this.pageTitle = pageTitle || pageUrl;
    this.entries.clear();
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    await this.send('Network.enable', {
      maxPostDataSize: MAX_BODY_BYTES,
    });
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    this.recording = true;
  }

  async stop(): Promise<void> {
    this.recording = false;
    try {
      await this.send('Network.setCacheDisabled', { cacheDisabled: false });
    } catch {
      /* detach 前尽力恢复 */
    }
    await this.awaitPendingBodies();
  }

  /** 等待 getResponseBody 队列排空 */
  async awaitPendingBodies(): Promise<void> {
    await this.bodyFetchQueue;
  }

  onEvent(method: string, params: Record<string, unknown>): void {
    if (!this.recording) return;
    try {
      if (method === 'Network.requestWillBeSent') {
        this.onRequestWillBeSent(params);
      } else if (method === 'Network.responseReceived') {
        this.onResponseReceived(params);
      } else if (method === 'Network.loadingFinished') {
        this.onLoadingFinished(params);
      } else if (method === 'Network.loadingFailed') {
        this.onLoadingFailed(params);
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.error(`[HAR抓包] tab=${this.tabId} - 事件处理失败: ${this.lastError}`);
    }
  }

  private onRequestWillBeSent(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? '');
    if (!requestId) return;
    const request = (params.request ?? {}) as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      postData?: string;
    };
    const url = String(request.url ?? '');
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;

    const wallTime = Number(params.wallTime ?? Date.now() / 1000);
    const timestamp = Number(params.timestamp ?? 0);
    const redirectedFrom = params.redirectResponse
      ? String(params.requestId)
      : null;
    void redirectedFrom;

    this.entries.set(requestId, {
      requestId,
      startedDateTime: new Date(wallTime * 1000).toISOString(),
      wallTime,
      timestamp,
      method: String(request.method ?? 'GET'),
      url,
      requestHeaders: headersFromCdp(request.headers),
      postData: request.postData,
      responseHeaders: [],
    });
  }

  private onResponseReceived(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? '');
    const entry = this.entries.get(requestId);
    if (!entry) return;
    const response = (params.response ?? {}) as {
      status?: number;
      statusText?: string;
      mimeType?: string;
      headers?: Record<string, string>;
      url?: string;
    };
    entry.status = Number(response.status ?? 0);
    entry.statusText = String(response.statusText ?? '');
    entry.mimeType = String(response.mimeType ?? '');
    entry.responseHeaders = headersFromCdp(response.headers);
    if (response.url) entry.url = String(response.url);
  }

  private onLoadingFinished(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? '');
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.encodedDataLength = Number(params.encodedDataLength ?? 0);
    entry.finished = true;
    this.bodyFetchQueue = this.bodyFetchQueue
      .then(() => this.fetchBody(entry))
      .catch((e) => {
        entry.bodyError = e instanceof Error ? e.message : String(e);
      });
  }

  private onLoadingFailed(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? '');
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.finished = true;
    entry.bodyError = String(params.errorText ?? 'loadingFailed');
  }

  private async fetchBody(entry: PendingEntry): Promise<void> {
    if (!this.recording && entry.bodyText) return;
    try {
      const res = (await this.send('Network.getResponseBody', {
        requestId: entry.requestId,
      })) as { body?: string; base64Encoded?: boolean } | undefined;
      const body = res?.body ?? '';
      if (!body) {
        entry.bodyError = 'empty body';
        return;
      }
      if (body.length > MAX_BODY_BYTES) {
        entry.bodyError = `body too large (${body.length})`;
        return;
      }
      entry.bodyText = body;
      if (res?.base64Encoded) entry.bodyEncoding = 'base64';
    } catch (e) {
      entry.bodyError = e instanceof Error ? e.message : String(e);
    }
  }

  buildHar(creatorVersion: string): object {
    const pageId = 'page_1';
    const harEntries = [...this.entries.values()]
      .filter((e) => e.url)
      .map((e) => {
        const content: Record<string, unknown> = {
          size: e.encodedDataLength ?? 0,
          mimeType: e.mimeType ?? 'application/octet-stream',
        };
        if (e.bodyText) {
          content.text = e.bodyText;
          content.size = e.bodyText.length;
          if (e.bodyEncoding) content.encoding = e.bodyEncoding;
        }
        return {
          startedDateTime: e.startedDateTime,
          time: 0,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: e.requestHeaders,
            queryString: [],
            headersSize: -1,
            bodySize: e.postData ? e.postData.length : 0,
            ...(e.postData
              ? { postData: { mimeType: '', text: e.postData } }
              : {}),
          },
          response: {
            status: e.status ?? 0,
            statusText: e.statusText ?? '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: e.responseHeaders,
            content,
            redirectURL: '',
            headersSize: -1,
            bodySize: e.encodedDataLength ?? -1,
          },
          cache: {},
          timings: {
            blocked: -1,
            dns: -1,
            connect: -1,
            ssl: -1,
            send: 0,
            wait: 0,
            receive: 0,
          },
          pageref: pageId,
        };
      });

    return {
      log: {
        version: '1.2',
        creator: {
          name: 'Cocos Inspector',
          version: creatorVersion,
        },
        pages: [
          {
            startedDateTime: this.startedAt ?? new Date().toISOString(),
            id: pageId,
            title: this.pageTitle || this.pageUrl,
            pageTimings: { onContentLoad: -1, onLoad: -1 },
          },
        ],
        entries: harEntries,
      },
    };
  }
}
