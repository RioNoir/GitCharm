import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  appName: 'commitPanel' | 'gitLog' | 'mergeEditor' | 'undockedPanel' | 'pullRequestCreate' | 'pullRequestDetail',
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

    /* ── Scrollbars (native, used outside ScrollArea component) ─────────────── */
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
    ::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); }
    ::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
    ::-webkit-scrollbar-thumb:active { background-color: var(--vscode-scrollbarSlider-activeBackground); }
    * { scrollbar-width: thin; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }

    /* ── Hover actions in file rows ─────────────────────────────────────────── */
    .file-row:hover .file-actions { opacity: 1 !important; }
    .file-row .file-actions { opacity: 0; transition: opacity 0.1s; }

    /* ── Rendered markdown (PR descriptions/comments/commit messages) ───────── */
    .markdown-body h1, .markdown-body h2, .markdown-body h3,
    .markdown-body h4, .markdown-body h5, .markdown-body h6 {
      margin: 16px 0 8px; line-height: 1.3;
    }
    .markdown-body h1:first-child, .markdown-body h2:first-child, .markdown-body h3:first-child,
    .markdown-body h4:first-child, .markdown-body h5:first-child, .markdown-body h6:first-child { margin-top: 0; }
    .markdown-body p { margin: 0 0 10px; }
    .markdown-body p:last-child { margin-bottom: 0; }
    .markdown-body ul, .markdown-body ol { margin: 0 0 10px; padding-left: 24px; }
    .markdown-body li { margin: 2px 0; }
    .markdown-body li > ul, .markdown-body li > ol { margin: 4px 0; }
    .markdown-body blockquote {
      margin: 0 0 10px; padding: 0 12px; border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
      background: var(--vscode-textBlockQuote-background, transparent); opacity: 0.9;
    }
    .markdown-body code {
      font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.16));
      padding: 1px 5px; border-radius: 3px;
    }
    .markdown-body pre {
      margin: 0 0 10px; padding: 10px 12px; overflow-x: auto; border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.16));
    }
    .markdown-body pre code { background: transparent; padding: 0; }
    .markdown-body a { color: var(--vscode-textLink-foreground); }
    .markdown-body a:hover { color: var(--vscode-textLink-activeForeground); }
    .markdown-body hr { margin: 14px 0; border: none; border-top: 1px solid var(--vscode-panel-border); }
    .markdown-body img { max-width: 100%; }
    .markdown-body table {
      margin: 0 0 10px; border-collapse: collapse; width: auto; max-width: 100%; display: block; overflow-x: auto;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--vscode-panel-border); padding: 5px 10px; text-align: left;
    }
    .markdown-body th { font-weight: 600; background: rgba(127,127,127,0.08); }
    .markdown-body input[type="checkbox"] { margin-right: 6px; }

    /* ── PR detail Overview tab: main content + sidebar, collapsing to stacked ── */
    .pr-overview-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      grid-template-areas: "main sidebar";
      align-items: start;
      gap: 24px;
    }
    .pr-overview-main { grid-area: main; min-width: 0; }
    .pr-overview-sidebar { grid-area: sidebar; display: flex; flex-direction: column; gap: 20px; }
    @media (max-width: 720px) {
      .pr-overview-layout { grid-template-columns: 1fr; grid-template-areas: "sidebar" "main"; }
    }

    /* ── Skeleton loading placeholders ───────────────────────────────────────── */
    .skeleton-block {
      background: linear-gradient(
        100deg,
        color-mix(in srgb, var(--vscode-foreground) 10%, transparent) 30%,
        color-mix(in srgb, var(--vscode-foreground) 16%, transparent) 50%,
        color-mix(in srgb, var(--vscode-foreground) 10%, transparent) 70%
      );
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.4s ease-in-out infinite;
    }
    @keyframes skeleton-shimmer {
      0% { background-position: 150% 0; }
      100% { background-position: -50% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .skeleton-block { animation: none; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">if (/Cursor/.test(navigator.userAgent)) document.body.classList.add('cursor-host');${initialConfig ? `\nwindow.__INITIAL_CONFIG__ = ${JSON.stringify(initialConfig)};` : ''}</script>
  <script nonce="${nonce}" type="module" src="${jsUri}"></script>
</body>
</html>`;
}
