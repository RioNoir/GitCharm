import * as vscode from 'vscode';
import { WorkspaceGitManager } from './git/WorkspaceGitManager';
import { CommitPanelProvider } from './panels/CommitPanelProvider';
import { isCommitPanelTabShown } from './ui/commitPanelConfig';
import { GitLogPanelProvider } from './panels/GitLogPanelProvider';
import { UndockedPanelProvider } from './panels/UndockedPanelProvider';
import { syncGitLogLocationContext, watchGitLogLocationContext } from './settings/GitLogLocationSettings';
import { BranchStatusBar } from './ui/BranchStatusBar';
import { BadgeController } from './ui/BadgeController';
import { registerCommands } from './commands/registerCommands';
import { ShelveDocumentProvider } from './utils/ShelveDocumentProvider';
import { FileAnnotationController } from './ui/FileAnnotationController';
import { GitProfileService } from './git/GitProfileService';
import { ProfileStatusBar } from './ui/ProfileStatusBar';
import { initLogger, logInfo, logWarn, notifyWithLogAction } from './utils/Logger';
import { plural } from './utils/plural';
import { presentOrphanBranches } from './utils/orphanBranches';
import { PullRequestManager } from './pullRequests/PullRequestManager';
import { IntegrationAccountStore } from './integrations/IntegrationAccountStore';
import { IntegrationsService } from './integrations/IntegrationsService';
import { SettingsPanel } from './panels/SettingsPanel';
import { registerConflictAiCommands } from './commands/conflictAiCommands';
import { CreatePullRequestPanel } from './panels/CreatePullRequestPanel';
import { PullRequestDetailPanel } from './panels/PullRequestDetailPanel';
import { PullRequestDocumentProvider } from './pullRequests/PullRequestDocumentProvider';
import { IssueManager } from './issues/IssueManager';
import { IssueDetailPanel } from './panels/IssueDetailPanel';
import { CreateIssuePanel } from './panels/CreateIssuePanel';
import { IssueResolvePanel } from './panels/IssueResolvePanel';
import { deserializeCommitFullDetailPanel } from './panels/CommitFullDetailPanel';
import { avatarResolver } from './utils/avatarResolver';
import { initAiSecrets } from './ai/aiSecrets';

/**
 * Before avatars and Gravatar were two settings, `avatars.enabled` (off by default) meant Gravatar, and users were
 * asked once whether to turn it on. Their answer carries over, once: those who turned it on keep Gravatar; those
 * who kept it off get the new default — avatars from the forges only, which share no email address.
 */
async function migrateAvatarSettings(globalState: vscode.Memento): Promise<void> {
  const MIGRATED_KEY = 'avatarSettingsMigrated';
  if (globalState.get<boolean>(MIGRATED_KEY)) return;
  const cfg = vscode.workspace.getConfiguration('gitcharm');
  const previous = cfg.inspect<boolean>('avatars.enabled')?.globalValue;
  if (previous !== undefined) suppressAvatarReloadPrompt = true;
  if (previous === true) await cfg.update('avatars.gravatar.enabled', true, vscode.ConfigurationTarget.Global);
  else if (previous === false) await cfg.update('avatars.enabled', undefined, vscode.ConfigurationTarget.Global);
  await globalState.update(MIGRATED_KEY, true);
}

