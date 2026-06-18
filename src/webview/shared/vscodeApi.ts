declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

type VsCodeApi = ReturnType<typeof acquireVsCodeApi>;

let _api: VsCodeApi | undefined;

/**
 * In the undocked panel, each sub-app (commit, log) needs its own proxy that
 * wraps outgoing messages with a source tag. Setting this before the sub-app
 * initialises lets getVsCodeApi() return the proxy instead of acquiring the
 * real singleton (which can only be called once per webview context).
 */
export function overrideVsCodeApi(api: VsCodeApi): void {
  _api = api;
}

export function getVsCodeApi(): VsCodeApi {
  if (!_api) {
    _api = acquireVsCodeApi();
  }
  return _api;
}
