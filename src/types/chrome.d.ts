declare namespace chrome {
  namespace runtime {
    function getURL(path: string): string;
    const lastError?: { message?: string };
    function sendMessage(
      message: unknown,
      responseCallback?: (response: {
        status?: string;
        port?: number;
        wsUrl?: string;
        ok?: boolean;
      }) => void
    ): void;
    const onMessage: {
      addListener: (
        callback: (
          message: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void
        ) => boolean | void
      ) => void;
    };
  }

  namespace tabs {
    function sendMessage(
      tabId: number,
      message: unknown,
      responseCallback?: (response: {
        ok?: boolean;
        result?: unknown;
        error?: string;
      }) => void
    ): void;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      windowId?: number;
    }
    function query(queryInfo: {
      url?: string | string[];
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<Tab[]>;
    function captureVisibleTab(
      windowId: number,
      options: { format: 'png' | 'jpeg' }
    ): Promise<string>;
    const onUpdated: {
      addListener: (callback: () => void) => void;
    };
  }

  namespace scripting {
    function executeScript(injection: {
      target: { tabId: number };
      world?: 'MAIN' | 'ISOLATED';
      func: (...args: unknown[]) => unknown;
      args?: unknown[];
    }): Promise<Array<{ result?: unknown }>>;
  }
}