/** Webviews read the avatar and date settings from their HTML, so a later change only takes effect on reload. */
let suppressAvatarReloadPrompt = false;
function watchAvatarSetting(): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(async e => {
    if (!e.affectsConfiguration('gitcharm.avatars') && !e.affectsConfiguration('gitcharm.dateFormat')) return;
    avatarResolver.clear();
    if (suppressAvatarReloadPrompt) { suppressAvatarReloadPrompt = false; return; }
    const RELOAD = vscode.l10n.t('Reload Window');
    const picked = await vscode.window.showInformationMessage(vscode.l10n.t('Reload the window to apply the GitCharm setting.'), RELOAD);
    if (picked === RELOAD) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
}

async function showViewModeQuickpick(globalState: vscode.Memento): Promise<void> {
  const SHOWN_KEY = 'hasShownViewModeQuickpick';
  if (globalState.get<boolean>(SHOWN_KEY)) return;

  type Item = vscode.QuickPickItem & { value: string };
  const items: Item[] = [
    {
      label: `$(layout) ${vscode.l10n.t('Simplified')}`,
      description: vscode.l10n.t('Default'),
      detail: vscode.l10n.t('Staged and Unstaged sections grouped per repository'),
      value: 'simplified',
    },
    {
      label: `$(list-tree) ${vscode.l10n.t('Changelists')}`,
      description: vscode.l10n.t('PhpStorm-style'),
      detail: vscode.l10n.t('Files grouped into named changelists across repositories'),
      value: 'changelists',
    },
    {
      label: '$(source-control) VS Code',
      description: vscode.l10n.t('Native-style'),
      detail: vscode.l10n.t('Staged Changes / Changes sections with inline stage/unstage buttons'),
      value: 'vscode',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('GitCharm — Choose your preferred view mode'),
    placeHolder: vscode.l10n.t('Select how changed files are displayed (you can change this later in Settings)'),
    ignoreFocusOut: true,
  });

  await globalState.update(SHOWN_KEY, true);

  if (picked) {
    await vscode.workspace.getConfiguration('gitcharm').update('changesViewMode', picked.value, vscode.ConfigurationTarget.Global);
  }
}

async function maybeShowSupportNotification(globalState: vscode.Memento): Promise<void> {
  const DO_NOT_SHOW_KEY = 'doNotShowSupportNotification';
  const LAST_SHOWN_KEY = 'supportNotificationLastShown';

  if (globalState.get<boolean>(DO_NOT_SHOW_KEY)) return;

  const lastShown = globalState.get<number>(LAST_SHOWN_KEY, 0);
  const oneMonthMs = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - lastShown < oneMonthMs) return;

  await globalState.update(LAST_SHOWN_KEY, Date.now());

  const star = vscode.l10n.t('Leave a Star');
  const support = vscode.l10n.t('Support');
  const doNotShow = vscode.l10n.t('Do Not Show Again');
  const picked = await vscode.window.showInformationMessage(
    vscode.l10n.t('Do you like GitCharm?'),
    star,
    support,
    doNotShow,
  );

  if (picked === doNotShow) {
    await globalState.update(DO_NOT_SHOW_KEY, true);
  } else if (picked === star) {
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/RioNoir/GitCharm'));
  } else if (picked === support) {
    await vscode.env.openExternal(vscode.Uri.parse('https://ko-fi.com/rionoir'));
  }
}

async function maybeNotifyUnpushedCommits(manager: WorkspaceGitManager, commitPanel: CommitPanelProvider): Promise<void> {
  if (!vscode.workspace.getConfiguration('gitcharm').get<boolean>('notifyOnUnpushedCommits', true)) return;

  const metas = manager.getRepoMetas();
  const countResults = await Promise.allSettled(
    metas.map(async m => {
      const repo = manager.getRepo(m.id);
      return repo ? repo.getUnpushedCount() : 0;
    })
  );

  const counts = countResults
    .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
    .map(r => r.value);

  const totalAhead = counts.reduce((sum, c) => sum + c, 0);
  if (totalAhead === 0) return;

  const reposWithAhead = counts.filter(c => c > 0).length;

  const message = reposWithAhead === 1
    ? plural(totalAhead, vscode.l10n.t('1 unpushed commit ready to push.'), vscode.l10n.t('{0} unpushed commits ready to push.', totalAhead))
    : plural(totalAhead, vscode.l10n.t('1 unpushed commit across {0} repositories.', reposWithAhead), vscode.l10n.t('{0} unpushed commits across {1} repositories.', totalAhead, reposWithAhead));

  const goToPush = vscode.l10n.t('Go to Push');
  // Without the Sync tab there's nowhere to go: the notification just informs.
  const actions = isCommitPanelTabShown('push') ? [goToPush, vscode.l10n.t('Dismiss')] : [vscode.l10n.t('Dismiss')];
  const picked = await vscode.window.showInformationMessage(message, ...actions);

  if (picked === goToPush) {
    await vscode.commands.executeCommand('gitcharm.commitPanel.focus');
    commitPanel.switchToTab('push');
  }
}

/** Incoming commits last told about: a periodic fetch only speaks up when there are more than that. */
let lastNotifiedBehind = 0;

