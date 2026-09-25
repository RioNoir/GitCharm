import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { LogToHostMsg, HostToLogMsg, LogLayoutPrefs, LogLayoutByLocation, LogViewLocation } from '../types/messages';
import type { BranchInfo, RepoMeta } from '../types/git';
import { loadIconTheme } from '../utils/IconThemeService';
import type { CommitPanelProvider } from './CommitPanelProvider';
import type { UndockedPanelProvider } from './UndockedPanelProvider';
import type { GitProfileService } from '../git/GitProfileService';
import { openSquashEditor } from './SquashEditorPanel';
import { openEditMessageEditor } from './EditMessageEditorPanel';
import { formatGitError, showGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { pickRefQuickPick } from '../utils/refPicker';
import { logInfo, logWarn, logError, notifyWithLogAction } from '../utils/Logger';
import { plural } from '../utils/plural';
import { offerRenameBranchRemoteSync } from '../utils/renameBranchRemoteSync';
import { handleDirtyCheckout } from '../utils/dirtyCheckoutHandler';
import { promptBranchName } from '../utils/branchNamePrompt';
import {
  getGitLogDefaultLayout,
  getGitLogDefaultLocation,
  setGitLogDefault,
  type GitLogLayout,
  type GitLogLocation,
} from '../settings/GitLogLocationSettings';

function mergeCurrentIntoBranches(branches: BranchInfo[], current: BranchInfo): BranchInfo[] {
  if (!current.detachedTag && !current.detachedHash) return branches; // normal branch — already in list
  const filtered = branches.filter(b => !(b.repoId === current.repoId && b.isHead));
  return [...filtered, current];
}

type DeleteTagChoice = 'local' | 'remote' | 'both' | null;

function deleteTagLabels() {
  return {
    local: vscode.l10n.t('Delete Local'),
    remote: vscode.l10n.t('Delete on Remote'),
    both: vscode.l10n.t('Delete Local and Remote'),
  };
}

function errorsSummary(errors: string[]): string {
  return plural(
    errors.length,
    vscode.l10n.t('1 error: {0}', errors.join('; ')),
    vscode.l10n.t('{0} errors: {1}', errors.length, errors.join('; ')),
  );
}

async function confirmDeleteTag(tagName: string, _title: string): Promise<DeleteTagChoice> {
  const labels = deleteTagLabels();
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete tag "{0}"?', tagName),
    { modal: true },
    labels.local,
    labels.remote,
    labels.both,
  );
  if (!pick) return null;
  if (pick === labels.remote) return 'remote';
  if (pick === labels.both) return 'both';
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
      logWarn('deleteTag', 'No remotes configured.');
      vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured.'));
      return;
    }
    const remote = remotes.length === 1
      ? remotes[0]
      : (await vscode.window.showQuickPick(remotes.map(r => ({ label: r })), { title: vscode.l10n.t('Delete "{0}" from remote', tagName) }))?.label;
    if (!remote) return;
    await repo.deleteTagRemote(tagName, remote);
    return;
  }
  // 'both': delete local first, then remote
  await repo.deleteTag(tagName);
  if (remotes.length === 0) {
    logWarn('deleteTag', `Tag "${tagName}" deleted locally, but no remotes configured.`);
    vscode.window.showWarningMessage(vscode.l10n.t('Tag "{0}" deleted locally, but no remotes configured.', tagName));
    return;
  }
  const remote = remotes.length === 1
    ? remotes[0]
    : (await vscode.window.showQuickPick(remotes.map(r => ({ label: r })), { title: vscode.l10n.t('Delete "{0}" from remote', tagName) }))?.label;
  if (!remote) return;
  await repo.deleteTagRemote(tagName, remote);
}


type ReplyTarget = 'sidebar' | 'undocked';

// Layout preferences live in globalState, one entry per location. In a side bar the
// filters bar and branch sidebar start hidden, since there is little room for them.
const LAYOUT_STATE_KEYS: Record<LogViewLocation, string> = {
  panel: 'gitcharm.logLayout.panel',
  sideBar: 'gitcharm.logLayout.sideBar',
};
const DEFAULT_LAYOUT: LogLayoutByLocation = {
  panel: { filtersHidden: false, sidebarHidden: false },
  sideBar: { filtersHidden: true, sidebarHidden: true },
};
// Context keys driving the title bar toggles of each surface.
const LAYOUT_CONTEXT: Record<ReplyTarget, Record<keyof LogLayoutPrefs, string>> = {
  sidebar: { filtersHidden: 'gitcharm.logFiltersHidden', sidebarHidden: 'gitcharm.logSidebarHidden' },
  undocked: { filtersHidden: 'gitcharm.undockedLogFiltersHidden', sidebarHidden: 'gitcharm.undockedLogSidebarHidden' },
};
const FILTERS_ACTIVE_CONTEXT: Record<ReplyTarget, string> = {
  sidebar: 'gitcharm.logFiltersActive',
  undocked: 'gitcharm.undockedLogFiltersActive',
};

