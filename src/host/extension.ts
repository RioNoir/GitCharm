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

export function activate(context: vscode.ExtensionContext): void {
  const manager = new WorkspaceGitManager(context);

  const shelveDocProvider = new ShelveDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ShelveDocumentProvider.scheme, shelveDocProvider)
  );

  const badge = new BadgeController();
  badge.startLoading();
  manager.onStatusChange(status => badge.update(status));
  manager.getAllStatusesFresh().then(status => badge.update(status));

  const profileService = new GitProfileService();
  profileService.autoInitIfEmpty();

  const commitPanel = new CommitPanelProvider(context.extensionUri, manager, context.globalStorageUri.fsPath, shelveDocProvider, profileService);
  const logPanel = new GitLogPanelProvider(context.extensionUri, manager);
  const mergeEditor = new MergeEditorProvider(context.extensionUri, manager);
  commitPanel.setMergeEditorProvider(mergeEditor);
  commitPanel.setLogProvider(logPanel);
  logPanel.setCommitPanel(commitPanel);

  const branchStatusBar = new BranchStatusBar(manager, () => {
    vscode.commands.executeCommand('gitstorm.commitPanel.focus');
  });

  const profileStatusBar = new ProfileStatusBar(profileService);

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
