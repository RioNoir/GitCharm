import * as vscode from 'vscode';
import { CommitPanelProvider } from '../panels/CommitPanelProvider';
import { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { MergeEditorProvider } from '../panels/MergeEditorProvider';
import { BranchStatusBar } from '../ui/BranchStatusBar';
import { FileAnnotationController } from '../ui/FileAnnotationController';
import { ProfileStatusBar } from '../ui/ProfileStatusBar';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';

export function registerCommands(
  context: vscode.ExtensionContext,
  commitPanel: CommitPanelProvider,
  logPanel: GitLogPanelProvider,
  mergeEditor: MergeEditorProvider,
  branchStatusBar: BranchStatusBar,
  annotationController: FileAnnotationController,
  profileStatusBar: ProfileStatusBar,
  manager?: WorkspaceGitManager,
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

    vscode.commands.registerCommand('gitcharm.showBranchOptions', (repoId: string, branchName: string) => {
      branchStatusBar.showBranchOptions(repoId, branchName);
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

    // ── Submodule commands ────────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.submodule.init', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, false);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_INIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.update', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_UPDATE', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, recursive: false });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.updateRecursive', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_UPDATE', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, recursive: true });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.deinit', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_DEINIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, force: false });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.deinitForce', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_DEINIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, force: true });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.openInNewWindow', async (repoId?: string) => {
      const metas = manager?.getRepoMetas().filter(m => m.isSubmodule) ?? [];
      let target = repoId ? metas.find(m => m.id === repoId) : undefined;
      if (!target && metas.length === 1) target = metas[0];
      if (!target) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: m.name, description: m.submodulePath, id: m.id })),
          { title: 'Open Submodule in New Window', placeHolder: 'Select a submodule…' }
        );
        if (!picked) return;
        target = metas.find(m => m.id === picked.id);
      }
      if (target) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.rootPath), { forceNewWindow: true });
      }
    }),

    // ── Worktree commands ─────────────────────────────────────────────────────
    vscode.commands.registerCommand('gitcharm.worktree.add', async () => {
      if (!commitPanel) return;
      // Determine which repo to use
      const metas = manager?.getRepoMetas().filter(m => (m.depth ?? 0) === 0) ?? [];
      let repoId: string | undefined;
      if (metas.length === 1) {
        repoId = metas[0].id;
      } else if (metas.length > 1) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: m.name, description: m.rootPath, id: m.id })),
          { title: 'New Worktree — Select Repository', placeHolder: 'Select a repository…' }
        );
        if (!picked) return;
        repoId = picked.id;
      }
      if (!repoId) return;
      commitPanel.handleSubmoduleCommand({ type: 'WORKTREE_CREATE_PROMPT', repoId });
    }),

    vscode.commands.registerCommand('gitcharm.worktree.prune', async () => {
      if (!commitPanel) return;
      const metas = manager?.getRepoMetas().filter(m => (m.depth ?? 0) === 0) ?? [];
      let repoId: string | undefined;
      if (metas.length === 1) {
        repoId = metas[0].id;
      } else if (metas.length > 1) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: m.name, description: m.rootPath, id: m.id })),
          { title: 'Prune Worktrees — Select Repository', placeHolder: 'Select a repository…' }
        );
        if (!picked) return;
        repoId = picked.id;
      }
      if (!repoId) return;
      commitPanel.handleSubmoduleCommand({ type: 'WORKTREE_PRUNE', requestId: Math.random().toString(36).slice(2), repoId });
    }),
  );

  // ─────────────────────────────────────────────────────────────────────────

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

async function pickSubmodule(
  manager: WorkspaceGitManager | undefined,
  repoId: string | undefined,
  requireInitialized: boolean,
): Promise<{ parentRepoId: string; submodulePath: string } | undefined> {
  const metas = manager?.getRepoMetas().filter(m => m.isSubmodule) ?? [];
  if (metas.length === 0) {
    vscode.window.showInformationMessage('No submodules found in this workspace.');
    return undefined;
  }

  let meta = repoId ? metas.find(m => m.id === repoId) : undefined;
  if (!meta && metas.length === 1) meta = metas[0];
  if (!meta) {
    const picked = await vscode.window.showQuickPick(
      metas.map(m => ({ label: m.name, description: m.submodulePath ?? '', id: m.id })),
      { title: 'Select Submodule', placeHolder: 'Select a submodule…' }
    );
    if (!picked) return undefined;
    meta = metas.find(m => m.id === picked.id);
  }
  if (!meta?.parentRepoId || !meta.submodulePath) return undefined;
  return { parentRepoId: meta.parentRepoId, submodulePath: meta.submodulePath };
}