export class GitLogPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'gitcharm.gitLog';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private readonly managerListeners: vscode.Disposable[] = [];
  private commitPanel?: CommitPanelProvider;
  private undockedPanel?: UndockedPanelProvider;
  private hiddenRepoIds: string[] = [];
  private defaultBranchCache = new Map<string, string | undefined>();
  /** Location of the docked view, as reported by its webview. The undocked panel is always 'panel'. */
  private dockedLocation: LogViewLocation = 'panel';
  private pendingFilterRepoId: string | null = null;
  private pendingFilterBranch: string | null = null;
  private pendingScrollHash: string | null = null;
  private pendingScrollRepoId: string | null = null;
  private cachedActiveProfile?: { name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' };
  private lastLogLoadErrorNotice = 0;
  // Scroll/filter intents queued while a freshly opened undocked panel boots up.
  private pendingUndocked: {
    scroll?: { hash: string; repoId: string };
    filter?: { repoId: string; branch: string | null };
  } | null = null;

  setCommitPanel(provider: CommitPanelProvider): void {
    this.commitPanel = provider;
  }

  setUndockedPanel(provider: UndockedPanelProvider): void {
    this.undockedPanel = provider;
  }

  async triggerUndockPick(): Promise<void> {
    if (!this.undockedPanel) return;
    type Item = vscode.QuickPickItem & { value: 'editorTab' | 'newWindow'; showCommit: boolean };
    const pick = await vscode.window.showQuickPick<Item>(
      [
        { label: `$(editor-layout) ${vscode.l10n.t('Undock in Editor Tab (Log & Commit)')}`, value: 'editorTab', showCommit: true },
        { label: `$(empty-window) ${vscode.l10n.t('Undock in New Window (Log & Commit)')}`, value: 'newWindow', showCommit: true },
        { label: `$(editor-layout) ${vscode.l10n.t('Undock in Editor Tab (Only Log)')}`, value: 'editorTab', showCommit: false },
        { label: `$(empty-window) ${vscode.l10n.t('Undock in New Window (Only Log)')}`, value: 'newWindow', showCommit: false },
      ],
      { title: vscode.l10n.t('Undock'), placeHolder: vscode.l10n.t('Choose where to open the panel') },
    );
    if (!pick) return;
    this.undockedPanel.open(pick.value, pick.showCommit);
  }

  /** Filters bar and branch sidebar visibility for every location. */
  getLayoutPrefs(): LogLayoutByLocation {
    const read = (location: LogViewLocation): LogLayoutPrefs => {
      const stored = this.globalState?.get<Partial<LogLayoutPrefs>>(LAYOUT_STATE_KEYS[location]) ?? {};
      const defaults = DEFAULT_LAYOUT[location];
      return {
        filtersHidden: typeof stored.filtersHidden === 'boolean' ? stored.filtersHidden : defaults.filtersHidden,
        sidebarHidden: typeof stored.sidebarHidden === 'boolean' ? stored.sidebarHidden : defaults.sidebarHidden,
      };
    };
    return { panel: read('panel'), sideBar: read('sideBar') };
  }

  /** Change a layout preference for the location of the Git Log the user is looking at. */
  async setLayoutPref(pref: keyof LogLayoutPrefs, value: boolean): Promise<void> {
    const location = this.undockedPanel?.isActive() ? 'panel' : this.dockedLocation;
    const current = this.getLayoutPrefs()[location];
    await this.globalState?.update(LAYOUT_STATE_KEYS[location], { ...current, [pref]: value });
    this.syncLayoutContext();
    this.broadcast({ type: 'LOG_LAYOUT_PREFS', layout: this.getLayoutPrefs() });
  }

  private syncLayoutContext(): void {
    const layout = this.getLayoutPrefs();
    const locations: Record<ReplyTarget, LogViewLocation> = { sidebar: this.dockedLocation, undocked: 'panel' };
    for (const target of Object.keys(LAYOUT_CONTEXT) as ReplyTarget[]) {
      for (const pref of Object.keys(LAYOUT_CONTEXT[target]) as Array<keyof LogLayoutPrefs>) {
        void vscode.commands.executeCommand('setContext', LAYOUT_CONTEXT[target][pref], layout[locations[target]][pref]);
      }
    }
  }

  /** Clear the text/author/branch/date filters of the Git Log the user is looking at. */
  clearFilters(): void {
    const msg: HostToLogMsg = { type: 'LOG_CLEAR_FILTERS' };
    if (this.undockedPanel?.isActive()) this.undockedPanel.postToLog(msg);
    else this.post(msg);
  }

  /** Reload repos, branches and commits without fetching. */
  async reload(): Promise<void> {
    await this.pushInitData();
    this.refresh();
  }

  /** Fetch all remotes, then reload repos/branches and commits on every open Git Log. */
  async fetchAndRefresh(): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Fetching all'), cancellable: false },
      async () => { await this.manager.fetchAll(); }
    );
    // A fetch can move the remote's default branch (e.g. origin/HEAD repointed after a
    // rename on GitHub/GitLab) — drop the cache so it's re-resolved, not stale.
    this.defaultBranchCache.clear();
    const [repos, branches] = await Promise.all([
      this.getVisibleReposWithDefaultBranch(),
      this.getFilteredBranches(),
    ]);
    this.broadcast({ type: 'LOG_INIT_DATA', repos, branches });
    this.broadcast({ type: 'LOG_REFRESH' });
  }

  /**
   * Open the Git Log where the persisted default says — bottom panel, editor tab
   * or a separate window. Used by `gitcharm.openLog` (command + keybinding).
   */
  openPreferred(): void {
    this.revealPreferred();
  }

  /**
   * Reveal the Git Log on whichever surface the default location points at.
   * `wasOpen` tells callers whether the surface was already live, so they know
   * if a follow-up message can be posted right away or has to be queued until
   * the webview has booted and asked for its first batch of commits.
   */
  private revealPreferred(): { target: 'sidebar' | 'undocked'; wasOpen: boolean } {
    const location = getGitLogDefaultLocation();
    if (location === 'panel' || !this.undockedPanel) {
      const wasOpen = this.view?.visible === true;
      this.focus();
      return { target: 'sidebar', wasOpen };
    }
    const wasOpen = this.undockedPanel.isOpen();
    this.undockedPanel.open(location, getGitLogDefaultLayout() === 'logAndCommit');
    return { target: 'undocked', wasOpen };
  }

  /** Ask for — and persist — the default Git Log location, then apply it right away. */
  async triggerDefaultLocationPick(): Promise<void> {
    type Item = vscode.QuickPickItem & { location: GitLogLocation; layout: GitLogLayout };
    const currentLocation = getGitLogDefaultLocation();
    const currentLayout = getGitLogDefaultLayout();

    const items: Item[] = [
      { label: `$(layout-panel) ${vscode.l10n.t('Bottom Panel')}`, location: 'panel', layout: currentLayout },
      { label: `$(editor-layout) ${vscode.l10n.t('Editor Tab (Log & Commit)')}`, location: 'editorTab', layout: 'logAndCommit' },
      { label: `$(editor-layout) ${vscode.l10n.t('Editor Tab (Only Log)')}`, location: 'editorTab', layout: 'logOnly' },
      { label: `$(empty-window) ${vscode.l10n.t('New Window (Log & Commit)')}`, location: 'newWindow', layout: 'logAndCommit' },
      { label: `$(empty-window) ${vscode.l10n.t('New Window (Only Log)')}`, location: 'newWindow', layout: 'logOnly' },
    ];
    for (const item of items) {
      const isCurrent = item.location === currentLocation
        && (item.location === 'panel' || item.layout === currentLayout);
      if (isCurrent) item.description = vscode.l10n.t('current default');
    }

    const pick = await vscode.window.showQuickPick<Item>(items, {
      title: vscode.l10n.t('Default GitCharm Log Location'),
      placeHolder: vscode.l10n.t('Where should the Git Log open from now on?'),
    });
    if (!pick) return;

    await setGitLogDefault(pick.location, pick.layout);

    if (pick.location === 'panel') {
      this.undockedPanel?.close();
      // The view's `when` clause has just flipped back on — give the workbench a
      // tick to re-register the panel container before focusing it.
      setTimeout(() => this.focus(), 100);
    } else {
      this.undockedPanel?.open(pick.location, pick.layout === 'logAndCommit');
    }
  }

  handleUndockedMessage(msg: LogToHostMsg, _provider: UndockedPanelProvider): void {
    void this.handleMessage(msg, 'undocked').catch(e => this.handleMessageFailure(msg, 'undocked', e));
  }

  /** Re-query repos and branches and push them to the webview. */
  private async pushInitData(): Promise<void> {
    const repos = await this.getVisibleReposWithDefaultBranch();
    const branches = await this.getFilteredBranches();
    await this.refreshActiveProfile();
    this.broadcast({ type: 'LOG_INIT_DATA', repos, branches });
  }

  notifyHiddenReposChanged(hiddenRepoIds: string[]): void {
    this.hiddenRepoIds = hiddenRepoIds;
    void this.pushInitData();
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly profileService?: GitProfileService,
    private readonly globalState?: vscode.Memento
  ) {
    this.syncLayoutContext();
    // The graph refresh goes out immediately: the manager has already debounced
    // the underlying file-event burst, so delaying it again only adds lag. The
    // branch query runs in parallel rather than being awaited first, so a slow
    // `git branch` can't hold up the commit list.
    const onGraphOrBranchChange = () => {
      this.broadcast({ type: 'LOG_REFRESH' });
      void this.pushInitData();
    };

    // Register manager listeners here so they fire even when the panel has never been opened.
    // this.post() silently drops messages when the webview is not yet resolved — that's fine,
    // because resolveWebviewView performs an explicit initial sync when the panel first opens.
    this.managerListeners.push(
      this.manager.onGraphChange(onGraphOrBranchChange),
      this.manager.onBranchChange(onGraphOrBranchChange),
      this.manager.onReposChange(onGraphOrBranchChange)
    );

    this.profileService?.onProfileChange(async () => {
      await this.refreshActiveProfile();
      this.broadcast({ type: 'LOG_REFRESH' });
      void this.pushInitData();
    });
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

    try {
      webviewView.webview.html = getWebviewHtml(
        webviewView.webview,
        this.extensionUri,
        'gitLog',
        'Git Log',
        { logLayout: this.getLayoutPrefs() },
      );
    } catch (e: unknown) {
      logError('gitLogHtml', String(e), e instanceof Error ? e.stack : undefined);
      webviewView.webview.html = this.getLoadFailureHtml(vscode.l10n.t('Git Log failed to load.'), vscode.l10n.t('Run the build task and reload the window, then check the GitCharm output log if it still fails.'));
      notifyWithLogAction('error', vscode.l10n.t('Git Log failed to load. See the GitCharm output log for details.'));
    }

    webviewView.webview.onDidReceiveMessage(
      (msg: LogToHostMsg) => {
        void this.handleMessage(msg).catch(e => this.handleMessageFailure(msg, 'sidebar', e));
      },
      null,
      this.disposables
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
          if (this.view) {
            Promise.all([loadIconTheme(this.view.webview), this.getFilteredBranches(), this.getVisibleReposWithDefaultBranch()])
              .then(([iconTheme, branches, repos]) => {
                this.post({ type: 'LOG_INIT_DATA', repos, branches, iconTheme });
              });
          }
        }
      })
    );

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      if (this.pendingFilterRepoId !== null) {
        const repoId = this.pendingFilterRepoId;
        const branch = this.pendingFilterBranch;
        this.pendingFilterRepoId = null;
        this.pendingFilterBranch = null;
        // Small delay to let the webview finish its initial LOG_REQUEST_COMMITS round-trip
        setTimeout(() => this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch }), 150);
      }
      if (this.pendingScrollHash !== null) {
        const hash = this.pendingScrollHash;
        const repoId = this.pendingScrollRepoId!;
        this.pendingScrollHash = null;
        this.pendingScrollRepoId = null;
        setTimeout(() => this.post({ type: 'LOG_SCROLL_TO_COMMIT', hash, repoId }), 150);
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
          // For git scheme URIs, the real fsPath is encoded in the query JSON
          const uri = input.modified;
          if (uri.scheme === 'git') {
            try { filePath = JSON.parse(uri.query).path; } catch { filePath = uri.fsPath; }
          } else {
            filePath = uri.fsPath;
          }
        }
        if (filePath) this.broadcast({ type: 'LOG_DESELECT_FILE', filePath });
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      tabWatcher.dispose();
      this.disposables.forEach(d => d.dispose());
      this.disposables = [];
    });
  }

  /** Focus/reveal the Git Log panel in the bottom bar. */
  focus(): void {
    vscode.commands.executeCommand(`${GitLogPanelProvider.viewType}.focus`);
  }

  /** Reveal the Git Log (wherever it lives) and scroll to a specific commit. */
  selectCommit(hash: string, repoId: string): void {
    const { target, wasOpen } = this.revealPreferred();

    if (target === 'undocked') {
      if (wasOpen) {
        // postToLog, not post(): post() targets the docked view.
        setTimeout(() => this.undockedPanel?.postToLog({ type: 'LOG_SCROLL_TO_COMMIT', hash, repoId }), 150);
      } else {
        this.pendingUndocked = { ...this.pendingUndocked, scroll: { hash, repoId } };
      }
      return;
    }

    if (wasOpen) {
      setTimeout(() => this.post({ type: 'LOG_SCROLL_TO_COMMIT', hash, repoId }), 150);
      return;
    }
    this.pendingScrollHash = hash;
    this.pendingScrollRepoId = repoId;
  }

  /** Reveal the Git Log and filter it to a specific repository (and optionally branch). */
  focusRepo(repoId: string, branch?: string): void {
    const { target, wasOpen } = this.revealPreferred();

    if (target === 'undocked') {
      if (wasOpen) {
        setTimeout(() => this.undockedPanel?.postToLog({ type: 'LOG_FILTER_BY_REPO', repoId, branch }), 150);
      } else {
        this.pendingUndocked = { ...this.pendingUndocked, filter: { repoId, branch: branch ?? null } };
      }
      return;
    }

    if (wasOpen) {
      this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch });
      return;
    }
    this.pendingFilterRepoId = repoId;
    this.pendingFilterBranch = branch ?? null;
  }

  /** Trigger a full log refresh — call this after any operation that creates new commits. */
  refresh(): void {
    this.broadcast({ type: 'LOG_REFRESH' });
  }

  private enrichLogMsg(msg: HostToLogMsg): void {
    if (msg.type === 'LOG_INIT_DATA') {
      const m = msg as typeof msg & { hasWorkspaceFolder?: boolean; aiEnabled?: boolean };
      if (m.hasWorkspaceFolder === undefined) m.hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      if (m.aiEnabled === undefined) m.aiEnabled = vscode.workspace.getConfiguration('gitcharm').get<boolean>('ai.enabled', true);
      if (m.activeProfile === undefined) m.activeProfile = this.cachedActiveProfile;
      if (m.layout === undefined) m.layout = this.getLayoutPrefs();
    }
  }

  /** Send to the docked Git Log view. */
  private post(msg: HostToLogMsg): void {
    this.enrichLogMsg(msg);
    this.view?.webview.postMessage(msg);
  }

  /** Send to one surface — used for replies, which belong to the webview that asked. */
  private postTo(origin: ReplyTarget, msg: HostToLogMsg): void {
    this.enrichLogMsg(msg);
    if (origin === 'undocked') {
      this.undockedPanel?.postToLog(msg);
    } else {
      this.view?.webview.postMessage(msg);
    }
  }

  /** Broadcast a host-initiated message to both the sidebar and the undocked panel. */
  private broadcast(msg: HostToLogMsg): void {
    this.enrichLogMsg(msg);
    this.view?.webview.postMessage(msg);
    this.undockedPanel?.postToLog(msg);
  }

  private handleMessageFailure(msg: LogToHostMsg, origin: ReplyTarget, error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logError('logMessage', `Failed to handle ${msg.type}: ${error instanceof Error ? error.message : String(error)}`, detail);

    if (msg.type === 'LOG_REQUEST_COMMITS') {
      this.postTo(origin, { type: 'LOG_INIT_DATA', repos: [], branches: [] });
      this.postTo(origin, {
        type: 'LOG_COMMITS_BATCH',
        commits: [],
        isLast: true,
        batchIndex: 0,
        requestId: msg.requestId,
      });

      const now = Date.now();
      if (now - this.lastLogLoadErrorNotice > 10_000) {
        this.lastLogLoadErrorNotice = now;
        notifyWithLogAction('error', vscode.l10n.t('Git Log failed to load. See the GitCharm output log for details.'));
      }
    }
  }

  private getLoadFailureHtml(title: string, detail: string): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
    return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    main { max-width: 360px; text-align: center; line-height: 1.45; }
    h1 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
    p { margin: 0; font-size: 12px; opacity: 0.72; }
  </style>
