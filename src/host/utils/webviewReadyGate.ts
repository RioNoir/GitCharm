import * as vscode from 'vscode';

/** Posted by a webview client once its 'message' listener is attached — see notifyHostReady() in webview/shared/vscodeApi.ts. */
export const WEBVIEW_READY = 'WEBVIEW_READY';

interface Gate { ready: boolean; pending: unknown[] }

const gates = new WeakMap<vscode.WebviewPanel, Gate>();

/**
 * Posts to a panel's webview, holding messages until the client has posted WEBVIEW_READY.
 *
 * A message posted before the client's script has attached its 'message' listener is silently
 * dropped, and whether a panel's one-shot INIT loses that race depends on the host: in Cursor,
 * editor-tab panels stayed on "Loading…" forever.
 *
 * Call it right after setting the panel's html, before any await, so the gate is listening
 * before the client can post READY. Repeated calls for the same panel return the same gate.
 */
export function webviewReadyGate<T>(panel: vscode.WebviewPanel): { post(msg: T): void } {
  let gate = gates.get(panel);
  if (!gate) {
    const g: Gate = { ready: false, pending: [] };
    const sub = panel.webview.onDidReceiveMessage((msg: { type?: unknown } | undefined) => {
      if (msg?.type !== WEBVIEW_READY || g.ready) return;
      g.ready = true;
      for (const m of g.pending.splice(0)) void panel.webview.postMessage(m);
    });
    panel.onDidDispose(() => sub.dispose());
    gates.set(panel, g);
    gate = g;
  }
  const g = gate;
  return {
    post(msg: T) {
      if (g.ready) void panel.webview.postMessage(msg);
      else g.pending.push(msg);
    },
  };
}
