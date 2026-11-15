import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitRunner } from '../git/historyRewrite';
import {
  deleteLocalBranch, dropRemoteTrackingBranch, findLocalBranch, hasRemoteBranch, inspectLocalBranch, LocalBranchNotDeleted,
  type LocalBranchState,
} from '../git/branchCleanup';
import { isProtectedBranch } from '../utils/protectedBranches';
import { formatGitError } from '../utils/gitErrorUtils';
import { logInfo, logWarn } from '../utils/Logger';
import type { PullRequestManager } from './PullRequestManager';
import type { PullRequestSummary } from './types';

type Choice = 'localAndRemote' | 'remote' | 'local';
type Setting = 'ask' | Choice | 'never';
export type BranchCleanupChoice = Choice | 'never';

/**
 * After a pull request is merged through the forge: fetches, so the remote-tracking branches catch up, then deletes
 * the pull request's source branch — locally, on the remote or both — as gitcharm.pullRequests.deleteBranchAfterMerge
 * says, asking when it says so. Only what exists is offered: no remote branch for a fork's pull request, nor once
 * the forge has deleted it; no local branch unless there is one. Protected branches and the default branch are kept.
 */
export async function cleanUpAfterMerge(
  manager: WorkspaceGitManager,
  pullRequestManager: PullRequestManager,
  repoId: string,
  pr: PullRequestSummary,
  /** Made by the caller (an MCP tool) instead of the setting: nothing is asked. */
  choiceOverride?: BranchCleanupChoice,
): Promise<string[]> {
  const setting: Setting = choiceOverride ?? vscode.workspace.getConfiguration('gitcharm.pullRequests').get<Setting>('deleteBranchAfterMerge', 'ask');
  const repo = manager.getRepo(repoId);
  const remote = repo && setting !== 'never' ? await pullRequestManager.getPullRequestRemote(repoId) : undefined;
  const fork = !!pr.sourceRepoFullName;
  // A fork's branch names say nothing about this repository's protected branches.
  if (!repo || !remote || setting === 'never' || (!fork && isProtectedBranch(pr.sourceBranch))) {
    await manager.fetchAll();
    return [];
  }
  const git: GitRunner = args => repo.run(args);

  const found = await findLocalBranch(git, remote, pr.sourceBranch, { prNumber: pr.number, fork }).catch(() => undefined);
  const localBranch = found && found !== pr.targetBranch && !isProtectedBranch(found) ? found : undefined;
  // This asks about the branch: the orphaned-branch notification must not as well once its remote branch is gone.
  if (localBranch) manager.ignoreOrphanBranch(repoId, localBranch);
  await manager.fetchAll();

  // The repository's default branch stays, protected or not (e.g. a pull request from develop… into a release branch).
  const defaultBranch = (await git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim();
  if (!fork && defaultBranch === `${remote}/${pr.sourceBranch}`) return [];
  const remoteBranch = !fork && await hasRemoteBranch(git, remote, pr.sourceBranch).catch(() => false);

  const available: Choice[] = [];
  if (remoteBranch && localBranch) available.push('localAndRemote');
  if (remoteBranch) available.push('remote');
  if (localBranch) available.push('local');
  if (available.length === 0) return [];

  const choice = setting === 'ask'
    ? await askChoice(pr, available, localBranch, `${remote}/${pr.sourceBranch}`)
    : narrowChoice(setting, available);
  if (!choice) return [];
  const deleteRemote = choice !== 'local';
  const deleteLocal = choice !== 'remote' && !!localBranch;

  // Checked before the remote branch goes: the commits it holds only count as kept while it stays.
  let localState: LocalBranchState | undefined;
  const messages: string[] = [];
  const problems: string[] = [];
  if (deleteLocal && localBranch) {
    // The head the pull request was merged at: the summary the panel opened with may be older.
    const headSha = await pullRequestManager.getPullRequestDetail(repoId, pr.number)
      .then(d => ('error' in d ? undefined : d.headSha), () => undefined) ?? pr.headSha;
    const keep = [
      ...(headSha ? [headSha] : []),
      ...(deleteRemote ? [] : [`refs/remotes/${remote}/${pr.sourceBranch}`]),
      `refs/remotes/${remote}/${pr.targetBranch}`,
    ];
    try {
      localState = await inspectLocalBranch(git, localBranch, keep);
    } catch (e: unknown) {
      problems.push(vscode.l10n.t('Could not delete the local branch "{0}": {1}', localBranch, formatGitError(e)));
    }
  }

  if (deleteRemote) {
    const result = await pullRequestManager.deleteRemoteBranch(repoId, pr.sourceBranch);
    if (result.ok) {
      await dropRemoteTrackingBranch(git, remote, pr.sourceBranch);
      messages.push(vscode.l10n.t('Deleted the remote branch "{0}".', `${remote}/${pr.sourceBranch}`));
    } else {
      problems.push(vscode.l10n.t('Could not delete the remote branch "{0}": {1}', `${remote}/${pr.sourceBranch}`, result.error ?? ''));
    }
  }

  if (localState) {
    try {
      const { checkedOut } = await deleteLocalBranch(git, localState, { remote, targetBranch: pr.targetBranch });
      messages.push(checkedOut
        ? vscode.l10n.t('Deleted the local branch "{0}" and checked out "{1}".', localState.branch, checkedOut)
        : vscode.l10n.t('Deleted the local branch "{0}".', localState.branch));
    } catch (e: unknown) {
      problems.push(keptMessage(localState, pr.targetBranch, e));
    }
  }

  void manager.getAllStatusesFresh();
  if (messages.length > 0) logInfo('pullrequest-delete-branch', messages.join(' '));
  if (problems.length > 0) logWarn('pullrequest-delete-branch', problems.join(' '));
  // An MCP tool reports the outcome to its agent itself.
  if (!choiceOverride) {
    if (problems.length > 0) void vscode.window.showWarningMessage([...messages, ...problems].join(' '));
    else void vscode.window.showInformationMessage(messages.join(' '));
  }
  return [...messages, ...problems];
}

async function askChoice(pr: PullRequestSummary, available: Choice[], localBranch: string | undefined, remoteBranch: string): Promise<Choice | undefined> {
  type Item = vscode.QuickPickItem & { choice?: Choice };
  const items: Item[] = available.map(choice => {
    switch (choice) {
      case 'localAndRemote': return {
        choice, label: `$(trash) ${vscode.l10n.t('Delete local and remote branch')}`, description: `${localBranch} · ${remoteBranch}`,
      };
      case 'remote': return { choice, label: `$(cloud) ${vscode.l10n.t('Delete remote branch only')}`, description: remoteBranch };
      case 'local': return { choice, label: `$(device-desktop) ${vscode.l10n.t('Delete local branch only')}`, description: localBranch };
    }
  });
  items.push({ label: `$(close) ${vscode.l10n.t('Keep the branch')}` });
  // The first item is preselected: local and remote when both exist.
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Pull request #{0} merged — delete its branch?', pr.number),
    placeHolder: vscode.l10n.t('To stop asking, choose what to do in the setting {0}', 'gitcharm.pullRequests.deleteBranchAfterMerge'),
    ignoreFocusOut: true,
  });
  return picked?.choice;
}

/** The setting's choice, as far as it applies: both branches when only one exists, the one there is. */
function narrowChoice(setting: Choice, available: Choice[]): Choice | undefined {
  if (available.includes(setting)) return setting;
  if (setting === 'localAndRemote') return available.find(c => c === 'remote' || c === 'local');
  return undefined;
}

function keptMessage(state: LocalBranchState, targetBranch: string, e: unknown): string {
  if (!(e instanceof LocalBranchNotDeleted)) return vscode.l10n.t('Could not delete the local branch "{0}": {1}', state.branch, formatGitError(e));
  switch (e.reason) {
    case 'unsafe': return vscode.l10n.t('Kept the local branch "{0}": it has commits that are not in the pull request.', state.branch);
    case 'otherWorktree': return vscode.l10n.t('Kept the local branch "{0}": it is checked out in another worktree ({1}).', state.branch, state.otherWorktree ?? '');
    case 'dirty': return vscode.l10n.t('Kept the local branch "{0}": it is checked out and has uncommitted changes.', state.branch);
    case 'noTarget': return vscode.l10n.t('Kept the local branch "{0}": it is checked out and "{1}" could not be checked out instead.', state.branch, targetBranch);
  }
}
