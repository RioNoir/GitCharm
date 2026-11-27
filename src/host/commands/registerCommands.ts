import * as vscode from 'vscode';
import { configuredPullMode } from '../git/GitService';
import type { PullMode } from '../git/GitService';
import { CommitPanelProvider } from '../panels/CommitPanelProvider';
import { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { BranchStatusBar } from '../ui/BranchStatusBar';
import { FileAnnotationController } from '../ui/FileAnnotationController';
import { ProfileStatusBar } from '../ui/ProfileStatusBar';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { openFileHistoryPanel } from '../panels/FileHistoryPanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { compareWithCommand } from '../panels/CompareWithCommand';
import { hasConflictMarkers } from '../git/ConflictParser';
import { logInfo, logWarn, notifyWithLogAction, showLogChannel } from '../utils/Logger';
import { plural } from '../utils/plural';
import type { IntegrationsService } from '../integrations/IntegrationsService';
import { presentOrphanBranches } from '../utils/orphanBranches';
import type { BranchInfo } from '../types/git';

export function registerCommands(
  context: vscode.ExtensionContext,
  commitPanel: CommitPanelProvider,
  logPanel: GitLogPanelProvider,
  branchStatusBar: BranchStatusBar,
  annotationController: FileAnnotationController,
  profileStatusBar: ProfileStatusBar,
  manager?: WorkspaceGitManager,
  extensionUri?: vscode.Uri,
  integrations?: IntegrationsService,
): void {
  context.subscriptions.push(
    // Open the Log Panel where the persisted default location says
    vscode.commands.registerCommand('gitcharm.openLog', () => {
      logPanel.openPreferred();
    }),

    // Pick and persist where the Log Panel opens by default
    vscode.commands.registerCommand('gitcharm.setGitLogDefaultLocation', () => {
      void logPanel.triggerDefaultLocationPick();
    }),

    // Show the GitCharm output channel (full error/event log)
    vscode.commands.registerCommand('gitcharm.showOutputLog', () => {
      showLogChannel();
    }),

    vscode.commands.registerCommand('gitcharm.showSubmodules', () => manager?.setSubmodulesShown(true)),
    vscode.commands.registerCommand('gitcharm.hideSubmodules', () => manager?.setSubmodulesShown(false)),

    vscode.commands.registerCommand('gitcharm.refreshCommitPanel', async () => {
      if (!manager) return;
      await manager.reinitializeAndRefresh();
      logPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.setFileViewFlat', () => {
      commitPanel.setFileViewMode('flat');
    }),
    vscode.commands.registerCommand('gitcharm.setFileViewFlatChecked', () => {
      commitPanel.setFileViewMode('flat');
    }),

    vscode.commands.registerCommand('gitcharm.setFileViewTree', () => {
      commitPanel.setFileViewMode('tree');
    }),
    vscode.commands.registerCommand('gitcharm.setFileViewTreeChecked', () => {
      commitPanel.setFileViewMode('tree');
    }),

    vscode.commands.registerCommand('gitcharm.sortReposByDiscovery', () => {
      commitPanel.setRepoSortMode('discovery');
    }),
    vscode.commands.registerCommand('gitcharm.sortReposByDiscoveryChecked', () => {
      commitPanel.setRepoSortMode('discovery');
    }),

    vscode.commands.registerCommand('gitcharm.sortReposByName', () => {
      commitPanel.setRepoSortMode('name');
    }),
    vscode.commands.registerCommand('gitcharm.sortReposByNameChecked', () => {
      commitPanel.setRepoSortMode('name');
    }),

    vscode.commands.registerCommand('gitcharm.sortReposByPath', () => {
      commitPanel.setRepoSortMode('path');
    }),
    vscode.commands.registerCommand('gitcharm.sortReposByPathChecked', () => {
      commitPanel.setRepoSortMode('path');
    }),

    vscode.commands.registerCommand('gitcharm.sortChangesByName', () => {
      commitPanel.setChangeSortMode('name');
    }),
    vscode.commands.registerCommand('gitcharm.sortChangesByNameChecked', () => {
      commitPanel.setChangeSortMode('name');
    }),

    vscode.commands.registerCommand('gitcharm.sortChangesByPath', () => {
      commitPanel.setChangeSortMode('path');
    }),
    vscode.commands.registerCommand('gitcharm.sortChangesByPathChecked', () => {
      commitPanel.setChangeSortMode('path');
    }),

    vscode.commands.registerCommand('gitcharm.sortChangesByStatus', () => {
      commitPanel.setChangeSortMode('status');
    }),
    vscode.commands.registerCommand('gitcharm.sortChangesByStatusChecked', () => {
      commitPanel.setChangeSortMode('status');
    }),

    vscode.commands.registerCommand('gitcharm.showReposWithoutChanges', () => {
      commitPanel.setHideReposWithoutChanges(false);
    }),
    vscode.commands.registerCommand('gitcharm.showReposWithoutChangesChecked', () => {
      commitPanel.setHideReposWithoutChanges(false);
    }),

    vscode.commands.registerCommand('gitcharm.hideReposWithoutChanges', () => {
      commitPanel.setHideReposWithoutChanges(true);
    }),
    vscode.commands.registerCommand('gitcharm.hideReposWithoutChangesChecked', () => {
      commitPanel.setHideReposWithoutChanges(true);
    }),

    vscode.commands.registerCommand('gitcharm.openMergeEditor', async (uri?: vscode.Uri) => {
      // Invoked from the editor context menu VS Code passes the file's URI; from the
      // Command Palette it passes nothing, so fall back to the active editor.
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        logWarn('mergeEditor:open', 'No active file');
        vscode.window.showWarningMessage(vscode.l10n.t('No active file'));
        return;
      }
      const doc = await vscode.workspace.openTextDocument(target);
      if (!hasConflictMarkers(doc.getText())) {
        logWarn('mergeEditor:open', 'No conflict markers found in the current file');
        vscode.window.showWarningMessage(vscode.l10n.t('No conflict markers found in the current file'));
        return;
      }
      await vscode.commands.executeCommand('git.openMergeEditor', target)
        .then(undefined, () => vscode.window.showTextDocument(target));
    }),

    vscode.commands.registerCommand('gitcharm.commit', () => {
      vscode.commands.executeCommand('gitcharm.commitPanel.focus');
    }),

    vscode.commands.registerCommand('gitcharm.pull', () => {
      return branchStatusBar.updateProject();
    }),

    vscode.commands.registerCommand('gitcharm.push', async () => {
      if (!manager) return;
      const metas = manager.getRepoMetas();
      const metaById = new Map(metas.map(m => [m.id, m]));
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing all repositories…'), cancellable: false },
        async () => {
          const results = await manager.pushAll();
          const failed = results.filter(r => !r.ok);
          const ok = results.filter(r => r.ok);
          const pushed = ok.filter(r => r.message !== 'Nothing to push — skipped');
          if (failed.length === 0) {
            const msg = pushed.length === 0
              ? 'Nothing to push — all repositories up to date.'
              : `${pushed.length} ${pushed.length === 1 ? 'repository' : 'repositories'} pushed.`;
            vscode.window.showInformationMessage(pushed.length === 0
              ? vscode.l10n.t('Nothing to push — all repositories up to date.')
              : plural(pushed.length, vscode.l10n.t('1 repository pushed.'), vscode.l10n.t('{0} repositories pushed.', pushed.length)));
            logInfo('push', msg);
          } else {
            const failedDesc = failed.map(r => {
              const name = metaById.get(r.repoId)?.name ?? r.repoId;
              return `${name}: ${r.message}`;
            }).join('; ');
            logWarn('push', `${pushed.length} pushed, ${failed.length} failed: ${failedDesc}`);
            notifyWithLogAction('warning', vscode.l10n.t('{0} pushed, {1} failed: {2}', pushed.length, failed.length, failedDesc));
          }
        }
      );
      commitPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.fetchAll', async () => {
      if (!manager) return;
      await branchStatusBar.fetchAll();
      commitPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.checkOrphanBranches', async () => {
      if (!manager) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking for orphaned branches…'), cancellable: false },
        async () => {
          await manager.fetchAll();
          const metas = manager.getRepoMetas().filter(m => !m.isWorktree);
          const results = await Promise.allSettled(
            metas.map(async m => ({ repoId: m.id, branches: await manager.getRepo(m.id)?.getBranches() ?? [] }))
          );
          const orphaned = results
            .filter((r): r is PromiseFulfilledResult<{ repoId: string; branches: BranchInfo[] }> => r.status === 'fulfilled')
            .flatMap(r => r.value.branches.filter(b => !b.isRemote && b.upstreamGone).map(b => ({ repoId: r.value.repoId, branchName: b.name })));
          presentOrphanBranches(manager, logPanel, orphaned, 'noValidRemote');
        }
      );
    }),

    vscode.commands.registerCommand('gitcharm.syncAll', async () => {
      if (!manager) return;
      const metas = manager.getRepoMetas();
      const metaById = new Map(metas.map(m => [m.id, m]));

      const configured = configuredPullMode();
      const pick = configured !== 'ask' ? { mode: configured } : await vscode.window.showQuickPick(
        [
          { label: `$(git-merge) ${vscode.l10n.t('Merge incoming changes into the current branch')}`, mode: 'merge' as PullMode },
          { label: `$(repo-forked) ${vscode.l10n.t('Rebase the current branch on top of incoming changes')}`, mode: 'rebase' as PullMode },
        ],
        { title: vscode.l10n.t('Sync — Pull Strategy') }
      );
      if (!pick) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Syncing all repositories…'), cancellable: false },
        async () => {
          // Pull first
          const pullResults = await manager.pullAll(pick.mode);
          const pullFailed = pullResults.filter(r => !r.ok);

          if (pullFailed.length > 0) {
            const failedDesc = pullFailed.map(r => {
              const name = metaById.get(r.repoId)?.name ?? r.repoId;
              return `${name}: ${r.message}`;
            }).join('; ');
            logWarn('sync', `Sync: Pull failed — stopping before push. ${failedDesc}`);
            notifyWithLogAction('warning', vscode.l10n.t('Sync: Pull failed — stopping before push. {0}', failedDesc));
            commitPanel.refresh();
            return;
          }

          // Push only if all pulls succeeded
          const pushResults = await manager.pushAll();
          const pushFailed = pushResults.filter(r => !r.ok);
          const pushOk = pushResults.filter(r => r.ok);

          if (pushFailed.length === 0) {
            vscode.window.showInformationMessage(plural(pushOk.length, vscode.l10n.t('Sync: 1 repository synced.'), vscode.l10n.t('Sync: {0} repositories synced.', pushOk.length)));
            logInfo('sync', `Sync: ${pushOk.length} ${pushOk.length === 1 ? 'repository' : 'repositories'} synced.`);
          } else {
            const failedDesc = pushFailed.map(r => {
              const name = metaById.get(r.repoId)?.name ?? r.repoId;
              return `${name}: ${r.message}`;
            }).join('; ');
            logWarn('sync', `Sync: ${pushOk.length} synced, ${pushFailed.length} push failed: ${failedDesc}`);
            notifyWithLogAction('warning', vscode.l10n.t('Sync: {0} synced, {1} push failed: {2}', pushOk.length, pushFailed.length, failedDesc));
          }
          commitPanel.refresh();
        }
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

    vscode.commands.registerCommand('gitcharm.openSettings', (section?: string) => {
      if (!extensionUri || !manager || !integrations) {
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nifan950624.gitcharm');
        return;
      }
      // Menu contributions pass their context (a view item, a URI…) as first argument: only a string is a section.
      SettingsPanel.show(extensionUri, manager, integrations, typeof section === 'string' ? section : undefined);
    }),

    vscode.commands.registerCommand('gitcharm.resetViewLocations', async () => {
      await vscode.commands.executeCommand('workbench.action.resetViewLocations');
      commitPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.openGitAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.openAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.closeGitAnnotations', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) annotationController.closeAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.toggleGitAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.toggleAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.navigateToAnnotationCommit', (hash: string, repoId: string) => {
      annotationController.navigateToCommit(hash, repoId);
    }),

    vscode.commands.registerCommand('gitcharm.manageHiddenRepos', () => {
      commitPanel.manageHiddenRepos();
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
          { title: vscode.l10n.t('Open Submodule in New Window'), placeHolder: vscode.l10n.t('Select a submodule…') }
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
          { title: vscode.l10n.t('New Worktree — Select Repository'), placeHolder: vscode.l10n.t('Select a repository…') }
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
          { title: vscode.l10n.t('Prune Worktrees — Select Repository'), placeHolder: vscode.l10n.t('Select a repository…') }
        );
        if (!picked) return;
        repoId = picked.id;
      }
      if (!repoId) return;
      commitPanel.handleSubmoduleCommand({ type: 'WORKTREE_PRUNE', requestId: Math.random().toString(36).slice(2), repoId });
    }),

    // ── Pull Request commands ─────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.pullRequests.refresh', async () => {
      await commitPanel.requestPullRequestRefresh();
    }),

    // Accounts are managed on the Cloud Integrations page of GitCharm's settings.
    vscode.commands.registerCommand('gitcharm.pullRequests.manageCredentials', () =>
      vscode.commands.executeCommand('gitcharm.openSettings', 'integrations')),

    // From a branch's actions in the Git Menu
    vscode.commands.registerCommand('gitcharm.createPullRequestFromBranch', (repoId: string, branchName: string) =>
      commitPanel.createPullRequestFromBranch(repoId, branchName)),

    // ── Issue commands ────────────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.issues.refresh', () => {
      commitPanel.requestIssueRefresh();
    }),

    vscode.commands.registerCommand('gitcharm.issues.insertReference', () => commitPanel.pickIssueReferenceForCommit()),

    // ── File History ──────────────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.showFileHistory', async (uri?: vscode.Uri) => {
      if (!manager || !extensionUri) return;
      // uri comes from explorer/context or editor/context; fall back to active editor
      const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!fileUri || fileUri.scheme !== 'file') {
        vscode.window.showInformationMessage(vscode.l10n.t('Open a file to view its history.'));
        return;
      }
      await openFileHistoryPanel(extensionUri, manager, fileUri, logPanel);
    }),

    // ── Compare With ────────────────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.compareWith', async (uri?: vscode.Uri) => {
      if (!manager) return;
      // uri comes from explorer/context or editor/context; fall back to active editor
      const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!fileUri || fileUri.scheme !== 'file') {
        vscode.window.showInformationMessage(vscode.l10n.t('Select a file or folder to compare.'));
        return;
      }
      await compareWithCommand(manager, fileUri);
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
        if (!vscode.workspace.getConfiguration('gitcharm').get<boolean>('openCommitPanelOnConflictResolved', true)) return;
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
  _requireInitialized: boolean,
): Promise<{ parentRepoId: string; submodulePath: string } | undefined> {
  const metas = manager?.getRepoMetas().filter(m => m.isSubmodule) ?? [];
  if (metas.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('No submodules found in this workspace.'));
    return undefined;
  }

  let meta = repoId ? metas.find(m => m.id === repoId) : undefined;
  if (!meta && metas.length === 1) meta = metas[0];
  if (!meta) {
    const picked = await vscode.window.showQuickPick(
      metas.map(m => ({ label: m.name, description: m.submodulePath ?? '', id: m.id })),
      { title: vscode.l10n.t('Select Submodule'), placeHolder: vscode.l10n.t('Select a submodule…') }
    );
    if (!picked) return undefined;
    meta = metas.find(m => m.id === picked.id);
  }
  if (!meta?.parentRepoId || !meta.submodulePath) return undefined;
  return { parentRepoId: meta.parentRepoId, submodulePath: meta.submodulePath };
}
