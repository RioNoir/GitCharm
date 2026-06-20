import * as vscode from 'vscode';
import * as path from 'path';
import { generateNonce } from '../utils/webviewHtml';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitLogPanelProvider } from './GitLogPanelProvider';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function openFileHistoryPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  fileUri: vscode.Uri,
  logPanel?: GitLogPanelProvider,
): Promise<void> {
  // Find the repo that owns this file
  const metas = manager.getRepoMetas();
  const meta = metas.find(m => fileUri.fsPath.startsWith(m.rootPath + path.sep) || fileUri.fsPath === m.rootPath)
    ?? metas.find(m => fileUri.fsPath.startsWith(m.rootPath));
  if (!meta) {
    vscode.window.showErrorMessage('GitCharm: No git repository found for this file.');
    return;
  }

  const repo = manager.getRepo(meta.id);
  if (!repo) {
    vscode.window.showErrorMessage('GitCharm: Repository not found.');
    return;
  }

  const relPath = path.relative(meta.rootPath, fileUri.fsPath).replace(/\\/g, '/');
  const fileName = path.basename(fileUri.fsPath);

  let commits: Awaited<ReturnType<typeof repo.getFileHistory>> = [];
  try {
    commits = await repo.getFileHistory(relPath);
  } catch (e: unknown) {
    vscode.window.showErrorMessage(`GitCharm: Failed to load file history: ${String(e)}`);
    return;
  }

  const nonce = generateNonce();

  const panel = vscode.window.createWebviewPanel(
    'gitcharmFileHistory',
    `History: ${fileName}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    }
  );
  panel.iconPath = new vscode.ThemeIcon('history');

  const codiconUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
  ).toString();

  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${panel.webview.cspSource}`,
  ].join('; ');

  panel.webview.html = getHtml(nonce, csp, codiconUri, {
    fileName,
    relPath,
    repoName: meta.name,
    repoId: meta.id,
    rootPath: meta.rootPath,
    commits,
  });

  panel.webview.onDidReceiveMessage(async (msg: {
    type: string;
    hash?: string;
    status?: string;
    currentPath?: string;
    oldPath?: string;
  }) => {
    if (msg.type === 'openDiff' && msg.hash && msg.currentPath) {
      try {
        const status = msg.status ?? 'M';
        const shortHash = msg.hash.slice(0, 7);
        const displayName = path.basename(msg.currentPath);

        const gitUri = (ref: string, p: string) => {
          const absPath = path.join(meta.rootPath, p);
          const fileUriAbs = vscode.Uri.file(absPath);
          return vscode.Uri.from({
            scheme: 'git',
            path: fileUriAbs.path,
            query: JSON.stringify({ path: fileUriAbs.fsPath, ref }),
          });
        };

        let leftUri: vscode.Uri;
        let rightUri: vscode.Uri;
        let title: string;

        if (status === 'A') {
          leftUri  = gitUri(EMPTY_TREE, msg.currentPath);
          rightUri = gitUri(msg.hash, msg.currentPath);
          title    = `${displayName} (added in ${shortHash})`;
        } else if (status === 'D') {
          const prevPath = msg.oldPath ?? msg.currentPath;
          leftUri  = gitUri(`${msg.hash}~1`, prevPath);
          rightUri = gitUri(EMPTY_TREE, prevPath);
          title    = `${displayName} (deleted in ${shortHash})`;
        } else if ((status === 'R' || status === 'C') && msg.oldPath) {
          leftUri  = gitUri(`${msg.hash}~1`, msg.oldPath);
          rightUri = gitUri(msg.hash, msg.currentPath);
          title    = `${path.basename(msg.oldPath)} → ${displayName} (${shortHash})`;
        } else {
          leftUri  = gitUri(`${msg.hash}~1`, msg.currentPath);
          rightUri = gitUri(msg.hash, msg.currentPath);
          title    = `${displayName} (${shortHash})`;
        }

        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`GitCharm: Cannot open diff: ${String(e)}`);
      }
    } else if (msg.type === 'openInLog' && msg.hash) {
      if (logPanel) {
        logPanel.selectCommit(msg.hash, meta.id);
      } else {
        await vscode.commands.executeCommand('gitcharm.openLog');
      }
    }
  });
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

interface PanelData {
  fileName: string;
  relPath: string;
  repoName: string;
  repoId: string;
  rootPath: string;
  commits: Array<{
    hash: string; shortHash: string; message: string;
    authorName: string; authorEmail: string; authorDate: string;
    status: string; oldPath?: string;
  }>;
}

