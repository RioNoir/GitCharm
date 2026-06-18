import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  appName: 'commitPanel' | 'gitLog' | 'mergeEditor' | 'undockedPanel',
  title: string,
  initialConfig?: Record<string, unknown>,
): string {
  const nonce = generateNonce();

  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', appName, 'index.js')
  );

  const codiconCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
  );

  // Monaco loads from CDN (jsdelivr) by default via @monaco-editor/react.
  // Phase 4 will switch to bundled Monaco and tighten this CSP.
  const monacoCdn = 'https://cdn.jsdelivr.net';
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: https:`,
    `style-src ${webview.cspSource} 'unsafe-inline' ${monacoCdn}`,
    `script-src 'nonce-${nonce}' ${monacoCdn}`,
    `worker-src blob:`,
    `font-src ${webview.cspSource} data: ${monacoCdn}`,
    `connect-src ${monacoCdn}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${codiconCssUri}">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; overflow: hidden; height: 100vh; }
    #root { height: 100vh; display: flex; flex-direction: column; }
    body.cursor-host { max-width: calc(100vw - 1px); }

    /* ── Themed checkboxes ──────────────────────────────────────────────────── */
    input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border: 1.5px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 3px;
      background: transparent;
      cursor: pointer;
      flex-shrink: 0;
      position: relative;
      vertical-align: middle;
      transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
    }
    input[type="checkbox"]:hover {
      background: var(--vscode-focusBorder, #007fd4)22;
      box-shadow: 0 0 0 2px var(--vscode-focusBorder, #007fd4)33;
    }
    input[type="checkbox"]:checked,
    input[type="checkbox"]:indeterminate {
      background: var(--vscode-focusBorder, #007fd4);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      left: 3px;
      top: 0px;
      width: 4px;
      height: 8px;
      border: 2px solid #fff;
      border-top: none;
      border-left: none;
      transform: rotate(45deg);
    }
    input[type="checkbox"]:indeterminate::after {
      content: '';
      position: absolute;
      left: 2px;
      top: 5px;
      width: 8px;
      height: 2px;
      background: #fff;
      border-radius: 1px;
    }
    input[type="checkbox"]:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    input[type="checkbox"]:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* ── Hover actions in file rows ─────────────────────────────────────────── */
    .file-row:hover .file-actions { opacity: 1 !important; }
    .file-row .file-actions { opacity: 0; transition: opacity 0.1s; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">if (/Cursor/.test(navigator.userAgent)) document.body.classList.add('cursor-host');${initialConfig ? `\nwindow.__INITIAL_CONFIG__ = ${JSON.stringify(initialConfig)};` : ''}</script>
  <script nonce="${nonce}" type="module" src="${jsUri}"></script>
</body>
</html>`;
}
