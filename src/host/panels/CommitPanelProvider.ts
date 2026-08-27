import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from '../utils/webviewHtml';
import { generateWithAI } from '../ai/aiGenerate';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { ShelveService } from '../git/ShelveService';
import { ChangelistService } from '../git/ChangelistService';
import { ShelveDocumentProvider, applyPatchToContent } from '../utils/ShelveDocumentProvider';
import type { CommitToHostMsg, HostToCommitMsg } from '../types/messages';
import type { WorkspaceStatus } from '../types/git';
import { CHANGELIST_UNVERSIONED_ID } from '../types/git';
import { parseConflictFile } from '../git/ConflictParser';
import { loadIconTheme } from '../utils/IconThemeService';
import type { MergeEditorProvider } from './MergeEditorProvider';
import type { GitLogPanelProvider } from './GitLogPanelProvider';
import type { UndockedPanelProvider } from './UndockedPanelProvider';
import { openSquashEditor } from './SquashEditorPanel';
import { openEditMessageEditor } from './EditMessageEditorPanel';
import { compareFileWithRef, compareFolderWithRef } from './CompareWithCommand';
import { pickRefQuickPick } from '../utils/refPicker';
import type { GitProfileService } from '../git/GitProfileService';
import { LOCAL_PROFILE_ID, GLOBAL_PROFILE_ID } from '../git/GitProfileService';
import type { BranchStatusBar } from '../ui/BranchStatusBar';
import { formatGitError, showGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logInfo, logWarn, logError, showLogChannel } from '../utils/Logger';

