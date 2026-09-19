const PRIMARY_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'release']);

/**
 * Whether `name` (local, or remote-tracking with a "<remote>/" prefix) is the repository's
 * primary branch. When `actualDefault` is known (the remote's real default branch, e.g. from
 * `GitService.getRemoteDefaultBranch`), it's the only source of truth — this correctly tells
 * "main" from "master" when both exist, unlike the naming heuristic. Without it, falls back
 * to a naming heuristic over common default-branch names.
 */
export function isPrimaryBranch(name: string, actualDefault?: string): boolean {
  const base = name.replace(/^[^/]+\//, '');
  if (actualDefault) return base === actualDefault;
  return PRIMARY_BRANCHES.has(base.toLowerCase());
}
