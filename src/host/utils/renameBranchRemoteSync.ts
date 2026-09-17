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

  const renameRemote = 'Rename Remote Too';
  const leaveRemote = 'Leave Remote As-Is';
  const picked = await vscode.window.showInformationMessage(
    `[${repoLabel}]: rename the remote branch "${oldUpstream.remote}/${oldUpstream.branchName}" to match?`,
    renameRemote,
    leaveRemote
  );
  if (picked !== renameRemote) return;

  try {
    await repo.pushBranch(newName, oldUpstream.remote, newName, true);
    await repo.deleteRemoteBranch(oldUpstream.remote, oldUpstream.branchName);
    const msg = `[${repoLabel}]: renamed remote branch "${oldUpstream.remote}/${oldUpstream.branchName}" → "${oldUpstream.remote}/${newName}".`;
    vscode.window.showInformationMessage(msg);
    logInfo(`rename-branch-remote:${repoLabel}`, msg);
  } catch (e: unknown) {
    showGitError(`rename-branch-remote:${repoLabel}`, e);
  }
}