export class CommitPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitcharm.commitPanel';
  private static readonly SHOW_ONLY_CHANGED_REPOS_KEY = 'gitcharm.showOnlyChangedRepos';
  private view?: vscode.WebviewView;
  private logProvider?: GitLogPanelProvider;
  private undockedPanel?: UndockedPanelProvider;
  private branchStatusBar?: BranchStatusBar;
  private changelistService?: ChangelistService;
  private badgeController?: import('../ui/BadgeController').BadgeController;
  // When set, post() sends to the undocked panel instead of the sidebar
  private activeReplyTarget: 'sidebar' | 'undocked' = 'sidebar';
  private cachedActiveProfile?: { name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' };

  setMergeEditorProvider(provider: MergeEditorProvider): void {
    this.mergeEditorProvider = provider;
  }

  setLogProvider(provider: GitLogPanelProvider): void {
    this.logProvider = provider;
  }

  setBadgeController(controller: import('../ui/BadgeController').BadgeController): void {
    this.badgeController = controller;
  }

  setUndockedPanel(provider: UndockedPanelProvider): void {
    this.undockedPanel = provider;
  }

  setBranchStatusBar(bar: BranchStatusBar): void {
    this.branchStatusBar = bar;
  }

  handleUndockedMessage(msg: CommitToHostMsg, _provider: UndockedPanelProvider): void {
    this.activeReplyTarget = 'undocked';
    this.handleMessage(msg, undefined as unknown as vscode.Webview).finally(() => { this.activeReplyTarget = 'sidebar'; });
  }

  prefillCommitMessage(message: string): void {
    this.post({ type: 'COMMIT_SET_MESSAGE', message });
  }
  private shelveServices = new Map<string, ShelveService>();

  private getShelveService(repoId: string): ShelveService | undefined {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return undefined;
    if (!this.shelveServices.has(repoId)) {
      this.shelveServices.set(repoId, new ShelveService(repo.rootPath, this.globalStoragePath));
    }
    return this.shelveServices.get(repoId);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly globalStoragePath: string,
    private readonly shelveDocProvider: ShelveDocumentProvider,
    private mergeEditorProvider?: MergeEditorProvider,
    private readonly profileService?: GitProfileService,
    private readonly globalState?: vscode.Memento,
    private readonly workspaceState?: vscode.Memento
  ) {
    this.manager.onStatusChange(async (status) => {
      await this.refreshActiveProfile();
      this.postChangelistsUpdate(status);
      this.broadcastCommit({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
    });

    const postAllBranches = async () => {
      for (const meta of this.manager.getRepoMetas()) {
        const repo = this.manager.getRepo(meta.id);
        if (!repo) continue;
        const branches = await repo.getBranches();
        this.broadcastCommit({ type: 'COMMIT_BRANCHES_UPDATE', repoId: meta.id, branches });
      }
    };

    this.manager.onBranchChange(postAllBranches);

    this.manager.onReposChange(async () => {
      const status = await this.manager.getAllStatusesFresh();
      this.postChangelistsUpdate(status);
      this.broadcastCommit({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
      await postAllBranches();
    });

    this.manager.onWorktreeChange(async () => {
      const repos = await this.manager.getAllWorktrees();
      this.broadcastCommit({ type: 'WORKTREE_LIST_RESULT', repos });
    });

    this.profileService?.onProfileChange(async () => {
      await this.refreshActiveProfile();
      const status = await this.manager.getAllStatuses();
      this.broadcastCommit({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
    });
  }

  /**
   * Resolves the effective profile for the repo and returns credentials for -c injection.
   * For local/global fallback sources no injection is needed — git already has the right config natively.
   * Never writes to .git/config — credentials are injected only for the duration of the commit command.
   */
  private async getCommitCredentials(repoPath: string): Promise<{ gitName: string; gitEmail: string } | undefined> {
    if (!this.profileService) return undefined;

    // For submodules, resolve the profile using the parent repo path so they
    // inherit the same identity as the parent.
    const meta = this.manager.getRepoMetas().find(m => m.rootPath === repoPath);
    const resolvedPath = (meta?.isSubmodule && meta.parentRepoId)
      ? meta.parentRepoId
      : repoPath;

    const result = await this.profileService.getEffectiveProfile(resolvedPath);
    if (!result) {
      logWarn('commit-credentials', 'No Git identity configured');
      vscode.window.showWarningMessage('No Git identity configured. Set a profile before committing.');
      return undefined;
    }
    if (result.source === 'local' || result.source === 'global') return undefined;
    const { gitName, gitEmail } = result.profile;
    if (!gitName && !gitEmail) return undefined;
    return { gitName, gitEmail };
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.badgeController?.setWebviewView(webviewView);

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
      'commitPanel',
      'GitCharm Commit'
    );

    webviewView.webview.onDidReceiveMessage((msg: CommitToHostMsg) =>
      this.handleMessage(msg, webviewView.webview)
    );

    // Refresh status whenever the panel becomes visible (e.g. user switches to it)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postRepoFilterState();
        this.manager.getAllStatuses().then(status => {
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        });
      }
    });

    // Sync current state — send changelists first so setStatus can read the correct viewMode
    this.manager.getAllStatuses().then(async status => {
      await this.refreshActiveProfile();
      this.postChangelistsUpdate(status);
      this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status, fileViewMode: this.getFileViewMode() });
      this.post({ type: 'COMMIT_HIDDEN_REPOS_UPDATE', hiddenRepoIds: this.getHiddenRepoIds() });
      this.postRepoFilterState();
      loadIconTheme(webviewView.webview).then(iconTheme => {
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status, iconTheme, fileViewMode: this.getFileViewMode() });
      }).catch(() => { /* icon theme optional */ });
    });

    // Re-send icon theme when the user changes icon or color theme
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
        if (this.view) {
          loadIconTheme(this.view.webview).then(iconTheme => {
            this.manager.getAllStatuses().then(status => {
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status, iconTheme });
            });
          }).catch(() => { /* icon theme optional */ });
        }
      }
      if (e.affectsConfiguration('gitcharm.ai.enabled')) {
        this.manager.getAllStatuses().then(status => {
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        });
      }
      if (e.affectsConfiguration('gitcharm.changesViewMode') || e.affectsConfiguration('gitcharm.defaultCommitAction') || e.affectsConfiguration('gitcharm.defaultSaveAction')) {
        this.changelistService?.setChangelistMode(this.getChangesViewMode() === 'changelists');
        this.manager.getAllStatuses().then(status => {
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        });
      }
    });

    const tabWatcher = vscode.window.tabGroups.onDidChangeTabs(e => {
      for (const tab of e.closed) {
        const input = tab.input;
        if (!input) continue;
        let filePath: string | undefined;
        if (input instanceof vscode.TabInputText) {
          filePath = input.uri.fsPath;
        } else if (input instanceof vscode.TabInputTextDiff) {
          filePath = input.modified.fsPath;
        }
        if (filePath) this.post({ type: 'COMMIT_DESELECT_FILE', filePath });
      }
    });

    webviewView.onDidDispose(() => { configWatcher.dispose(); tabWatcher.dispose(); });
  }

  private async refreshActiveProfile(): Promise<void> {
    if (!this.profileService) return;
    const repos = this.manager.getRepoMetas();
    const repoPath = repos.find(m => !m.isSubmodule)?.rootPath ?? repos[0]?.rootPath;
    if (!repoPath) return;
    const result = await this.profileService.getEffectiveProfile(repoPath);
    if (!result) { this.cachedActiveProfile = undefined; return; }
    const { profile } = result;
    this.cachedActiveProfile = { name: profile.name, gitName: profile.gitName, gitEmail: profile.gitEmail, ...(profile.builtIn ? { builtIn: profile.builtIn } : {}) };
  }

  private enrichCommitMsg(msg: HostToCommitMsg): void {
    if (msg.type === 'COMMIT_STATUS_UPDATE') {
      const m = msg as typeof msg & { fileViewMode?: 'flat' | 'tree'; defaultCommitAction?: 'commit' | 'commitAndPush'; defaultSaveAction?: 'stash' | 'shelve'; hasWorkspaceFolder?: boolean };
      if (m.fileViewMode === undefined) m.fileViewMode = this.getFileViewMode();
      if (m.defaultCommitAction === undefined) m.defaultCommitAction = this.getDefaultCommitAction();
      if (m.defaultSaveAction === undefined) m.defaultSaveAction = this.getDefaultSaveAction();
      if (m.hasWorkspaceFolder === undefined) m.hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      if (m.aiEnabled === undefined) m.aiEnabled = this.getAiEnabled();
      if (m.activeProfile === undefined) m.activeProfile = this.cachedActiveProfile;
    }
  }

  private post(msg: HostToCommitMsg): void {
    this.enrichCommitMsg(msg);
    this.syncBadgeFromMsg(msg);
    if (this.activeReplyTarget === 'undocked') {
      this.undockedPanel?.postToCommit(msg);
    } else {
      this.view?.webview.postMessage(msg);
    }
  }

  private broadcastCommit(msg: HostToCommitMsg): void {
    this.enrichCommitMsg(msg);
    this.syncBadgeFromMsg(msg);
    this.view?.webview.postMessage(msg);
    this.undockedPanel?.postToCommit(msg);
  }

  private syncBadgeFromMsg(msg: HostToCommitMsg): void {
    if (msg.type === 'COMMIT_STATUS_UPDATE') {
      this.badgeController?.update(msg.status);
    }
  }

  switchToTab(tab: 'changes' | 'shelf' | 'stash' | 'worktree' | 'push'): void {
    this.post({ type: 'COMMIT_SWITCH_TAB', tab });
  }

  /** Reads fresh status after a stage/unstage op. simple-git reads directly from the git index so it's always accurate once the op completes. */
  private async refreshStatusAfterOp(): Promise<WorkspaceStatus> {
    return this.manager.getAllStatusesFresh();
  }

  private getChangesViewMode(): 'simplified' | 'changelists' | 'vscode' {
    return vscode.workspace.getConfiguration('gitcharm').get<'simplified' | 'changelists' | 'vscode'>('changesViewMode', 'simplified');
  }

  private getFileViewMode(): 'flat' | 'tree' {
    return this.globalState?.get<'flat' | 'tree'>('fileViewMode', 'tree') ?? 'tree';
  }

  private getShowOnlyChangedRepos(): boolean {
    return this.globalState?.get<boolean>(CommitPanelProvider.SHOW_ONLY_CHANGED_REPOS_KEY, false) ?? false;
  }

  private postRepoFilterState(): void {
    this.post({ type: 'COMMIT_REPO_FILTER_UPDATE', showOnlyChangedRepos: this.getShowOnlyChangedRepos() });
  }

  private async setShowOnlyChangedRepos(showOnlyChangedRepos: boolean): Promise<void> {
    await this.globalState?.update(CommitPanelProvider.SHOW_ONLY_CHANGED_REPOS_KEY, showOnlyChangedRepos);
    this.postRepoFilterState();
  }

  private getDefaultCommitAction(): 'commit' | 'commitAndPush' {
    return vscode.workspace.getConfiguration('gitcharm').get<'commit' | 'commitAndPush'>('defaultCommitAction', 'commit');
  }

  private getDefaultSaveAction(): 'stash' | 'shelve' {
    return vscode.workspace.getConfiguration('gitcharm').get<'stash' | 'shelve'>('defaultSaveAction', 'stash');
  }

  private getAiEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitcharm').get<boolean>('ai.enabled', true);
  }

  private getHiddenRepoIds(): string[] {
    return this.workspaceState?.get<string[]>('gitcharm.hiddenRepoIds', []) ?? [];
  }

  private async setHiddenRepoIds(ids: string[]): Promise<void> {
    await this.workspaceState?.update('gitcharm.hiddenRepoIds', ids);
    this.post({ type: 'COMMIT_HIDDEN_REPOS_UPDATE', hiddenRepoIds: ids });
    this.logProvider?.notifyHiddenReposChanged(ids);
    this.badgeController?.setHiddenRepoIds(ids);
  }

  async hideRepo(repoId: string): Promise<void> {
    const current = this.getHiddenRepoIds();
    if (current.includes(repoId)) return;
    const allRepos = this.manager.getRepoMetas();
    const visibleCount = allRepos.filter(m => !current.includes(m.id)).length;
    if (visibleCount <= 1) return;
    await this.setHiddenRepoIds([...current, repoId]);
  }

  async unhideRepo(repoId: string): Promise<void> {
    const current = this.getHiddenRepoIds();
    await this.setHiddenRepoIds(current.filter(id => id !== repoId));
  }

  async manageHiddenRepos(): Promise<void> {
    const hidden = this.getHiddenRepoIds();
    if (hidden.length === 0) {
      vscode.window.showInformationMessage('No hidden repositories.');
      return;
    }
    const allMetas = this.manager.getRepoMetas();
    const items = hidden.map(id => {
      const meta = allMetas.find(m => m.id === id);
      return { label: `$(eye) ${meta?.name ?? id}`, repoId: id };
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select repositories to show again',
      canPickMany: true,
      title: 'Hidden Repositories',
    });
    if (!picked || picked.length === 0) return;
    const toUnhide = picked.map(p => p.repoId);
    await this.setHiddenRepoIds(hidden.filter(id => !toUnhide.includes(id)));
  }

  private getOrCreateChangelistService(): ChangelistService | undefined {
    if (this.changelistService) return this.changelistService;
    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folderPath) return undefined;
    const workspaceFilePath = vscode.workspace.workspaceFile?.scheme === 'file'
      ? vscode.workspace.workspaceFile.fsPath
      : undefined;
    this.changelistService = new ChangelistService(folderPath, this.globalStoragePath, workspaceFilePath, this.getChangesViewMode() === 'changelists');
    return this.changelistService;
  }

  private postChangelistsUpdate(status?: WorkspaceStatus): void {
    const svc = this.getOrCreateChangelistService();
    if (!svc) return;
    if (status) svc.reconcile(status.repos);
    this.broadcastCommit({
      type: 'CHANGELISTS_UPDATE',
      changelists: svc.getAll(),
      viewMode: this.getChangesViewMode(),
    });
  }

  private buildChangelistAssignments(
    svc: ChangelistService,
    repoId: string,
    paths?: string[],
  ): Array<{ path: string; changelistId: string; changelistName: string }> | undefined {
    const result: Array<{ path: string; changelistId: string; changelistName: string }> = [];
    for (const cl of svc.getAll()) {
      const clPaths = cl.fileAssignments[repoId] ?? [];
      for (const p of clPaths) {
        if (!paths || paths.includes(p)) {
          result.push({ path: p, changelistId: cl.id, changelistName: cl.name });
        }
      }
    }
    return result.length > 0 ? result : undefined;
  }

  private async restoreChangelistAssignments(
    repoId: string,
    assignments: Array<{ path: string; changelistId: string; changelistName: string }>,
  ): Promise<void> {
    const svc = this.getOrCreateChangelistService();
    if (!svc) return;
    // Ensure all target changelists exist (recreate if deleted)
    const existing = svc.getAll();
    const neededIds = [...new Set(assignments.map(a => a.changelistId))];
    for (const id of neededIds) {
      const { CHANGELIST_DEFAULT_ID: DEF, CHANGELIST_UNVERSIONED_ID: UNV } = await import('../types/git');
      if (id === DEF || id === UNV) continue;
      if (!existing.find(c => c.id === id)) {
        const name = assignments.find(a => a.changelistId === id)?.changelistName ?? id;
        const newCl = svc.create(name);
        // Override the auto-generated id to match the original (so assignments work)
        // We can't do that easily, so instead remap to the new id
        const newId = newCl.id;
        for (const a of assignments) {
          if (a.changelistId === id) a.changelistId = newId;
        }
      }
    }
    svc.moveFiles(assignments.map(a => ({ repoId, path: a.path, changelistId: a.changelistId })));
  }

  private async stageUnversionedFiles(
    svc: ChangelistService,
    assignments: Array<{ repoId: string; path: string; changelistId: string }>,
  ): Promise<void> {
    const unversionedCl = svc.getAll().find(c => c.id === CHANGELIST_UNVERSIONED_ID);
    if (!unversionedCl) return;
    const byRepo = new Map<string, string[]>();
    for (const { repoId, path: filePath, changelistId } of assignments) {
      if (changelistId === CHANGELIST_UNVERSIONED_ID) continue;
      const unvPaths = unversionedCl.fileAssignments[repoId] ?? [];
      if (!unvPaths.includes(filePath)) continue;
      if (!byRepo.has(repoId)) byRepo.set(repoId, []);
      byRepo.get(repoId)!.push(filePath);
    }
    for (const [repoId, paths] of byRepo) {
      const repo = this.manager.getRepo(repoId);
      if (repo) await repo.stageFiles(paths).catch(() => {});
    }
  }

  private async handleMessage(msg: CommitToHostMsg, webview: vscode.Webview): Promise<void> {
    switch (msg.type) {
      case 'COMMIT_REQUEST_STATUS': {
        const [repos, status, iconTheme] = await Promise.all([
          Promise.resolve(this.manager.getRepoMetas()),
          this.manager.getAllStatuses(),
          this.view ? loadIconTheme(this.view.webview) : Promise.resolve(undefined),
        ]);
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos, status, iconTheme });
        this.postRepoFilterState();
        this.postChangelistsUpdate(status);
        break;
      }

      case 'COMMIT_REQUEST_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          logWarn('diff', 'Repo not found');
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff: null, error: 'Repo not found' });
          return;
        }
        try {
          const diff = msg.staged
            ? await repo.getStagedDiff(msg.repoId, msg.filePath)
            : await repo.getUnstagedDiff(msg.repoId, msg.filePath);
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff });
        } catch (e: unknown) {
          logError('diff', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff: null, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_STAGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('stage', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.stageFiles(msg.paths);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('stage', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_UNSTAGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('unstage', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.unstageFiles(msg.paths);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('unstage', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_STAGE_ALL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('stage-all', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.stageAll();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('stage-all', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_UNSTAGE_ALL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('unstage-all', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.unstageAll();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('unstage-all', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_DO_COMMIT': {
        this.profileService?.trace(`COMMIT_DO_COMMIT received repoId=${msg.repoId}`);
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('commit', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const creds = await this.getCommitCredentials(repo.rootPath);
          const output = await repo.commit(msg.message, msg.amend, creds, s => this.profileService?.trace(s));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, output });
          logInfo('commit', `Committed${msg.amend ? ' (amend)' : ''} in ${msg.repoId}`);
          this.logProvider?.refresh();
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('commit', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_DO_COMMIT_PUSH': {
        this.profileService?.trace(`COMMIT_DO_COMMIT_PUSH received repoId=${msg.repoId}`);
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('commit-push', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Commit & Push', cancellable: false },
          async () => {
            try {
              const creds = await this.getCommitCredentials(repo.rootPath);
              await repo.commit(msg.message, msg.amend, creds, s => this.profileService?.trace(s));
              await repo.push();
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
              logInfo('commit-push', `Committed and pushed in ${msg.repoId}`);
              this.logProvider?.refresh();
              const status = await this.manager.getAllStatusesFresh();
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            } catch (e: unknown) {
              logError('commit-push', formatGitError(e), getRawErrorDetail(e));
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
            }
          }
        );
        break;
      }

      case 'COMMIT_DO_COMMIT_MULTI': {
        this.profileService?.trace(`COMMIT_DO_COMMIT_MULTI received repos=${msg.repos.map(r=>r.repoId).join(',')}`);
        // Check for missing remotes before pushing
        if (msg.andPush) {
          const noRemoteRepoIds: string[] = [];
          for (const r of msg.repos) {
            const repo = this.manager.getRepo(r.repoId);
            if (!repo) continue;
            const remotes = await repo.getRemotes().catch(() => []);
            if (remotes.length === 0) noRemoteRepoIds.push(r.repoId);
          }
          if (noRemoteRepoIds.length > 0) {
            logWarn('commit-multi', 'No remote configured');
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'No remote configured' });
            if (noRemoteRepoIds.length === 1) {
              const meta = this.manager.getRepoMetas().find(m => m.id === noRemoteRepoIds[0]);
              if (meta && this.branchStatusBar) await this.branchStatusBar.showRepoRemotesMenu(meta);
            } else {
              const names = noRemoteRepoIds.map(id => id.split('/').pop() ?? id);
              vscode.window.showInformationMessage(
                `Cannot push — no remote configured for: ${names.join(', ')}. Add a remote first (git remote add <name> <url>).`
              );
            }
            return;
          }
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Committing ${msg.repos.length} ${msg.repos.length === 1 ? 'repository' : 'repositories'}`, cancellable: false },
          async () => {
            const errors: string[] = [];
            // Commit submodules before parent repos so the parent's pointer update
            // always refers to an already-committed submodule state.
            const repoMetas = this.manager.getRepoMetas();
            const ordered = [...msg.repos].sort((a, b) => {
              const aMeta = repoMetas.find(m => m.id === a.repoId);
              const bMeta = repoMetas.find(m => m.id === b.repoId);
              const aDepth = aMeta?.depth ?? 0;
              const bDepth = bMeta?.depth ?? 0;
              return bDepth - aDepth; // deeper (submodules) first
            });
            for (const r of ordered) {
              const repo = this.manager.getRepo(r.repoId);
              if (!repo) { errors.push(`${r.repoId}: not found`); continue; }
              try {
                // Stage/unstage according to user selection before committing
                if (r.filesToUnstage.length > 0) await repo.unstageFiles(r.filesToUnstage);
                if (r.filesToStage.length > 0) await repo.stageFiles(r.filesToStage);
                const creds = await this.getCommitCredentials(repo.rootPath);
                await repo.commit(r.message, r.amend, creds, s => this.profileService?.trace(s));
                if (msg.andPush) await repo.push();
              } catch (e: unknown) {
                errors.push(`${r.repoId.split('/').pop()}: ${formatGitError(e)}`);
                logError(`commit-multi:${r.repoId}`, formatGitError(e), getRawErrorDetail(e));
              }
            }
            if (errors.length > 0) {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
            } else {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
              logInfo('commit-multi', `Committed ${msg.repos.length} ${msg.repos.length === 1 ? 'repository' : 'repositories'}${msg.andPush ? ' and pushed' : ''}`);
              this.logProvider?.refresh();
            }
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
          }
        );
        break;
      }

      case 'OPEN_PROFILES_MENU': {
        vscode.commands.executeCommand('gitcharm.manageProfiles');
        break;
      }

      case 'COMMIT_PULL_ALL': {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Pulling all repositories', cancellable: false },
          async (progress) => {
            const results = await this.manager.pullAll();
            const failed = results.filter(r => !r.ok);
            if (failed.length > 0) {
              for (const r of failed) {
                logError('pull-all', `${r.repoId}: pull failed`);
              }
              void vscode.window.showWarningMessage(`${failed.length} pull(s) failed`, 'Show Log').then(choice => {
                if (choice === 'Show Log') showLogChannel();
              });
            } else {
              logInfo('pull-all', `Pulled ${results.length} ${results.length === 1 ? 'repository' : 'repositories'}`);
            }
          }
        );
        break;
      }

      case 'COMMIT_PULL_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('pull', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const output = await repo.pull();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, output });
          logInfo('pull', `Pulled ${msg.repoId}`);
          const pullStatus = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: pullStatus });
        } catch (e: unknown) {
          logError('pull', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_GET_REMOTES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('remotes', 'Repo not found'); this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: 'Repo not found' }); return; }
        try {
          const remotes = await repo.getRemotes();
          this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes });
        } catch (e: unknown) {
          logError('remotes', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_GET_LAST_COMMIT_MESSAGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('last-commit-msg', 'Repo not found'); this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, message: '', error: 'Repo not found' }); return; }
        try {
          const message = await repo.getLastCommitMessage();
          this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, message });
        } catch (e: unknown) {
          logError('last-commit-msg', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, message: '', error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_PUSH_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('push', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) {
          logWarn('push', 'No remote configured');
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'No remote configured' });
          const meta = this.manager.getRepoMetas().find(m => m.id === msg.repoId);
          if (meta && this.branchStatusBar) {
            await this.branchStatusBar.showRepoRemotesMenu(meta);
          }
          break;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Pushing', cancellable: false },
          async () => {
            try {
              await repo.push(msg.force ?? false, msg.remote);
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
              logInfo('push', `Pushed ${msg.repoId}`);
              this.logProvider?.refresh();
              const status = await this.manager.getAllStatusesFresh();
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            } catch (e: unknown) {
              logError('push', formatGitError(e), getRawErrorDetail(e));
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
            }
          }
        );
        break;
      }

      case 'COMMIT_SYNC_AND_PUSH_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('sync-push', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Syncing', cancellable: false },
          async () => {
            try {
              await (msg.rebase ? repo.pullRebase() : repo.pull());
            } catch (e: unknown) {
              logError('sync-push:pull', formatGitError(e), getRawErrorDetail(e));
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: `Pull failed: ${formatGitError(e)}` });
              const status = await this.manager.getAllStatusesFresh();
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
              return;
            }
            try {
              await repo.push();
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
              logInfo('sync-push', `Synced and pushed ${msg.repoId}`);
              this.logProvider?.refresh();
              const status = await this.manager.getAllStatusesFresh();
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            } catch (e: unknown) {
              logError('sync-push:push', formatGitError(e), getRawErrorDetail(e));
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: `Push failed: ${formatGitError(e)}` });
            }
          }
        );
        break;
      }

      case 'COMMIT_DISCARD_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('discard', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Discard changes to ${msg.path}? This cannot be undone.`,
          { modal: true }, 'Discard'
        );
        if (confirm !== 'Discard') { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.discardFile(msg.path);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('discard', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_DISCARD_FILES': {
        const n = msg.files.length;
        const confirm = await vscode.window.showWarningMessage(
          `Discard changes to ${n} file${n === 1 ? '' : 's'}? This cannot be undone.`,
          { modal: true }, 'Discard'
        );
        if (confirm !== 'Discard') {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          break;
        }
        const errors: string[] = [];
        for (const f of msg.files) {
          const repo = this.manager.getRepo(f.repoId);
          if (!repo) { errors.push(`${f.path}: repo not found`); continue; }
          try { await repo.discardFile(f.path); }
          catch (e: unknown) { errors.push(`${f.path}: ${formatGitError(e)}`); logError(`discard-files:${f.repoId}`, formatGitError(e), getRawErrorDetail(e)); }
        }
        if (errors.length > 0) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
        } else {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        const status = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        break;
      }

      case 'COMMIT_OPEN_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absUri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
        // git.openChange opens the native VS Code diff (index↔worktree or HEAD↔index)
        // depending on which group the file is in. Passing the file URI is enough.
        try {
          await vscode.commands.executeCommand('git.openChange', absUri);
        } catch {
          // Fallback: manual vscode.diff with git: URI scheme
          const ref = msg.staged ? '' : '~';
          const gitUri = absUri.with({
            scheme: 'git',
            query: JSON.stringify({ path: absUri.fsPath, ref }),
          });
          const title = msg.staged
            ? `${msg.filePath} (Index ↔ HEAD)`
            : `${msg.filePath} (Working Tree)`;
          await vscode.commands.executeCommand('vscode.diff', gitUri, absUri, title);
        }
        break;
      }

      case 'COMMIT_SHOW_DIFF_TAB': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absPath = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
        await vscode.commands.executeCommand('git.openChange', absPath).then(
          undefined,
          // fallback: open as diff with HEAD
          () => vscode.commands.executeCommand('vscode.diff',
            absPath.with({ scheme: 'git', query: JSON.stringify({ path: absPath.fsPath, ref: 'HEAD' }) }),
            absPath,
            `${msg.filePath} (Working Tree)`
          )
        );
        break;
      }

      case 'COMMIT_OPEN_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absPath = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
        await vscode.window.showTextDocument(absPath, { preview: false });
        break;
      }

      case 'COMMIT_SHOW_FILE_HISTORY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absUri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
        await vscode.commands.executeCommand('gitcharm.showFileHistory', absUri);
        break;
      }

      case 'COMMIT_COMPARE_FILE_WITH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const pickedRef = await pickRefQuickPick(repo, {
          placeHolder: `Compare ${msg.filePath} with…`,
          title: 'GitCharm - Compare With',
        });
        if (!pickedRef) return;
        let refHash: string;
        try {
          refHash = await repo.resolveRef(pickedRef);
        } catch {
          logError('compare-file-with', `Cannot resolve ref "${pickedRef}"`);
          vscode.window.showErrorMessage(`Cannot resolve ref "${pickedRef}"`);
          return;
        }
        await compareFileWithRef(repo, msg.filePath, refHash);
        break;
      }

      case 'COMMIT_COMPARE_FOLDER_WITH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const pickedRef = await pickRefQuickPick(repo, {
          placeHolder: `Compare ${msg.folderPath || '.'} with…`,
          title: 'GitCharm - Compare With',
        });
        if (!pickedRef) return;
        let refHash: string;
        try {
          refHash = await repo.resolveRef(pickedRef);
        } catch {
          logError('compare-folder-with', `Cannot resolve ref "${pickedRef}"`);
          vscode.window.showErrorMessage(`Cannot resolve ref "${pickedRef}"`);
          return;
        }
        await compareFolderWithRef(repo, msg.folderPath, refHash);
        break;
      }

      case 'COMMIT_DELETE_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('delete-file', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${msg.filePath}? This cannot be undone.`,
          { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          const absPath = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
          await vscode.workspace.fs.delete(absPath, { useTrash: true });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          logError('delete-file', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_DELETE_FOLDER': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('delete-folder', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Delete folder "${msg.folderPath}" and all its contents? This cannot be undone.`,
          { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {

          const absPath = vscode.Uri.file(path.join(repo.rootPath, msg.folderPath));
          await vscode.workspace.fs.delete(absPath, { recursive: true, useTrash: true });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('delete-folder', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'COMMIT_ADD_TO_GITIGNORE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        
        const fs = require('fs') as typeof import('fs');

        // Find all .gitignore files in the repo
        const rootUri = vscode.Uri.file(repo.rootPath);
        const gitignoreFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(rootUri, '**/.gitignore'),
          new vscode.RelativePattern(rootUri, '**/node_modules/**'),
          20
        );

        // Sort: root .gitignore first, then alphabetical
        gitignoreFiles.sort((a, b) => {
          const aRel = path.relative(repo.rootPath, a.fsPath);
          const bRel = path.relative(repo.rootPath, b.fsPath);
          if (aRel === '.gitignore') return -1;
          if (bRel === '.gitignore') return 1;
          return aRel.localeCompare(bRel);
        });

        // If no .gitignore exists, create one at the root
        let targetPath: string;
        if (gitignoreFiles.length === 0) {
          targetPath = path.join(repo.rootPath, '.gitignore');
        } else if (gitignoreFiles.length === 1) {
          targetPath = gitignoreFiles[0].fsPath;
        } else {
          // Let user pick
          const picks = gitignoreFiles.map(f => ({
            label: path.relative(repo.rootPath, f.fsPath),
            fsPath: f.fsPath,
          }));
          const picked = await vscode.window.showQuickPick(picks, {
            title: 'Add to .gitignore',
            placeHolder: 'Select which .gitignore to update',
          });
          if (!picked) return;
          targetPath = picked.fsPath;
        }

        // Determine the entry to add (relative to the .gitignore's directory)
        const gitignoreDir = path.dirname(targetPath);
        let entry = path.relative(gitignoreDir, path.join(repo.rootPath, msg.entryPath));
        // Normalise to forward slashes
        entry = entry.split(path.sep).join('/');

        // Append to .gitignore if not already present
        let existing = '';
        try { existing = fs.readFileSync(targetPath, 'utf8'); } catch { /* new file */ }
        const lines = existing.split('\n').map(l => l.trim());
        if (lines.includes(entry) || lines.includes('/' + entry)) {
          vscode.window.showInformationMessage(`"${entry}" is already in ${path.relative(repo.rootPath, targetPath)}`);
          return;
        }
        const newContent = existing.endsWith('\n') || existing === ''
          ? existing + entry + '\n'
          : existing + '\n' + entry + '\n';
        fs.writeFileSync(targetPath, newContent, 'utf8');
        vscode.window.showInformationMessage(`Added "${entry}" to ${path.relative(repo.rootPath, targetPath)}`);
        logInfo('gitignore', `Added "${entry}" to ${path.relative(repo.rootPath, targetPath)}`);

        // Refresh status so the newly-ignored file disappears
        const status = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        break;
      }

      case 'COMMIT_SHOW_BRANCH_MENU': {
        await vscode.commands.executeCommand('gitcharm.showBranchMenu', msg.repoId);
        break;
      }

      case 'COMMIT_OPEN_MERGE_EDITOR': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absPath = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
        await vscode.commands.executeCommand('git.openMergeEditor', absPath)
          .then(undefined, () => vscode.window.showTextDocument(absPath));
        break;
      }

      case 'COMMIT_SELECT_AI_MODEL': {
        await vscode.commands.executeCommand('gitcharm.selectAiModel');
        break;
      }

      case 'COMMIT_OPEN_AI_SETTINGS': {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rionoir.gitcharm gitcharm.ai');
        break;
      }

      case 'COMMIT_GENERATE_MESSAGE': {
        try {
          const ws = await this.manager.getAllStatuses();
          const cfg = vscode.workspace.getConfiguration('gitcharm');
          const maxDiffChars: number = cfg.get('ai.maxDiffChars', 8000);
          const multiRepo = ws.repos.length > 1;

          // Collect file summary + diff per repo
          const sections: string[] = [];
          for (const repo of ws.repos) {
            const repoName = path.basename(repo.repoId);
            const files = [...repo.stagedFiles, ...repo.unstagedFiles];
            if (files.length === 0) continue;

            const fileLines = files.slice(0, 50).map(f => `${f.status[0].toUpperCase()} ${f.path}`);
            const svc = this.manager.getRepo(repo.repoId);
            const diff = svc ? await svc.getFullStagedDiff(maxDiffChars) : '';

            const block = [
              multiRepo ? `### Repository: ${repoName}` : '',
              '## Changed files',
              fileLines.join('\n'),
              diff ? `\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`` : '',
            ].filter(Boolean).join('\n');
            sections.push(block);
          }

          const context = sections.join('\n\n');
          const configuredLang: string = cfg.get('ai.language', '');
          const language = configuredLang.trim() || vscode.env.language || 'en';
          const prompt = [
            'You are a git commit message writer. Analyze the following changes and write a commit message.',
            '',
            'Rules:',
            `- Write the commit message in this language: ${language}`,
            '- First line: imperative mood, max 72 characters (e.g. "Add user authentication")',
            '- Leave a blank line after the first line',
            '- Body: 2-4 bullet points explaining WHAT changed and WHY, each starting with "- "',
            '- Be specific and technical, reference file names or module names when relevant',
            '- Output ONLY the commit message, no explanations, no markdown fences',
            '',
            context,
          ].join('\n');

          const provider: string = cfg.get('ai.provider', 'vscode-lm');
          const message = await generateWithAI(provider, prompt, cfg);
          this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, message });
        } catch (e: unknown) {
          logError('ai-generate', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, error: formatGitError(e) });
        }
        break;
      }

      case 'SHELVE_LIST': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { logWarn('shelve-list', 'Repo not found'); this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves: [], error: 'Repo not found' }); return; }
        try {
          const shelves = await svc.list();
          this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves });
        } catch (e: unknown) {
          logError('shelve-list', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves: [], error: formatGitError(e) });
        }
        break;
      }

      case 'SHELVE_PUSH': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { logWarn('shelve-push', 'Repo not found'); this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: 'Repo not found' }); return; }
        try {
          // Capture changelist assignments for the shelved files, if in changelists mode
          const clSvc = this.getOrCreateChangelistService();
          const clAssignments = clSvc ? this.buildChangelistAssignments(clSvc, msg.repoId, msg.paths) : undefined;
          await svc.push(msg.name, msg.paths, clAssignments);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.postChangelistsUpdate(status);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: true });
        } catch (e: unknown) {
          logError('shelve-push', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'SHELVE_APPLY': {
        const svc = this.getShelveService(msg.repoId);
        const repo = this.manager.getRepo(msg.repoId);
        if (!svc || !repo) { logWarn('shelve-apply', 'Repo not found'); this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: 'Repo not found' }); return; }
        try {
          const clAssignments = await svc.apply(msg.shelveId, msg.paths);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          // Restore changelist assignments if present
          if (clAssignments?.length) {
            await this.restoreChangelistAssignments(msg.repoId, clAssignments);
          }
          this.postChangelistsUpdate(status);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: true });
        } catch (e: unknown) {
          const err = e as { code?: string; conflictFiles?: string[] };
          if (err.code === 'SHELVE_CONFLICT' && err.conflictFiles?.length) {
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
            this.post({
              type: 'SHELVE_OP_RESULT',
              requestId: msg.requestId,
              repoId: msg.repoId,
              op: 'apply',
              ok: true,
              hasConflicts: true,
              conflictFiles: err.conflictFiles,
            });
            
            for (const filePath of err.conflictFiles) {
              const absUri = vscode.Uri.file(path.join(repo.rootPath, filePath));
              try {
                await vscode.commands.executeCommand('git.openMergeEditor', absUri);
              } catch {
                await vscode.window.showTextDocument(absUri, { preview: false });
              }
            }
          } else {
            logError('shelve-apply', formatGitError(e), getRawErrorDetail(e));
            this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: formatGitError(e) });
          }
        }
        break;
      }

      case 'SHELVE_DROP': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { logWarn('shelve-drop', 'Repo not found'); this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Repo not found' }); return; }
        const confirmDrop = await vscode.window.showWarningMessage(
          'Delete this shelved changelist? This cannot be undone.',
          { modal: true }, 'Delete'
        );
        if (confirmDrop !== 'Delete') { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Cancelled' }); return; }
        try {
          svc.drop(msg.shelveId);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: true });
        } catch (e: unknown) {
          logError('shelve-drop', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'SHELVE_RENAME': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { logWarn('shelve-rename', 'Repo not found'); this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Repo not found' }); return; }
        const newName = await vscode.window.showInputBox({
          title: 'Rename Shelf',
          prompt: 'Enter a new name for the shelf',
          value: msg.currentName,
        });
        if (!newName || newName === msg.currentName) { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Cancelled' }); return; }
        try {
          svc.rename(msg.shelveId, newName);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: true });
        } catch (e: unknown) {
          logError('shelve-rename', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'SHELVE_GET_FILE_DIFF': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { logWarn('shelve-diff', 'Repo not found'); this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: msg.filePath, diff: '', error: 'Repo not found' }); return; }
        try {
          const diff = svc.getFileDiff(msg.shelveId, msg.filePath);
          this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: msg.filePath, diff });
        } catch (e: unknown) {
          logError('shelve-diff', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: msg.filePath, diff: '', error: formatGitError(e) });
        }
        break;
      }

      case 'SHELVE_OPEN_FILE_DIFF': {
        const svc = this.getShelveService(msg.repoId);
        const repo = this.manager.getRepo(msg.repoId);
        if (!svc || !repo) return;
        try {
          const fs = require('fs') as typeof import('fs');
          

          const diffChunk = svc.getFileDiff(msg.shelveId, msg.filePath);
          const absFilePath = path.join(repo.rootPath, msg.filePath);
          const fileName = msg.filePath.split('/').pop() ?? msg.filePath;

          // Read current working tree content (empty string if file doesn't exist)
          let currentContent = '';
          const fileExists = fs.existsSync(absFilePath);
          if (fileExists) {
            try { currentContent = fs.readFileSync(absFilePath, 'utf8'); } catch { /* unreadable */ }
          }

          // Apply the patch to get what the file would look like after unshelving
          const afterContent = applyPatchToContent(diffChunk, currentContent);

          // Right side: virtual doc showing post-unshelve content
          const afterUri = ShelveDocumentProvider.buildUri(msg.repoId, msg.shelveId, msg.filePath);
          this.shelveDocProvider.set(afterUri, afterContent);

          // Left side: actual current working tree file, or virtual empty doc if file doesn't exist
          let leftUri: vscode.Uri;
          if (fileExists) {
            leftUri = vscode.Uri.file(absFilePath);
          } else {
            leftUri = ShelveDocumentProvider.buildUri(msg.repoId, `${msg.shelveId}-before`, msg.filePath);
            this.shelveDocProvider.set(leftUri, '');
          }

          await vscode.commands.executeCommand(
            'vscode.diff',
            leftUri,    // left = current file (or empty if deleted)
            afterUri,   // right = after applying shelf
            `${fileName} (Working Tree ↔ After Unshelve)`
          );
        } catch { /* silently ignore if file cannot be diffed */ }
        break;
      }

      case 'STASH_OPEN_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          
          const fs = require('fs') as typeof import('fs');
          const fileName = msg.filePath.split('/').pop() ?? msg.filePath;
          const absPath = path.join(repo.rootPath, msg.filePath);
          const safeRef = msg.stashRef.replace(/[{}]/g, '_');

          // Left: current working tree content (virtual doc to avoid VSCode git extension interference)
          let currentContent = '';
          try {
            if (fs.existsSync(absPath)) currentContent = fs.readFileSync(absPath, 'utf8');
          } catch { /* unreadable, keep empty */ }
          const currentUri = ShelveDocumentProvider.buildUri(msg.repoId, `${safeRef}-current`, msg.filePath);
          this.shelveDocProvider.set(currentUri, currentContent);

          // Right: stashed version — tracked path first, then untracked (stash@{N}^3)
          const stashedContent = await repo.getStashFileContent(msg.stashRef, msg.filePath);
          const stashUri = ShelveDocumentProvider.buildUri(msg.repoId, safeRef, msg.filePath);
          this.shelveDocProvider.set(stashUri, stashedContent);

          await vscode.commands.executeCommand(
            'vscode.diff',
            currentUri,
            stashUri,
            `${fileName} (Working Tree ↔ ${msg.stashRef})`
          );
        } catch (e) {
          showGitError('stash-diff', e);
        }
        break;
      }

      case 'STASH_LIST': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          logWarn('stash-list', 'Repo not found');
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes: [], error: 'Repo not found' });
          return;
        }
        try {
          const stashes = await repo.stashList();
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes });
        } catch (e: unknown) {
          logError('stash-list', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes: [], error: formatGitError(e) });
        }
        break;
      }

      case 'STASH_SHOW': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          logWarn('stash-show', 'Repo not found');
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff: '', error: 'Repo not found' });
          return;
        }
        try {
          const diff = await repo.stashShow(msg.stashRef, msg.filePath);
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff });
        } catch (e: unknown) {
          logError('stash-show', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff: '', error: formatGitError(e) });
        }
        break;
      }

      case 'STASH_APPLY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          logWarn('stash-apply', 'Repo not found');
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repo.stashApply(msg.stashRef);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: true });
          logInfo('stash-apply', `Applied stash in ${msg.repoId}`);
        } catch (e: unknown) {
          logError('stash-apply', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'STASH_POP': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          logWarn('stash-pop', 'Repo not found');
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repo.stashPop(msg.stashRef);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: true });
          logInfo('stash-pop', `Popped stash in ${msg.repoId}`);
        } catch (e: unknown) {
          logError('stash-pop', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'STASH_DROP': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          logWarn('stash-drop', 'Repo not found');
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Repo not found' });
          return;
        }
        const confirmDrop = await vscode.window.showWarningMessage(
          'Drop this stash? This cannot be undone.',
          { modal: true }, 'Drop'
        );
        if (confirmDrop !== 'Drop') {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.stashDrop(msg.stashRef);
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: true });
        } catch (e: unknown) {
          logError('stash-drop', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'STASH_RENAME': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('stash-rename', 'Repo not found'); this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Repo not found' }); return; }
        const newMessage = await vscode.window.showInputBox({
          title: 'Rename Stash',
          prompt: 'Enter a new description for the stash',
          value: msg.currentMessage,
        });
        if (!newMessage || newMessage === msg.currentMessage) { this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.stashRename(msg.stashRef, newMessage);
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: true });
        } catch (e: unknown) {
          logError('stash-rename', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'PUSH_GET_UNPUSHED': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          logWarn('unpushed', 'Repo not found');
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: 'Repo not found' });
          return;
        }
        try {
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
        } catch (e: unknown) {
          logError('unpushed', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: formatGitError(e) });
        }
        break;
      }

      case 'STASH_PUSH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          logWarn('stash-push', 'Repo not found');
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repo.stashPush(msg.message, msg.paths);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: true });
          logInfo('stash-push', `Stashed changes in ${msg.repoId}`);
        } catch (e: unknown) {
          logError('stash-push', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'PUSH_SQUASH_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('squash', 'Repo not found'); this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const fullMessages = await Promise.all(msg.hashes.map(h => repo.getFullCommitMessage(h).then(m => m.trim())));
        const fullCombined = fullMessages.join('\n\n');
        const fullCommits = msg.commits.map((c, i) => ({ ...c, message: fullMessages[i] ?? c.message }));
        const result = await openSquashEditor(this.extensionUri, msg.hashes.length, fullCombined, fullCommits);
        if (!result.confirmed) {
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.squashCommits(msg.oldestHash, result.message);
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, ok: true });
          logInfo('squash', `Squashed ${msg.hashes.length} commits in ${msg.repoId}`);
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('squash', e);
        }
        break;
      }

      case 'PUSH_DROP_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('drop-commits', 'Repo not found'); this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Drop ${msg.hashes.length} commits? This rewrites history and cannot be undone.`,
          { modal: true }, 'Drop'
        );
        if (confirm !== 'Drop') { this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.dropCommits(msg.oldestHash);
          this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, ok: true });
          logInfo('drop-commits', `Dropped ${msg.hashes.length} commits in ${msg.repoId}`);
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('drop-commits', e);
        }
        break;
      }

      case 'PUSH_REVERT_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('revert', 'Repo not found'); this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Revert ${msg.hashes.length} commits? This creates new commits that undo the changes.`,
          { modal: true }, 'Revert'
        );
        if (confirm !== 'Revert') { this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.revertCommits(msg.hashes);
          this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, ok: true });
          logInfo('revert', `Reverted ${msg.hashes.length} commits in ${msg.repoId}`);
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          const errMsg = formatGitError(e);
          this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            logError('revert', errMsg, getRawErrorDetail(e));
            const choice = await vscode.window.showWarningMessage(
              'Revert has conflicts. Resolve them, then choose an action.',
              'Continue', 'Abort'
            );
            if (choice === 'Continue') await repo.revertContinue();
            else await repo.revertAbort();
          } else {
            showGitError('revert', e);
          }
        }
        break;
      }

      case 'PUSH_EDIT_COMMIT_MSG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('edit-commit-msg', 'Repo not found'); this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const fullMessage = (await repo.getFullCommitMessage(msg.hash)).trim();
        const result = await openEditMessageEditor(this.extensionUri, msg.hash.slice(0, 8), fullMessage);
        if (!result.confirmed) {
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.rewordCommit(result.message);
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, ok: true });
          logInfo('edit-commit-msg', `Edited commit message in ${msg.repoId}`);
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('edit-commit-msg', e);
        }
        break;
      }

      case 'PUSH_OPEN_DETAIL': {
        const { openCommitDetailPanel } = await import('./CommitDetailPanel');
        await openCommitDetailPanel(this.extensionUri, this.manager, msg.repoId, msg.hash);
        break;
      }

      case 'PUSH_OPEN_COMMIT_CHANGES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        const files = await repo.getCommitFiles(msg.hash);
        const rootPath = repo.rootPath;
        const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        const parentHash = (await repo.getParents(msg.hash))[0] ?? EMPTY_TREE;
        const gitUri = (ref: string, filePath: string): vscode.Uri => {
          const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
          return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
        };
        const resources = files
          .filter(f => f.status !== 'U')
          .map(f => {
            const label = vscode.Uri.file(path.join(rootPath, f.path));
            const original = gitUri(f.status === 'A' ? EMPTY_TREE : parentHash, f.oldPath ?? f.path);
            const modified = gitUri(f.status === 'D' ? EMPTY_TREE : msg.hash, f.path);
            return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
          });
        await vscode.commands.executeCommand('vscode.changes', `Changes in ${msg.hash.slice(0, 8)}`, resources);
        break;
      }

      case 'PUSH_EXPLAIN_COMMIT': {
        const { openCommitDetailPanel } = await import('./CommitDetailPanel');
        await openCommitDetailPanel(this.extensionUri, this.manager, msg.repoId, msg.hash, { autoExplain: true });
        break;
      }

      case 'PUSH_VIEW_COMBINED_DIFF': {
        const { openCombinedDiffPanel } = await import('./CombinedDiffPanel');
        await openCombinedDiffPanel(this.extensionUri, this.manager, msg.repoId, msg.hashes);
        break;
      }

      case 'COMMIT_OPEN_LOG': {
        this.logProvider?.selectCommit(msg.hash, msg.repoId);
        break;
      }

      case 'COMMIT_UNDO_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { logWarn('undo-commit', 'Repo not found'); this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          'Undo last commit? Changes will be kept as unstaged (git reset --soft HEAD~1).',
          { modal: true }, 'Undo Commit'
        );
        if (confirm !== 'Undo Commit') { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.undoCommit();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          logInfo('undo-commit', `Undid last commit in ${msg.repoId}`);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('undo-commit', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'CHANGELISTS_CREATE': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          svc.create(msg.name);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_CREATE_PROMPT': {
        const name = await vscode.window.showInputBox({
          title: 'New Changelist',
          prompt: 'Enter a name for the new changelist',
          placeHolder: 'Changelist name…',
          validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!name) break;
        const svcCreate = this.getOrCreateChangelistService();
        if (svcCreate) {
          svcCreate.create(name.trim());
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_RENAME': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          svc.rename(msg.id, msg.name);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_RENAME_PROMPT': {
        const newName = await vscode.window.showInputBox({
          title: 'Rename Changelist',
          prompt: `Rename "${msg.currentName}"`,
          value: msg.currentName,
          validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!newName) break;
        const svcRename = this.getOrCreateChangelistService();
        if (svcRename) {
          svcRename.rename(msg.id, newName.trim());
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_DELETE': {
        const svcDel = this.getOrCreateChangelistService();
        if (!svcDel) break;
        const clToDelete = svcDel.getAll().find(c => c.id === msg.id);
        const clName = clToDelete?.name ?? 'this changelist';
        const confirmed = await vscode.window.showWarningMessage(
          `Delete "${clName}"? Its files will be moved to Changes.`,
          { modal: true }, 'Delete'
        );
        if (confirmed !== 'Delete') break;
        svcDel.delete(msg.id);
        this.postChangelistsUpdate();
        break;
      }

      case 'CHANGELISTS_MOVE_FILES': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          await this.stageUnversionedFiles(svc, msg.assignments);
          svc.moveFiles(msg.assignments);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_MOVE_FILES_PROMPT': {
        const svcMove = this.getOrCreateChangelistService();
        if (!svcMove) break;
        const allCls = svcMove.getAll().filter(cl => cl.id !== CHANGELIST_UNVERSIONED_ID);
        const picks = allCls.map(cl => ({ label: cl.name, description: cl.id }));
        const picked = await vscode.window.showQuickPick(picks, {
          title: 'Move to Changelist',
          placeHolder: 'Select a changelist…',
        });
        if (!picked) break;
        const assignments = msg.files.map(f => ({ ...f, changelistId: picked.description! }));
        await this.stageUnversionedFiles(svcMove, assignments);
        svcMove.moveFiles(assignments);
        this.postChangelistsUpdate();
        break;
      }

      case 'CHANGELISTS_SHELVE': {
        const clSvc = this.getOrCreateChangelistService();
        if (!clSvc) break;
        const clForShelve = clSvc.getAll().find(c => c.id === msg.changelistId);
        if (!clForShelve) break;
        // Gather files per repo for this changelist
        const filesByRepo = new Map<string, string[]>();
        for (const [repoId, paths] of Object.entries(clForShelve.fileAssignments)) {
          if (paths.length > 0) filesByRepo.set(repoId, paths);
        }
        if (filesByRepo.size === 0) { vscode.window.showInformationMessage('No files in this changelist to shelve.'); break; }
        const shelveName = await vscode.window.showInputBox({
          title: `Shelve "${clForShelve.name}"`,
          value: clForShelve.name,
          placeHolder: 'Shelve name…',
          validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!shelveName) break;
        for (const [repoId, paths] of filesByRepo) {
          const shelveSvc = this.getShelveService(repoId);
          if (!shelveSvc) continue;
          const clAssignments = this.buildChangelistAssignments(clSvc, repoId, paths);
          try {
            await shelveSvc.push(shelveName.trim(), paths, clAssignments);
          } catch (e: unknown) {
            showGitError(`changelist-shelve:${repoId}`, e);
          }
        }
        const shelveStatus = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: shelveStatus });
        this.postChangelistsUpdate(shelveStatus);
        this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: [...filesByRepo.keys()][0], op: 'push', ok: true });
        break;
      }

      case 'CHANGELISTS_STASH': {
        const clSvcStash = this.getOrCreateChangelistService();
        if (!clSvcStash) break;
        const clForStash = clSvcStash.getAll().find(c => c.id === msg.changelistId);
        if (!clForStash) break;
        const stashName = await vscode.window.showInputBox({
          title: `Stash "${clForStash.name}"`,
          value: clForStash.name,
          placeHolder: 'Stash message…',
          validateInput: v => v.trim() ? undefined : 'Message cannot be empty',
        });
        if (!stashName) break;
        for (const [repoId, paths] of Object.entries(clForStash.fileAssignments)) {
          if (paths.length === 0) continue;
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await repo.stashPush(stashName.trim(), paths);
          } catch (e: unknown) {
            showGitError(`changelist-stash:${repoId}`, e);
          }
        }
        const stashStatus = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: stashStatus });
        this.postChangelistsUpdate(stashStatus);
        break;
      }

      case 'COMMIT_OPEN_ALL_CHANGES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const repoUri = vscode.Uri.file(repo.rootPath);

          // Direct section shortcut (vscode view mode buttons)
          if (msg.section === 'staged') {
            await vscode.commands.executeCommand('git.viewStagedChanges', repoUri);
            return;
          }
          if (msg.section === 'unstaged') {
            await vscode.commands.executeCommand('git.viewChanges', repoUri);
            return;
          }

          const status = await repo.getStatus();
          const hasUnstaged = status.unstagedFiles.length > 0;
          const hasStaged   = status.stagedFiles.length > 0;

          const options: vscode.QuickPickItem[] = [];
          if (hasUnstaged) options.push({ label: '$(diff) Changes',        description: 'git.viewChanges' });
          if (hasStaged)   options.push({ label: '$(diff-added) Staged Changes', description: 'git.viewStagedChanges' });

          if (options.length === 0) return;

          if (options.length === 1) {
            await vscode.commands.executeCommand(options[0].description!, repoUri);
            return;
          }

          const picked = await vscode.window.showQuickPick(options, { placeHolder: 'Open changes…' });
          if (picked) {
            await vscode.commands.executeCommand(picked.description!, repoUri);
          }
        } catch { /* command unavailable */ }
        break;
      }

      case 'COMMIT_SET_FILE_VIEW_MODE': {
        await this.globalState?.update('fileViewMode', msg.mode);
        break;
      }

      case 'COMMIT_SET_REPO_FILTER': {
        await this.setShowOnlyChangedRepos(msg.showOnlyChangedRepos);
        break;
      }

      case 'COMMIT_HIDE_REPO': {
        await this.hideRepo(msg.repoId);
        break;
      }

      case 'COMMIT_UNHIDE_REPO': {
        await this.unhideRepo(msg.repoId);
        break;
      }

      case 'COMMIT_MANAGE_HIDDEN_REPOS': {
        await this.manageHiddenRepos();
        break;
      }

      case 'COMMIT_MANAGE_REPO': {
        await vscode.commands.executeCommand('gitcharm.showBranchMenu', msg.repoId);
        break;
      }

      case 'COMMIT_REVEAL_REPO_IN_EXPLORER': {
        const repoReveal = this.manager.getRepo(msg.repoId);
        if (!repoReveal) break;
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(repoReveal.rootPath));
        break;
      }

      case 'COMMIT_OPEN_REPO_IN_NEW_WINDOW': {
        const repoNewWindow = this.manager.getRepo(msg.repoId);
        if (!repoNewWindow) break;
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoNewWindow.rootPath), { forceNewWindow: true });
        break;
      }

      case 'COMMIT_REVEAL_REPO_IN_OS': {
        const repoOS = this.manager.getRepo(msg.repoId);
        if (!repoOS) break;
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repoOS.rootPath));
        break;
      }

      case 'COMMIT_VIEW_GIT_LOG': {
        const meta = this.manager.getRepoMetas().find(m => m.id === msg.repoId);
        let logRepoId = msg.repoId;
        let branch: string | undefined;
        if (meta?.isWorktree && meta.mainWorktreePath) {
          // Worktrees are not shown in the Log Panel — use the parent repo and filter by branch
          logRepoId = meta.mainWorktreePath;
          const status = await this.manager.getAllStatuses();
          const repoStatus = status.repos.find(r => r.repoId === msg.repoId);
          const branchName = repoStatus?.branch?.name;
          if (branchName && !repoStatus?.isDetachedHead) {
            branch = branchName;
          }
        }
        this.logProvider?.focusRepo(logRepoId, branch);
        break;
      }

      case 'SUBMODULE_PUSH': {
        const subRepoPush = this.manager.getRepo(msg.repoId);
        if (!subRepoPush) {
          logWarn('submodule-push', 'Repo not found');
          this.post({ type: 'SUBMODULE_PUSH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: 'Repo not found' });
          return;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pushing submodule ${subRepoPush.rootPath.split('/').pop()}`, cancellable: false },
          async () => {
            try {
              await subRepoPush.pushSubmodule();
              this.post({ type: 'SUBMODULE_PUSH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
              logInfo('submodule-push', `Pushed submodule ${msg.repoId}`);
              this.logProvider?.refresh();
            } catch (e: unknown) {
              logError('submodule-push', formatGitError(e), getRawErrorDetail(e));
              this.post({ type: 'SUBMODULE_PUSH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: formatGitError(e) });
            }
          }
        );
        break;
      }

      case 'SUBMODULE_PULL': {
        const subRepoPull = this.manager.getRepo(msg.repoId);
        if (!subRepoPull) {
          logWarn('submodule-pull', 'Repo not found');
          this.post({ type: 'SUBMODULE_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: 'Repo not found' });
          return;
        }
        try {
          const output = await subRepoPull.pullSubmodule(msg.rebase);
          this.post({ type: 'SUBMODULE_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true, output });
          logInfo('submodule-pull', `Pulled submodule ${msg.repoId}`);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          logError('submodule-pull', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'SUBMODULE_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'SUBMODULE_INIT': {
        const parentRepo = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepo) {
          logWarn('submodule-init', 'Repo not found');
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await parentRepo.initSubmodule(msg.submodulePath);
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: true });
          logInfo('submodule-init', `Initialized submodule ${msg.submodulePath}`);
          // Re-discover so the newly-initialized submodule gets its own GitService
          // scheduleRefresh will re-send status to the webview
        } catch (e: unknown) {
          logError('submodule-init', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'SUBMODULE_DEINIT': {
        const parentRepoD = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepoD) {
          logWarn('submodule-deinit', 'Repo not found');
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: 'Repo not found' });
          return;
        }
        const confirmDeinit = await vscode.window.showWarningMessage(
          `Deinit submodule "${msg.submodulePath}"? The working directory will be cleared.`,
          { modal: true }, 'Deinit'
        );
        if (confirmDeinit !== 'Deinit') {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await parentRepoD.deinitSubmodule(msg.submodulePath, msg.force);
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: true });
          logInfo('submodule-deinit', `Deinitialized submodule ${msg.submodulePath}`);
        } catch (e: unknown) {
          logError('submodule-deinit', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'SUBMODULE_UPDATE': {
        const parentRepoU = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepoU) {
          logWarn('submodule-update', 'Repo not found');
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: false, error: 'Repo not found' });
          return;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Updating submodule ${msg.submodulePath}`, cancellable: false },
          async () => {
            try {
              await parentRepoU.updateSubmodule(msg.submodulePath, true, msg.recursive);
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: true });
              logInfo('submodule-update', `Updated submodule ${msg.submodulePath}`);
              // Check if the submodule is now in detached HEAD (almost always true after update)
              const subRepoId = path.join(parentRepoU.rootPath, msg.submodulePath);
              const subRepo = this.manager.getRepo(subRepoId);
              if (subRepo) {
                const subStatus = await subRepo.getStatus().catch(() => null);
                if (subStatus?.isDetachedHead) {
                  this.post({ type: 'SUBMODULE_DETACHED_HEAD_WARNING', repoId: subRepoId, headCommit: subStatus.branch.detachedHash ?? subStatus.branch.detachedTag ?? 'HEAD' });
                }
              }
            } catch (e: unknown) {
              logError('submodule-update', formatGitError(e), getRawErrorDetail(e));
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: false, error: formatGitError(e) });
            }
          }
        );
        break;
      }

      case 'WORKTREE_REQUEST_LIST': {
        const repos = await this.manager.getAllWorktrees();
        this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        break;
      }

      case 'WORKTREE_CREATE_PROMPT': {
        const repoCP = this.manager.getRepo(msg.repoId);
        if (!repoCP) return;

        // Step 1: pick branch or "new branch"
        const branches = await repoCP.getBranches();
        const NEW_BRANCH_ID = '__new__';
        const branchItems: Array<{ label: string; description?: string; branchName: string; isNew?: boolean }> = [
          { label: '$(add) Create new branch…', branchName: NEW_BRANCH_ID, isNew: true },
          ...branches.map(b => ({
            label: b.isRemote ? `$(cloud) ${b.name}` : `$(git-branch) ${b.name}`,
            description: b.isHead ? '(current)' : undefined,
            branchName: b.name,
          })),
        ];
        const picked = await vscode.window.showQuickPick(branchItems, {
          placeHolder: 'Select branch for new worktree',
          title: 'New Worktree — Branch',
          matchOnDescription: true,
        });
        if (!picked) return;

        // If "new branch" chosen, ask for the name
        let newBranchName: string | undefined;
        let baseBranchName = picked.branchName;
        if (picked.isNew) {
          const input = await vscode.window.showInputBox({
            prompt: 'New branch name',
            placeHolder: 'e.g. feature/my-feature',
            title: 'New Worktree — New Branch Name',
          });
          if (!input?.trim()) return;
          newBranchName = input.trim();
          baseBranchName = newBranchName;
        }

        // Step 2: worktree path — format: <repo-folder-name>--<branch-name>
        const repoParent = path.dirname(repoCP.rootPath);
        const repoFolderName = path.basename(repoCP.rootPath);
        const defaultPath = path.join(repoParent, `${repoFolderName}--${baseBranchName.replace(/\//g, '-')}`);
        const worktreePath = await vscode.window.showInputBox({
          prompt: 'Path for the new worktree directory',
          value: defaultPath,
          title: 'New Worktree — Directory Path',
        });
        if (!worktreePath?.trim()) return;

        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Creating worktree…', cancellable: false },
            async () => {
              await repoCP.createWorktree(worktreePath.trim(), {
                branch: picked.isNew ? undefined : picked.branchName,
                newBranch: newBranchName,
              });
            }
          );
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
          vscode.window.showInformationMessage(`Worktree created at ${worktreePath.trim()}`);
          logInfo('worktree-create', `Worktree created at ${worktreePath.trim()}`);
        } catch (e: unknown) {
          showGitError('worktree-create', e);
        }
        break;
      }

      case 'WORKTREE_CREATE': {
        const repoWC = this.manager.getRepo(msg.repoId);
        if (!repoWC) {
          logWarn('worktree-create', 'Repo not found');
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'create', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repoWC.createWorktree(msg.worktreePath, { branch: msg.branch, newBranch: msg.newBranch, commitish: msg.commitish, noTrack: msg.noTrack });
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'create', ok: true });
          logInfo('worktree-create', `Worktree created at ${msg.worktreePath}`);
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          logError('worktree-create', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'create', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'WORKTREE_DELETE': {
        const repoWD = this.manager.getRepo(msg.repoId);
        if (!repoWD) {
          logWarn('worktree-delete', 'Repo not found');
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'delete', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repoWD.deleteWorktree(msg.worktreePath, msg.force);
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'delete', ok: true });
          logInfo('worktree-delete', `Deleted worktree ${msg.worktreePath}`);
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          logError('worktree-delete', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'delete', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'WORKTREE_PRUNE': {
        const repoWP = this.manager.getRepo(msg.repoId);
        if (!repoWP) {
          logWarn('worktree-prune', 'Repo not found');
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'prune', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repoWP.pruneWorktrees();
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'prune', ok: true });
          logInfo('worktree-prune', `Pruned worktrees in ${msg.repoId}`);
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          logError('worktree-prune', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'prune', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'WORKTREE_LOCK': {
        const repoWL = this.manager.getRepo(msg.repoId);
        if (!repoWL) {
          logWarn('worktree-lock', 'Repo not found');
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'lock', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repoWL.lockWorktree(msg.worktreePath, msg.reason);
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'lock', ok: true });
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          logError('worktree-lock', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'lock', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'WORKTREE_UNLOCK': {
        const repoWU = this.manager.getRepo(msg.repoId);
        if (!repoWU) {
          logWarn('worktree-unlock', 'Repo not found');
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'unlock', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repoWU.unlockWorktree(msg.worktreePath);
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'unlock', ok: true });
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          logError('worktree-unlock', formatGitError(e), getRawErrorDetail(e));
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'unlock', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'WORKTREE_OPEN_IN_EXPLORER': {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.worktreePath));
        break;
      }

      case 'WORKTREE_OPEN_IN_NEW_WINDOW': {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.worktreePath), { forceNewWindow: true });
        break;
      }

      case 'WORKTREE_OPEN_IN_OS': {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.worktreePath));
        break;
      }

      case 'WORKTREE_ADD_TO_WORKSPACE': {
        const uri = vscode.Uri.file(msg.worktreePath);
        const folders = vscode.workspace.workspaceFolders ?? [];
        vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri });
        break;
      }

      case 'NOTIFY_ERROR': {
        logError('notify', `${msg.message}`);
        void vscode.window.showErrorMessage(`${msg.message}`, 'Show Log').then(choice => {
          if (choice === 'Show Log') showLogChannel();
        });
        break;
      }

      case 'NOTIFY_INFO': {
        vscode.window.showInformationMessage(`${msg.message}`);
        break;
      }

      case 'COMMIT_INIT_REPO': {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) break;
        await vscode.commands.executeCommand('git.init', folder.uri);
        await new Promise(r => setTimeout(r, 500));
        this.manager.reinitializeAndRefresh();
        this.logProvider?.refresh();
        break;
      }

      case 'COMMIT_OPEN_FOLDER':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;

      case 'COMMIT_CLONE_REPO':
        await vscode.commands.executeCommand('git.clone');
        break;

      case 'COMMIT_REVEAL_IN_EXPLORER': {
        const repoRE = this.manager.getRepo(msg.repoId);
        if (!repoRE) return;
        const absPathRE = path.join(repoRE.rootPath, msg.filePath);
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(absPathRE));
        break;
      }

      case 'COMMIT_REVEAL_IN_OS': {
        const repoOS = this.manager.getRepo(msg.repoId);
        if (!repoOS) return;
        const absPathOS = path.join(repoOS.rootPath, msg.filePath);
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(absPathOS));
        break;
      }
    }
  }

  handleSubmoduleCommand(msg: import('../types/messages').CommitToHostMsg): void {
    void this.handleMessage(msg, this.view!.webview);
  }

  refresh(): void {
    this.manager.getAllStatuses().then(status => {
      this.postChangelistsUpdate(status);
      this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
      this.post({ type: 'COMMIT_HIDDEN_REPOS_UPDATE', hiddenRepoIds: this.getHiddenRepoIds() });
    });
  }
}
