import type { RepoStatus } from '../shared/types';
import * as l10n from '@vscode/l10n';
import { plural } from '../shared/l10n';

/**
 * What the primary button in the commit tab should do when there is nothing to commit.
 *
 * - `publish` — at least one branch has no upstream yet
 * - `push` / `pull` — published branches that are only ahead / only behind
 * - `sync`   — published branches that are both ahead and behind (diverged, e.g. after an amend)
 * - `none`   — nothing to publish, push or pull
 */
export type SyncAction = 'publish' | 'push' | 'pull' | 'sync' | 'none';

export interface SyncState {
  action: SyncAction;
  /** Commits to push, summed across the repos the action applies to. */
  ahead: number;
  /** Commits to pull, summed across the repos the action applies to. */
  behind: number;
  /** Repos the action applies to. */
  repoIds: string[];
  label: string;
  icon: string;
}

const none = (): SyncState => ({ action: 'none', ahead: 0, behind: 0, repoIds: [], label: l10n.t('Sync Changes'), icon: 'sync' });

/**
 * Derives the publish/sync state for the commit tab from the repos it shows.
 *
 * Publishing wins over syncing: an unpublished branch has no upstream to compare against,
 * so it has to reach the remote before ahead/behind means anything.
 */
export function computeSyncState(repos: RepoStatus[]): SyncState {
  // A detached HEAD has no branch to publish or track.
  const eligible = repos.filter(r => !r.isDetachedHead);
  if (eligible.length === 0) return none();

  const unpublished = eligible.filter(r => !r.branch.upstream);
  if (unpublished.length > 0) {
    return {
      action: 'publish',
      ahead: 0,
      behind: 0,
      repoIds: unpublished.map(r => r.repoId),
      label: plural(unpublished.length, l10n.t('Publish Branch'), l10n.t('Publish {0} Branches', unpublished.length)),
      icon: 'cloud-upload',
    };
  }

  const outOfSync = eligible.filter(r => (r.branch.aheadBehind?.ahead ?? 0) > 0 || (r.branch.aheadBehind?.behind ?? 0) > 0);
  if (outOfSync.length === 0) return none();

  let ahead = 0;
  let behind = 0;
  for (const r of outOfSync) {
    ahead += r.branch.aheadBehind?.ahead ?? 0;
    behind += r.branch.aheadBehind?.behind ?? 0;
  }

  return {
    action: ahead > 0 && behind > 0 ? 'sync' : ahead > 0 ? 'push' : 'pull',
    ahead,
    behind,
    repoIds: outOfSync.map(r => r.repoId),
    label: l10n.t('Sync Changes'),
    icon: 'sync',
  };
}

/** True when any of the given repos has uncommitted work (staged or not). */
export function hasWorkingChanges(repos: RepoStatus[]): boolean {
  return repos.some(r => r.stagedFiles.length > 0 || r.unstagedFiles.length > 0);
}
