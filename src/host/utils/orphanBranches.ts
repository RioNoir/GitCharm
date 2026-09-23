import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { formatGitError } from './gitErrorUtils';
import { notifyWithLogAction } from './Logger';
import { plural } from './plural';

/** Why the branches are orphaned; each maps to complete, translatable sentences below. */
export type OrphanReason = 'noValidRemote' | 'lostAfterMerge';

function orphanMessage(count: number, branchName: string, reason: OrphanReason): string {
  if (reason === 'noValidRemote') {
    return count === 1
      ? vscode.l10n.t('Branch "{0}" has no valid remote.', branchName)
      : vscode.l10n.t('{0} local branches have no valid remote.', count);
  }
  return count === 1
    ? vscode.l10n.t('Branch "{0}" lost its remote (likely deleted after a merge).', branchName)
    : vscode.l10n.t('{0} local branches lost their remote (likely deleted after a merge).', count);
}

/** Shows the found orphaned branches (or "none found") with View in Log / Delete actions. Shared by the automatic post-fetch notification and the manual "Check for Orphaned Branches" command. */
export function presentOrphanBranches(
  manager: WorkspaceGitManager,
  logPanel: GitLogPanelProvider,
  orphaned: Array<{ repoId: string; branchName: string }>,
  reason: OrphanReason
): void {
  const count = orphaned.length;
  if (count === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('No orphaned branches found — every local branch still has a valid remote.'));
    return;
  }
  const message = orphanMessage(count, orphaned[0].branchName, reason);

  const viewInLog = vscode.l10n.t('View in Log');
  const deleteAction = plural(count, vscode.l10n.t('Delete Branch'), vscode.l10n.t('Delete Branches'));
  const dismiss = vscode.l10n.t('Dismiss');

  void vscode.window.showInformationMessage(message, viewInLog, deleteAction, dismiss).then(async picked => {
    if (picked === viewInLog) {
      logPanel.focus();
      return;
    }
    if (picked !== deleteAction) return;

    const metaById = new Map(manager.getRepoMetas().map(m => [m.id, m]));
    const list = orphaned.map(o => `"${o.branchName}"${metaById.get(o.repoId) ? ` (${metaById.get(o.repoId)!.name})` : ''}`).join(', ');
    const del = vscode.l10n.t('Delete');
    const confirm = await vscode.window.showWarningMessage(
      plural(count, vscode.l10n.t('Delete branch {0}?', list), vscode.l10n.t('Delete branches {0}?', list)),
      { modal: true }, del
    );
    if (confirm !== del) return;

    const errors: string[] = [];
    for (const { repoId, branchName } of orphaned) {
      const repo = manager.getRepo(repoId);
      if (!repo) continue;
      try {
        await repo.deleteBranch(branchName, false);
      } catch (e: unknown) {
        errors.push(`${metaById.get(repoId)?.name ?? repoId}: ${formatGitError(e)}`);
      }
    }
    if (errors.length > 0) {
      notifyWithLogAction('warning', plural(errors.length,
        vscode.l10n.t('1 error: {0}', errors.join('; ')),
        vscode.l10n.t('{0} errors: {1}', errors.length, errors.join('; '))));
    } else {
      vscode.window.showInformationMessage(plural(count, vscode.l10n.t('Deleted 1 orphaned branch.'), vscode.l10n.t('Deleted {0} orphaned branches.', count)));
    }
  });
}
