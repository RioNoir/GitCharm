import * as vscode from 'vscode';
import { CommitPanelProvider } from '../panels/CommitPanelProvider';
import { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { MergeEditorProvider } from '../panels/MergeEditorProvider';
import { BranchStatusBar } from '../ui/BranchStatusBar';
import { FileAnnotationController } from '../ui/FileAnnotationController';
import { ProfileStatusBar } from '../ui/ProfileStatusBar';

export function registerCommands(
  context: vscode.ExtensionContext,
  commitPanel: CommitPanelProvider,
  logPanel: GitLogPanelProvider,
  mergeEditor: MergeEditorProvider,
  branchStatusBar: BranchStatusBar,
  annotationController: FileAnnotationController,
  profileStatusBar: ProfileStatusBar,
): void {
  context.subscriptions.push(
    // Focus the Git Log panel in the bottom bar
    vscode.commands.registerCommand('gitcharm.openLog', () => {
      logPanel.focus();
    }),

    vscode.commands.registerCommand('gitcharm.refreshCommitPanel', () => {
      commitPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.openMergeEditor', () => {
      mergeEditor.openCurrentEditorFile();
    }),

    vscode.commands.registerCommand('gitcharm.fetchAll', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Fetching all remotes', cancellable: false },
        async () => { /* delegated to panel message handler */ }
      );
    }),

    vscode.commands.registerCommand('gitcharm.showBranchMenu', (repoId?: string) => {
      branchStatusBar.showMenu(repoId);
    }),

    vscode.commands.registerCommand('gitcharm.updateProject', () => {
      branchStatusBar.updateProject();
    }),

    vscode.commands.registerCommand('gitcharm.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rionoir.gitcharm');
    }),

    vscode.commands.registerCommand('gitcharm.openGitAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.openAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.closeGitAnnotations', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) annotationController.closeAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.navigateToAnnotationCommit', (hash: string, repoId: string) => {
      annotationController.navigateToCommit(hash, repoId);
    }),

    vscode.commands.registerCommand('gitcharm.manageProfiles', () => {
      profileStatusBar.showMenu();
    }),

    vscode.commands.registerCommand('gitcharm.switchProfile', () => {
      profileStatusBar.switchProfile();
    }),
  );

  // Track files with conflict markers so we know when they've been resolved
  const conflictedFiles = new Set<string>();

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.uri.scheme !== 'file') return;
      if (doc.getText().includes('<<<<<<<')) {
        conflictedFiles.add(doc.uri.fsPath);
      }
    }),

    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'file') return;
      if (e.document.getText().includes('<<<<<<<')) {
        conflictedFiles.add(e.document.uri.fsPath);
      }
    }),

    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme !== 'file') return;
      if (!conflictedFiles.has(doc.uri.fsPath)) return;
      if (!doc.getText().includes('<<<<<<<')) {
        conflictedFiles.delete(doc.uri.fsPath);
        // Delay to run after VS Code's built-in SCM view focus
        setTimeout(() => {
          vscode.commands.executeCommand('gitcharm.commitPanel.focus');
        }, 300);
      }
    }),
  );
}
