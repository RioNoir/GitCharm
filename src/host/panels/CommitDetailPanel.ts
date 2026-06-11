import * as vscode from 'vscode';
import { generateNonce } from '../utils/webviewHtml';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';

export async function openCommitDetailPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  repoId: string,
  hash: string,
  opts: { autoExplain?: boolean } = {},
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    vscode.window.showErrorMessage('GitCharm: Repository not found.');
    return;
  }

  let commitInfo: Awaited<ReturnType<typeof repo.getCommitMeta>> | null = null;
  let files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
  let fullMessage = '';
  let branches: { local: string[]; remote: string[]; tags: string[] } = { local: [], remote: [], tags: [] };

  try {
    [fullMessage, commitInfo] = await Promise.all([
      repo.getFullCommitMessage(hash),
      repo.getCommitMeta(hash),
    ]);
    commitInfo ??= { hash, shortHash: hash.slice(0, 7), message: '', authorName: '', authorEmail: '', authorDate: '', committerDate: '', parents: [] };
    [files, branches] = await Promise.all([
      repo.getCommitFiles(hash, commitInfo.parents),
      repo.getBranchesContaining(hash).catch(() => ({ local: [], remote: [], tags: [] })),
    ]);
  } catch (e: unknown) {
    vscode.window.showErrorMessage(`GitCharm: Failed to load commit details: ${String(e)}`);
    return;
  }

  const repoMeta = manager.getRepoMetas().find(r => r.id === repoId);
  const repoName = repoMeta?.name ?? repoId;

  const nonce = generateNonce();

  const panel = vscode.window.createWebviewPanel(
    'gitcharmCommitDetail',
    `Commit ${commitInfo.shortHash}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    }
  );
  panel.iconPath = new vscode.ThemeIcon('git-commit');

  const codiconUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
  ).toString();

  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${panel.webview.cspSource}`,
    `img-src https://gravatar.com https://avatars.githubusercontent.com data:`,
  ].join('; ');

  panel.webview.html = getHtml(nonce, csp, codiconUri, {
    repoName, repoId, hash,
    shortHash: commitInfo.shortHash,
    message: commitInfo.message,
    fullMessage: fullMessage.trim(),
    authorName: commitInfo.authorName,
    authorEmail: commitInfo.authorEmail,
    authorDate: commitInfo.authorDate,
    committerDate: commitInfo.committerDate,
    parents: commitInfo.parents,
    files,
    branches,
    autoExplain: opts.autoExplain ?? false,
    aiEnabled: vscode.workspace.getConfiguration('gitcharm').get('ai.enabled', true),
    aiModelLabel: getAiModelLabel(vscode.workspace.getConfiguration('gitcharm')),
  });

  panel.webview.onDidReceiveMessage(async (msg: { type: string; filePath?: string; fileStatus?: string; hash?: string; parents?: string[]; requestId?: string }) => {
    if (msg.type === 'explainCommit') {
      try {
        const cfg = vscode.workspace.getConfiguration('gitcharm');
        const maxDiffChars: number = cfg.get('ai.maxDiffChars', 8000);
        const configuredLang: string = cfg.get('ai.language', '');
        const language = configuredLang.trim() || vscode.env.language || 'en';

        const diff = await repo.getCommitDiff(hash, maxDiffChars);

        const fileList = files.slice(0, 50).map(f => `${f.status[0].toUpperCase()} ${f.path}`).join('\n');
        const prompt = [
          'You are a code reviewer explaining a git commit to a developer.',
          '',
          'Rules:',
          `- Write the explanation in this language: ${language}`,
          '- Start with a one-sentence summary of what this commit does',
          '- Then explain the key changes: what was modified and why',
          '- Be specific: reference file names, function names, or module names when relevant',
          '- Keep it concise but complete (3-8 sentences or bullet points)',
          '- Output ONLY the explanation, no markdown fences, no preamble',
          '',
          `## Commit: ${commitInfo!.shortHash}`,
          `## Message: ${fullMessage.trim() || commitInfo!.message}`,
          '',
          '## Changed files',
          fileList,
          diff ? `\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`` : '',
        ].filter(Boolean).join('\n');

        const { generateWithAI } = await import('../ai/aiGenerate');
        const explanation = await generateWithAI(
          cfg.get('ai.provider', 'vscode-lm'),
          prompt,
          cfg,
        );
        panel.webview.postMessage({ type: 'explainCommitResult', explanation });
      } catch (e: unknown) {
        panel.webview.postMessage({ type: 'explainCommitResult', error: String(e) });
      }
      return;
    }
    if (msg.type === 'getMergeCommits' && msg.hash && msg.parents && msg.requestId) {
      try {
        const commits = await repo.getMergeCommits(msg.hash, msg.parents);
        panel.webview.postMessage({ type: 'mergeCommitsResult', requestId: msg.requestId, commits });
      } catch {
        panel.webview.postMessage({ type: 'mergeCommitsResult', requestId: msg.requestId, commits: [] });
      }
      return;
    }
    if (msg.type === 'getMergeFiles' && msg.hash && msg.requestId) {
      try {
        const mergeFiles = await repo.getCommitFiles(msg.hash);
        panel.webview.postMessage({ type: 'mergeFilesResult', requestId: msg.requestId, files: mergeFiles });
      } catch {
        panel.webview.postMessage({ type: 'mergeFilesResult', requestId: msg.requestId, files: [] });
      }
      return;
    }
    if (msg.type === 'openDiff' && msg.filePath) {
      try {
        const pathMod = await import('path');
        const status = msg.fileStatus ?? 'M';
        const diffHash = msg.hash ?? hash; // support merge commit files
        const fileName = pathMod.basename(msg.filePath);
        const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        const gitUri = (ref: string) => vscode.Uri.from({
          scheme: 'git',
          path: pathMod.join(repo.rootPath, msg.filePath!),
          query: JSON.stringify({ path: pathMod.join(repo.rootPath, msg.filePath!), ref }),
        });
        let leftUri: vscode.Uri;
        let rightUri: vscode.Uri;
        let title: string;
        if (status === 'A') {
          leftUri = gitUri(EMPTY_TREE); rightUri = gitUri(diffHash);
          title = `${fileName} (added in ${diffHash.slice(0, 7)})`;
        } else if (status === 'D') {
          leftUri = gitUri(`${diffHash}~1`); rightUri = gitUri(EMPTY_TREE);
          title = `${fileName} (deleted in ${diffHash.slice(0, 7)})`;
        } else {
          leftUri = gitUri(`${diffHash}~1`); rightUri = gitUri(diffHash);
          title = `${fileName} (${diffHash.slice(0, 7)})`;
        }
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`GitCharm: Cannot open diff: ${String(e)}`);
      }
    } else if (msg.type === 'openFile' && msg.filePath) {
      const fileUri = vscode.Uri.joinPath(vscode.Uri.file(repo.rootPath), msg.filePath);
      vscode.commands.executeCommand('vscode.open', fileUri);
    } else if (msg.type === 'revealInExplorer' && msg.filePath) {
      const fileUri = vscode.Uri.joinPath(vscode.Uri.file(repo.rootPath), msg.filePath);
      vscode.commands.executeCommand('revealInExplorer', fileUri);
    } else if (msg.type === 'revealInOS' && msg.filePath) {
      const fileUri = vscode.Uri.joinPath(vscode.Uri.file(repo.rootPath), msg.filePath);
      vscode.commands.executeCommand('revealFileInOS', fileUri);
    } else if (msg.type === 'revertFile' && msg.filePath) {
      const confirmed = await vscode.window.showWarningMessage(
        `Revert changes to "${msg.filePath}" from commit ${commitInfo!.shortHash}?`,
        { modal: true }, 'Revert'
      );
      if (confirmed !== 'Revert') return;
      try {
        if (msg.fileStatus === 'A') {
          const pathMod = await import('path');
          const uri = vscode.Uri.file(pathMod.join(repo.rootPath, msg.filePath));
          await vscode.workspace.fs.delete(uri, { useTrash: false });
        } else {
          await repo.revertFileToParent(hash, msg.filePath);
        }
        vscode.window.showInformationMessage(`GitCharm: Reverted "${msg.filePath}".`);
        panel.webview.postMessage({ type: 'revertDone', filePath: msg.filePath });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`GitCharm: Revert failed: ${String(e)}`);
      }
    }
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

interface PanelData {
  repoName: string;
  repoId: string;
  hash: string;
  shortHash: string;
  message: string;
  fullMessage: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerDate: string;
  parents: string[];
  files: Array<{ path: string; status: string; added?: number; removed?: number }>;
  branches: { local: string[]; remote: string[]; tags: string[] };
  autoExplain: boolean;
  aiEnabled: boolean;
  aiModelLabel: string;
}

function getAiModelLabel(cfg: vscode.WorkspaceConfiguration): string {
  const provider: string = cfg.get('ai.provider', 'vscode-lm');
  switch (provider) {
    case 'claude-api': {
      const model: string = cfg.get('ai.claudeModel', 'claude-sonnet-4-6');
      return `claude api · ${model || 'claude-sonnet-4-6'}`;
    }
    case 'openai-api': {
      const model: string = cfg.get('ai.openaiModel', 'gpt-4o');
      return `openai api · ${model || 'gpt-4o'}`;
    }
    case 'claude-cli': {
      const model: string = cfg.get('ai.claudeModel', '');
      return model ? `claude · ${model}` : 'claude';
    }
    case 'codex-cli': {
      const model: string = cfg.get('ai.codexModel', '');
      return model ? `codex · ${model}` : 'codex';
    }
    case 'ollama': {
      const model: string = cfg.get('ai.ollamaModel', 'llama3');
      return `ollama · ${model}`;
    }
    case 'lmstudio': {
      const model: string = cfg.get('ai.lmStudioModel', '');
      return model ? `lmstudio · ${model}` : 'lmstudio';
    }
    default: {
      const modelId: string = cfg.get('ai.modelId', '');
      return modelId ? modelId.replace('copilot:', '') : 'copilot';
    }
  }
}

function getHtml(nonce: string, csp: string, codiconUri: string, data: PanelData): string {
  // remote entries come in as "origin/feat" — split into remote + name
  const allBranches = [
    ...data.branches.local.map(b => ({ type: 'local',  name: b, remote: '' })),
    ...data.branches.remote.map(b => {
      const slash = b.indexOf('/');
      return slash >= 0
        ? { type: 'remote', name: b.slice(slash + 1), remote: b.slice(0, slash) }
        : { type: 'remote', name: b, remote: '' };
    }),
    ...data.branches.tags.map(b => ({ type: 'tag', name: b, remote: '' })),
  ];

  const authorInitials = data.authorName.split(' ').map((p: string) => p[0] ?? '').join('').slice(0, 2).toUpperCase();
  const fullMsgDisplay = data.fullMessage || data.message;

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

    /* ── Top toolbar ── */
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .toolbar-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; opacity: 0.6;
    }
    .toolbar-message {
      flex: 1; font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ── Split layout ── */
    .split { display: flex; flex: 1; overflow: hidden; }

    /* ── Left panel ── */
    .left-panel {
      width: 50%; min-width: 260px; max-width: 680px;
      display: flex; flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border);
      overflow-y: auto;
      padding: 20px 24px;
      gap: 20px;
    }
    .section-label {
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      opacity: 0.5; margin-bottom: 6px;
    }
    .author-row { display: flex; align-items: center; gap: 10px; }
    .avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 600; flex-shrink: 0;
    }
    .author-meta { display: flex; flex-direction: column; gap: 2px; }
    .author-name { font-weight: 500; }
    .author-email { font-size: 11px; opacity: 0.55; }
    .meta-grid {
      display: grid; grid-template-columns: max-content 1fr;
      gap: 4px 14px; align-items: start;
    }
    .meta-key { opacity: 0.55; font-size: 12px; white-space: nowrap; }
    .meta-val { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
    .meta-val.normal { font-family: var(--vscode-font-family); word-break: normal; }
    .refs-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .ref-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 7px; border-radius: 10px;
      font-size: 11px; font-weight: 500;
      border: 1px solid currentColor; opacity: 0.9;
    }
    .ref-badge .codicon { font-size: 10px; }
    .ref-local  { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
    .ref-remote { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .ref-tag    { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c6e7); }
    .commit-message {
      background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px; padding: 12px 14px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; line-height: 1.7;
      white-space: pre-wrap; word-break: break-word;
    }

    /* ── Right panel ── */
    .right-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .file-toolbar {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .file-count { font-size: 11px; opacity: 0.55; flex: 1; padding-left: 4px; }
    .tb-btn {
      background: none; border: none; cursor: pointer;
      padding: 3px 4px; border-radius: 3px;
      color: var(--vscode-foreground); opacity: 0.6;
      display: flex; align-items: center;
      font-size: 13px;
    }
    .tb-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .tb-btn.active { opacity: 1; background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }

    .file-list { flex: 1; overflow-y: auto; padding: 2px 0; }

    /* Flat rows */
    .file-row {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 8px 3px 0; cursor: pointer; user-select: none;
    }
    .file-row:hover { background: var(--vscode-list-hoverBackground); }
    .file-row.ctx-active { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); }
    .row-indent { flex-shrink: 0; }
    .row-icon { font-size: 14px; flex-shrink: 0; opacity: 0.85; }
    .row-name { font-size: 12px; white-space: nowrap; font-weight: 500; }
    .row-dir { font-size: 11px; opacity: 0.45; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .row-stats { display: flex; gap: 3px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); flex-shrink: 0; }
    .row-status { font-size: 10px; font-weight: 700; flex-shrink: 0; opacity: 0.85; margin-right: 6px; }
    .added   { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
    .removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }

    /* Tree dir rows */
    .dir-row {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 8px 3px 0; cursor: pointer; user-select: none;
    }
    .dir-row:hover { background: var(--vscode-list-hoverBackground); }
    .dir-name { font-size: 12px; white-space: nowrap; opacity: 0.85; }
    .dir-badge {
      font-size: 10px; opacity: 0.45;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 8px; padding: 0 5px; flex-shrink: 0;
    }

    /* Context menu */
    .ctx-menu {
      position: fixed;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px; padding: 3px 0;
      min-width: 200px; z-index: 9999;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    .ctx-menu.hidden { display: none; }
    .ctx-item {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 12px; font-size: 12px; cursor: pointer;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
    }
    .ctx-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
    .ctx-sep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 3px 0; }
    .ctx-item.danger { color: var(--vscode-errorForeground); }

    /* ── Merged commits ── */
    .merge-section {
      display: flex; flex-direction: column; gap: 2px;
      flex-shrink: 0; max-height: 200px; overflow-y: auto;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .merge-title {
      display: flex; align-items: center; gap: 5px;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      opacity: 0.5; margin-bottom: 4px;
    }
    .merge-loading { font-size: 11px; opacity: 0.5; padding: 4px 0; }
    .merge-commit-row {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 6px; border-radius: 3px; cursor: pointer;
      font-size: 11px;
    }
    .merge-commit-row:hover { background: var(--vscode-list-hoverBackground); }
    .merge-commit-row.active { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); }
    .merge-hash { font-family: var(--vscode-editor-font-family, monospace); opacity: 0.6; flex-shrink: 0; }
    .merge-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .merge-author { opacity: 0.45; flex-shrink: 0; font-size: 10px; }
    .merge-files { padding-left: 16px; display: flex; flex-direction: column; gap: 1px; margin-bottom: 2px; }
    .merge-file-row {
      display: flex; align-items: center; gap: 5px;
      padding: 2px 4px; border-radius: 3px; cursor: pointer; font-size: 11px;
    }
    .merge-file-row:hover { background: var(--vscode-list-hoverBackground); }
    .merge-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .merge-file-status { font-size: 10px; font-weight: 700; flex-shrink: 0; }

    /* ── AI Explanation ── */
    .ai-section {
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .ai-header {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 16px; cursor: pointer; user-select: none;
    }
    .ai-header:hover { background: var(--vscode-list-hoverBackground); }
    .ai-title {
      flex: 1; font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6;
    }
    .ai-model-label {
      font-size: 10px; opacity: 0.5;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 160px;
    }
    .ai-toggle-btn {
      display: flex; align-items: center; gap: 5px;
      border: none; cursor: pointer;
      padding: 5px 10px; border-radius: 4px; font-size: 12px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      opacity: 0.9;
    }
    .ai-toggle-btn:hover { opacity: 1; }
    .ai-toggle-btn:disabled { opacity: 0.4; cursor: default; }
    .ai-body {
      padding: 0 16px 14px;
    }
    .hidden { display: none !important; }
    .ai-body.hidden { display: none; }
    .ai-text {
      font-size: 12px; line-height: 1.65;
      white-space: pre-wrap; word-break: break-word;
      color: var(--vscode-editor-foreground);
      max-height: 240px; overflow-y: auto;
    }
    .ai-error { font-size: 12px; color: var(--vscode-errorForeground); }
    .ai-loading {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; opacity: 0.6;
    }
    .spin { animation: spin 1s linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="codicon codicon-git-commit" style="opacity:0.6"></span>
    <span class="toolbar-hash">${escHtml(data.shortHash)}</span>
    <span class="toolbar-message">${escHtml(data.message)}</span>
  </div>

  ${data.aiEnabled ? `
  <div class="ai-section" id="aiSection">
    <div class="ai-header" id="aiHeader">
      <span class="codicon codicon-sparkle" style="font-size:13px;opacity:0.7"></span>
      <span class="ai-title">AI Explanation</span>
      <span class="ai-model-label">${escHtml(data.aiModelLabel)}</span>
      <button class="ai-toggle-btn" id="aiBtn" title="Generate AI explanation">
        <span class="codicon codicon-sparkle"></span>
        <span id="aiBtnLabel">Generate</span>
      </button>
    </div>
    <div class="ai-body hidden" id="aiBody">
      <div class="ai-loading hidden" id="aiLoading">
        <span class="codicon codicon-loading spin"></span>
        <span>Generating explanation…</span>
      </div>
      <div class="ai-error hidden" id="aiError"></div>
      <div class="ai-text" id="aiText"></div>
    </div>
  </div>` : ''}

  <div class="split">
    <div class="left-panel">
      <div>
        <div class="section-label">Author</div>
        <div class="author-row">
          <div class="avatar" id="authorAvatar" title="${escHtml(data.authorName)} &lt;${escHtml(data.authorEmail)}&gt;">${escHtml(authorInitials)}</div>
          <div class="author-meta">
            <span class="author-name">${escHtml(data.authorName)}</span>
            <span class="author-email">${escHtml(data.authorEmail)}</span>
          </div>
        </div>
      </div>
      <div>
        <div class="section-label">Details</div>
        <div class="meta-grid">
          <span class="meta-key">Hash</span>
          <span class="meta-val">${escHtml(data.hash)}</span>
          <span class="meta-key">Author date</span>
          <span class="meta-val normal" id="authorDate">${escHtml(data.authorDate)}</span>
          <span class="meta-key">Commit date</span>
          <span class="meta-val normal" id="committerDate">${escHtml(data.committerDate)}</span>
          <span class="meta-key">Repository</span>
          <span class="meta-val normal">${escHtml(data.repoName)}</span>
        </div>
      </div>
      ${allBranches.length > 0 ? `<div id="refsSection">
        <div class="section-label">Branches &amp; tags</div>
        <div class="refs-row" id="refsRow"></div>
      </div>` : ''}
      <div>
        <div class="section-label">Commit message</div>
        <pre class="commit-message">${escHtml(fullMsgDisplay)}</pre>
      </div>
    </div>

    <div class="right-panel">
      ${data.parents.length >= 2 ? `<div class="merge-section" id="mergeSection">
        <div class="merge-title"><span class="codicon codicon-git-merge" style="font-size:11px"></span>Merged commits</div>
        <div id="mergeList"><div class="merge-loading">Loading...</div></div>
      </div>` : ''}
      <div class="file-toolbar">
        <span class="file-count" id="fileCount">${data.files.length} file${data.files.length !== 1 ? 's' : ''} changed</span>
        <button class="tb-btn" id="btnExpandAll" title="Expand all" style="display:none"><span class="codicon codicon-expand-all"></span></button>
        <button class="tb-btn" id="btnCollapseAll" title="Collapse all" style="display:none"><span class="codicon codicon-collapse-all"></span></button>
        <button class="tb-btn active" id="btnTree" title="Tree view"><span class="codicon codicon-list-tree"></span></button>
        <button class="tb-btn" id="btnFlat" title="Flat view"><span class="codicon codicon-list-flat"></span></button>
      </div>
      <div class="file-list" id="fileList"></div>
    </div>
  </div>

  <div class="ctx-menu hidden" id="ctxMenu">
    <div class="ctx-item" id="ctxDiff"><span class="codicon codicon-diff"></span>Show Diff</div>
    <div class="ctx-item" id="ctxEdit"><span class="codicon codicon-go-to-file"></span>Edit Source</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" id="ctxRevert"><span class="codicon codicon-discard"></span>Revert Selected Changes</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" id="ctxRevealExp"><span class="codicon codicon-list-tree"></span>Reveal in Explorer</div>
    <div class="ctx-item" id="ctxRevealOS"><span class="codicon codicon-folder-opened"></span><span id="revealOsLabel"></span></div>
  </div>

  <script id="__data" type="application/json">${escJson({
    files: data.files,
    parents: data.parents,
    hash: data.hash,
    repoId: data.repoId,
    authorDate: data.authorDate,
    committerDate: data.committerDate,
    authorEmail: data.authorEmail,
    authorName: data.authorName,
    branches: allBranches,
    autoExplain: data.autoExplain,
  })}</script>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('revealOsLabel').textContent = 'Reveal in File Manager';

    // ── Load all dynamic data from JSON data block ──
    const __d = JSON.parse(document.getElementById('__data').textContent);
    const FILES = __d.files;

    // ── Escape helpers ──
    function escText(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function escAttr(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Date formatting ──
    function fmtDate(iso) {
      if (!iso) return iso;
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
             + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch { return iso; }
    }
    document.getElementById('authorDate').textContent    = fmtDate(__d.authorDate);
    document.getElementById('committerDate').textContent = fmtDate(__d.committerDate);

    // ── Status colors ──
    const STATUS_COLOR = {
      M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
      A: 'var(--vscode-gitDecoration-addedResourceForeground)',
      D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
      R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
      C: 'var(--vscode-gitDecoration-addedResourceForeground)',
      U: 'var(--vscode-gitDecoration-conflictingResourceForeground)',
    };
    function statusColor(s) { return STATUS_COLOR[s] || 'var(--vscode-foreground)'; }

    // ── Codicon icon helpers ──
    const EXT_CODICONS = {
      ts:'symbol-variable', tsx:'symbol-variable', js:'symbol-variable', jsx:'symbol-variable',
      json:'json', jsonc:'json', md:'markdown', mdx:'markdown',
      html:'symbol-method', htm:'symbol-method',
      css:'symbol-color', scss:'symbol-color', less:'symbol-color',
      svg:'symbol-color', png:'symbol-color', jpg:'symbol-color', jpeg:'symbol-color',
      py:'symbol-namespace', rb:'symbol-namespace', go:'symbol-namespace', rs:'symbol-namespace',
      java:'symbol-namespace', kt:'symbol-namespace', swift:'symbol-namespace', cs:'symbol-namespace',
      cpp:'symbol-namespace', c:'symbol-namespace', h:'symbol-namespace',
      sh:'terminal', bash:'terminal', zsh:'terminal',
      yml:'list-ordered', yaml:'list-ordered', toml:'list-ordered', ini:'list-ordered',
      lock:'lock', sql:'database', xml:'symbol-structure', proto:'symbol-structure',
      txt:'file-text', log:'output',
    };
    function fileIconHtml(name) {
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      const icon = EXT_CODICONS[ext] || 'file';
      return '<span class="codicon codicon-' + icon + '" style="font-size:14px;opacity:0.75;flex-shrink:0;" aria-hidden="true"></span>';
    }
    function folderIconHtml(open) {
      return '<span class="codicon codicon-' + (open ? 'folder-opened' : 'folder') + '" style="font-size:14px;opacity:0.75;flex-shrink:0;" aria-hidden="true"></span>';
    }

    // ── Stats HTML helper ──
    function statsHtml(f) {
      let s = '';
      if (f.added   != null) s += '<span class="added">+' + f.added   + '</span>';
      if (f.removed != null) s += '<span class="removed">-' + f.removed + '</span>';
      return s ? '<span class="row-stats">' + s + '</span>' : '';
    }

    // ── Context menu ──
    const ctxMenu  = document.getElementById('ctxMenu');
    let ctxPath = null, ctxStatus = null;

    function showCtx(x, y, path, status) {
      ctxPath = path; ctxStatus = status;
      ctxMenu.classList.remove('hidden');
      requestAnimationFrame(() => {
        const margin = 4;
        const { offsetWidth: w, offsetHeight: h } = ctxMenu;
        ctxMenu.style.left = Math.max(margin, Math.min(x, window.innerWidth  - w - margin)) + 'px';
        ctxMenu.style.top  = Math.max(margin, Math.min(y, window.innerHeight - h - margin)) + 'px';
      });
    }
    function hideCtx() {
      ctxMenu.classList.add('hidden');
      document.querySelectorAll('.file-row.ctx-active').forEach(el => el.classList.remove('ctx-active'));
    }
    document.addEventListener('mousedown', e => { if (!ctxMenu.contains(e.target)) hideCtx(); }, true);
    window.addEventListener('blur', hideCtx);

    document.getElementById('ctxDiff').addEventListener('click',      () => { if (ctxPath) vscode.postMessage({ type: 'openDiff',         filePath: ctxPath, fileStatus: ctxStatus }); hideCtx(); });
    document.getElementById('ctxEdit').addEventListener('click',      () => { if (ctxPath) vscode.postMessage({ type: 'openFile',         filePath: ctxPath }); hideCtx(); });
    document.getElementById('ctxRevert').addEventListener('click',    () => { if (ctxPath) vscode.postMessage({ type: 'revertFile',       filePath: ctxPath, fileStatus: ctxStatus }); hideCtx(); });
    document.getElementById('ctxRevealExp').addEventListener('click', () => { if (ctxPath) vscode.postMessage({ type: 'revealInExplorer', filePath: ctxPath }); hideCtx(); });
    document.getElementById('ctxRevealOS').addEventListener('click',  () => { if (ctxPath) vscode.postMessage({ type: 'revealInOS',       filePath: ctxPath }); hideCtx(); });

    // ── Tree builder ──
    function buildTree(files) {
      const root = { name: '', fullPath: '', children: new Map(), file: null, fileCount: 0 };
      for (const f of files) {
        const parts = f.path.split('/');
        let node = root, acc = '';
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          acc = acc ? acc + '/' + p : p;
          if (!node.children.has(p)) node.children.set(p, { name: p, fullPath: acc, children: new Map(), file: null, fileCount: 0 });
          node = node.children.get(p);
          if (i === parts.length - 1) node.file = f;
        }
      }
      countFiles(root);
      return root;
    }
    function countFiles(node) {
      if (node.file) { node.fileCount = 1; return 1; }
      let n = 0;
      for (const c of node.children.values()) n += countFiles(c);
      node.fileCount = n;
      return n;
    }
    function collapseDirs(node) {
      if (node.file) return node;
      if (node.children.size === 1) {
        const [, child] = node.children.entries().next().value;
        if (!child.file) {
          const col = collapseDirs(child);
          const joined = node.name ? node.name + '/' + col.name : col.name;
          return { ...col, name: joined };
        }
      }
      const nc = new Map();
      for (const [k, v] of node.children) nc.set(k, collapseDirs(v));
      return { ...node, children: nc };
    }

    // ── Render state ──
    let viewMode = 'tree';
    // Map<fullPath, boolean> — open/closed state per dir node
    const dirOpen = new Map();
    // forceAll: null = use dirOpen, true = all open, false = all closed
    let forceAll = null;

    function isDirOpen(fullPath) {
      if (forceAll !== null) return forceAll;
      if (!dirOpen.has(fullPath)) return true; // default open
      return dirOpen.get(fullPath);
    }
    function toggleDir(fullPath) {
      forceAll = null;
      dirOpen.set(fullPath, !isDirOpen(fullPath));
      render();
    }

    // ── Tree rendering ──
    function renderTreeNode(node, depth, buf) {
      if (node.file) {
        const f = node.file;
        const col = statusColor(f.status);
        buf.push(
          '<div class="file-row" data-path="' + escAttr(f.path) + '" data-status="' + escAttr(f.status) + '" title="' + escAttr(f.path) + '">' +
          '<div class="row-indent" style="width:' + (depth * 14 + 4) + 'px"></div>' +
          fileIconHtml(node.name) +
          '<span class="row-name" style="color:' + col + '">' + escText(node.name) + '</span>' +
          statsHtml(f) +
          '<span class="row-status" style="color:' + col + '">' + escText(f.status) + '</span>' +
          '</div>'
        );
        return;
      }
      const open = isDirOpen(node.fullPath);
      // last segment for folder icon lookup (collapsed dirs may have '/' in name)
      const folderBase = node.name.includes('/') ? node.name.split('/').pop() : node.name;
      buf.push(
        '<div class="dir-row" data-dir="' + escAttr(node.fullPath) + '">' +
        '<div class="row-indent" style="width:' + (depth * 14 + 2) + 'px"></div>' +
        '<span class="codicon ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="font-size:12px;opacity:0.6;flex-shrink:0;"></span>' +
        folderIconHtml(open) +
        '<span class="dir-name">' + escText(node.name) + '</span>' +
        '<span class="dir-badge">' + node.fileCount + '</span>' +
        '</div>'
      );
      if (open) {
        const sorted = Array.from(node.children.values()).sort((a, b) => {
          if (!a.file && b.file) return -1;
          if (a.file && !b.file) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const child of sorted) renderTreeNode(child, depth + 1, buf);
      }
    }

    function renderFlat() {
      const buf = [];
      for (const f of FILES) {
        const col  = statusColor(f.status);
        const name = f.path.includes('/') ? f.path.split('/').pop() : f.path;
        const dir  = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        buf.push(
          '<div class="file-row" data-path="' + escAttr(f.path) + '" data-status="' + escAttr(f.status) + '" title="' + escAttr(f.path) + '">' +
          '<div class="row-indent" style="width:4px"></div>' +
          fileIconHtml(name) +
          '<span class="row-name" style="color:' + col + '">' + escText(name) + '</span>' +
          (dir ? '<span class="row-dir">' + escText(dir) + '</span>' : '') +
          statsHtml(f) +
          '<span class="row-status" style="color:' + col + '">' + escText(f.status) + '</span>' +
          '</div>'
        );
      }
      return buf.join('');
    }

    function render() {
      const listEl = document.getElementById('fileList');
      const btnExpandAll    = document.getElementById('btnExpandAll');
      const btnCollapseAll  = document.getElementById('btnCollapseAll');
      if (viewMode === 'flat') {
        listEl.innerHTML = renderFlat();
        btnExpandAll.style.display   = 'none';
        btnCollapseAll.style.display = 'none';
      } else {
        const tree = buildTree(FILES);
        const root = collapseDirs(tree);
        const buf = [];
        const sorted = Array.from(root.children.values()).sort((a, b) => {
          if (!a.file && b.file) return -1;
          if (a.file && !b.file) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const child of sorted) renderTreeNode(child, 0, buf);
        listEl.innerHTML = buf.join('');
        btnExpandAll.style.display   = '';
        btnCollapseAll.style.display = '';
        console.log('[GitCharm] render tree: html length=' + listEl.innerHTML.length);
      }
    }

    // ── Event delegation on file list ──
    const listEl = document.getElementById('fileList');
    listEl.addEventListener('click', e => {
      const dirRow  = e.target.closest('.dir-row');
      const fileRow = e.target.closest('.file-row');
      if (dirRow)  { toggleDir(dirRow.dataset.dir); return; }
      if (fileRow) { vscode.postMessage({ type: 'openDiff', filePath: fileRow.dataset.path, fileStatus: fileRow.dataset.status }); }
    });
    listEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      const row = e.target.closest('.file-row');
      if (!row) return;
      document.querySelectorAll('.file-row.ctx-active').forEach(el => el.classList.remove('ctx-active'));
      row.classList.add('ctx-active');
      showCtx(e.clientX, e.clientY, row.dataset.path, row.dataset.status);
    });

    // ── Toolbar buttons ──
    document.getElementById('btnTree').addEventListener('click', () => {
      viewMode = 'tree'; forceAll = null;
      document.getElementById('btnTree').classList.add('active');
      document.getElementById('btnFlat').classList.remove('active');
      render();
    });
    document.getElementById('btnFlat').addEventListener('click', () => {
      viewMode = 'flat';
      document.getElementById('btnFlat').classList.add('active');
      document.getElementById('btnTree').classList.remove('active');
      render();
    });
    document.getElementById('btnExpandAll').addEventListener('click', () => {
      forceAll = true; render();
    });
    document.getElementById('btnCollapseAll').addEventListener('click', () => {
      forceAll = false; render();
    });

    // ── Initial render ──
    render();

    // ── Author avatar (Gravatar / GitHub) — runs after render, isolated ──
    try {
      (async () => {
        const authorEmail = __d.authorEmail;
        const authorName  = __d.authorName;
        const SIZE = 36;

        function avatarColor(email) {
          let h = 0;
          for (let i = 0; i < email.length; i++) h = email.charCodeAt(i) + ((h << 5) - h);
          return 'hsl(' + (Math.abs(h) % 360) + ',55%,45%)';
        }

        const avatarEl = document.getElementById('authorAvatar');
        avatarEl.style.background = avatarColor(authorEmail);
        avatarEl.style.color = '#fff';

        function isBlankImage(url) {
          return new Promise(resolve => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              try {
                const c = document.createElement('canvas');
                c.width = 8; c.height = 8;
                const ctx = c.getContext('2d');
                if (!ctx) { resolve(false); return; }
                ctx.drawImage(img, 0, 0, 8, 8);
                const px = ctx.getImageData(0, 0, 8, 8).data;
                const uniq = new Set();
                for (let i = 0; i < px.length; i += 4)
                  uniq.add((Math.round(px[i]/16) << 8) | (Math.round(px[i+1]/16) << 4) | Math.round(px[i+2]/16));
                resolve(uniq.size <= 3);
              } catch { resolve(false); }
            };
            img.onerror = () => resolve(true);
            img.src = url;
          });
        }

        async function resolveAvatarUrl() {
          if (authorEmail.toLowerCase().endsWith('@users.noreply.github.com')) {
            const local = authorEmail.split('@')[0] || '';
            const username = local.includes('+') ? local.split('+')[1] : local;
            if (username) {
              const url = 'https://avatars.githubusercontent.com/' + username + '?size=' + (SIZE * 2);
              if (!(await isBlankImage(url))) return url;
            }
            return null;
          }
          const norm = authorEmail.trim().toLowerCase();
          const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
          const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
          const url = 'https://gravatar.com/avatar/' + hex + '?s=' + (SIZE * 2) + '&d=404';
          return (await isBlankImage(url)) ? null : url;
        }

        const url = await resolveAvatarUrl();
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.style.cssText = 'width:' + SIZE + 'px;height:' + SIZE + 'px;border-radius:50%;object-fit:cover;';
          img.onerror = () => {};
          avatarEl.textContent = '';
          avatarEl.style.background = 'none';
          avatarEl.appendChild(img);
        }
      })();
    } catch(e) { /* avatar is optional */ }

    // ── Branch / tag badges — runs after render, isolated ──
    try {
      const refsRow = document.getElementById('refsRow');
      if (refsRow) {
        const BRANCHES = __d.branches;
        const PAL_D = ['#6a9fc2','#a07cb0','#5aaa96','#b87c5a','#7a9e5a','#b09050','#7085b8','#a06060','#5a8fa0','#908060','#7aaa70','#9a7060'];
        const PAL_L = ['#2a6090','#6a3a80','#2a7a68','#8a4a28','#3a6a28','#7a5a18','#3a4a88','#7a2828','#1a5a70','#605030','#3a6a30','#603828'];
        const PRIM  = ['main','master','develop','dev','trunk','release'];
        const dark  = () => document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
        function normB(n) { const i=n.indexOf('/'); return i>=0?n.slice(i+1):n; }
        function hashB(n) { let h=0; const s=normB(n); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h%PAL_D.length; }
        function bColor(n) {
          if (PRIM.includes(normB(n).toLowerCase())) {
            const raw = getComputedStyle(document.body).getPropertyValue('--vscode-button-background').trim() || '#0078d4';
            const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(raw);
            return m ? raw : '#0078d4';
          }
          return (dark() ? PAL_D : PAL_L)[hashB(n)];
        }
        const tColor = () => dark() ? '#4aaa9a' : '#1a7a6a';
        for (const b of BRANCHES) {
          const color = b.type === 'tag' ? tColor() : bColor(b.name);
          const icon  = b.type === 'tag' ? 'tag' : b.type === 'remote' ? 'cloud' : 'git-branch';
          const label = b.type === 'remote' && b.remote ? b.remote + '/' + b.name : b.name;
          const sp = document.createElement('span');
          sp.title = (b.type==='tag'?'Tag: ':b.type==='remote'?'Remote: ':'Branch: ') + label;
          sp.style.cssText = 'font-size:10px;padding:0 6px;height:16px;line-height:16px;border-radius:3px;display:inline-flex;align-items:center;gap:3px;background:' + color + '33;color:' + color + ';border:1px solid ' + color + '88;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;box-sizing:border-box;font-weight:500;margin:2px;';
          sp.innerHTML = '<span class="codicon codicon-' + icon + '" style="font-size:10px;flex-shrink:0;line-height:1"></span>' + escText(label);
          refsRow.appendChild(sp);
        }
      }
    } catch(e) { /* badges are optional */ }

    // ── Merged commits ──
    try {
      const mergeListEl = document.getElementById('mergeList');
      if (mergeListEl && __d.parents && __d.parents.length >= 2) {
        const pending = new Map();
        let selectedMergeHash = null;

        window.addEventListener('message', e => {
          const cb = pending.get(e.data?.requestId);
          if (cb) { pending.delete(e.data.requestId); cb(e.data); }
        });

        function reqId() { return Math.random().toString(36).slice(2); }

        function renderMergeList(commits, mergeFiles) {
          const buf = [];
          for (const c of commits) {
            const isActive = selectedMergeHash === c.hash;
            buf.push(
              '<div class="merge-commit-row' + (isActive ? ' active' : '') + '" data-hash="' + escAttr(c.hash) + '" title="' + escAttr(c.hash) + '">' +
              '<span class="codicon codicon-' + (isActive ? 'chevron-down' : 'chevron-right') + '" style="font-size:10px;opacity:0.5;flex-shrink:0"></span>' +
              '<span class="merge-hash">' + escText(c.shortHash) + '</span>' +
              '<span class="merge-msg">' + escText(c.message) + '</span>' +
              '<span class="merge-author">' + escText(c.authorName) + '</span>' +
              '</div>'
            );
            if (isActive) {
              buf.push('<div class="merge-files">');
              if (!mergeFiles) {
                buf.push('<div class="merge-loading">Loading files...</div>');
              } else if (mergeFiles.length === 0) {
                buf.push('<div class="merge-loading">No changed files</div>');
              } else {
                for (const f of mergeFiles) {
                  const col = statusColor(f.status);
                  const name = f.path.includes('/') ? f.path.split('/').pop() : f.path;
                  buf.push(
                    '<div class="merge-file-row" data-path="' + escAttr(f.path) + '" data-status="' + escAttr(f.status) + '" data-hash="' + escAttr(c.hash) + '" title="' + escAttr(f.path) + '">' +
                    fileIconHtml(name) +
                    '<span class="merge-file-name" style="color:' + col + '">' + escText(name) + '</span>' +
                    statsHtml(f) +
                    '<span class="merge-file-status" style="color:' + col + '">' + escText(f.status) + '</span>' +
                    '</div>'
                  );
                }
              }
              buf.push('</div>');
            }
          }
          mergeListEl.innerHTML = buf.join('');
        }

        // Load merge commits
        const rid = reqId();
        pending.set(rid, data => {
          const commits = data.commits || [];
          if (commits.length === 0) {
            mergeListEl.innerHTML = '<div class="merge-loading">No commits found</div>';
            return;
          }
          renderMergeList(commits, null);

          mergeListEl.addEventListener('click', e => {
            const row = e.target.closest('.merge-commit-row');
            const fileRow = e.target.closest('.merge-file-row');
            if (fileRow) {
              vscode.postMessage({ type: 'openDiff', filePath: fileRow.dataset.path, fileStatus: fileRow.dataset.status, hash: fileRow.dataset.hash });
              return;
            }
            if (!row) return;
            const clickedHash = row.dataset.hash;
            if (selectedMergeHash === clickedHash) {
              selectedMergeHash = null;
              renderMergeList(commits, null);
              // restore main file list
              document.getElementById('fileCount').textContent = FILES.length + ' file' + (FILES.length !== 1 ? 's' : '') + ' changed';
              render();
              return;
            }
            selectedMergeHash = clickedHash;
            renderMergeList(commits, null);
            // Load files for this merge commit
            const frid = reqId();
            pending.set(frid, fdata => {
              const mf = fdata.files || [];
              renderMergeList(commits, mf);
              // Show merge commit files in right panel
              document.getElementById('fileCount').textContent = mf.length + ' file' + (mf.length !== 1 ? 's' : '') + ' · ' + commits.find(c => c.hash === selectedMergeHash)?.shortHash;
              const listEl2 = document.getElementById('fileList');
              const buf2 = [];
              for (const f of mf) {
                const col = statusColor(f.status);
                const name = f.path.includes('/') ? f.path.split('/').pop() : f.path;
                const dir  = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
                buf2.push(
                  '<div class="file-row" data-path="' + escAttr(f.path) + '" data-status="' + escAttr(f.status) + '" data-hash="' + escAttr(selectedMergeHash) + '" title="' + escAttr(f.path) + '">' +
                  '<div class="row-indent" style="width:4px"></div>' +
                  fileIconHtml(name) +
                  '<span class="row-name" style="color:' + col + '">' + escText(name) + '</span>' +
                  (dir ? '<span class="row-dir">' + escText(dir) + '</span>' : '') +
                  statsHtml(f) +
                  '<span class="row-status" style="color:' + col + '">' + escText(f.status) + '</span>' +
                  '</div>'
                );
              }
              listEl2.innerHTML = buf2.join('');
            });
            vscode.postMessage({ type: 'getMergeFiles', hash: clickedHash, requestId: frid });
          });
        });
        vscode.postMessage({ type: 'getMergeCommits', hash: __d.hash, parents: __d.parents, requestId: rid });
      }
    } catch(e) { /* merge section is optional */ }

    // ── Revert feedback ──
    window.addEventListener('message', e => {
      if (e.data?.type === 'revertDone') {
        const row = document.querySelector('[data-path="' + CSS.escape(e.data.filePath) + '"]');
        if (row) { row.style.opacity = '0.4'; }
      }
    });

    // ── AI Explanation ──
    if (${data.aiEnabled}) {
      const aiBtn     = document.getElementById('aiBtn');
      const aiBtnLabel = document.getElementById('aiBtnLabel');
      const aiHeader  = document.getElementById('aiHeader');
      const aiBody    = document.getElementById('aiBody');
      const aiLoading = document.getElementById('aiLoading');
      const aiText    = document.getElementById('aiText');
      const aiError   = document.getElementById('aiError');
      let aiExpanded = false;

      window.addEventListener('message', e => {
        if (e.data?.type !== 'explainCommitResult') return;
        aiLoading.classList.add('hidden');
        aiBtn.disabled = false;
        aiBtnLabel.textContent = 'Regenerate';
        if (e.data.error) {
          aiError.textContent = e.data.error;
          aiError.classList.remove('hidden');
          aiText.textContent = '';
        } else {
          aiError.classList.add('hidden');
          aiText.textContent = e.data.explanation;
        }
      });

      function triggerExplain() {
        aiExpanded = true;
        aiBody.classList.remove('hidden');
        aiLoading.classList.remove('hidden');
        aiText.textContent = '';
        aiError.classList.add('hidden');
        aiBtn.disabled = true;
        aiBtnLabel.textContent = 'Generating…';
        vscode.postMessage({ type: 'explainCommit' });
      }

      aiBtn.addEventListener('click', e => { e.stopPropagation(); triggerExplain(); });
      aiHeader.addEventListener('click', () => {
        if (!aiExpanded) return;
        aiBody.classList.toggle('hidden');
      });

      if (${data.autoExplain}) { triggerExplain(); }
    }
  </script>
</body>
</html>`;
}
