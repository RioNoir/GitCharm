import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { LogToHostMsg, HostToLogMsg } from '../types/messages';
import type { BranchInfo } from '../types/git';
import { loadIconTheme } from '../utils/IconThemeService';
import type { CommitPanelProvider } from './CommitPanelProvider';
import { openSquashEditor } from './SquashEditorPanel';
import { openEditMessageEditor } from './EditMessageEditorPanel';

function mergeCurrentIntoBranches(branches: BranchInfo[], current: BranchInfo): BranchInfo[] {
  if (!current.detachedTag && !current.detachedHash) return branches; // normal branch — already in list
  const filtered = branches.filter(b => !(b.repoId === current.repoId && b.isHead));
  return [...filtered, current];
}

type DeleteTagChoice = 'local' | 'remote' | 'both' | null;

async function confirmDeleteTag(tagName: string, title: string): Promise<DeleteTagChoice> {
  const pick = await vscode.window.showWarningMessage(
    `Delete tag "${tagName}"?`,
    { modal: true },
    'Delete Local',
    'Delete on Remote',
    'Delete Local and Remote',
  );
  if (!pick) return null;
  if (pick === 'Delete on Remote') return 'remote';
  if (pick === 'Delete Local and Remote') return 'both';
  return 'local';
}

async function deleteTagWithRemoteOption(
  repo: import('../git/GitService').GitService,
  tagName: string,
  choice: DeleteTagChoice,
): Promise<void> {
  if (!choice) return;
  if (choice === 'local') {
    await repo.deleteTag(tagName);
    return;
  }
  const remotes = await repo.getRemotes().catch(() => [] as string[]);
  if (choice === 'remote') {
    // Remote only — don't delete locally
    if (remotes.length === 0) {
      vscode.window.showWarningMessage(`GitCharm: No remotes configured.`);
      return;
    }
    const remote = remotes.length === 1
      ? remotes[0]
      : (await vscode.window.showQuickPick(remotes.map(r => ({ label: r })), { title: `Delete "${tagName}" from remote` }))?.label;
    if (!remote) return;
    await repo.deleteTagRemote(tagName, remote);
    return;
  }
  // 'both': delete local first, then remote
  await repo.deleteTag(tagName);
  if (remotes.length === 0) {
    vscode.window.showWarningMessage(`GitCharm: Tag "${tagName}" deleted locally, but no remotes configured.`);
    return;
  }
  const remote = remotes.length === 1
    ? remotes[0]
    : (await vscode.window.showQuickPick(remotes.map(r => ({ label: r })), { title: `Delete "${tagName}" from remote` }))?.label;
  if (!remote) return;
  await repo.deleteTagRemote(tagName, remote);
}


