import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import type { ChangedFile, HostToPrCreateMsg, PrCreateToHostMsg } from '../types/messages';
import { formatGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logInfo, logError } from '../utils/Logger';
import { pickRefQuickPick } from '../utils/refPicker';
import { loadIconTheme } from '../utils/IconThemeService';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const RAW_STATUS_MAP: Record<string, ChangedFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed' };

function mapRawFileToChangedFile(f: { path: string; status: string; added?: number; removed?: number; oldPath?: string }): ChangedFile {
  return { path: f.path, oldPath: f.oldPath, status: RAW_STATUS_MAP[f.status[0]] ?? 'modified', additions: f.added, deletions: f.removed };
}

/** Builds a `git:`-scheme URI for `filePath` at `ref` — the same virtual content source VS Code's built-in Git extension serves, so no custom content provider is needed for local branch-vs-branch diffs (see BranchStatusBar.compareSingleRepo, which this mirrors). */
function gitUri(rootPath: string, ref: string, filePath: string): vscode.Uri {
  const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
  return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
}

export class CreatePullRequestPanel {
  private panels = new Map<string, vscode.WebviewPanel>();
  /** Most recent PRCREATE_REQUEST_COMPARE requestId per repo — lets a stale in-flight compare discard its own result instead of clobbering a newer one. */
  private latestCompareRequestId = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly pullRequestManager: PullRequestManager,
    private readonly onCreated: () => void,
  ) {}

  async open(repoId: string): Promise<void> {
    if (this.panels.has(repoId)) {
      this.panels.get(repoId)!.reveal();
      return;
    }

    const meta = this.manager.getRepoMetas().find(m => m.id === repoId);
    if (!meta) {
      vscode.window.showErrorMessage('Repository not found');
      return;
    }

    const connection = await this.pullRequestManager.getConnectionStatus(repoId);

    // Icon theme assets (SVG icons, icon fonts) live in the icon theme's own extension, not GitCharm's —
    // without granting access here, FileIcon's <img>/@font-face URIs fail to load silently (see PullRequestDetailPanel, same fix).
    const localResourceRoots: vscode.Uri[] = [this.extensionUri];
    for (const ext of vscode.extensions.all) {
      const themes: Array<{ id: string }> = ext.packageJSON?.contributes?.iconThemes ?? [];
      if (themes.length > 0) localResourceRoots.push(vscode.Uri.file(ext.extensionPath));
    }

    const panel = vscode.window.createWebviewPanel(
      'gitcharm.createPullRequest',
      `New Pull Request — ${meta.name}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots }
    );
    panel.iconPath = new vscode.ThemeIcon('git-pull-request');

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      'pullRequestCreate',
      `New Pull Request — ${meta.name}`
    );

    const iconThemeWatcher = vscode.workspace.onDidChangeConfiguration(async e => {
      if (!e.affectsConfiguration('workbench.iconTheme')) return;
      const iconTheme = await loadIconTheme(panel.webview).catch(() => ({ type: 'none' as const }));
      panel.webview.postMessage({ type: 'PRCREATE_ICON_THEME', iconTheme } satisfies HostToPrCreateMsg);
    });

    panel.webview.onDidReceiveMessage((msg: PrCreateToHostMsg) => this.handleMessage(msg, repoId, panel));
    panel.onDidDispose(() => { this.panels.delete(repoId); this.latestCompareRequestId.delete(repoId); iconThemeWatcher.dispose(); });
    this.panels.set(repoId, panel);

    panel.webview.postMessage({
      type: 'PRCREATE_INIT', repoId, repoName: meta.name, provider: connection.provider,
    } satisfies HostToPrCreateMsg);

    const iconTheme = await loadIconTheme(panel.webview).catch(() => ({ type: 'none' as const }));
    panel.webview.postMessage({ type: 'PRCREATE_ICON_THEME', iconTheme } satisfies HostToPrCreateMsg);
  }

  private async handleMessage(msg: PrCreateToHostMsg, repoId: string, panel: vscode.WebviewPanel): Promise<void> {
    const post = (m: HostToPrCreateMsg) => panel.webview.postMessage(m);

    switch (msg.type) {
      case 'PRCREATE_REQUEST_BRANCHES': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) { post({ type: 'PRCREATE_BRANCHES_RESULT', branches: [], error: 'Repository not found' }); break; }
        try {
          const branches = await repo.getBranches();
          post({ type: 'PRCREATE_BRANCHES_RESULT', branches });
        } catch (e: unknown) {
          post({ type: 'PRCREATE_BRANCHES_RESULT', branches: [], error: formatGitError(e) });
        }
        break;
      }

      case 'PRCREATE_PICK_BRANCH': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) { post({ type: 'PRCREATE_BRANCH_PICKED', requestId: msg.requestId, role: msg.role, branch: undefined }); break; }
        const picked = await pickRefQuickPick(repo, {
          placeHolder: msg.role === 'source' ? 'Select source branch' : 'Select target branch',
          title: msg.role === 'source' ? 'Pull Request: Source Branch' : 'Pull Request: Target Branch',
          includeTags: false,
        });
        post({ type: 'PRCREATE_BRANCH_PICKED', requestId: msg.requestId, role: msg.role, branch: picked });
        break;
      }

      case 'PRCREATE_REQUEST_COMPARE': {
        this.latestCompareRequestId.set(repoId, msg.requestId);
        const repo = this.manager.getRepo(repoId);
        if (!repo) { post({ type: 'PRCREATE_COMPARE_RESULT', requestId: msg.requestId, files: [], commits: [], error: 'Repository not found' }); break; }
        try {
          const [baseHash, headHash] = await Promise.all([repo.resolveRef(msg.targetBranch), repo.resolveRef(msg.sourceBranch)]);
          const [rawFiles, commits] = await Promise.all([
            repo.getFilesBetween([baseHash, headHash]),
            repo.getCommitsBetween(baseHash, headHash),
          ]);
          if (this.latestCompareRequestId.get(repoId) !== msg.requestId) break;
          post({ type: 'PRCREATE_COMPARE_RESULT', requestId: msg.requestId, files: rawFiles.map(mapRawFileToChangedFile), commits });
        } catch (e: unknown) {
          if (this.latestCompareRequestId.get(repoId) !== msg.requestId) break;
          post({ type: 'PRCREATE_COMPARE_RESULT', requestId: msg.requestId, files: [], commits: [], error: formatGitError(e) });
        }
        break;
      }

      case 'PRCREATE_OPEN_FILE_DIFF': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) break;
        try {
          const [baseHash, headHash] = await Promise.all([repo.resolveRef(msg.targetBranch), repo.resolveRef(msg.sourceBranch)]);
          const isAdded = msg.file.status === 'added';
          const isDeleted = msg.file.status === 'deleted';
          const left = gitUri(repo.rootPath, isAdded ? EMPTY_TREE : baseHash, msg.file.oldPath ?? msg.file.path);
          const right = gitUri(repo.rootPath, isDeleted ? EMPTY_TREE : headHash, msg.file.path);
          const title = `${msg.file.path} (${msg.sourceBranch} vs ${msg.targetBranch})`;
          await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
        } catch (e: unknown) {
          vscode.window.showErrorMessage(`Cannot open diff: ${formatGitError(e)}`);
        }
        break;
      }

      case 'PRCREATE_OPEN_NATIVE_COMPARE': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) break;
        try {
          const [baseHash, headHash] = await Promise.all([repo.resolveRef(msg.targetBranch), repo.resolveRef(msg.sourceBranch)]);
          const rawFiles = await repo.getFilesBetween([baseHash, headHash]);
          if (rawFiles.length === 0) {
            vscode.window.showInformationMessage(`No differences between '${msg.targetBranch}' and '${msg.sourceBranch}'.`);
            break;
          }
          const resources = rawFiles.filter(f => f.status !== 'U').map(f => {
            const label = vscode.Uri.file(path.join(repo.rootPath, f.path));
            const original = gitUri(repo.rootPath, f.status === 'A' ? EMPTY_TREE : baseHash, f.oldPath ?? f.path);
            const modified = gitUri(repo.rootPath, f.status === 'D' ? EMPTY_TREE : headHash, f.path);
            return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
          });
          await vscode.commands.executeCommand('vscode.changes', `${msg.sourceBranch} vs ${msg.targetBranch}`, resources);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(`Cannot open comparison: ${formatGitError(e)}`);
        }
        break;
      }

      case 'PRCREATE_SUBMIT': {
        try {
          const result = await this.pullRequestManager.createPullRequest(repoId, msg.input);
          post({ type: 'PRCREATE_SUBMIT_RESULT', ok: result.ok, pr: result.pr, error: result.error });
          if (result.ok) {
            logInfo('pullrequest-create', `Created PR #${result.pr?.number} for ${repoId}`);
            this.onCreated();
            panel.dispose();
          }
        } catch (e: unknown) {
          logError('pullrequest-create', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'PRCREATE_SUBMIT_RESULT', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'PRCREATE_CANCEL': {
        panel.dispose();
        break;
      }
    }
  }

  dispose(): void {
    this.panels.forEach(p => p.dispose());
    this.panels.clear();
  }
}