function getHtml(nonce: string, csp: string, codiconUri: string, data: PanelData): string {
  const STATUS_LABEL: Record<string, string> = {
    A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed',
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${codiconUri}">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      display: flex; flex-direction: column;
    }

    /* ── Toolbar ── */
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px; flex-shrink: 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .toolbar-icon { opacity: 0.6; }
    .toolbar-path {
      flex: 1; font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .toolbar-repo { font-size: 11px; opacity: 0.45; flex-shrink: 0; }
    .toolbar-count { font-size: 11px; opacity: 0.45; flex-shrink: 0; }

    /* ── Commit list ── */
    .commit-list {
      flex: 1; overflow-y: auto;
    }
    .commit-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 9px 16px; cursor: pointer; user-select: none;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    }
    .commit-row:hover  { background: var(--vscode-list-hoverBackground); }
    .commit-row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

    /* status badge */
    .status-badge {
      flex-shrink: 0; margin-top: 2px;
      width: 18px; height: 18px; border-radius: 3px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700;
    }
    .status-M { background: rgba(226,192,141,0.18); color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .status-A { background: rgba(129,184,139,0.18); color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
    .status-D { background: rgba(199, 78, 57, 0.18); color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
    .status-R { background: rgba(115,201,145,0.18); color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }
    .status-C { background: rgba(115,201,145,0.18); color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }
    .status-T { background: rgba(115,198,231,0.18); color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c6e7); }

    .commit-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .commit-msg {
      font-size: 13px; font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .commit-meta {
      display: flex; align-items: center; gap: 10px;
      font-size: 11px; opacity: 0.55;
    }
    .commit-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      opacity: 0.65; flex-shrink: 0;
    }
    .commit-author { flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .commit-date   { flex-shrink: 0; }
    .commit-rename {
      font-size: 10px; opacity: 0.5; font-style: italic;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ── Open-in-Log button ── */
    .log-btn {
      flex-shrink: 0; opacity: 0;
      background: none; border: none; cursor: pointer;
      padding: 2px 4px; border-radius: 3px;
      color: var(--vscode-foreground); font-size: 13px;
      display: flex; align-items: center;
    }
    .commit-row:hover .log-btn { opacity: 0.5; }
    .log-btn:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground); }

    /* ── Empty state ── */
    .empty {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 8px; opacity: 0.4; font-size: 13px;
    }
    .empty .codicon { font-size: 32px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="codicon codicon-history toolbar-icon"></span>
    <span class="toolbar-path" title="${escHtml(data.relPath)}">${escHtml(data.relPath)}</span>
    <span class="toolbar-repo">${escHtml(data.repoName)}</span>
    <span class="toolbar-count" id="commitCount"></span>
  </div>

  <div class="commit-list" id="commitList">
    ${data.commits.length === 0 ? `
      <div class="empty">
        <span class="codicon codicon-git-commit"></span>
        <span>No history found for this file</span>
      </div>
    ` : ''}
  </div>

  <script id="__data" type="application/json">${escJson({ commits: data.commits, relPath: data.relPath })}</script>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const __d    = JSON.parse(document.getElementById('__data').textContent);
    const COMMITS = __d.commits;

    document.getElementById('commitCount').textContent =
      COMMITS.length === 0 ? '' :
      COMMITS.length === 1 ? '1 commit' : COMMITS.length + ' commits';

    const STATUS_LABEL = {
      A:'Added', M:'Modified', D:'Deleted', R:'Renamed', C:'Copied', T:'Type changed',
    };

    function escText(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function escAttr(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function fmtDate(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        const now = new Date();
        const diff = now - d;
        const days = Math.floor(diff / 86400000);
        if (days === 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 7)  return days + ' days ago';
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } catch { return iso; }
    }

    function render() {
      if (COMMITS.length === 0) return;
      const listEl = document.getElementById('commitList');
      const buf = [];
      for (const c of COMMITS) {
        const st = c.status || 'M';
        const stLabel = STATUS_LABEL[st] || st;
        const renameHtml = (st === 'R' || st === 'C') && c.oldPath
          ? '<div class="commit-rename">← ' + escText(c.oldPath) + '</div>'
          : '';
        buf.push(
          '<div class="commit-row"' +
          ' data-hash="' + escAttr(c.hash) + '"' +
          ' data-status="' + escAttr(st) + '"' +
          ' data-currentpath="' + escAttr(__d.relPath) + '"' +
          (c.oldPath ? ' data-oldpath="' + escAttr(c.oldPath) + '"' : '') +
          ' title="' + escAttr(c.message) + '">' +
          '<div class="status-badge status-' + escAttr(st) + '" title="' + escAttr(stLabel) + '">' + escText(st) + '</div>' +
          '<div class="commit-main">' +
          '<div class="commit-msg">' + escText(c.message) + '</div>' +
          '<div class="commit-meta">' +
          '<span class="commit-hash">' + escText(c.shortHash) + '</span>' +
          '<span class="commit-author">' + escText(c.authorName) + '</span>' +
          '<span class="commit-date">' + escText(fmtDate(c.authorDate)) + '</span>' +
          '</div>' +
          renameHtml +
          '</div>' +
          '<button class="log-btn" data-action="openinlog" data-hash="' + escAttr(c.hash) + '" title="Show in Git Log"><span class="codicon codicon-git-commit"></span></button>' +
          '</div>'
        );
      }
      listEl.innerHTML = buf.join('');
    }

    render();

    // ── Event delegation ──
    document.getElementById('commitList').addEventListener('click', e => {
      const logBtn = e.target.closest('[data-action="openinlog"]');
      if (logBtn) {
        e.stopPropagation();
        vscode.postMessage({ type: 'openInLog', hash: logBtn.dataset.hash });
        return;
      }
      const row = e.target.closest('.commit-row');
      if (!row) return;
      document.querySelectorAll('.commit-row.active').forEach(el => el.classList.remove('active'));
      row.classList.add('active');
      vscode.postMessage({
        type: 'openDiff',
        hash: row.dataset.hash,
        status: row.dataset.status,
        currentPath: row.dataset.currentpath,
        oldPath: row.dataset.oldpath || undefined,
      });
    });
  </script>
</body>
</html>`;
}
