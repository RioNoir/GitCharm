import * as vscode from 'vscode';
import { generateNonce } from '../utils/webviewHtml';

export interface SquashEditorResult {
  confirmed: boolean;
  message: string;
}

export interface SquashCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
}

export async function openSquashEditor(
  extensionUri: vscode.Uri,
  commitCount: number,
  initialMessage: string,
  commits: SquashCommitInfo[] = []
): Promise<SquashEditorResult> {
  return new Promise(resolve => {
    const nonce = generateNonce();
    const panel = vscode.window.createWebviewPanel(
      'gitcharmSquash',
      `Squash ${commitCount} commits`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: false }
    );

    const codiconUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
    );

    const csp = [
      `default-src 'none'`,
      `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${panel.webview.cspSource}`,
    ].join('; ');

    panel.webview.html = getHtml(nonce, csp, codiconUri.toString(), commitCount, initialMessage, commits);

    let settled = false;
    const settle = (result: SquashEditorResult) => {
      if (settled) return;
      settled = true;
      panel.dispose();
      resolve(result);
    };

    panel.webview.onDidReceiveMessage((msg: { type: string; message?: string }) => {
      if (msg.type === 'confirm') settle({ confirmed: true, message: msg.message ?? '' });
      else if (msg.type === 'cancel') settle({ confirmed: false, message: '' });
    });

    panel.onDidDispose(() => settle({ confirmed: false, message: '' }));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getHtml(nonce: string, csp: string, codiconUri: string, commitCount: number, initialMessage: string, commits: SquashCommitInfo[]): string {
  const escaped = escapeHtml(initialMessage);
  const commitRows = commits.map(c =>
    `<div class="commit-row">
      <span class="commit-hash">${escapeHtml(c.shortHash)}</span>
      <span class="commit-msg">${escapeHtml(c.message)}</span>
    </div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${codiconUri}">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      height: 100vh;
      display: flex; flex-direction: column;
    }
    .header {
      display: flex; align-items: center; gap: 8px;
      padding: 16px 24px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .header-icon {
      font-size: 18px;
      opacity: 0.7;
      color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
    }
    .header-title {
      font-size: 15px; font-weight: 600;
    }
    .header-sub {
      font-size: 12px; opacity: 0.55; margin-top: 1px;
    }
    .body {
      flex: 1; display: flex; flex-direction: column;
      padding: 20px 24px; gap: 10px; overflow: auto;
    }
    .label {
      font-size: 11px; opacity: 0.55;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .commit-list {
      display: flex; flex-direction: column;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .commit-row {
      display: flex; align-items: baseline; gap: 10px;
      padding: 5px 10px;
      font-size: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .commit-row:last-child { border-bottom: none; }
    .commit-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; opacity: 0.5; flex-shrink: 0;
    }
    .commit-msg {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      opacity: 0.85;
    }
    textarea {
      flex: 1; min-height: 160px;
      width: 100%; resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 10px 12px;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 13px; line-height: 1.6;
      outline: none;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .footer {
      display: flex; align-items: center; justify-content: flex-end; gap: 8px;
      padding: 12px 24px 20px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    button {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 16px; border-radius: 3px;
      font-family: var(--vscode-font-family);
      font-size: 13px; cursor: pointer; border: none;
    }
    .btn-cancel {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    }
    .btn-cancel:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .btn-confirm {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-confirm:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-confirm:disabled {
      opacity: 0.45; cursor: default;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="codicon codicon-fold header-icon"></span>
    <div>
      <div class="header-title">Squash ${commitCount} commits</div>
      <div class="header-sub">Edit the combined commit message below, then confirm.</div>
    </div>
  </div>
  <div class="body">
    ${commitRows ? `<div>
      <div class="label" style="margin-bottom:6px">Commits being squashed</div>
      <div class="commit-list">${commitRows}</div>
    </div>` : ''}
    <div>
      <div class="label" style="margin-bottom:6px">Commit message</div>
      <textarea id="msg" autofocus spellcheck="false">${escaped}</textarea>
    </div>
  </div>
  <div class="footer">
    <button class="btn-cancel" id="cancelBtn">
      <span class="codicon codicon-close" style="font-size:13px"></span>
      Cancel
    </button>
    <button class="btn-confirm" id="confirmBtn">
      <span class="codicon codicon-check" style="font-size:13px"></span>
      Confirm Squash
    </button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const ta = document.getElementById('msg');
    const confirmBtn = document.getElementById('confirmBtn');

    const update = () => { confirmBtn.disabled = !ta.value.trim(); };
    ta.addEventListener('input', update);
    update();

    ta.focus();
    ta.setSelectionRange(0, ta.value.length);

    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    confirmBtn.addEventListener('click', () => {
      const msg = ta.value.trim();
      if (!msg) return;
      vscode.postMessage({ type: 'confirm', message: msg });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') vscode.postMessage({ type: 'cancel' });
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const msg = ta.value.trim();
        if (msg) vscode.postMessage({ type: 'confirm', message: msg });
      }
    });
  </script>
</body>
</html>`;
}