async function maybeNotifyIncomingCommits(manager: WorkspaceGitManager, globalState: vscode.Memento, periodic = false): Promise<void> {
  const DO_NOT_SHOW_KEY = 'doNotShowIncomingCommitsNotification';
  if (globalState.get<boolean>(DO_NOT_SHOW_KEY)) return;
  if (!vscode.workspace.getConfiguration('gitcharm').get<boolean>('notifyOnIncomingCommits', true)) return;

  await manager.startupFetchPromise;

  const metas = manager.getRepoMetas().filter(m => !m.isWorktree);
  const branchResults = await Promise.allSettled(
    metas.map(async m => {
      const repo = manager.getRepo(m.id);
      return repo ? repo.getCurrentBranch() : null;
    })
  );

  type BranchInfo = Awaited<ReturnType<NonNullable<ReturnType<WorkspaceGitManager['getRepo']>>['getCurrentBranch']>>;
  const branches = branchResults
    .filter((r): r is PromiseFulfilledResult<BranchInfo | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((b): b is BranchInfo => b !== null);

  const totalBehind = branches.reduce((sum, b) => sum + (b.aheadBehind?.behind ?? 0), 0);
  const alreadyKnown = periodic && totalBehind <= lastNotifiedBehind;
  lastNotifiedBehind = totalBehind;
  if (totalBehind === 0 || alreadyKnown) return;

  const reposWithBehind = branches.filter(b => (b.aheadBehind?.behind ?? 0) > 0).length;

  const message = reposWithBehind === 1
    ? plural(totalBehind, vscode.l10n.t('1 incoming commit available to pull.'), vscode.l10n.t('{0} incoming commits available to pull.', totalBehind))
    : plural(totalBehind, vscode.l10n.t('1 incoming commit across {0} repositories.', reposWithBehind), vscode.l10n.t('{0} incoming commits across {1} repositories.', totalBehind, reposWithBehind));

  const pull = vscode.l10n.t('Pull');
  const dismiss = vscode.l10n.t('Dismiss');
  const doNotShow = vscode.l10n.t("Don't show again");

  const picked = await vscode.window.showInformationMessage(message, pull, dismiss, doNotShow);

  if (picked === doNotShow) {
    await globalState.update(DO_NOT_SHOW_KEY, true);
  } else if (picked === pull) {
    const metaById = new Map(metas.map(m => [m.id, m]));
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pulling…'), cancellable: false },
      async () => {
        const results = await manager.pullAll();
        const failed = results.filter(r => !r.ok);
        const ok = results.filter(r => r.ok);
        if (failed.length === 0) {
          logInfo('pull:incoming', `${ok.length} ${ok.length === 1 ? 'repository' : 'repositories'} updated.`);
          vscode.window.showInformationMessage(plural(ok.length, vscode.l10n.t('1 repository updated.'), vscode.l10n.t('{0} repositories updated.', ok.length)));
        } else {
          const failedDesc = failed.map(r => {
            const name = metaById.get(r.repoId)?.name ?? r.repoId;
            return `${name}: ${r.message}`;
          }).join('; ');
          logWarn('pull:incoming', `${ok.length} updated, ${failed.length} failed`, failedDesc);
          notifyWithLogAction('warning', vscode.l10n.t('{0} updated, {1} failed: {2}', ok.length, failed.length, failedDesc));
        }
      }
    );
  }
}

function notifyOrphanBranches(manager: WorkspaceGitManager, logPanel: GitLogPanelProvider, newlyOrphaned: Array<{ repoId: string; branchName: string }>): void {
  if (!vscode.workspace.getConfiguration('gitcharm').get<boolean>('notifyOnOrphanBranches', true)) return;
  presentOrphanBranches(manager, logPanel, newlyOrphaned, 'lostAfterMerge');
}

