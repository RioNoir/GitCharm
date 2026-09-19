import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { formatGitError } from './gitErrorUtils';
import { showLogChannel } from './Logger';

/** Shows the found orphaned branches (or "none found") with View in Log / Delete actions. Shared by the automatic post-fetch notification and the manual "Check for Orphaned Branches" command. */
export function presentOrphanBranches(
  manager: WorkspaceGitManager,
  logPanel: GitLogPanelProvider,
  orphaned: Array<{ repoId: string; branchName: string }>,
  reasonSuffix: string
): void {
  const count = orphaned.length;
  if (count === 0) {
    vscode.window.showInformationMessage('No orphaned branches found — every local branch still has a valid remote.');
    return;
  }
  const branchWord = count === 1 ? 'branch has' : 'branches have';
  const message = count === 1
    ? `Branch "${orphaned[0].branchName}" ${reasonSuffix}.`
    : `${count} local ${branchWord} ${reasonSuffix}.`;

  const viewInLog = 'View in Log';
  const deleteAction = count === 1 ? 'Delete Branch' : 'Delete Branches';
  const dismiss = 'Dismiss';

  void vscode.window.showInformationMessage(message, viewInLog, deleteAction, dismiss).then(async picked => {
    if (picked === viewInLog) {
      logPanel.focus();
      return;
    }
    if (picked !== deleteAction) return;

    const metaById = new Map(manager.getRepoMetas().map(m => [m.id, m]));
    const list = orphaned.map(o => `"${o.branchName}"${metaById.get(o.repoId) ? ` (${metaById.get(o.repoId)!.name})` : ''}`).join(', ');
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${count === 1 ? 'branch' : 'branches'} ${list}?`,
      { modal: true }, 'Delete'
    );
    if (confirm !== 'Delete') return;

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
      void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log').then(choice => {
        if (choice === 'Show Log') showLogChannel();
      });
    } else {
      vscode.window.showInformationMessage(`Deleted ${count} orphaned ${count === 1 ? 'branch' : 'branches'}.`);
    }
  });
}