export class GitLogPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'gitcharm.gitLog';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private readonly managerListeners: vscode.Disposable[] = [];
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;
  private commitPanel?: CommitPanelProvider;
  private hiddenRepoIds: string[] = [];
  private pendingFilterRepoId: string | null = null;
  private pendingFilterBranch: string | null = null;

  setCommitPanel(provider: CommitPanelProvider): void {
    this.commitPanel = provider;
  }

  notifyHiddenReposChanged(hiddenRepoIds: string[]): void {
    this.hiddenRepoIds = hiddenRepoIds;
    this.getFilteredBranches().then(branches => {
      this.post({ type: 'LOG_INIT_DATA', repos: this.getVisibleRepos(), branches });
    });
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
        const repos = this.getVisibleRepos();
        const branches = await this.getFilteredBranches();
        this.post({ type: 'LOG_INIT_DATA', repos, branches });
        if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
        this.refreshDebounce = setTimeout(() => this.post({ type: 'LOG_REFRESH' }), 300);
      }),
      this.manager.onReposChange(async () => {
        const repos = this.getVisibleRepos();
        const branches = await this.getFilteredBranches();
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
      'GitCharm: Git Log'
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
              this.post({ type: 'LOG_INIT_DATA', repos: this.getVisibleRepos(), branches: [], iconTheme });
            });
          }
        }
      })
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.pendingFilterRepoId !== null) {
        const repoId = this.pendingFilterRepoId;
        const branch = this.pendingFilterBranch;
        this.pendingFilterRepoId = null;
        this.pendingFilterBranch = null;
        // Small delay to let the webview finish its initial LOG_REQUEST_COMMITS round-trip
        setTimeout(() => this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch }), 150);
      }
    });

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

  /** Focus the panel and filter the log to a specific repository (and optionally branch). */
  focusRepo(repoId: string, branch?: string): void {
    this.pendingFilterRepoId = repoId;
    this.pendingFilterBranch = branch ?? null;
    this.focus();
    if (this.view?.visible) {
      this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch });
      this.pendingFilterRepoId = null;
      this.pendingFilterBranch = null;
    }
  }

  /** Trigger a full log refresh — call this after any operation that creates new commits. */
  refresh(): void {
    this.post({ type: 'LOG_REFRESH' });
  }

  private post(msg: HostToLogMsg): void {
    if (msg.type === 'LOG_INIT_DATA') {
      const m = msg as typeof msg & { hasWorkspaceFolder?: boolean };
      if (m.hasWorkspaceFolder === undefined) m.hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    }
    this.view?.webview.postMessage(msg);
  }

  private getNonWorktreeRepos() {
    return this.manager.getRepoMetas().filter(m => !m.isWorktree);
  }

  private getVisibleRepos() {
    return this.getNonWorktreeRepos().filter(m => !this.hiddenRepoIds.includes(m.id));
  }

  private async getFilteredBranches() {
    const ids = new Set(this.getNonWorktreeRepos().map(r => r.id));
    const all = await this.manager.getAllBranches();
    return all.filter(b => ids.has(b.repoId));
  }

  private async handleMessage(msg: LogToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'LOG_REQUEST_COMMITS': {
        const maxCommits = vscode.workspace.getConfiguration('gitcharm').get<number>('graphMaxCommits', 1000);
        const limit = Math.min(msg.limit, maxCommits);

        const repos = this.getVisibleRepos();
        const [branches, iconTheme] = await Promise.all([
          this.getFilteredBranches(),
          this.view ? loadIconTheme(this.view.webview) : Promise.resolve(undefined),
        ]);
        this.post({ type: 'LOG_INIT_DATA', repos, branches, iconTheme });

        // Send tags for all repos
        for (const meta of repos) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          repo.getTags().then(rawTags => {
            this.post({ type: 'LOG_TAGS_UPDATE', repoId: meta.id, tags: rawTags.map(t => ({ ...t, repoId: meta.id })) });
          }).catch(() => {});
        }

        const logRepoIds = msg.repoIds.length > 0
          ? msg.repoIds.filter(id => !this.manager.getRepoMetas().find(m => m.id === id)?.isWorktree && !this.hiddenRepoIds.includes(id))
          : this.getVisibleRepos().map(r => r.id);
        const commits = await this.manager.getInterleavedLog(logRepoIds, limit, msg.skip, {
          filterText: msg.filterText,
          filterAuthor: msg.filterAuthor,
          filterBranch: msg.filterBranch,
          filterDateFrom: msg.filterDateFrom,
          filterDateTo: msg.filterDateTo,
        });
        this.post({ type: 'LOG_COMMITS_BATCH', commits, isLast: commits.length < limit, batchIndex: 0, requestId: msg.requestId });
        break;
      }

      case 'LOG_REQUEST_COMMIT_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: 'Repo not found' }); return; }
        try {
          const files = await repo.getCommitFiles(msg.hash, msg.parents);
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
          vscode.window.showErrorMessage(`GitCharm: Cannot open diff: ${String(e)}`);
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
          vscode.window.showErrorMessage(`GitCharm: Cannot open file: ${String(e)}`);
        }
        break;
      }

      case 'LOG_REVEAL_IN_EXPLORER': {
        const repoRE = this.manager.getRepo(msg.repoId);
        if (!repoRE) return;
        const pathRE = await import('path');
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(pathRE.join(repoRE.rootPath, msg.filePath)));
        break;
      }

      case 'LOG_REVEAL_IN_OS': {
        const repoOS = this.manager.getRepo(msg.repoId);
        if (!repoOS) return;
        const pathOS = await import('path');
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pathOS.join(repoOS.rootPath, msg.filePath)));
        break;
      }

      case 'LOG_INIT_REPO': {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) break;
        await vscode.commands.executeCommand('git.init', folder.uri);
        await new Promise(r => setTimeout(r, 1000));
        this.manager.reinitializeAndRefresh();
        break;
      }

      case 'LOG_OPEN_FOLDER':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;

      case 'LOG_CLONE_REPO':
        await vscode.commands.executeCommand('git.clone');
        break;

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
          vscode.window.showErrorMessage(`GitCharm: Cannot revert file: ${String(e)}`);
        }
        break;
      }

      case 'LOG_CHECKOUT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.checkout(msg.branchName, msg.createNew, msg.from);
          // _pendingDetachedTag is cleared inside GitService.checkout().
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
          const merged = mergeCurrentIntoBranches(branches, current);
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_PULL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Pulling', cancellable: false },
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
          { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Pushing', cancellable: false },
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
          const isDirty = errMsg.includes('Your local changes') || errMsg.includes('overwritten by merge') || (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree';
          if (isDirty) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
            const repoMeta = this.getNonWorktreeRepos().find(m => m.id === msg.repoId);
            const repoName = repoMeta?.name ?? msg.repoId;
            const pick = await vscode.window.showQuickPick(
              [
                { label: '$(archive) Stash and merge', detail: 'Save local changes to stash, then merge', value: 'stash' },
                { label: '$(close) Cancel', detail: '', value: 'cancel' },
              ],
              {
                title: `GitCharm [${repoName}]: Uncommitted changes`,
                placeHolder: `Local changes would be overwritten by merging "${msg.from}"`,
                ignoreFocusOut: true,
              }
            );
            if (pick?.value === 'stash') {
              try {
                await repo.stashPush(`WIP before merge of ${msg.from}`);
                await repo.merge(msg.from);
                this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              } catch (e2: unknown) {
                this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e2) });
              }
            }
            break;
          }
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT')) {
            repo.getCurrentBranch().then(current => {
              const mergeMsg = `Merge branch '${msg.from}' into '${current.name}'`;
              this.commitPanel?.prefillCommitMessage(mergeMsg);
            }).catch(() => {});
            vscode.window.showWarningMessage(
              'GitCharm: Merge conflicts detected. Use the Merge Editor to resolve them.',
              'Open Commit Panel'
            ).then(choice => {
              if (choice) vscode.commands.executeCommand('gitcharm.commitPanel.focus');
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

      case 'LOG_DELETE_BRANCH_MULTI': {
        // Check if the branch is currently checked out in any of the target repos
        const checkedOutIn: string[] = [];
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          const current = await repo.getCurrentBranch().catch(() => null);
          if (current && (current.name === msg.branchName || current.detachedTag === msg.branchName)) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            checkedOutIn.push(meta?.name ?? repoId);
          }
        }
        const eligibleRepoIds = msg.repoIds.filter(id => {
          const meta = this.getNonWorktreeRepos().find(m => m.id === id);
          return !checkedOutIn.includes(meta?.name ?? id);
        });
        if (eligibleRepoIds.length === 0) {
          vscode.window.showWarningMessage(`GitCharm: Cannot delete "${msg.branchName}" — it is currently checked out in all target repositories.`);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Checked out' });
          return;
        }
        const skippedMsg = checkedOutIn.length > 0
          ? ` (skipped in: ${checkedOutIn.join(', ')} — currently checked out)`
          : '';
        const repoCount = eligibleRepoIds.length;
        const confirm = await vscode.window.showWarningMessage(
          `Delete branch "${msg.branchName}" in ${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}?${skippedMsg}`,
          { modal: true }, 'Delete', 'Force Delete'
        );
        if (!confirm) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        const force = confirm === 'Force Delete';
        const errors: string[] = [];
        for (const repoId of eligibleRepoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await repo.deleteBranch(msg.branchName, force);
            const branches = await repo.getBranches();
            this.post({ type: 'LOG_REFS_UPDATE', repoId, branches });
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        }
        break;
      }

      case 'LOG_FETCH_ALL': {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Fetching all', cancellable: false },
          async () => { await this.manager.fetchAll(); }
        );
        const branches = await this.getFilteredBranches();
        const repos = this.getVisibleRepos();
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
            vscode.window.showErrorMessage(`GitCharm: Cherry-pick failed: ${errMsg}`);
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
            vscode.window.showErrorMessage(`GitCharm: Revert failed: ${errMsg}`);
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
          vscode.window.showErrorMessage(`GitCharm: Reset failed: ${String(e)}`);
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
          vscode.window.showErrorMessage(`GitCharm: Create patch failed: ${String(e)}`);
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
            vscode.window.showErrorMessage(`GitCharm: Cherry-pick failed: ${errMsg}`);
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
            vscode.window.showErrorMessage(`GitCharm: Revert failed: ${errMsg}`);
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
          vscode.window.showErrorMessage(`GitCharm: Drop commits failed: ${String(e)}`);
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
          vscode.window.showErrorMessage(`GitCharm: Create patches failed: ${String(e)}`);
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
          vscode.window.showErrorMessage(`GitCharm: Drop commit failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_SQUASH_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const fullMessages = await Promise.all(msg.hashes.map(h => repo.getFullCommitMessage(h).then(m => m.trim())));
        const fullCombined = fullMessages.join('\n\n');
        const fullCommits = msg.commits.map((c, i) => ({ ...c, message: fullMessages[i] ?? c.message }));
        const result = await openSquashEditor(this.extensionUri, msg.hashes.length, fullCombined, fullCommits);
        if (!result.confirmed) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.squashCommits(msg.oldestHash, result.message);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitCharm: Squash failed: ${String(e)}`);
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
          vscode.window.showErrorMessage(`GitCharm: Undo commit failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_EDIT_COMMIT_MESSAGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const fullMessage = (await repo.getFullCommitMessage(msg.hash)).trim();
        const result = await openEditMessageEditor(this.extensionUri, msg.hash.slice(0, 7), fullMessage);
        if (!result.confirmed) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.rewordCommit(result.message);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitCharm: Edit commit message failed: ${String(e)}`);
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
          vscode.window.showErrorMessage(`GitCharm: Create branch failed: ${String(e)}`);
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
          const rawTags = await repo.getTags();
          this.post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags: rawTags.map(t => ({ ...t, repoId: msg.repoId })) });
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitCharm: Create tag failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_REQUEST_COMMIT_BRANCHES': {
        const repo = this.manager.getRepo(msg.repoId);
        const branches = repo
          ? await repo.getBranchesContaining(msg.hash).catch(() => ({ local: [], remote: [], tags: [] }))
          : { local: [], remote: [], tags: [] };
        this.post({ type: 'LOG_COMMIT_BRANCHES_RESULT', requestId: msg.requestId, branches });
        break;
      }

      case 'LOG_REQUEST_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const rawTags = await repo.getTags();
          const tags = rawTags.map(t => ({ ...t, repoId: msg.repoId }));
          this.post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags });
        } catch { /* ignore */ }
        break;
      }

      case 'LOG_REQUEST_COMMIT_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        const tags = repo ? await repo.getTagsForCommit(msg.hash).catch(() => []) : [];
        this.post({ type: 'LOG_COMMIT_TAGS_RESULT', requestId: msg.requestId, tags });
        break;
      }

      case 'LOG_MANAGE_COMMIT_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const tags = await repo.getTagsForCommit(msg.hash).catch(() => [] as string[]);
        if (tags.length === 0) {
          vscode.window.showInformationMessage('GitCharm: No tags on this commit.');
          return;
        }
        await this.showManageCommitTagsMenu(repo, msg.repoId, msg.hash, tags, msg.currentBranch);
        break;
      }

      case 'LOG_DELETE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.deleteTag(msg.tagName);
          const rawTags = await repo.getTags();
          this.post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags: rawTags.map(t => ({ ...t, repoId: msg.repoId })) });
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitCharm: Delete tag failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_DELETE_TAG_MULTI': {
        // Tags can't be "checked out" in the same sense, but prevent deleting the
        // tag that HEAD is currently detached on.
        const checkedOutTagIn: string[] = [];
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          const current = await repo.getCurrentBranch().catch(() => null);
          if (current?.detachedTag === msg.tagName) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            checkedOutTagIn.push(meta?.name ?? repoId);
          }
        }
        const eligibleRepoIds = msg.repoIds.filter(id => {
          const meta = this.getNonWorktreeRepos().find(m => m.id === id);
          return !checkedOutTagIn.includes(meta?.name ?? id);
        });
        if (eligibleRepoIds.length === 0) {
          vscode.window.showWarningMessage(`GitCharm: Cannot delete tag "${msg.tagName}" — HEAD is detached on it in all target repositories.`);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Checked out' });
          return;
        }
        const skippedMsg = checkedOutTagIn.length > 0
          ? ` (skipped in: ${checkedOutTagIn.join(', ')} — HEAD detached on this tag)`
          : '';
        const repoCount = eligibleRepoIds.length;
        const choice = await (async (): Promise<DeleteTagChoice> => {
          const pick = await vscode.window.showWarningMessage(
            `Delete tag "${msg.tagName}" in ${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}?${skippedMsg}`,
            { modal: true }, 'Delete Local', 'Delete on Remote', 'Delete Local and Remote'
          );
          if (!pick) return null;
          if (pick === 'Delete on Remote') return 'remote';
          if (pick === 'Delete Local and Remote') return 'both';
          return 'local';
        })();
        if (!choice) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        const errors: string[] = [];
        for (const repoId of eligibleRepoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await deleteTagWithRemoteOption(repo, msg.tagName, choice);
            const rawTags = await repo.getTags();
            this.post({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        this.post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_PUSH_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `GitCharm: Pushing tag "${msg.tagName}" to ${msg.remote}…`, cancellable: false },
          async () => {
            try {
              await repo.pushTag(msg.tagName, msg.remote);
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              vscode.window.showInformationMessage(`GitCharm: Tag "${msg.tagName}" pushed to "${msg.remote}".`);
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
              vscode.window.showErrorMessage(`GitCharm: Push tag failed: ${String(e)}`);
            }
          }
        );
        break;
      }

      case 'LOG_CHECKOUT_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.checkoutTag(msg.tagName);
          // _pendingDetachedTag is now set inside GitService.checkoutTag().
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const branches = await repo.getBranches();
          const detachedHeadEntry: BranchInfo = {
            repoId: msg.repoId,
            name: 'HEAD',
            fullName: 'HEAD',
            isHead: true,
            isRemote: false,
            detachedTag: msg.tagName,
          };
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: [...branches, detachedHeadEntry] });
          this.post({ type: 'LOG_REFRESH' });
          vscode.window.showInformationMessage(`GitCharm: Checked out tag "${msg.tagName}" (detached HEAD).`);
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitCharm: Checkout tag failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_MERGE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.mergeTag(msg.tagName);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          vscode.window.showInformationMessage(`GitCharm: Merged tag "${msg.tagName}".`);
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitCharm: Merge tag failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_MERGE_TAG_MULTI': {
        const errors: string[] = [];
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await repo.mergeTag(msg.tagName);
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          vscode.window.showInformationMessage(`GitCharm: Merged tag "${msg.tagName}" in ${msg.repoIds.length} ${msg.repoIds.length === 1 ? 'repository' : 'repositories'}.`);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        this.post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_RESET_TO_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        type ModeItem = vscode.QuickPickItem & { mode: 'soft' | 'mixed' | 'hard' };
        const pick = await vscode.window.showQuickPick(
          [
            { label: '$(arrow-down) Soft', description: 'Keep staged and unstaged changes', mode: 'soft' as const },
            { label: '$(discard) Mixed', description: 'Keep unstaged changes, unstage staged changes', mode: 'mixed' as const },
            { label: '$(trash) Hard', description: 'Discard all local changes', mode: 'hard' as const },
          ] satisfies ModeItem[],
          { title: `Reset Current Branch to ${msg.hash.slice(0, 7)}` }
        ) as ModeItem | undefined;
        if (!pick) return;
        const reqId = msg.hash + pick.mode;
        try {
          await repo.resetTo(msg.hash, pick.mode);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: reqId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: reqId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(`GitCharm: Reset failed: ${String(e)}`);
        }
        break;
      }

      case 'LOG_PUSH_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) { vscode.window.showWarningMessage('GitCharm: No remotes configured.'); return; }
        const remotePick = remotes.length === 1
          ? remotes[0]
          : (await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: 'Push — Select remote' }
            ) as { label: string; remote: string } | undefined)?.remote;
        if (!remotePick) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `GitCharm: Pushing to ${remotePick}…`, cancellable: false },
          async () => {
            try {
              await repo.push(false, remotePick);
              vscode.window.showInformationMessage(`GitCharm: Pushed to "${remotePick}" successfully.`);
            } catch (e: unknown) {
              vscode.window.showErrorMessage(`GitCharm: Push failed: ${String(e)}`);
            }
          }
        );
        this.post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_PUSH_TAG_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) { vscode.window.showWarningMessage('GitCharm: No remotes configured.'); return; }
        const remotePick = remotes.length === 1
          ? remotes[0]
          : (await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: `Push tag "${msg.tagName}" — Select remote` }
            ) as { label: string; remote: string } | undefined)?.remote;
        if (!remotePick) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `GitCharm: Pushing tag "${msg.tagName}" to ${remotePick}…`, cancellable: false },
          async () => {
            try {
              await repo.pushTag(msg.tagName, remotePick);
              vscode.window.showInformationMessage(`GitCharm: Tag "${msg.tagName}" pushed to "${remotePick}".`);
            } catch (e: unknown) {
              vscode.window.showErrorMessage(`GitCharm: Push tag failed: ${String(e)}`);
            }
          }
        );
        break;
      }

      case 'LOG_OPEN_COMMIT_BODY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_COMMIT_BODY_RESULT', requestId: msg.requestId, hasBody: false }); return; }
        try {
          const full = (await repo.getFullCommitMessage(msg.hash)).trim();
          const lines = full.split('\n');
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

      case 'LOG_SHOW_BRANCH_OPTIONS': {
        await vscode.commands.executeCommand('gitcharm.showBranchOptions', msg.repoId, msg.branchName);
        break;
      }

      case 'LOG_CHECKOUT_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        let target: string;
        if (msg.branchName) {
          type CheckoutItem = vscode.QuickPickItem & { value: 'branch' | 'revision' };
          const pick = await vscode.window.showQuickPick<CheckoutItem>(
            [
              { label: `$(arrow-right) Checkout branch '${msg.branchName}'`, description: msg.branchName, value: 'branch' },
              { label: '$(git-commit) Checkout revision (detached HEAD)', description: msg.hash.slice(0, 8), value: 'revision' },
            ],
            { title: 'Checkout' }
          );
          if (!pick) break;
          target = pick.value === 'branch' ? msg.branchName : msg.hash;
        } else {
          target = msg.hash;
        }
        try {
          await repo.checkout(target);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
          const merged = mergeCurrentIntoBranches(branches, current);
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_OPEN_EXTENDED_DETAIL': {
        const { openCommitDetailPanel } = await import('./CommitDetailPanel');
        await openCommitDetailPanel(this.extensionUri, this.manager, msg.repoId, msg.hash);
        break;
      }
    }
  }

  private async showManageCommitTagsMenu(
    repo: import('../git/GitService').GitService,
    repoId: string,
    hash: string,
    tags: string[],
    currentBranch: string,
  ): Promise<void> {
    type TagListItem = vscode.QuickPickItem & { tagName: string | null };

    // Step 1: always show the tag list + "New Tag..." so the user picks a tag first
    const tagListItems: TagListItem[] = [
      { label: '$(add) New Tag...', tagName: null },
      { label: '', kind: vscode.QuickPickItemKind.Separator, tagName: null },
      ...tags.map(t => ({ label: `$(tag) ${t}`, tagName: t })),
    ];

    const tagPick = await vscode.window.showQuickPick(tagListItems, {
      title: `Tags on commit ${hash.slice(0, 7)}`,
      placeHolder: 'Select a tag or create a new one',
    }) as TagListItem | undefined;
    if (!tagPick) return;

    // "New Tag..." selected
    if (tagPick.tagName === null) {
      const newName = await vscode.window.showInputBox({
        prompt: `Tag name for commit ${hash.slice(0, 7)}`,
        placeHolder: 'v1.0.0',
        validateInput: v => v.trim() ? undefined : 'Tag name cannot be empty',
      });
      if (!newName) return;
      try {
        await repo.createTag(newName.trim(), hash);
        const rawTags = await repo.getTags();
        this.post({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
        this.post({ type: 'LOG_REFRESH' });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`GitCharm: Create tag failed: ${String(e)}`);
      }
      return;
    }

    // Step 2: show actions for the selected tag
    const tagName = tagPick.tagName;
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const actionItems: ActionItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showManageCommitTagsMenu(repo, repoId, hash, tags, currentBranch),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(git-merge) Merge "${tagName}" into "${currentBranch}"`,
        action: async () => {
          try {
            await repo.mergeTag(tagName);
            this.post({ type: 'LOG_REFRESH' });
            vscode.window.showInformationMessage(`GitCharm: Merged tag "${tagName}" into "${currentBranch}".`);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(`GitCharm: Merge tag failed: ${String(e)}`);
          }
        },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(trash) Delete "${tagName}"`,
        action: async () => {
          const choice = await confirmDeleteTag(tagName, `Delete tag "${tagName}"?`);
          if (!choice) return;
          try {
            await deleteTagWithRemoteOption(repo, tagName, choice);
            const rawTags = await repo.getTags();
            this.post({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
            this.post({ type: 'LOG_REFRESH' });
            vscode.window.showInformationMessage(`GitCharm: Deleted tag "${tagName}".`);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(`GitCharm: Delete tag failed: ${String(e)}`);
          }
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(actionItems, {
      title: `Tag: ${tagName}`,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  dispose(): void {
    this.managerListeners.forEach(d => d.dispose());
    this.disposables.forEach(d => d.dispose());
    if (this.refreshDebounce) { clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }
}
