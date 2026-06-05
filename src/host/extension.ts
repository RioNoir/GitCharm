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
  manager.onStatusChange(status => badge.update(status));
  manager.getAllStatusesFresh().then(status => badge.update(status));

  const log = vscode.window.createOutputChannel('GitCharm Profiles');
  context.subscriptions.push(log);

  const profileService = new GitProfileService(context, log);
  profileService.autoInitIfEmpty();

  const commitPanel = new CommitPanelProvider(context.extensionUri, manager, context.globalStorageUri.fsPath, shelveDocProvider, undefined, profileService, context.globalState);
  const logPanel = new GitLogPanelProvider(context.extensionUri, manager);
  const mergeEditor = new MergeEditorProvider(context.extensionUri, manager);
  commitPanel.setMergeEditorProvider(mergeEditor);
  commitPanel.setLogProvider(logPanel);
  logPanel.setCommitPanel(commitPanel);

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

  registerCommands(context, commitPanel, logPanel, mergeEditor, branchStatusBar, annotationController, profileStatusBar);
}

export function deactivate(): void {}
