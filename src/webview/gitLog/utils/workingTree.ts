import * as l10n from '@vscode/l10n';
import type { CommitNode } from '../../shared/types';

/**
 * Builds a repo's "Uncommitted Changes" row. Its only parent is HEAD, so the graph
 * layout draws it as the tip of the checked-out branch. The hash never collides with
 * a real one (it isn't hex) and is unique per repo, since rows are keyed by hash.
 */
export function workingTreeRow(
  repoId: string,
  fileCount: number,
  headHash: string | undefined,
  branch: string | undefined,
  author?: { gitName: string; gitEmail: string },
): CommitNode {
  // The changes have no date of their own: they are shown as of now
  const now = new Date().toISOString();
  return {
    hash: `working-tree:${repoId}`,
    shortHash: '*',
    repoId,
    message: l10n.t('Uncommitted Changes ({0})', fileCount),
    authorName: author?.gitName ?? l10n.t('You'),
    authorEmail: author?.gitEmail ?? '',
    authorDate: now,
    committerDate: now,
    parents: headHash ? [headHash] : [],
    refs: [],
    isWorkingTree: true,
    workingTreeBranch: branch,
  };
}

/**
 * Puts each working-tree row directly above the first row of its repo, which keeps it
 * above HEAD (so the graph stays topologically ordered) and inside its repo's block in
 * a multi-repo log. A repo with no rows yet — no commits at all — gets it at the top.
 */
export function insertWorkingTreeRows(list: CommitNode[], rows: CommitNode[]): CommitNode[] {
  if (rows.length === 0) return list;
  const out = [...list];
  for (const row of rows) {
    const at = out.findIndex(c => c.repoId === row.repoId);
    out.splice(at < 0 ? 0 : at, 0, row);
  }
  return out;
}
