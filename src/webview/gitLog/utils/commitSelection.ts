import type { CommitNode } from '../../shared/types';
import type { CommitSelectionGroup, CommitSelectionMode } from '../../../host/types/messages';

/** Several commits picked together in the log — of one repo or more. */
export interface CommitSelection {
  /** Oldest first. */
  commits: CommitNode[];
  mode: CommitSelectionMode;
}

/** The revision git knows a row by: a stash's `hash` is its shifting stash@{N} ref, so use the commit's own. */
export function commitRevision(c: CommitNode): string {
  return c.isStash ? (c.stashHash ?? c.hash) : c.hash;
}

/** The selected revisions, by repo, in the order the repos first show up. */
export function selectionGroups(commits: CommitNode[]): CommitSelectionGroup[] {
  const groups = new Map<string, string[]>();
  for (const c of commits) groups.set(c.repoId, [...(groups.get(c.repoId) ?? []), commitRevision(c)]);
  return [...groups].map(([repoId, hashes]) => ({ repoId, hashes }));
}