export function activate(context: vscode.ExtensionContext): void {
  const log = initLogger(context);
  // Set before any view renders: hides the bottom-panel Log Panel view while the
  // Log's default home is an editor tab or a separate window, so there is only
  // ever one Log surface.
  syncGitLogLocationContext();
  const manager = new WorkspaceGitManager(context);

  // DEV ONLY: uncomment to reset the quickpick flag
  //context.globalState.update('hasShownViewModeQuickpick', false);
  // DEV ONLY: uncomment to reset the support notification
  //context.globalState.update('doNotShowSupportNotification', false);
  //context.globalState.update('supportNotificationLastShown', 0);
  // DEV ONLY: uncomment to reset the incoming commits notification flag
  //context.globalState.update('doNotShowIncomingCommitsNotification', false);
  showViewModeQuickpick(context.globalState);
  context.subscriptions.push(watchAvatarSetting());
  void migrateAvatarSettings(context.globalState);
  setTimeout(() => maybeShowSupportNotification(context.globalState), 5 * 60 * 1000); // DEV: use 5 * 60 * 1000 for production

  const shelveDocProvider = new ShelveDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ShelveDocumentProvider.scheme, shelveDocProvider)
  );

  const prDocProvider = new PullRequestDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PullRequestDocumentProvider.scheme, prDocProvider)
  );

  const badge = new BadgeController();
  badge.startLoading();

  const profileService = new GitProfileService(context, log);
  profileService.autoInitIfEmpty();

  initAiSecrets(context);
  const integrationAccounts = new IntegrationAccountStore(context.secrets, context.globalState);
  const pullRequestManager = new PullRequestManager(manager, integrationAccounts, context.workspaceState);
  avatarResolver.setForgeLookup((repoId, email, sha) => pullRequestManager.getCommitAuthorAvatar(repoId, email, sha));
  const integrations = new IntegrationsService(integrationAccounts, pullRequestManager, manager);

  const commitPanel = new CommitPanelProvider(context.extensionUri, manager, context.globalStorageUri.fsPath, shelveDocProvider, profileService, context.globalState, context.workspaceState, pullRequestManager);

  let startupNotificationsDone = false;
  const badgeDisposable = manager.onStatusChange(status => { badge.update(status); });
  const startupDisposable = manager.onStatusChange(async _status => {
    if (!startupNotificationsDone) {
      startupNotificationsDone = true;
      startupDisposable.dispose();
      await maybeNotifyIncomingCommits(manager, context.globalState);
      await maybeNotifyUnpushedCommits(manager, commitPanel);
    }
  });
  context.subscriptions.push(badgeDisposable);
  context.subscriptions.push(manager.onPeriodicFetch(() => { void maybeNotifyIncomingCommits(manager, context.globalState, true); }));
  const logPanel = new GitLogPanelProvider(context.extensionUri, manager, profileService, context.globalState);
  context.subscriptions.push(
    manager.onOrphanBranches(newlyOrphaned => notifyOrphanBranches(manager, logPanel, newlyOrphaned))
  );
  const undockedPanel = new UndockedPanelProvider(context.extensionUri, commitPanel, logPanel);
  const createPullRequestPanel = new CreatePullRequestPanel(context.extensionUri, manager, pullRequestManager, () => {
    commitPanel.requestPullRequestRefresh();
  });
  const pullRequestDetailPanel = new PullRequestDetailPanel(context.extensionUri, manager, pullRequestManager, prDocProvider, () => {
    commitPanel.requestPullRequestRefresh();
  });
  commitPanel.setLogProvider(logPanel);
  commitPanel.setBadgeController(badge);
  commitPanel.setUndockedPanel(undockedPanel);
  commitPanel.setCreatePullRequestPanel(createPullRequestPanel);
  commitPanel.setPullRequestDetailPanel(pullRequestDetailPanel);
  const issueManager = new IssueManager(manager, pullRequestManager, context.workspaceState);
  const issueDetailPanel = new IssueDetailPanel(
    context.extensionUri, manager, issueManager, pullRequestManager,
    () => commitPanel.requestIssueRefresh(),
    text => void commitPanel.insertCommitText(text),
  );
  const createIssuePanel = new CreateIssuePanel(context.extensionUri, manager, issueManager, pullRequestManager, (repoId, issue) => {
    commitPanel.requestIssueRefresh();
    void issueDetailPanel.open(repoId, issue);
  });
  issueDetailPanel.setPullRequestDetailPanel(pullRequestDetailPanel);
  const issueResolvePanel = new IssueResolvePanel(context.extensionUri, manager, issueManager, prDocProvider, (_repoId, _issue, commitDraft) => {
    void commitPanel.showCommitDraft(commitDraft);
  });
  issueDetailPanel.setIssueResolvePanel(issueResolvePanel);
  pullRequestDetailPanel.setIssueSupport(issueManager, issueDetailPanel);
  commitPanel.setIssueSupport(issueManager, issueDetailPanel, createIssuePanel);
  logPanel.setCommitPanel(commitPanel);
  logPanel.setUndockedPanel(undockedPanel);
  // Changing the setting from the Settings UI: switching back to the bottom
  // panel should tear down the undocked surface, same as the QuickPick does.
  context.subscriptions.push(
    watchGitLogLocationContext(undocked => { if (!undocked) undockedPanel.close(); }),
  );

  // Apply saved hidden repos to badge immediately (before webview opens)
  const savedHidden = commitPanel.getHiddenRepoIds();
  if (savedHidden.length > 0) badge.setHiddenRepoIds(savedHidden);

  const branchStatusBar = new BranchStatusBar(manager, () => {
    vscode.commands.executeCommand('gitcharm.commitPanel.focus');
  });

  commitPanel.setBranchStatusBar(branchStatusBar);
  branchStatusBar.setLogPanel(logPanel);
  logPanel.setBranchStatusBar(branchStatusBar);

  const profileStatusBar = new ProfileStatusBar(profileService, manager, context.globalStorageUri.fsPath);

  const annotationController = new FileAnnotationController(manager, logPanel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CommitPanelProvider.viewType, commitPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(GitLogPanelProvider.viewType, logPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Discard any stale undocked panel restored from a previous session
    vscode.window.registerWebviewPanelSerializer(UndockedPanelProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel): Thenable<void> {
        panel.dispose();
        return Promise.resolve();
      },
    }),
    // Restore Commit Full Detail / Pull Request Detail panels left open across a window reload/restart
    vscode.window.registerWebviewPanelSerializer('gitcharm.commitFullDetail', {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: unknown) =>
        deserializeCommitFullDetailPanel(panel, state, context.extensionUri, manager, profileService),
    }),
    vscode.window.registerWebviewPanelSerializer('gitcharm.settings', {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: unknown) => {
        SettingsPanel.restore(panel, state, context.extensionUri, manager, integrations);
        return Promise.resolve();
      },
    }),
    vscode.window.registerWebviewPanelSerializer('gitcharm.pullRequestDetail', {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: unknown) =>
        pullRequestDetailPanel.restore(panel, state),
    }),
    vscode.window.registerWebviewPanelSerializer('gitcharm.issueDetail', {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: unknown) =>
        issueDetailPanel.restore(panel, state),
    }),
    issueDetailPanel,
    createIssuePanel,
    issueResolvePanel,
    manager,
    badge,
    logPanel,
    undockedPanel,
    branchStatusBar,
    profileStatusBar,
    profileService,
    annotationController,
  );

  registerCommands(context, commitPanel, logPanel, branchStatusBar, annotationController, profileStatusBar, manager, context.extensionUri, integrations);
  registerConflictAiCommands(context, manager);

  context.subscriptions.push(
    vscode.commands.registerCommand('gitcharm.undock', () => {
      logPanel.triggerUndockPick();
    }),
    vscode.commands.registerCommand('gitcharm.log.fetchAndRefresh', async () => {
      await logPanel.fetchAndRefresh();
      commitPanel.refresh();
    }),
    vscode.commands.registerCommand('gitcharm.log.refresh', () => logPanel.reload()),
    vscode.commands.registerCommand('gitcharm.log.clearFilters', () => logPanel.clearFilters()),
    vscode.commands.registerCommand('gitcharm.log.compare', () => logPanel.setCompareMode(true)),
    vscode.commands.registerCommand('gitcharm.log.exitCompare', () => logPanel.setCompareMode(false)),
    vscode.commands.registerCommand('gitcharm.log.hideFilters', () => logPanel.setLayoutPref('filtersHidden', true)),
    vscode.commands.registerCommand('gitcharm.log.showFilters', () => logPanel.setLayoutPref('filtersHidden', false)),
    vscode.commands.registerCommand('gitcharm.log.hideBranchSidebar', () => logPanel.setLayoutPref('sidebarHidden', true)),
    vscode.commands.registerCommand('gitcharm.log.showBranchSidebar', () => logPanel.setLayoutPref('sidebarHidden', false)),
  );

  if (vscode.workspace.getConfiguration('gitcharm').get<boolean>('resetViewLocationsOnStartup', false)) {
    void vscode.commands.executeCommand('workbench.action.resetViewLocations')
      .then(() => commitPanel.refresh(), () => undefined);
  }
}

export function deactivate(): void {}