</head>
<body>
  <main>
    <h1>${esc(title)}</h1>
    <p>${esc(detail)}</p>
  </main>
</body>
</html>`;
  }

  async refreshTagsForRepo(repoId: string): Promise<void> {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return;
    const rawTags = await repo.getTags().catch(() => []);
    this.broadcast({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
    this.broadcast({ type: 'LOG_REFRESH' });
  }

  private getNonWorktreeRepos() {
    return this.manager.getRepoMetas().filter(m => !m.isWorktree);
  }

  private getVisibleRepos() {
    return this.getNonWorktreeRepos().filter(m => !this.hiddenRepoIds.includes(m.id));
  }

  /**
   * Same as getVisibleRepos(), but with each RepoMeta's `defaultBranch` resolved to the
   * remote's actual default branch — the source of truth the webview's "primary branch"
   * star/delete-protection should use instead of its own naming heuristic. Cached per repoId
   * since the remote symref rarely changes and a miss falls back to a network round trip.
   */
  private async getVisibleReposWithDefaultBranch(): Promise<RepoMeta[]> {
    const repos = this.getVisibleRepos();
    return Promise.all(repos.map(async meta => {
      if (this.defaultBranchCache.has(meta.id)) {
        return { ...meta, defaultBranch: this.defaultBranchCache.get(meta.id) };
      }
      const repo = this.manager.getRepo(meta.id);
      if (!repo) return meta;
      const remotes = await repo.getRemotes().catch(() => [] as string[]);
      const remote = remotes.includes('origin') ? 'origin' : remotes[0];
      const defaultBranch = remote ? await repo.getRemoteDefaultBranch(remote).catch(() => undefined) : undefined;
      this.defaultBranchCache.set(meta.id, defaultBranch);
      return { ...meta, defaultBranch };
    }));
  }

  private async getFilteredBranches() {
    const ids = new Set(this.getNonWorktreeRepos().map(r => r.id));
    const all = await this.manager.getAllBranches();
    return all.filter(b => ids.has(b.repoId));
  }

  private async pickBranchRepo(repoIds: string[], branchName: string, action: 'Pull' | 'Push'): Promise<string | null> {
    const metas = new Map(this.manager.getRepoMetas().map(meta => [meta.id, meta]));
    const candidates = Array.from(new Set(repoIds))
      .filter(repoId => !!this.manager.getRepo(repoId))
      .map(repoId => {
        const meta = metas.get(repoId);
        return {
          label: `$(repo) ${meta?.name ?? repoId}`,
          description: meta?.rootPath,
          repoId,
        };
      });
    if (candidates.length === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t('No repository found for branch "{0}".', branchName));
      return null;
    }
    if (candidates.length === 1) return candidates[0].repoId;
    const picked = await vscode.window.showQuickPick(candidates, action === 'Pull'
      ? {
        title: vscode.l10n.t('Pull "{0}" — Select repository', branchName),
        placeHolder: vscode.l10n.t('Select the repository in which to pull this branch'),
      }
      : {
        title: vscode.l10n.t('Push "{0}" — Select repository', branchName),
        placeHolder: vscode.l10n.t('Select the repository in which to push this branch'),
      });
    return picked?.repoId ?? null;
  }

  private async handleMessage(msg: LogToHostMsg, origin: ReplyTarget = 'sidebar'): Promise<void> {
    // Reply to the webview this message came from, captured per message rather than
    // held in a field. Handlers interleave: a long one (pull, push, a quick pick) that
    // finished while another request was still awaiting git used to reset that field,
    // and the second reply went to the other webview — or to a view that isn't open —
    // where it was discarded for having an unknown requestId. A LOG_COMMITS_BATCH lost
    // that way left the log's progress bar running forever, since a batch matching the
    // in-flight requestId is the only thing that ever clears it.
    const post = (m: HostToLogMsg) => this.postTo(origin, m);

    switch (msg.type) {
      case 'LOG_REQUEST_COMMITS': {
        // graphMaxCommits is a ceiling on how many commits the graph holds, not a page
        // size: pagination adds to what is already loaded, so the cap belongs on
        // skip + limit. Capping the page size alone let a deep scroll grow the list past
        // the ceiling, and the next refresh — one request covering every loaded row — came
        // back truncated, dropping rows out from under the viewport.
        const maxCommits = vscode.workspace.getConfiguration('gitcharm').get<number>('graphMaxCommits', 1000);
        const limit = Math.min(msg.limit, Math.max(0, maxCommits - msg.skip));

        // Resolve the icon theme against the webview that asked, so the undocked
        // panel still gets file icons when the bottom-panel view is hidden.
        const iconWebview = origin === 'undocked'
          ? this.undockedPanel?.webview
          : this.view?.webview;
        const [repos, branches, iconTheme] = await Promise.all([
          this.getVisibleReposWithDefaultBranch(),
          this.getFilteredBranches(),
          iconWebview ? loadIconTheme(iconWebview) : Promise.resolve(undefined),
        ]);
        post({ type: 'LOG_INIT_DATA', repos, branches, iconTheme });

        // Send tags for all repos
        for (const meta of repos) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          repo.getTags().then(rawTags => {
            post({ type: 'LOG_TAGS_UPDATE', repoId: meta.id, tags: rawTags.map(t => ({ ...t, repoId: meta.id })) });
          }).catch(() => {});
        }

        const logRepoIds = msg.repoIds.length > 0
          ? msg.repoIds.filter(id => !this.manager.getRepoMetas().find(m => m.id === id)?.isWorktree && !this.hiddenRepoIds.includes(id))
          : this.getVisibleRepos().map(r => r.id);
        const commits = limit > 0
          ? await this.manager.getInterleavedLog(logRepoIds, limit, msg.skip, {
            filterText: msg.filterText,
            filterAuthor: msg.filterAuthor,
            filterBranch: msg.filterBranch,
            filterDateFrom: msg.filterDateFrom,
            filterDateTo: msg.filterDateTo,
          })
          : [];
        // Last batch when git ran out of commits, or when the ceiling is reached — either
        // way there is nothing further to page in, and the client stops asking.
        const isLast = commits.length < limit || msg.skip + commits.length >= maxCommits;
        post({ type: 'LOG_COMMITS_BATCH', commits, isLast, batchIndex: 0, requestId: msg.requestId });

        // A freshly opened undocked panel is only ready once it has asked for commits.
        if (msg.skip === 0 && origin === 'undocked' && this.pendingUndocked) {
          const queued = this.pendingUndocked;
          this.pendingUndocked = null;
          setTimeout(() => {
            if (queued.filter) {
              const { repoId, branch } = queued.filter;
              this.undockedPanel?.postToLog({ type: 'LOG_FILTER_BY_REPO', repoId, branch });
            }
            if (queued.scroll) {
              const { hash, repoId } = queued.scroll;
              this.undockedPanel?.postToLog({ type: 'LOG_SCROLL_TO_COMMIT', hash, repoId });
            }
          }, 150);
        }

        // Send stashes only on first load (not on pagination)
        if (msg.skip === 0) {
          Promise.all(logRepoIds.map(async (repoId) => {
            const repo = this.manager.getRepo(repoId);
            if (!repo) return [];
            try {
              const stashes = await repo.stashList();
              return stashes.map(s => ({
                hash: s.ref,
                shortHash: s.ref,
                repoId,
                message: s.message || `WIP on ${s.branch}`,
                authorName: '',
                authorEmail: '',
                authorDate: s.date,
                committerDate: s.date,
                parents: s.parentHash ? [s.parentHash] : [],
                refs: [],
                isStash: true as const,
                stashRef: s.ref,
                stashBranch: s.branch,
                stashFiles: s.files,
              }));
            } catch { return []; }
          })).then(all => {
            // Always post, empty included: an empty list is how the last stash
            // disappearing is reported. Skipping it left a stash dropped elsewhere on
            // screen until the webview remounted. The store bails on an unchanged list,
            // so the repeated empty batch of a stash-less repo costs nothing.
            //
            // queriedRepoIds scopes the replace to the repos this request actually asked
            // about — logRepoIds can be a single filtered repo, and without this the
            // store's full-replace would wipe every other repo's stashes off screen.
            post({ type: 'LOG_STASHES_BATCH', stashCommits: all.flat(), queriedRepoIds: logRepoIds });
          }).catch(() => {});
        }
        break;
      }

      case 'LOG_REQUEST_COMMIT_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: 'Repo not found' }); return; }
        try {
          const files = await repo.getCommitFiles(msg.hash, msg.parents);
          post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files });
        } catch (e: unknown) {
          logError('commitFiles', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: formatGitError(e) });
        }
        break;
      }

      case 'LOG_REQUEST_RANGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_RANGE_FILES_RESULT', requestId: msg.requestId, files: [], orderedHashes: [], error: 'Repo not found' }); return; }
        try {
          const [files, orderedHashes] = await Promise.all([
            repo.getFilesBetween(msg.hashes),
            repo.getCombinedFilesOrder(msg.hashes),
          ]);
          post({ type: 'LOG_RANGE_FILES_RESULT', requestId: msg.requestId, files, orderedHashes });
        } catch (e: unknown) {
          logError('rangeFiles', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'LOG_RANGE_FILES_RESULT', requestId: msg.requestId, files: [], orderedHashes: [], error: formatGitError(e) });
        }
        break;
      }

      case 'LOG_REQUEST_MERGE_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits: [], error: 'Repo not found' }); return; }
        try {
          const commits = await repo.getMergeCommits(msg.hash, msg.parents);
          post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits });
        } catch (e: unknown) {
          logError('mergeCommits', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits: [], error: formatGitError(e) });
        }
        break;
      }

      case 'LOG_REQUEST_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff: null, error: 'Repo not found' }); return; }
        try {
          const diff = await repo.getFileDiff(msg.repoId, msg.hash, msg.filePath);
          post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff });
        } catch (e: unknown) {
          logError('fileDiff', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff: null, error: formatGitError(e) });
        }
        break;
      }

      case 'LOG_OPEN_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          await openSmartDiff(repo, msg);
        } catch (e: unknown) {
          showGitError('openDiff', e);
        }
        break;
      }

      case 'LOG_OPEN_RANGE_FILE_DIFF': {
        const { openRangeFileDiff } = await import('./CombinedDiffPanel');
        await openRangeFileDiff(this.manager, msg.repoId, msg.hashes, msg.filePath, msg.fileStatus, msg.oldPath);
        break;
      }

      case 'LOG_OPEN_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const uri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
          await vscode.commands.executeCommand('vscode.open', uri);
        } catch (e: unknown) {
          showGitError('openFile', e);
        }
        break;
      }

      case 'LOG_REVEAL_IN_EXPLORER': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(repo.rootPath, msg.filePath)));
        break;
      }

      case 'LOG_REVEAL_IN_OS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(repo.rootPath, msg.filePath)));
        break;
      }

      case 'LOG_SHOW_FILE_HISTORY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        await vscode.commands.executeCommand('gitcharm.showFileHistory', vscode.Uri.file(path.join(repo.rootPath, msg.filePath)));
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
        if (!repo) { post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          if (msg.fileStatus === 'A') {
            // File was added in this commit — reverting means deleting it from the working tree
            const uri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
            await vscode.workspace.fs.delete(uri, { useTrash: false });
          } else {
            await repo.revertFileToParent(msg.hash, msg.filePath);
          }
          post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('revertFile', e);
        }
        break;
      }

      case 'LOG_CHERRY_PICK_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.cherryPickFile(msg.hash, msg.filePath, msg.oldPath);
          post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
          logInfo('cherryPickFile', `Cherry-picked changes for ${msg.filePath}.`);
          vscode.window.showInformationMessage(vscode.l10n.t('Cherry-picked changes for {0}.', msg.filePath));
        } catch (e: unknown) {
          const errMsg = formatGitError(e);
          post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('FILE_CHERRY_PICK_CONFLICT')) {
            const files = errMsg.split('FILE_CHERRY_PICK_CONFLICT:')[1]?.trim();
            logWarn('cherryPickFile', `Cherry-pick of ${msg.filePath} has conflicts${files ? ` in ${files}` : ''}.`);
            vscode.window.showWarningMessage(files
              ? vscode.l10n.t('Cherry-pick of {0} has conflicts in {1}. Resolve them in the editor.', msg.filePath, files)
              : vscode.l10n.t('Cherry-pick of {0} has conflicts. Resolve them in the editor.', msg.filePath)
            );
          } else {
            showGitError('cherryPickFile', e);
          }
        }
        break;
      }

      case 'LOG_CHECKOUT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.checkout(msg.branchName, msg.createNew, msg.from);
          // _pendingDetachedTag is cleared inside GitService.checkout().
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
          const merged = mergeCurrentIntoBranches(branches, current);
          post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          const repoLabel = this.getNonWorktreeRepos().find(m => m.id === msg.repoId)?.name ?? msg.repoId;
          const handled = await handleDirtyCheckout(repo, repoLabel, msg.branchName, e);
          if (handled) {
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
            const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
            const merged = mergeCurrentIntoBranches(branches, current);
            post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
            post({ type: 'LOG_REFRESH' });
          } else {
            logError('checkout', formatGitError(e), getRawErrorDetail(e));
            showGitError('checkout', e);
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          }
        }
        break;
      }

      case 'LOG_PULL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pulling'), cancellable: false },
          async () => {
            try {
              const output = await repo.pull();
              post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true, output });
              post({ type: 'LOG_REFRESH' });
            } catch (e: unknown) {
              logError('pull', formatGitError(e), getRawErrorDetail(e));
              post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
            }
          }
        );
        break;
      }

      case 'LOG_PULL_BRANCH_PICK': {
        const repoId = await this.pickBranchRepo(msg.repoIds, msg.branchName, 'Pull');
        if (!repoId) break;
        const repo = this.manager.getRepo(repoId);
        if (!repo) break;
        const current = await repo.getCurrentBranch().catch(() => null);
        const isCurrent = !!current && current.name === msg.branchName && !current.detachedTag && !current.detachedHash;

        if (isCurrent) {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pulling "{0}"', msg.branchName), cancellable: false },
            async () => {
              try {
                await repo.pull();
                post({ type: 'LOG_REFRESH' });
              } catch (e: unknown) {
                logError('pullBranch', formatGitError(e), getRawErrorDetail(e));
                showGitError('pullBranch', e);
              }
            }
          );
          break;
        }

        // Not the current branch: update it in place via a fast-forward-only fetch,
        // same upstream resolution as LOG_PUSH_BRANCH_PICK below.
        const branches = await repo.getBranches().catch(() => []);
        if (!branches.some(branch => !branch.isRemote && branch.name === msg.branchName)) {
          vscode.window.showWarningMessage(vscode.l10n.t('Local branch "{0}" was not found.', msg.branchName));
          break;
        }
        const upstream = await repo.getBranchUpstream(msg.branchName);
        if (!upstream) {
          vscode.window.showWarningMessage(vscode.l10n.t('Branch "{0}" has no upstream to pull from.', msg.branchName));
          break;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pulling "{0}"', msg.branchName), cancellable: false },
          async () => {
            try {
              await repo.pullBranchFastForward(upstream.remote, upstream.branchName, msg.branchName);
              post({ type: 'LOG_REFRESH' });
            } catch (e: unknown) {
              logError('pullBranch', formatGitError(e), getRawErrorDetail(e));
              showGitError('pullBranch', e);
            }
          }
        );
        break;
      }

      case 'LOG_PUSH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing'), cancellable: false },
          async () => {
            try {
              await repo.push(msg.force, msg.remote);
              post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              post({ type: 'LOG_REFRESH' });
            } catch (e: unknown) {
              logError('push', formatGitError(e), getRawErrorDetail(e));
              post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
            }
          }
        );
        break;
      }

      case 'LOG_PUSH_BRANCH_PICK': {
        const repoId = await this.pickBranchRepo(msg.repoIds, msg.branchName, 'Push');
        if (!repoId) break;
        const repo = this.manager.getRepo(repoId);
        if (!repo) break;
        const branches = await repo.getBranches().catch(() => []);
        if (!branches.some(branch => !branch.isRemote && branch.name === msg.branchName)) {
          vscode.window.showWarningMessage(vscode.l10n.t('Local branch "{0}" was not found.', msg.branchName));
          break;
        }

        const upstream = await repo.getBranchUpstream(msg.branchName);
        let remote = upstream?.remote;
        let remoteBranchName = upstream?.branchName ?? msg.branchName;
        if (!remote) {
          const remotes = await repo.getRemotes().catch(() => [] as string[]);
          if (remotes.length === 0) {
            vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured.'));
            break;
          }
          remote = remotes.length === 1
            ? remotes[0]
            : (await vscode.window.showQuickPick(
                remotes.map(name => ({ label: `$(cloud-upload) ${name}`, remote: name })),
                { title: vscode.l10n.t('Push "{0}" — Select remote', msg.branchName) }
              ))?.remote;
          if (!remote) break;
          remoteBranchName = msg.branchName;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing "{0}" to {1}', msg.branchName, remote), cancellable: false },
          async () => {
            try {
              await repo.pushBranch(msg.branchName, remote!, remoteBranchName, !upstream);
              logInfo('pushBranch', `Pushed "${msg.branchName}" to "${remote}/${remoteBranchName}" successfully.`);
              vscode.window.showInformationMessage(vscode.l10n.t('Pushed "{0}" to "{1}" successfully.', msg.branchName, `${remote}/${remoteBranchName}`));
              post({ type: 'LOG_REFRESH' });
            } catch (e: unknown) {
              showGitError('pushBranch', e);
            }
          }
        );
        break;
      }

      case 'LOG_GET_REMOTES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: 'Repo not found' }); return; }
        try {
          const remotes = await repo.getRemotes();
          post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes });
        } catch (e: unknown) {
          logError('getRemotes', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: formatGitError(e) });
        }
        break;
      }

      case 'LOG_MERGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const { upToDate } = await repo.merge(msg.from);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
          if (upToDate) vscode.window.showInformationMessage(vscode.l10n.t('"{0}" is already up to date — nothing to merge.', msg.from));
        } catch (e: unknown) {
          const errMsg = formatGitError(e);
          const isDirty = errMsg.includes('Your local changes') || errMsg.includes('overwritten by merge') || (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree';
          if (isDirty) {
            logWarn('merge', errMsg, getRawErrorDetail(e));
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
            const repoMeta = this.getNonWorktreeRepos().find(m => m.id === msg.repoId);
            const repoName = repoMeta?.name ?? msg.repoId;
            const pick = await vscode.window.showQuickPick(
              [
                { label: `$(archive) ${vscode.l10n.t('Stash and merge')}`, detail: vscode.l10n.t('Save local changes to stash, then merge'), value: 'stash' },
                { label: `$(close) ${vscode.l10n.t('Cancel')}`, detail: '', value: 'cancel' },
              ],
              {
                title: vscode.l10n.t('[{0}]: Uncommitted changes', repoName),
                placeHolder: vscode.l10n.t('Local changes would be overwritten by merging "{0}"', msg.from),
                ignoreFocusOut: true,
              }
            );
            if (pick?.value === 'stash') {
              try {
                await repo.stashPush(`WIP before merge of ${msg.from}`);
                const { upToDate } = await repo.merge(msg.from);
                post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
                post({ type: 'LOG_REFRESH' });
                if (upToDate) vscode.window.showInformationMessage(vscode.l10n.t('"{0}" is already up to date — nothing to merge.', msg.from));
              } catch (e2: unknown) {
                logError('merge:stash', formatGitError(e2), getRawErrorDetail(e2));
                post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e2) });
              }
            }
            break;
          }
          logError('merge', errMsg, getRawErrorDetail(e));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT')) {
            void this.commitPanel?.seedCommitMessage();
            vscode.window.showWarningMessage(
              vscode.l10n.t('Merge conflicts detected. Use the Merge Editor to resolve them.'),
              vscode.l10n.t('Open Commit Panel')
            ).then(choice => {
              if (choice) vscode.commands.executeCommand('gitcharm.commitPanel.focus');
            });
          } else {
            // The webview only logs this to its console, so the failure is
            // invisible unless it is reported here.
            vscode.window.showErrorMessage(vscode.l10n.t('Merge of "{0}" failed: {1}', msg.from, errMsg));
          }
        }
        break;
      }

      case 'LOG_REBASE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.rebase(msg.onto);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          logError('rebase', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          vscode.window.showErrorMessage(vscode.l10n.t('Rebase onto "{0}" failed: {1}', msg.onto, formatGitError(e)));
        }
        break;
      }

      case 'LOG_DELETE_BRANCH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }

        const branchInfo = (await repo.getBranches()).find(b => b.name === msg.branchName);
        if (branchInfo?.isRemote) {
          const remote = branchInfo.remoteName ?? msg.branchName.split('/')[0];
          const bareName = msg.branchName.slice(remote.length + 1);
          const defaultBranch = await repo.getRemoteDefaultBranch(remote);
          if (defaultBranch && bareName === defaultBranch) {
            const warnMsg = `"${bareName}" is the default branch on "${remote}" — it can't be deleted from the remote.`;
            vscode.window.showWarningMessage(vscode.l10n.t('"{0}" is the default branch on "{1}" — it can\'t be deleted from the remote.', bareName, remote));
            logWarn('deleteBranch', warnMsg);
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Default branch' });
            return;
          }
        }

        const deleteLabel = vscode.l10n.t('Delete');
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t('Delete branch "{0}"?', msg.branchName), { modal: true }, deleteLabel
        );
        if (confirm !== deleteLabel) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          if (branchInfo?.isRemote) {
            const remote = branchInfo.remoteName ?? msg.branchName.split('/')[0];
            const bareName = msg.branchName.slice(remote.length + 1);
            await repo.deleteRemoteBranch(remote, bareName);
          } else {
            await repo.deleteBranch(msg.branchName, msg.force);
          }
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          logInfo('deleteBranch', `Deleted branch "${msg.branchName}".`);
          const branches = await repo.getBranches();
          post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
        } catch (e: unknown) {
          logError('deleteBranch', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'LOG_DELETE_BRANCH_MULTI': {
        // Check if the branch is currently checked out in any of the target repos
        const checkedOutIn: string[] = [];
        await Promise.all(msg.repoIds.map(async repoId => {
          const repo = this.manager.getRepo(repoId);
          if (!repo) return;
          const current = await repo.getCurrentBranch().catch(() => null);
          if (current && (current.name === msg.branchName || current.detachedTag === msg.branchName)) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            checkedOutIn.push(meta?.name ?? repoId);
          }
        }));
        let eligibleRepoIds = msg.repoIds.filter(id => {
          const meta = this.getNonWorktreeRepos().find(m => m.id === id);
          return !checkedOutIn.includes(meta?.name ?? id);
        });
        if (eligibleRepoIds.length === 0) {
          logWarn('deleteBranchMulti', `Cannot delete "${msg.branchName}" — it is currently checked out in all target repositories.`);
          vscode.window.showWarningMessage(vscode.l10n.t('Cannot delete "{0}" — it is currently checked out in all target repositories.', msg.branchName));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Checked out' });
          return;
        }

        // A remote-tracking ref pointing at the remote's default branch (e.g. "origin/main")
        // can't be deleted from the remote — skip those repos rather than let the push fail.
        const defaultBranchChecks = await Promise.all(eligibleRepoIds.map(async repoId => {
          const repo = this.manager.getRepo(repoId);
          if (!repo) return { repoId, isDefaultOnRemote: false };
          const branchInfo = (await repo.getBranches()).find(b => b.name === msg.branchName);
          if (branchInfo?.isRemote) {
            const remote = branchInfo.remoteName ?? msg.branchName.split('/')[0];
            const bareName = msg.branchName.slice(remote.length + 1);
            const defaultBranch = await repo.getRemoteDefaultBranch(remote);
            if (defaultBranch && bareName === defaultBranch) return { repoId, isDefaultOnRemote: true };
          }
          return { repoId, isDefaultOnRemote: false };
        }));
        const isDefaultOnRemote = defaultBranchChecks
          .filter(r => r.isDefaultOnRemote)
          .map(r => this.getNonWorktreeRepos().find(m => m.id === r.repoId)?.name ?? r.repoId);
        eligibleRepoIds = defaultBranchChecks.filter(r => !r.isDefaultOnRemote).map(r => r.repoId);
        if (eligibleRepoIds.length === 0) {
          const warnMsg = `Cannot delete "${msg.branchName}" — it's the default branch on the remote in: ${isDefaultOnRemote.join(', ')}.`;
          vscode.window.showWarningMessage(vscode.l10n.t('Cannot delete "{0}" — it\'s the default branch on the remote in: {1}.', msg.branchName, isDefaultOnRemote.join(', ')));
          logWarn('deleteBranchMulti', warnMsg);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Default branch' });
          return;
        }

        const skippedMsg = [
          checkedOutIn.length > 0 ? vscode.l10n.t('currently checked out in: {0}', checkedOutIn.join(', ')) : undefined,
          isDefaultOnRemote.length > 0 ? vscode.l10n.t('default branch on the remote in: {0}', isDefaultOnRemote.join(', ')) : undefined,
        ].filter(Boolean).join('; ');
        const repoCount = eligibleRepoIds.length;
        const deleteQuestion = plural(
          repoCount,
          vscode.l10n.t('Delete branch "{0}" in 1 repository?', msg.branchName),
          vscode.l10n.t('Delete branch "{0}" in {1} repositories?', msg.branchName, repoCount),
        );
        const deleteLabel = vscode.l10n.t('Delete');
        const forceDeleteLabel = vscode.l10n.t('Force Delete');
        const confirm = await vscode.window.showWarningMessage(
          skippedMsg ? vscode.l10n.t('{0} (skipped — {1})', deleteQuestion, skippedMsg) : deleteQuestion,
          { modal: true }, deleteLabel, forceDeleteLabel
        );
        if (!confirm) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        const force = confirm === forceDeleteLabel;
        const errors: string[] = [];
        for (const repoId of eligibleRepoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            // A remote-tracking ref (e.g. "origin/feature/x") can't be deleted with
            // `git branch -d` — that only works on local branches. Deleting it for real
            // requires pushing the deletion to the remote itself.
            const branchInfo = (await repo.getBranches()).find(b => b.name === msg.branchName);
            if (branchInfo?.isRemote) {
              const remote = branchInfo.remoteName ?? msg.branchName.split('/')[0];
              const bareName = msg.branchName.slice(remote.length + 1);
              await repo.deleteRemoteBranch(remote, bareName);
            } else {
              await repo.deleteBranch(msg.branchName, force);
            }
            const branches = await repo.getBranches();
            post({ type: 'LOG_REFS_UPDATE', repoId, branches });
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            logError('deleteBranchMulti', formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta?.name ?? repoId}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          notifyWithLogAction('warning', errorsSummary(errors));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        }
        break;
      }

      case 'LOG_RENAME_BRANCH_MULTI': {
        const repoCount = msg.repoIds.length;
        const newName = await vscode.window.showInputBox({
          title: repoCount === 1
            ? vscode.l10n.t('Rename branch \'{0}\'', msg.oldName)
            : vscode.l10n.t('Rename branch \'{0}\' in {1} repos', msg.oldName, repoCount),
          value: msg.oldName,
          validateInput: v => (v.trim() ? undefined : vscode.l10n.t('Branch name cannot be empty')),
        });
        if (!newName || newName === msg.oldName) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }

        const errors: string[] = [];
        const renamed: Array<{ repoId: string; label: string; oldUpstream: { remote: string; branchName: string } | null }> = [];
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
          const oldUpstream = await repo.getBranchUpstream(msg.oldName).catch(() => null);
          try {
            await repo.renameBranch(msg.oldName, newName);
            renamed.push({ repoId, label: meta?.name ?? repoId, oldUpstream });
            const branches = await repo.getBranches();
            post({ type: 'LOG_REFS_UPDATE', repoId, branches });
          } catch (e: unknown) {
            logError('renameBranchMulti', formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta?.name ?? repoId}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          notifyWithLogAction('warning', errorsSummary(errors));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        }
        for (const { repoId, label, oldUpstream } of renamed) {
          const repo = this.manager.getRepo(repoId);
          if (repo) await offerRenameBranchRemoteSync(repo, label, oldUpstream, newName);
        }
        break;
      }

      case 'LOG_FETCH_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.fetchAll();
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const branches = await repo.getBranches();
          post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
        } catch (e: unknown) {
          logError('fetch', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'LOG_CHERRY_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.cherryPick(msg.hash);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          const errMsg = formatGitError(e);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            logWarn('cherryPick', `Cherry-pick of ${msg.hash.slice(0, 8)} has conflicts.`, getRawErrorDetail(e));
            const continueLabel = vscode.l10n.t('Continue');
            const skipLabel = vscode.l10n.t('Skip');
            const abortLabel = vscode.l10n.t('Abort');
            const choice = await vscode.window.showWarningMessage(
              vscode.l10n.t('Cherry-pick of {0} has conflicts. Resolve them in the editor, then choose an action.', msg.hash.slice(0, 8)),
              continueLabel, skipLabel, abortLabel
            );
            if (choice === continueLabel) {
              await repo.cherryPickContinue();
            } else if (choice === skipLabel) {
              await repo.cherryPickSkip();
            } else if (choice === abortLabel) {
              await repo.cherryPickAbort();
            }
          } else {
            showGitError('cherryPick', e);
          }
        }
        break;
      }

      case 'LOG_REVERT_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        {
          const revertLabel = vscode.l10n.t('Revert');
          const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('Revert commit {0}? This creates a new commit that undoes the changes.', msg.hash.slice(0, 8)),
            { modal: true }, revertLabel
          );
          if (confirm !== revertLabel) {
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }
        try {
          await repo.revertCommit(msg.hash);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          const errMsg = formatGitError(e);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            logWarn('revertCommit', `Revert of ${msg.hash.slice(0, 8)} has conflicts.`, getRawErrorDetail(e));
            const continueLabel = vscode.l10n.t('Continue');
            const abortLabel = vscode.l10n.t('Abort');
            const choice = await vscode.window.showWarningMessage(
              vscode.l10n.t('Revert of {0} has conflicts. Resolve them in the editor, then choose an action.', msg.hash.slice(0, 8)),
              continueLabel, abortLabel
            );
            if (choice === continueLabel) {
              await repo.revertContinue();
            } else if (choice === abortLabel) {
              await repo.revertAbort();
            }
          } else {
            showGitError('revertCommit', e);
          }
        }
        break;
      }

      case 'LOG_RESET_TO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const modeLabel = msg.mode === 'hard'
          ? vscode.l10n.t('Hard Reset (discard all changes)')
          : msg.mode === 'mixed' ? vscode.l10n.t('Mixed Reset (keep unstaged)') : vscode.l10n.t('Soft Reset (keep staged)');
        const resetLabel = vscode.l10n.t('Reset');
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t('Reset current branch to {0}? ({1})', msg.hash.slice(0, 8), modeLabel),
          { modal: true }, resetLabel
        );
        if (confirm !== resetLabel) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.resetTo(msg.hash, msg.mode);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('resetTo', e);
        }
        break;
      }

      case 'LOG_CREATE_PATCH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const patch = await repo.createPatch(msg.hash);
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${msg.hash.slice(0, 8)}.patch`),
            filters: { [vscode.l10n.t('Patch files')]: ['patch'], [vscode.l10n.t('All files')]: ['*'] },
          });
          if (uri) {
            logInfo('createPatch', `Patch saved to ${uri.fsPath}`);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(patch, 'utf8'));
            vscode.window.showInformationMessage(vscode.l10n.t('Patch saved to {0}', uri.fsPath));
          }
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('createPatch', e);
        }
        break;
      }

      case 'LOG_CHERRY_PICK_MULTI': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.cherryPickMulti(msg.hashes);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          const errMsg = formatGitError(e);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            logWarn('cherryPickMulti', 'Cherry-pick has conflicts.', getRawErrorDetail(e));
            const continueLabel = vscode.l10n.t('Continue');
            const skipLabel = vscode.l10n.t('Skip');
            const choice = await vscode.window.showWarningMessage(
              vscode.l10n.t('Cherry-pick has conflicts. Resolve them, then choose an action.'),
              continueLabel, skipLabel, vscode.l10n.t('Abort')
            );
            if (choice === continueLabel) await repo.cherryPickContinue();
            else if (choice === skipLabel) await repo.cherryPickSkip();
            else await repo.cherryPickAbort();
          } else {
            showGitError('cherryPickMulti', e);
          }
        }
        break;
      }

      case 'LOG_REVERT_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        {
          const revertLabel = vscode.l10n.t('Revert');
          const confirm = await vscode.window.showWarningMessage(
            plural(
              msg.hashes.length,
              vscode.l10n.t('Revert 1 commit? This creates a new commit that undoes the changes.'),
              vscode.l10n.t('Revert {0} commits? This creates new commits that undo the changes.', msg.hashes.length),
            ),
            { modal: true }, revertLabel
          );
          if (confirm !== revertLabel) {
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }
        try {
          await repo.revertCommits(msg.hashes);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          const errMsg = formatGitError(e);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            logWarn('revertCommits', 'Revert has conflicts.', getRawErrorDetail(e));
            const continueLabel = vscode.l10n.t('Continue');
            const choice = await vscode.window.showWarningMessage(
              vscode.l10n.t('Revert has conflicts. Resolve them, then choose an action.'),
              continueLabel, vscode.l10n.t('Abort')
            );
            if (choice === continueLabel) await repo.revertContinue();
            else await repo.revertAbort();
          } else {
            showGitError('revertCommits', e);
          }
        }
        break;
      }

      case 'LOG_DROP_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const dropLabel = vscode.l10n.t('Drop');
        const confirm = await vscode.window.showWarningMessage(
          plural(
            msg.hashes.length,
            vscode.l10n.t('Drop 1 commit? This rewrites history and cannot be undone.'),
            vscode.l10n.t('Drop {0} commits? This rewrites history and cannot be undone.', msg.hashes.length),
          ),
          { modal: true }, dropLabel
        );
        if (confirm !== dropLabel) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.dropCommits(msg.oldestHash);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('dropCommits', e);
        }
        break;
      }

      case 'LOG_CREATE_PATCH_MULTI': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const folderUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: vscode.l10n.t('Save patches here'),
          });
          if (!folderUris || folderUris.length === 0) {
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
            return;
          }
          const folderPath = folderUris[0].fsPath;
          for (const hash of msg.hashes) {
            const patch = await repo.createPatch(hash);
            const filePath = path.join(folderPath, `${hash.slice(0, 8)}.patch`);
            await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(patch, 'utf8'));
          }
          logInfo('createPatchMulti', `${msg.hashes.length} patches saved to ${folderPath}`);
          vscode.window.showInformationMessage(plural(
            msg.hashes.length,
            vscode.l10n.t('1 patch saved to {0}', folderPath),
            vscode.l10n.t('{0} patches saved to {1}', msg.hashes.length, folderPath),
          ));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('createPatchMulti', e);
        }
        break;
      }

      case 'LOG_DROP_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const dropLabel = vscode.l10n.t('Drop');
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t('Drop commit {0}? This rewrites history. Only drop unpushed commits — dropping a pushed commit will require a force push.', msg.hash.slice(0, 8)),
          { modal: true }, dropLabel
        );
        if (confirm !== dropLabel) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.dropCommit(msg.hash);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('dropCommit', e);
        }
        break;
      }

      case 'LOG_SQUASH_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const fullMessages = await Promise.all(msg.hashes.map(h => repo.getFullCommitMessage(h).then(m => m.trim())));
        const fullCombined = fullMessages.join('\n\n');
        const fullCommits = msg.commits.map((c, i) => ({ ...c, message: fullMessages[i] ?? c.message }));
        const result = await openSquashEditor(this.extensionUri, msg.hashes.length, fullCombined, fullCommits);
        if (!result.confirmed) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.squashCommits(msg.oldestHash, result.message);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('squash', e);
        }
        break;
      }

      case 'LOG_UNDO_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const undoLabel = vscode.l10n.t('Undo Commit');
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t('Undo last commit? Changes will be moved back to the staged area.'),
          { modal: true }, undoLabel
        );
        if (confirm !== undoLabel) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.undoCommit();
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('undoCommit', e);
        }
        break;
      }

      case 'LOG_EDIT_COMMIT_MESSAGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const fullMessage = (await repo.getFullCommitMessage(msg.hash)).trim();
        const result = await openEditMessageEditor(this.extensionUri, msg.hash.slice(0, 8), fullMessage);
        if (!result.confirmed) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.rewordCommit(result.message);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('editCommitMessage', e);
        }
        break;
      }

      case 'LOG_NEW_BRANCH_FROM_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const branchName = await promptBranchName({
          title: vscode.l10n.t('Create new branch from {0}', msg.hash.slice(0, 8)),
          prompt: vscode.l10n.t('Create new branch from {0}', msg.hash.slice(0, 8)),
          placeHolder: 'my-feature-branch',
        });
        if (!branchName) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.createBranchFromCommit(branchName.trim(), msg.hash);
          const branches = await repo.getBranches();
          post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('createBranch', e);
        }
        break;
      }

      case 'LOG_CREATE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const tagName = await vscode.window.showInputBox({
          prompt: vscode.l10n.t('Tag name for commit {0}', msg.hash.slice(0, 8)),
          placeHolder: 'v1.0.0',
          validateInput: v => v.trim() ? undefined : vscode.l10n.t('Tag name cannot be empty'),
        });
        if (!tagName) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          const trimmed = tagName.trim();
          await repo.createTag(trimmed, msg.hash);
          const rawTags = await repo.getTags();
          post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags: rawTags.map(t => ({ ...t, repoId: msg.repoId })) });
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
          const pushLabel = vscode.l10n.t('Push');
          const push = await vscode.window.showInformationMessage(
            vscode.l10n.t('Tag "{0}" created. Push to remote?', trimmed),
            { modal: false },
            pushLabel
          );
          if (push === pushLabel) await this.pushTagWithRemotePicker(repo, trimmed);
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('createTag', e);
        }
        break;
      }

      // Branches that merely descend from this commit — kept separate from the refs
      // shown on the commit itself (see getRefsAt), which only cover exact matches.
      case 'LOG_REQUEST_COMMIT_BRANCHES': {
        const repo = this.manager.getRepo(msg.repoId);
        const branches = repo
          ? await repo.getBranchesContaining(msg.hash).catch(() => ({ local: [], remote: [], tags: [] }))
          : { local: [], remote: [], tags: [] };
        post({ type: 'LOG_COMMIT_BRANCHES_RESULT', requestId: msg.requestId, branches });
        break;
      }

      case 'LOG_REQUEST_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const rawTags = await repo.getTags();
          const tags = rawTags.map(t => ({ ...t, repoId: msg.repoId }));
          post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags });
        } catch { /* ignore */ }
        break;
      }

      case 'LOG_REQUEST_COMMIT_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        const tags = repo ? await repo.getTagsForCommit(msg.hash).catch(() => []) : [];
        post({ type: 'LOG_COMMIT_TAGS_RESULT', requestId: msg.requestId, tags });
        break;
      }

      case 'LOG_MANAGE_COMMIT_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const tags = await repo.getTagsForCommit(msg.hash).catch(() => [] as string[]);
        if (tags.length === 0) {
          vscode.window.showInformationMessage(vscode.l10n.t('No tags on this commit.'));
          return;
        }
        await this.showManageCommitTagsMenu(repo, msg.repoId, msg.hash, tags, msg.currentBranch);
        break;
      }

      case 'LOG_DELETE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.deleteTag(msg.tagName);
          const rawTags = await repo.getTags();
          post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags: rawTags.map(t => ({ ...t, repoId: msg.repoId })) });
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('deleteTag', e);
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
          logWarn('deleteTagMulti', `Cannot delete tag "${msg.tagName}" — HEAD is detached on it in all target repositories.`);
          vscode.window.showWarningMessage(vscode.l10n.t('Cannot delete tag "{0}" — HEAD is detached on it in all target repositories.', msg.tagName));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Checked out' });
          return;
        }
        const repoCount = eligibleRepoIds.length;
        const deleteQuestion = plural(
          repoCount,
          vscode.l10n.t('Delete tag "{0}" in 1 repository?', msg.tagName),
          vscode.l10n.t('Delete tag "{0}" in {1} repositories?', msg.tagName, repoCount),
        );
        const confirmMsg = checkedOutTagIn.length > 0
          ? vscode.l10n.t('{0} (skipped in: {1} — HEAD detached on this tag)', deleteQuestion, checkedOutTagIn.join(', '))
          : deleteQuestion;
        const choice = await (async (): Promise<DeleteTagChoice> => {
          const labels = deleteTagLabels();
          const pick = await vscode.window.showWarningMessage(
            confirmMsg,
            { modal: true }, labels.local, labels.remote, labels.both
          );
          if (!pick) return null;
          if (pick === labels.remote) return 'remote';
          if (pick === labels.both) return 'both';
          return 'local';
        })();
        if (!choice) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        const errors: string[] = [];
        for (const repoId of eligibleRepoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await deleteTagWithRemoteOption(repo, msg.tagName, choice);
            const rawTags = await repo.getTags();
            post({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            logError('deleteTagMulti', formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta?.name ?? repoId}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          notifyWithLogAction('warning', errorsSummary(errors));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_PUSH_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing tag "{0}" to {1}…', msg.tagName, msg.remote), cancellable: false },
          async () => {
            try {
              await repo.pushTag(msg.tagName, msg.remote);
              post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              logInfo('pushTag', `Tag "${msg.tagName}" pushed to "${msg.remote}".`);
              vscode.window.showInformationMessage(vscode.l10n.t('Tag "{0}" pushed to "{1}".', msg.tagName, msg.remote));
            } catch (e: unknown) {
              post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
              showGitError('pushTag', e);
            }
          }
        );
        break;
      }

      case 'LOG_CHECKOUT_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.checkoutTag(msg.tagName);
          // _pendingDetachedTag is now set inside GitService.checkoutTag().
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const branches = await repo.getBranches();
          const detachedHeadEntry: BranchInfo = {
            repoId: msg.repoId,
            name: 'HEAD',
            fullName: 'HEAD',
            isHead: true,
            isRemote: false,
            detachedTag: msg.tagName,
          };
          post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: [...branches, detachedHeadEntry] });
          post({ type: 'LOG_REFRESH' });
          logInfo('checkoutTag', `Checked out tag "${msg.tagName}" (detached HEAD).`);
          vscode.window.showInformationMessage(vscode.l10n.t('Checked out tag "{0}" (detached HEAD).', msg.tagName));
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('checkoutTag', e);
        }
        break;
      }

      case 'LOG_MERGE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.mergeTag(msg.tagName);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          post({ type: 'LOG_REFRESH' });
          logInfo('mergeTag', `Merged tag "${msg.tagName}".`);
          vscode.window.showInformationMessage(vscode.l10n.t('Merged tag "{0}".', msg.tagName));
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          showGitError('mergeTag', e);
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
            logError('mergeTagMulti', formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta?.name ?? repoId}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          notifyWithLogAction('warning', errorsSummary(errors));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          logInfo('mergeTagMulti', `Merged tag "${msg.tagName}" in ${msg.repoIds.length} ${msg.repoIds.length === 1 ? 'repository' : 'repositories'}.`);
          vscode.window.showInformationMessage(plural(
            msg.repoIds.length,
            vscode.l10n.t('Merged tag "{0}" in 1 repository.', msg.tagName),
            vscode.l10n.t('Merged tag "{0}" in {1} repositories.', msg.tagName, msg.repoIds.length),
          ));
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_RESET_TO_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        type ModeItem = vscode.QuickPickItem & { mode: 'soft' | 'mixed' | 'hard' };
        const pick = await vscode.window.showQuickPick(
          [
            { label: `$(arrow-down) ${vscode.l10n.t({ message: 'Soft', comment: ['git reset mode'] })}`, description: vscode.l10n.t('Keep staged and unstaged changes'), mode: 'soft' as const },
            { label: `$(discard) ${vscode.l10n.t({ message: 'Mixed', comment: ['git reset mode'] })}`, description: vscode.l10n.t('Keep unstaged changes, unstage staged changes'), mode: 'mixed' as const },
            { label: `$(trash) ${vscode.l10n.t({ message: 'Hard', comment: ['git reset mode'] })}`, description: vscode.l10n.t('Discard all local changes'), mode: 'hard' as const },
          ] satisfies ModeItem[],
          { title: vscode.l10n.t('Reset Current Branch to {0}', msg.hash.slice(0, 8)) }
        ) as ModeItem | undefined;
        if (!pick) return;
        const reqId = msg.hash + pick.mode;
        try {
          await repo.resetTo(msg.hash, pick.mode);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: reqId, ok: true });
          post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: reqId, ok: false, error: formatGitError(e) });
          showGitError('resetTo', e);
        }
        break;
      }

      case 'LOG_PUSH_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) { logWarn('push', 'No remotes configured.'); vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured.')); return; }
        const remotePick = remotes.length === 1
          ? remotes[0]
          : (await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: vscode.l10n.t('Push — Select remote') }
            ) as { label: string; remote: string } | undefined)?.remote;
        if (!remotePick) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing to {0}…', remotePick), cancellable: false },
          async () => {
            try {
              await repo.push(false, remotePick);
              logInfo('push', `Pushed to "${remotePick}" successfully.`);
              vscode.window.showInformationMessage(vscode.l10n.t('Pushed to "{0}" successfully.', remotePick));
            } catch (e: unknown) {
              showGitError('push', e);
            }
          }
        );
        post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_PUSH_TAG_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        await this.pushTagWithRemotePicker(repo, msg.tagName);
        break;
      }

      case 'LOG_OPEN_COMMIT_BODY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_COMMIT_BODY_RESULT', requestId: msg.requestId, hasBody: false }); return; }
        try {
          const full = (await repo.getFullCommitMessage(msg.hash)).trim();
          const lines = full.split('\n');
          const bodyLines = lines.slice(1).filter(l => l.trim() !== '');
          const hasBody = bodyLines.length > 0;
          if (hasBody) {
            const doc = await vscode.workspace.openTextDocument({ content: full, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: true });
          }
          post({ type: 'LOG_COMMIT_BODY_RESULT', requestId: msg.requestId, hasBody });
        } catch (e: unknown) {
          post({ type: 'LOG_COMMIT_BODY_RESULT', requestId: msg.requestId, hasBody: false });
        }
        break;
      }

      case 'LOG_SHOW_BRANCH_OPTIONS': {
        await vscode.commands.executeCommand('gitcharm.showBranchOptions', msg.repoId, msg.branchName);
        break;
      }

      case 'LOG_CHECKOUT_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        let target: string;
        if (msg.branchName) {
          type CheckoutItem = vscode.QuickPickItem & { value: 'branch' | 'revision' };
          const pick = await vscode.window.showQuickPick<CheckoutItem>(
            [
              { label: `$(arrow-right) ${vscode.l10n.t('Checkout branch \'{0}\'', msg.branchName.replace(/^remotes\//, ''))}`, description: msg.branchName.replace(/^remotes\//, ''), value: 'branch' },
              { label: `$(git-commit) ${vscode.l10n.t('Checkout revision (detached HEAD)')}`, description: msg.hash.slice(0, 8), value: 'revision' },
            ],
            { title: vscode.l10n.t('Checkout') }
          );
          if (!pick) break;
          target = pick.value === 'branch' ? msg.branchName : msg.hash;
        } else {
          target = msg.hash;
        }
        try {
          await repo.checkout(target);
          post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
          const merged = mergeCurrentIntoBranches(branches, current);
          post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
        } catch (e: unknown) {
          const repoLabel = this.getNonWorktreeRepos().find(m => m.id === msg.repoId)?.name ?? msg.repoId;
          const handled = await handleDirtyCheckout(repo, repoLabel, target, e);
          if (handled) {
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
            const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
            const merged = mergeCurrentIntoBranches(branches, current);
            post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
          } else {
            logError('checkoutCommit', formatGitError(e), getRawErrorDetail(e));
            showGitError('checkoutCommit', e);
            post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
          }
        }
        break;
      }

      case 'LOG_OPEN_EXTENDED_DETAIL': {
        const { openCommitFullDetailPanel } = await import('./CommitFullDetailPanel');
        await openCommitFullDetailPanel(this.extensionUri, this.manager, msg.repoId, msg.hash, {}, this.profileService);
        break;
      }

      case 'LOG_VIEW_COMBINED_DIFF': {
        const { openCombinedDiffPanel } = await import('./CombinedDiffPanel');
        await openCombinedDiffPanel(this.extensionUri, this.manager, msg.repoId, msg.hashes);
        break;
      }

      case 'LOG_COMPARE_COMMIT_WITH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        const commitMeta = await repo.getCommitMeta(msg.hash);
        const shortHash = commitMeta?.shortHash ?? msg.hash.slice(0, 7);
        const pickedRef = await pickRefQuickPick(repo, {
          placeHolder: vscode.l10n.t('Compare {0} with…', shortHash),
          title: vscode.l10n.t('GitCharm - Compare Commit With'),
        });
        if (!pickedRef) break;
        let refHash: string;
        try {
          refHash = await repo.resolveRef(pickedRef);
        } catch {
          logError('resolveRef', `Cannot resolve ref "${pickedRef}"`);
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot resolve ref "{0}"', pickedRef));
          break;
        }
        const rootPath = repo.rootPath;
        const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        const gitUri = (ref: string, filePath: string): vscode.Uri => {
          const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
          return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
        };
        const files = await repo.getCombinedFiles([refHash, msg.hash]);
        const resources = files
          .filter(f => f.status !== 'U')
          .map(f => {
            const label = vscode.Uri.file(path.join(rootPath, f.path));
            const original = gitUri(f.status === 'A' ? EMPTY_TREE : refHash, f.path);
            const modified = gitUri(f.status === 'D' ? EMPTY_TREE : msg.hash, f.path);
            return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
          });
        await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('{0} vs {1}', shortHash, pickedRef), resources);
        break;
      }

      case 'LOG_COMPARE_FILE_WITH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        const pickedRef = await pickRefQuickPick(repo, {
          placeHolder: vscode.l10n.t('Compare {0} with…', msg.filePath),
          title: vscode.l10n.t('GitCharm - Compare With'),
        });
        if (!pickedRef) break;
        let refHash: string;
        try {
          refHash = await repo.resolveRef(pickedRef);
        } catch {
          logError('resolveRef', `Cannot resolve ref "${pickedRef}"`);
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot resolve ref "{0}"', pickedRef));
          break;
        }
        const rootPath = repo.rootPath;
        const gitUri = (ref: string, filePath: string): vscode.Uri => {
          const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
          return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
        };
        const shortHash = msg.hash.slice(0, 7);
        await vscode.commands.executeCommand(
          'vscode.diff',
          gitUri(msg.hash, msg.filePath),
          gitUri(refHash, msg.filePath),
          vscode.l10n.t('{0} ({1} vs {2})', msg.filePath, shortHash, pickedRef),
        );
        break;
      }

      case 'LOG_OPEN_COMMIT_CHANGES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        const files = await repo.getCommitFiles(msg.hash);
        const rootPath = repo.rootPath;
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
        await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('Changes in {0}', msg.hash.slice(0, 8)), resources);
        break;
      }

      case 'LOG_EXPLAIN_COMMIT': {
        const { openCommitFullDetailPanel } = await import('./CommitFullDetailPanel');
        await openCommitFullDetailPanel(this.extensionUri, this.manager, msg.repoId, msg.hash, { autoExplain: true }, this.profileService);
        break;
      }

      case 'LOG_STASH_APPLY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        try {
          await repo.stashApply(msg.stashRef);
          this.refresh();
        } catch (e: unknown) {
          showGitError('stashApply', e);
        }
        break;
      }

      case 'LOG_STASH_POP': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        try {
          await repo.stashPop(msg.stashRef);
          this.refresh();
        } catch (e: unknown) {
          showGitError('stashPop', e);
        }
        break;
      }

      case 'LOG_STASH_DROP': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        const dropLabel = vscode.l10n.t('Drop');
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t('Drop this stash? This cannot be undone.'),
          { modal: true }, dropLabel
        );
        if (confirm !== dropLabel) break;
        try {
          await repo.stashDrop(msg.stashRef);
          this.refresh();
        } catch (e: unknown) {
          showGitError('stashDrop', e);
        }
        break;
      }

      case 'LOG_VIEW_LOCATION': {
        if (origin === 'sidebar' && msg.location !== this.dockedLocation) {
          this.dockedLocation = msg.location;
          this.syncLayoutContext();
        }
        break;
      }

      case 'LOG_FILTERS_ACTIVE': {
        await vscode.commands.executeCommand('setContext', FILTERS_ACTIVE_CONTEXT[origin], msg.active);
        break;
      }
    }
  }

  private async pushTagWithRemotePicker(repo: import('../git/GitService').GitService, tagName: string): Promise<void> {
    const remotes = await repo.getRemotes().catch(() => [] as string[]);
    if (remotes.length === 0) { logWarn('pushTag', 'No remotes configured.'); vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured.')); return; }
    const remotePick = remotes.length === 1
      ? remotes[0]
      : (await vscode.window.showQuickPick(
          remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
          { title: vscode.l10n.t('Push tag "{0}" — Select remote', tagName) }
        ) as { label: string; remote: string } | undefined)?.remote;
    if (!remotePick) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing tag "{0}" to {1}…', tagName, remotePick), cancellable: false },
      async () => {
        try {
          await repo.pushTag(tagName, remotePick);
          logInfo('pushTag', `Tag "${tagName}" pushed to "${remotePick}".`);
          vscode.window.showInformationMessage(vscode.l10n.t('Tag "{0}" pushed to "{1}".', tagName, remotePick));
        } catch (e: unknown) {
          showGitError('pushTag', e);
        }
      }
    );
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
      { label: `$(add) ${vscode.l10n.t('New Tag...')}`, tagName: null },
      { label: '', kind: vscode.QuickPickItemKind.Separator, tagName: null },
      ...tags.map(t => ({ label: `$(tag) ${t}`, tagName: t })),
    ];

    const tagPick = await vscode.window.showQuickPick(tagListItems, {
      title: vscode.l10n.t('Tags on commit {0}', hash.slice(0, 8)),
      placeHolder: vscode.l10n.t('Select a tag or create a new one'),
    }) as TagListItem | undefined;
    if (!tagPick) return;

    // "New Tag..." selected
    if (tagPick.tagName === null) {
      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Tag name for commit {0}', hash.slice(0, 8)),
        placeHolder: 'v1.0.0',
        validateInput: v => v.trim() ? undefined : vscode.l10n.t('Tag name cannot be empty'),
      });
      if (!newName) return;
      try {
        const trimmed = newName.trim();
        await repo.createTag(trimmed, hash);
        const rawTags = await repo.getTags();
        this.broadcast({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
        this.broadcast({ type: 'LOG_REFRESH' });
        const pushLabel = vscode.l10n.t('Push');
        const push = await vscode.window.showInformationMessage(
          vscode.l10n.t('Tag "{0}" created. Push to remote?', trimmed),
          { modal: false },
          pushLabel
        );
        if (push === pushLabel) await this.pushTagWithRemotePicker(repo, trimmed);
      } catch (e: unknown) {
        showGitError('createTag', e);
      }
      return;
    }

    // Step 2: show actions for the selected tag
    const tagName = tagPick.tagName;
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const actionItems: ActionItem[] = [
      {
        label: `$(arrow-left) ${vscode.l10n.t('Back')}`,
        action: () => this.showManageCommitTagsMenu(repo, repoId, hash, tags, currentBranch),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(git-merge) ${vscode.l10n.t('Merge "{0}" into "{1}"', tagName, currentBranch)}`,
        action: async () => {
          try {
            await repo.mergeTag(tagName);
            this.broadcast({ type: 'LOG_REFRESH' });
            logInfo('mergeTag', `Merged tag "${tagName}" into "${currentBranch}".`);
            vscode.window.showInformationMessage(vscode.l10n.t('Merged tag "{0}" into "{1}".', tagName, currentBranch));
          } catch (e: unknown) {
            showGitError('mergeTag', e);
          }
        },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(cloud-upload) ${vscode.l10n.t('Push "{0}" to remote…', tagName)}`,
        action: () => this.pushTagWithRemotePicker(repo, tagName),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(trash) ${vscode.l10n.t('Delete "{0}"', tagName)}`,
        action: async () => {
          const choice = await confirmDeleteTag(tagName, `Delete tag "${tagName}"?`);
          if (!choice) return;
          try {
            await deleteTagWithRemoteOption(repo, tagName, choice);
            const rawTags = await repo.getTags();
            this.broadcast({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
            this.broadcast({ type: 'LOG_REFRESH' });
            logInfo('deleteTag', `Deleted tag "${tagName}".`);
            vscode.window.showInformationMessage(vscode.l10n.t('Deleted tag "{0}".', tagName));
          } catch (e: unknown) {
            showGitError('deleteTag', e);
          }
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(actionItems, {
      title: vscode.l10n.t('Tag: {0}', tagName),
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  dispose(): void {
    this.managerListeners.forEach(d => d.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}

// git empty tree SHA — represents an empty file for added/deleted diffs
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function openSmartDiff(
  repo: import('../git/GitService').GitService,
  msg: { hash: string; filePath: string; fileStatus?: string; oldPath?: string; parents?: string[]; combined?: boolean },
): Promise<void> {
  const rootPath = repo.rootPath;
  const status = msg.fileStatus ?? 'M';
  const shortHash = msg.hash.slice(0, 8);
  const fileName = path.basename(msg.filePath);

  const gitUri = (ref: string, filePath: string): vscode.Uri => {
    const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
    return vscode.Uri.from({
      scheme: 'git',
      path: fileUri.path,
      query: JSON.stringify({ path: fileUri.fsPath, ref }),
    });
  };

  // Resolve parent hash: use provided parents array, fall back to git log
  const resolveParent = async (index = 0): Promise<string | null> => {
    const parents = msg.parents?.filter(Boolean) ?? [];
    if (parents[index]) return parents[index];
    const list = await repo.getParents(msg.hash);
    return list[index] ?? null;
  };

  let leftUri: vscode.Uri;
  let rightUri: vscode.Uri;
  let title: string;

  if (status === 'A' || status === 'C') {
    // File added or copied — left side is empty
    leftUri  = gitUri(EMPTY_TREE, msg.filePath);
    rightUri = gitUri(msg.hash, msg.filePath);
    title    = vscode.l10n.t('{0} (added in {1})', fileName, shortHash);

  } else if (status === 'D') {
    // File deleted — right side is empty; find the correct parent
    const parent = await resolveParent();
    const parentRef = parent ?? `${msg.hash}~1`;
    leftUri  = gitUri(parentRef, msg.filePath);
    rightUri = gitUri(EMPTY_TREE, msg.filePath);
    title    = vscode.l10n.t('{0} (deleted in {1})', fileName, shortHash);

  } else if (status === 'R') {
    // File renamed — diff old path at parent vs new path at commit
    const oldFilePath = msg.oldPath ?? msg.filePath;
    const parent = await resolveParent();
    const parentRef = parent ?? `${msg.hash}~1`;
    leftUri  = gitUri(parentRef, oldFilePath);
    rightUri = gitUri(msg.hash, msg.filePath);
    title    = vscode.l10n.t('{0} → {1} (renamed in {2})', path.basename(oldFilePath), fileName, shortHash);

  } else {
    // Modified (M), or combined/merge diff
    let parentRef: string;

    if (msg.combined) {
      // Combined diff: find the parent where this file actually changed
      const differingParent = await repo.findParentWithFileDiff(msg.hash, msg.filePath, msg.parents ?? []);
      parentRef = differingParent ?? `${msg.hash}~1`;
    } else {
      const parent = await resolveParent(0);
      parentRef = parent ?? `${msg.hash}~1`;
    }

    // Fallback: if parent doesn't have the file, treat as newly added
    const parentHasFile = await repo.gitObjectExists(parentRef, msg.filePath);
    if (!parentHasFile) {
      leftUri  = gitUri(EMPTY_TREE, msg.filePath);
      rightUri = gitUri(msg.hash, msg.filePath);
      title    = vscode.l10n.t('{0} (added in {1})', fileName, shortHash);
    } else {
      leftUri  = gitUri(parentRef, msg.filePath);
      rightUri = gitUri(msg.hash, msg.filePath);
      title    = `${fileName} (${shortHash})`;
    }
  }

  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
}
