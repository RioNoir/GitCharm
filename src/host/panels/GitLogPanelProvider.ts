import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { LogToHostMsg, HostToLogMsg } from '../types/messages';
import { loadIconTheme } from '../utils/IconThemeService';
import type { CommitPanelProvider } from './CommitPanelProvider';

export class GitLogPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'gitstorm.gitLog';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private readonly managerListeners: vscode.Disposable[] = [];
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;
  private commitPanel?: CommitPanelProvider;

  setCommitPanel(provider: CommitPanelProvider): void {
    this.commitPanel = provider;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager
  ) {
    // Register manager listeners here so they fire even when the panel has never been opened.
    // this.post() silently drops messages when the webview is not yet resolved — that's fine,
    // because resolveWebviewView performs an explicit initial sync when the panel first opens.
    this.managerListeners.push(
      this.manager.onBranchChange(async () => {
        const repos = this.manager.getRepoMetas();
        const branches = await this.manager.getAllBranches();
        this.post({ type: 'LOG_INIT_DATA', repos, branches });
        if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
        this.refreshDebounce = setTimeout(() => this.post({ type: 'LOG_REFRESH' }), 300);
      })
    );
  }

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

  /** Focus the panel and scroll to a specific commit. */
  selectCommit(hash: string, repoId: string): void {
    this.focus();
    this.post({ type: 'LOG_SCROLL_TO_COMMIT', hash, repoId });
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
          const status = msg.fileStatus ?? 'M';
          const fileName = path.basename(msg.filePath);
          const rootPath = repo.rootPath;
          // git empty tree SHA — used as "no file" side for added/deleted diffs
          const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

          const gitUri = (ref: string, filePath?: string) => vscode.Uri.from({
            scheme: 'git',
            path: path.join(rootPath, filePath ?? msg.filePath),
            query: JSON.stringify({ path: path.join(rootPath, filePath ?? msg.filePath), ref }),
          });

          let leftUri: vscode.Uri;
          let rightUri: vscode.Uri;
          let title: string;

          if (status === 'A') {
            // File was added in this commit — left side is empty
            leftUri  = gitUri(EMPTY_TREE);
            rightUri = gitUri(msg.hash);
            title    = `${fileName} (added in ${msg.hash.slice(0, 7)})`;
          } else if (status === 'D') {
            // File was deleted in this commit — right side is empty
            leftUri  = gitUri(`${msg.hash}~1`);
            rightUri = gitUri(EMPTY_TREE);
            title    = `${fileName} (deleted in ${msg.hash.slice(0, 7)})`;
          } else {
            leftUri  = gitUri(`${msg.hash}~1`);
            rightUri = gitUri(msg.hash);
            title    = `${fileName} (${msg.hash.slice(0, 7)})`;
          }

          await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
        } catch (e: unknown) {
          vscode.window.showErrorMessage(`GitStorm: Cannot open diff: ${String(e)}`);
        }
        break;
      }

      case 'LOG_OPEN_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const path = await import('path');
          const uri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
          await vscode.commands.executeCommand('vscode.open', uri);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(`GitStorm: Cannot open file: ${String(e)}`);
        }
        break;
      }

      case 'LOG_REVERT_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          if (msg.fileStatus === 'A') {
            // File was added in this commit — reverting means deleting it from the working tree
            const path = await import('path');
            const uri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
            await vscode.workspace.fs.delete(uri, { useTrash: false });
          } else {
            await repo.revertFileToParent(msg.hash, msg.filePath);
          }
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Cannot revert file: ${String(e)}`);
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
              this.post({ type: 'LOG_REFRESH' });
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
              this.post({ type: 'LOG_REFRESH' });
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
            repo.getCurrentBranch().then(current => {
              const mergeMsg = `Merge branch '${msg.from}' into '${current.name}'`;
              this.commitPanel?.prefillCommitMessage(mergeMsg);
            }).catch(() => {});
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
        {
          const confirm = await vscode.window.showWarningMessage(
            `Revert commit ${msg.hash.slice(0, 7)}? This creates a new commit that undoes the changes.`,
            { modal: true }, 'Revert'
          );
          if (confirm !== 'Revert') {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }
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

      case 'LOG_CHERRY_PICK_MULTI': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.cherryPickMulti(msg.hashes);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            const choice = await vscode.window.showWarningMessage(
              'Cherry-pick has conflicts. Resolve them, then choose an action.',
              'Continue', 'Skip', 'Abort'
            );
            if (choice === 'Continue') await repo.cherryPickContinue();
            else if (choice === 'Skip') await repo.cherryPickSkip();
            else await repo.cherryPickAbort();
          } else {
            vscode.window.showErrorMessage(`GitStorm: Cherry-pick failed: ${errMsg}`);
          }
        }
        break;
      }

      case 'LOG_REVERT_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        {
          const confirm = await vscode.window.showWarningMessage(
            `Revert ${msg.hashes.length} commits? This creates new commits that undo the changes.`,
            { modal: true }, 'Revert'
          );
          if (confirm !== 'Revert') {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }
        try {
          await repo.revertCommits(msg.hashes);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            const choice = await vscode.window.showWarningMessage(
              'Revert has conflicts. Resolve them, then choose an action.',
              'Continue', 'Abort'
            );
            if (choice === 'Continue') await repo.revertContinue();
            else await repo.revertAbort();
          } else {
            vscode.window.showErrorMessage(`GitStorm: Revert failed: ${errMsg}`);
          }
        }
        break;
      }

      case 'LOG_DROP_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Drop ${msg.hashes.length} commits? This rewrites history and cannot be undone.`,
          { modal: true }, 'Drop'
        );
        if (confirm !== 'Drop') {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.dropCommits(msg.oldestHash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Drop commits failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_CREATE_PATCH_MULTI': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const folderUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Save patches here',
          });
          if (!folderUris || folderUris.length === 0) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
            return;
          }
          const folderPath = folderUris[0].fsPath;
          const path = await import('path');
          for (const hash of msg.hashes) {
            const patch = await repo.createPatch(hash);
            const filePath = path.join(folderPath, `${hash.slice(0, 7)}.patch`);
            await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(patch, 'utf8'));
          }
          vscode.window.showInformationMessage(`${msg.hashes.length} patches saved to ${folderPath}`);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Create patches failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_DROP_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Drop commit ${msg.hash.slice(0, 7)}? This rewrites history. Only drop unpushed commits — dropping a pushed commit will require a force push.`,
          { modal: true }, 'Drop'
        );
        if (confirm !== 'Drop') {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.dropCommit(msg.hash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Drop commit failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_SQUASH_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        // Open untitled editor for multi-line commit message editing
        const uri = vscode.Uri.parse('untitled:Squash Commit Message');
        const doc = await vscode.workspace.openTextDocument(uri);
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.insert(uri, new vscode.Position(0, 0), msg.message);
        await vscode.workspace.applyEdit(wsEdit);
        await vscode.window.showTextDocument(doc, { preview: false });
        // Show persistent status bar buttons (unlike showInformationMessage which auto-dismisses)
        const uid = Date.now().toString(36);
        const confirmCmdId = `gitstorm._squashConfirm_${uid}`;
        const cancelCmdId = `gitstorm._squashCancel_${uid}`;
        const choice = await new Promise<'confirm' | 'cancel'>(resolve => {
          const disposables: vscode.Disposable[] = [];
          let settled = false;
          const settle = (v: 'confirm' | 'cancel') => {
            if (settled) return;
            settled = true;
            disposables.forEach(d => d.dispose());
            resolve(v);
          };
          disposables.push(
            vscode.commands.registerCommand(confirmCmdId, () => settle('confirm')),
            vscode.commands.registerCommand(cancelCmdId, () => settle('cancel')),
          );
          const confirmItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
          confirmItem.text = '$(check) Confirm Squash';
          confirmItem.command = confirmCmdId;
          confirmItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
          confirmItem.tooltip = `Confirm squash of ${msg.hashes.length} commits`;
          confirmItem.show();
          disposables.push(confirmItem);
          const cancelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9999);
          cancelItem.text = '$(close) Cancel';
          cancelItem.command = cancelCmdId;
          cancelItem.tooltip = 'Cancel squash';
          cancelItem.show();
          disposables.push(cancelItem);
          // Auto-cancel if the user closes the editor tab without using the buttons
          disposables.push(
            vscode.workspace.onDidCloseTextDocument(closed => {
              if (closed.uri.toString() === uri.toString()) settle('cancel');
            })
          );
        });
        const finalMessage = doc.getText().trim();
        // Close the editor (revert so VSCode doesn't ask to save the untitled file)
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        if (choice !== 'confirm' || !finalMessage) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.squashCommits(msg.oldestHash, finalMessage);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Squash failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_UNDO_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          'Undo last commit? Changes will be moved back to the staged area.',
          { modal: true }, 'Undo Commit'
        );
        if (confirm !== 'Undo Commit') {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.undoCommit();
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Undo commit failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_EDIT_COMMIT_MESSAGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const uri = vscode.Uri.parse('untitled:Edit Commit Message');
        const doc = await vscode.workspace.openTextDocument(uri);
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.insert(uri, new vscode.Position(0, 0), msg.currentMessage);
        await vscode.workspace.applyEdit(wsEdit);
        await vscode.window.showTextDocument(doc, { preview: false });
        const uid = Date.now().toString(36);
        const confirmCmdId = `gitstorm._editMsgConfirm_${uid}`;
        const cancelCmdId = `gitstorm._editMsgCancel_${uid}`;
        const choice = await new Promise<'confirm' | 'cancel'>(resolve => {
          const disposables: vscode.Disposable[] = [];
          let settled = false;
          const settle = (v: 'confirm' | 'cancel') => {
            if (settled) return;
            settled = true;
            disposables.forEach(d => d.dispose());
            resolve(v);
          };
          disposables.push(
            vscode.commands.registerCommand(confirmCmdId, () => settle('confirm')),
            vscode.commands.registerCommand(cancelCmdId, () => settle('cancel')),
          );
          const confirmItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
          confirmItem.text = '$(check) Confirm Edit';
          confirmItem.command = confirmCmdId;
          confirmItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
          confirmItem.tooltip = 'Confirm commit message edit';
          confirmItem.show();
          disposables.push(confirmItem);
          const cancelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9999);
          cancelItem.text = '$(close) Cancel';
          cancelItem.command = cancelCmdId;
          cancelItem.tooltip = 'Cancel commit message edit';
          cancelItem.show();
          disposables.push(cancelItem);
          disposables.push(
            vscode.workspace.onDidCloseTextDocument(closed => {
              if (closed.uri.toString() === uri.toString()) settle('cancel');
            })
          );
        });
        const finalMessage = doc.getText().trim();
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        if (choice !== 'confirm' || !finalMessage) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.editCommitMessage(finalMessage);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Edit commit message failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_NEW_BRANCH_FROM_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const branchName = await vscode.window.showInputBox({
          prompt: `Create new branch from ${msg.hash.slice(0, 7)}`,
          placeHolder: 'my-feature-branch',
          validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!branchName) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.createBranchFromCommit(branchName.trim(), msg.hash);
          const branches = await repo.getBranches();
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Create branch failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_CREATE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const tagName = await vscode.window.showInputBox({
          prompt: `Tag name for commit ${msg.hash.slice(0, 7)}`,
          placeHolder: 'v1.0.0',
          validateInput: v => v.trim() ? undefined : 'Tag name cannot be empty',
        });
        if (!tagName) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.createTag(tagName.trim(), msg.hash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitStorm: Create tag failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_REQUEST_COMMIT_BRANCHES': {
        const repo = this.manager.getRepo(msg.repoId);
        const branches = repo ? await repo.getBranchesContaining(msg.hash).catch(() => []) : [];
        this.post({ type: 'LOG_COMMIT_BRANCHES_RESULT', requestId: msg.requestId, branches });
        break;
      }

      case 'LOG_OPEN_COMMIT_BODY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_COMMIT_BODY_RESULT', requestId: msg.requestId, hasBody: false }); return; }
        try {
          const full = (await repo.getFullCommitMessage(msg.hash)).trim();
          const lines = full.split('\n');
          // A body exists when there are non-empty lines after the subject line
          const bodyLines = lines.slice(1).filter(l => l.trim() !== '');
          const hasBody = bodyLines.length > 0;
          if (hasBody) {
            const doc = await vscode.workspace.openTextDocument({ content: full, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: true });
          }
          this.post({ type: 'LOG_COMMIT_BODY_RESULT', requestId: msg.requestId, hasBody });
        } catch (e: unknown) {
          this.post({ type: 'LOG_COMMIT_BODY_RESULT', requestId: msg.requestId, hasBody: false });
        }
        break;
      }
    }
  }

  dispose(): void {
    this.managerListeners.forEach(d => d.dispose());
    this.disposables.forEach(d => d.dispose());
    if (this.refreshDebounce) { clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }
}
