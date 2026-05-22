import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { LogToHostMsg, HostToLogMsg } from '../types/messages';
import { loadIconTheme } from '../utils/IconThemeService';

export class GitLogPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'gitstorm.gitLog';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.file(vscode.env.appRoot),
        ...vscode.extensions.all.map(e => vscode.Uri.file(e.extensionPath)),
      ],
    };

    webviewView.webview.html = getWebviewHtml(
      webviewView.webview,
      this.extensionUri,
      'gitLog',
      'GitStorm: Git Log'
    );

    webviewView.webview.onDidReceiveMessage(
      (msg: LogToHostMsg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.disposables.push(
      this.manager.onBranchChange(async () => {
        const repos = this.manager.getRepoMetas();
        const branches = await this.manager.getAllBranches();
        this.post({ type: 'LOG_INIT_DATA', repos, branches });
        if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
        this.refreshDebounce = setTimeout(() => this.post({ type: 'LOG_REFRESH' }), 300);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
          if (this.view) {
            loadIconTheme(this.view.webview).then(iconTheme => {
              this.post({ type: 'LOG_INIT_DATA', repos: this.manager.getRepoMetas(), branches: [], iconTheme });
            });
          }
        }
      })
    );

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.disposables.forEach(d => d.dispose());
      this.disposables = [];
    });
  }

  /** Focus/reveal the Git Log panel in the bottom bar. */
  focus(): void {
    vscode.commands.executeCommand(`${GitLogPanelProvider.viewType}.focus`);
  }

  private post(msg: HostToLogMsg): void {
    this.view?.webview.postMessage(msg);
  }

  private async handleMessage(msg: LogToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'LOG_REQUEST_COMMITS': {
        const maxCommits = vscode.workspace.getConfiguration('gitstorm').get<number>('graphMaxCommits', 1000);
        const limit = Math.min(msg.limit, maxCommits);

        const repos = this.manager.getRepoMetas();
        const branches = await this.manager.getAllBranches();
        const iconTheme = this.view ? await loadIconTheme(this.view.webview) : undefined;
        this.post({ type: 'LOG_INIT_DATA', repos, branches, iconTheme });

        const commits = await this.manager.getInterleavedLog(msg.repoIds, limit, msg.skip, {
          filterText: msg.filterText,
          filterAuthor: msg.filterAuthor,
          filterBranch: msg.filterBranch,
          filterDateFrom: msg.filterDateFrom,
          filterDateTo: msg.filterDateTo,
        });
        this.post({ type: 'LOG_COMMITS_BATCH', commits, isLast: commits.length < limit, batchIndex: 0 });
        break;
      }

      case 'LOG_REQUEST_COMMIT_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: 'Repo not found' }); return; }
        try {
          const files = await repo.getCommitFiles(msg.hash);
          this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files });
        } catch (e: unknown) {
          this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: String(e) });
        }
        break;
      }

      case 'LOG_REQUEST_MERGE_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits: [], error: 'Repo not found' }); return; }
        try {
          const commits = await repo.getMergeCommits(msg.hash, msg.parents);
          this.post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits });
        } catch (e: unknown) {
          this.post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits: [], error: String(e) });
        }
        break;
      }

      case 'LOG_REQUEST_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff: null, error: 'Repo not found' }); return; }
        try {
          const diff = await repo.getFileDiff(msg.repoId, msg.hash, msg.filePath);
          this.post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff });
        } catch (e: unknown) {
          this.post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff: null, error: String(e) });
        }
        break;
      }

      case 'LOG_OPEN_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const path = await import('path');
          const prevRef = `${msg.hash}~1`;
          const currRef = msg.hash;
          const fileName = path.basename(msg.filePath);
          const rootPath = repo.rootPath;

          // Create git-show URIs via a virtual document scheme or use the vscode.git scheme
          const gitUri = (ref: string) => vscode.Uri.from({
            scheme: 'git',
            path: path.join(rootPath, msg.filePath),
            query: JSON.stringify({ path: path.join(rootPath, msg.filePath), ref }),
          });

          await vscode.commands.executeCommand(
            'vscode.diff',
            gitUri(prevRef),
            gitUri(currRef),
            `${fileName} (${msg.hash.slice(0, 7)})`,
            { preview: true }
          );
        } catch (e: unknown) {
          vscode.window.showErrorMessage(`GitStorm: Cannot open diff: ${String(e)}`);
        }
        break;
      }

      case 'LOG_CHECKOUT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.checkout(msg.branchName, msg.createNew, msg.from);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const branches = await repo.getBranches();
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_PULL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitStorm: Pulling', cancellable: false },
          async () => {
            try {
              const output = await repo.pull();
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true, output });
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
            }
          }
        );
        break;
      }

      case 'LOG_PUSH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitStorm: Pushing', cancellable: false },
          async () => {
            try {
              await repo.push(msg.force, msg.remote);
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
            }
          }
        );
        break;
      }

      case 'LOG_GET_REMOTES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: 'Repo not found' }); return; }
        try {
          const remotes = await repo.getRemotes();
          this.post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes });
        } catch (e: unknown) {
          this.post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: String(e) });
        }
        break;
      }

      case 'LOG_MERGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.merge(msg.from);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT')) {
            vscode.window.showWarningMessage(
              'GitStorm: Merge conflicts detected. Use the Merge Editor to resolve them.',
              'Open Commit Panel'
            ).then(choice => {
              if (choice) vscode.commands.executeCommand('gitstorm.commitPanel.focus');
            });
          }
        }
        break;
      }

      case 'LOG_REBASE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.rebase(msg.onto);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_DELETE_BRANCH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Delete branch "${msg.branchName}"?`, { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.deleteBranch(msg.branchName, msg.force);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const branches = await repo.getBranches();
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_FETCH_ALL': {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitStorm: Fetching all', cancellable: false },
          async () => { await this.manager.fetchAll(); }
        );
        const branches = await this.manager.getAllBranches();
        const repos = this.manager.getRepoMetas();
        this.post({ type: 'LOG_INIT_DATA', repos, branches });
        this.post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_FETCH_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.fetchAll();
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const branches = await repo.getBranches();
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_CHERRY_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.cherryPick(msg.hash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            const choice = await vscode.window.showWarningMessage(
              `Cherry-pick of ${msg.hash.slice(0, 7)} has conflicts. Resolve them in the editor, then choose an action.`,
              'Continue', 'Skip', 'Abort'
            );
            if (choice === 'Continue') {
              await repo.cherryPickContinue();
            } else if (choice === 'Skip') {
              await repo.cherryPickSkip();
            } else if (choice === 'Abort') {
              await repo.cherryPickAbort();
            }
          } else {
            vscode.window.showErrorMessage(`GitStorm: Cherry-pick failed: ${errMsg}`);
          }
        }
        break;
      }

      case 'LOG_REVERT_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.revertCommit(msg.hash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            const choice = await vscode.window.showWarningMessage(
              `Revert of ${msg.hash.slice(0, 7)} has conflicts. Resolve them in the editor, then choose an action.`,
              'Continue', 'Abort'
            );
            if (choice === 'Continue') {
              await repo.revertContinue();
            } else if (choice === 'Abort') {
              await repo.revertAbort();
            }
          } else {
            vscode.window.showErrorMessage(`GitStorm: Revert failed: ${errMsg}`);
          }
        }
        break;
      }

      case 'LOG_RESET_TO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const modeLabel = msg.mode === 'hard' ? 'Hard Reset (discard all changes)' : msg.mode === 'mixed' ? 'Mixed Reset (keep unstaged)' : 'Soft Reset (keep staged)';
        const confirm = await vscode.window.showWarningMessage(
          `Reset current branch to ${msg.hash.slice(0, 7)}? (${modeLabel})`,
          { modal: true }, 'Reset'
        );
        if (confirm !== 'Reset') {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.resetTo(msg.hash, msg.mode);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Reset failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_CREATE_PATCH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const patch = await repo.createPatch(msg.hash);
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${msg.hash.slice(0, 7)}.patch`),
            filters: { 'Patch files': ['patch'], 'All files': ['*'] },
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(patch, 'utf8'));
            vscode.window.showInformationMessage(`Patch saved to ${uri.fsPath}`);
          }
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Create patch failed: ${String(e)}`);
        }
        break;
      }
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
