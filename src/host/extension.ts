import * as vscode from 'vscode';
import { WorkspaceGitManager } from './git/WorkspaceGitManager';
import { CommitPanelProvider } from './panels/CommitPanelProvider';
import { GitLogPanelProvider } from './panels/GitLogPanelProvider';
import { MergeEditorProvider } from './panels/MergeEditorProvider';
import { BranchStatusBar } from './ui/BranchStatusBar';
import { BadgeController } from './ui/BadgeController';
import { registerCommands } from './commands/registerCommands';
import { ShelveDocumentProvider } from './utils/ShelveDocumentProvider';
import { FileAnnotationController } from './ui/FileAnnotationController';
import { GitProfileService } from './git/GitProfileService';
import { ProfileStatusBar } from './ui/ProfileStatusBar';

async function showViewModeQuickpick(globalState: vscode.Memento): Promise<void> {
  const SHOWN_KEY = 'hasShownViewModeQuickpick';
  if (globalState.get<boolean>(SHOWN_KEY)) return;

  type Item = vscode.QuickPickItem & { value: string };
  const items: Item[] = [
    {
      label: '$(layout) Simplified',
      description: 'Default',
      detail: 'Staged and Unstaged sections grouped per repository',
      value: 'simplified',
    },
    {
      label: '$(list-tree) Changelists',
      description: 'PhpStorm-style',
      detail: 'Files grouped into named changelists across repositories',
      value: 'changelists',
    },
    {
      label: '$(source-control) VS Code',
      description: 'Native-style',
      detail: 'Staged Changes / Changes sections with inline stage/unstage buttons',
      value: 'vscode',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'GitCharm — Choose your preferred view mode',
    placeHolder: 'Select how changed files are displayed (you can change this later in Settings)',
    ignoreFocusOut: true,
  });

  await globalState.update(SHOWN_KEY, true);

  if (picked) {
    await vscode.workspace.getConfiguration('gitcharm').update('changesViewMode', picked.value, vscode.ConfigurationTarget.Global);
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

  const commitWord = totalAhead === 1 ? 'commit' : 'commits';
  const repoWord = reposWithAhead === 1 ? 'repository' : 'repositories';
  const message = reposWithAhead === 1
    ? `GitCharm: ${totalAhead} unpushed ${commitWord} ready to push.`
    : `GitCharm: ${totalAhead} unpushed ${commitWord} across ${reposWithAhead} ${repoWord}.`;

  const picked = await vscode.window.showInformationMessage(message, 'Go to Push', 'Dismiss');

  if (picked === 'Go to Push') {
    await vscode.commands.executeCommand('gitcharm.commitPanel.focus');
    commitPanel.switchToTab('push');
  }
}

async function maybeNotifyIncomingCommits(manager: WorkspaceGitManager, globalState: vscode.Memento): Promise<void> {
  const DO_NOT_SHOW_KEY = 'doNotShowIncomingCommitsNotification';
  if (globalState.get<boolean>(DO_NOT_SHOW_KEY)) return;
  if (!vscode.workspace.getConfiguration('gitcharm').get<boolean>('notifyOnIncomingCommits', true)) return;

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
  if (totalBehind === 0) return;

  const reposWithBehind = branches.filter(b => (b.aheadBehind?.behind ?? 0) > 0).length;

  const commitWord = totalBehind === 1 ? 'commit' : 'commits';
  const repoWord = reposWithBehind === 1 ? 'repository' : 'repositories';
  const message = reposWithBehind === 1
    ? `GitCharm: ${totalBehind} incoming ${commitWord} available to pull.`
    : `GitCharm: ${totalBehind} incoming ${commitWord} across ${reposWithBehind} ${repoWord}.`;

  const pull = 'Pull';
  const dismiss = 'Dismiss';
  const doNotShow = "Don't show again";

  const picked = await vscode.window.showInformationMessage(message, pull, dismiss, doNotShow);

  if (picked === doNotShow) {
    await globalState.update(DO_NOT_SHOW_KEY, true);
  } else if (picked === pull) {
    const metaById = new Map(metas.map(m => [m.id, m]));
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Pulling…', cancellable: false },
      async () => {
        const results = await manager.pullAll(false);
        const failed = results.filter(r => !r.ok);
        const ok = results.filter(r => r.ok);
        if (failed.length === 0) {
          vscode.window.showInformationMessage(
            `GitCharm: ${ok.length} ${ok.length === 1 ? 'repository' : 'repositories'} updated.`
          );
        } else {
          const failedDesc = failed.map(r => {
            const name = metaById.get(r.repoId)?.name ?? r.repoId;
            return `${name}: ${r.message}`;
          }).join('; ');
          vscode.window.showWarningMessage(
            `GitCharm: ${ok.length} updated, ${failed.length} failed: ${failedDesc}`
          );
        }
      }
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const manager = new WorkspaceGitManager(context);

  // DEV ONLY: uncomment to reset the quickpick flag
  //context.globalState.update('hasShownViewModeQuickpick', false);
  showViewModeQuickpick(context.globalState);

  const shelveDocProvider = new ShelveDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ShelveDocumentProvider.scheme, shelveDocProvider)
  );

  const badge = new BadgeController();
  badge.startLoading();

  const log = vscode.window.createOutputChannel('GitCharm Profiles');
  context.subscriptions.push(log);

  const profileService = new GitProfileService(context, log);
  profileService.autoInitIfEmpty();

  const commitPanel = new CommitPanelProvider(context.extensionUri, manager, context.globalStorageUri.fsPath, shelveDocProvider, undefined, profileService, context.globalState, context.workspaceState);

  let startupNotificationsDone = false;
  const startupDisposable = manager.onStatusChange(async status => {
    badge.update(status);
    if (!startupNotificationsDone) {
      startupNotificationsDone = true;
      startupDisposable.dispose();
      await maybeNotifyIncomingCommits(manager, context.globalState);
      await maybeNotifyUnpushedCommits(manager, commitPanel);
    }
  });
  const logPanel = new GitLogPanelProvider(context.extensionUri, manager);
  const mergeEditor = new MergeEditorProvider(context.extensionUri, manager);
  commitPanel.setMergeEditorProvider(mergeEditor);
  commitPanel.setLogProvider(logPanel);
  commitPanel.setBadgeController(badge);
  logPanel.setCommitPanel(commitPanel);

  // Apply saved hidden repos to badge immediately (before webview opens)
  const savedHidden = context.workspaceState.get<string[]>('gitcharm.hiddenRepoIds', []);
  if (savedHidden.length > 0) badge.setHiddenRepoIds(savedHidden);

  const branchStatusBar = new BranchStatusBar(manager, () => {
    vscode.commands.executeCommand('gitcharm.commitPanel.focus');
  });

  const profileStatusBar = new ProfileStatusBar(profileService, manager);

  const annotationController = new FileAnnotationController(manager, logPanel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CommitPanelProvider.viewType, commitPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(GitLogPanelProvider.viewType, logPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    manager,
    badge,
    logPanel,
    mergeEditor,
    branchStatusBar,
    profileStatusBar,
    profileService,
    annotationController,
  );

  registerCommands(context, commitPanel, logPanel, mergeEditor, branchStatusBar, annotationController, profileStatusBar, manager);
}

export function deactivate(): void {}
