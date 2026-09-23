import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { logInfo } from './Logger';
import { showGitError } from './gitErrorUtils';

/**
 * After a local branch rename, offers to carry the rename over to its upstream (push the new
 * name, delete the old remote branch) instead of leaving the remote pointing at the stale name.
 * `oldUpstream` must be resolved via `GitService.getBranchUpstream(oldName)` *before* the local
 * rename runs — once `git branch -m` completes, the `refs/heads/<oldName>` ref is gone and the
 * upstream link can no longer be looked up from it.
 */
export async function offerRenameBranchRemoteSync(
  repo: GitService,
  repoLabel: string,
  oldUpstream: { remote: string; branchName: string } | null,
  newName: string
): Promise<void> {
  if (!oldUpstream) return;

  const renameRemote = vscode.l10n.t('Rename Remote Too');
  const leaveRemote = vscode.l10n.t('Leave Remote As-Is');
  const picked = await vscode.window.showInformationMessage(
    vscode.l10n.t('[{0}]: rename the remote branch "{1}" to match?', repoLabel, `${oldUpstream.remote}/${oldUpstream.branchName}`),
    renameRemote,
    leaveRemote
  );
  if (picked !== renameRemote) return;

  try {
    await repo.pushBranch(newName, oldUpstream.remote, newName, true);
    await repo.deleteRemoteBranch(oldUpstream.remote, oldUpstream.branchName);
    const oldRef = `${oldUpstream.remote}/${oldUpstream.branchName}`;
    const newRef = `${oldUpstream.remote}/${newName}`;
    vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: renamed remote branch "{1}" → "{2}".', repoLabel, oldRef, newRef));
    logInfo(`rename-branch-remote:${repoLabel}`, `[${repoLabel}]: renamed remote branch "${oldRef}" → "${newRef}".`);
  } catch (e: unknown) {
    showGitError(`rename-branch-remote:${repoLabel}`, e);
  }
}
