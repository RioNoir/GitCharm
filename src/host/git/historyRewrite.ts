import type { RebasePlanEntry } from '../types/messages';

// Squashing and dropping a selection of commits that need not reach HEAD, nor be adjacent: the history from the
// oldest selected commit up to HEAD is replayed by an interactive rebase, the selected commits squashed or
// dropped and every other commit picked as it was. (Resetting to the oldest selected commit's parent would
// squash or drop every commit after it as well, selected or not — issue #123.)
//
// Kept free of vscode and simple-git so it runs, with real git, under the acceptance tests in test/.

/** Runs git with these arguments in the repository and resolves to its stdout. */
export type GitRunner = (args: string[]) => Promise<string>;

/** The commits a rewrite replays, oldest first, and the commit it replays them onto (null: from the root). */
export interface RewriteRange {
  upstream: string | null;
  history: string[];
}

export interface SquashGroup {
  /** Adjacent commits, oldest first. */
  hashes: string[];
  message: string;
}

/** A rewrite ready for an interactive rebase: the plan replays `history` onto `upstream`. */
export interface Rewrite {
  upstream: string | null;
  plan: RebasePlanEntry[];
}

/**
 * The linear history from the oldest of `hashes` up to HEAD. Throws when one of them is not a commit HEAD
 * contains, or when a merge commit lies between them and HEAD: an interactive rebase would flatten it.
 */
export async function readRewriteRange(git: GitRunner, hashes: readonly string[]): Promise<RewriteRange> {
  if (hashes.length === 0) throw new Error('No commits selected');
  const selected = await resolveCommits(git, hashes);
  for (const hash of selected) {
    const contained = await git(['merge-base', '--is-ancestor', hash, 'HEAD']).then(() => true, () => false);
    if (!contained) throw new Error(`Commit ${hash.slice(0, 8)} is not on the current branch`);
  }
  // The oldest selected commit: in a linear history, the merge base of the selection (checked below).
  // Replayed from its parent on, or from the root when it has none.
  const oldest = (await git(['merge-base', '--octopus', ...selected])).trim();
  const parents = (await git(['rev-list', '--parents', '-n', '1', oldest])).trim().split(/\s+/).slice(1);
  const out = await git(['rev-list', '--reverse', '--topo-order', '--parents', 'HEAD', ...(parents.length > 0 ? ['--not', ...parents] : []), '--']);
  const rows = out.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split(/\s+/));
  const merge = rows.find(r => r.length > 2);
  if (merge) throw new Error(`Commit ${merge[0].slice(0, 8)} is a merge: the commits around it can't be rewritten without flattening it`);
  const history: string[] = [];
  let upstream: string | null = null;
  for (const [hash, ...ps] of rows) {
    if (history.length === 0) upstream = ps[0] ?? null;
    else if (ps[0] !== history[history.length - 1]) throw new Error('The history to rewrite is not linear');
    history.push(hash);
  }
  for (const hash of selected) if (!history.includes(hash)) throw new Error(`Commit ${hash.slice(0, 8)} is not on the current branch`);
  return { upstream, history };
}

/**
 * The selected commits in runs of adjacent commits of `history` (oldest first), oldest run first. A run of
 * one commit has nothing to squash; `squashGroups` leaves those out.
 */
export function selectionRuns(history: readonly string[], selected: ReadonlySet<string>): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  for (const hash of history) {
    if (selected.has(hash)) { run.push(hash); continue; }
    if (run.length > 0) runs.push(run);
    run = [];
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** The runs of the selection that a squash turns into one commit each: those of two commits or more. */
export function squashGroups(history: readonly string[], selected: ReadonlySet<string>): string[][] {
  return selectionRuns(history, selected).filter(run => run.length > 1);
}

/** The plan of a squash: each group folded into its oldest commit with the group's message, the rest picked. */
export function squashPlan(history: readonly string[], groups: readonly SquashGroup[]): RebasePlanEntry[] {
  const heads = new Map<string, string>();
  const members = new Set<string>();
  for (const group of groups) {
    if (group.hashes.length < 2) throw new Error('A squash needs two commits or more');
    const start = history.indexOf(group.hashes[0]);
    if (start < 0 || group.hashes.some((h, i) => history[start + i] !== h)) throw new Error('The commits of a squash must be adjacent');
    heads.set(group.hashes[0], group.message);
    for (const hash of group.hashes.slice(1)) members.add(hash);
  }
  return history.map((hash): RebasePlanEntry => {
    if (heads.has(hash)) return { hash, action: 'pick', message: heads.get(hash) };
    if (members.has(hash)) return { hash, action: 'squash' };
    return { hash, action: 'pick' };
  });
}

/** The plan of a drop: the selected commits dropped, the rest picked. */
export function dropPlan(history: readonly string[], selected: ReadonlySet<string>): RebasePlanEntry[] {
  return history.map((hash): RebasePlanEntry => ({ hash, action: selected.has(hash) ? 'drop' : 'pick' }));
}

/** The groups of adjacent commits that squashing `hashes` makes, oldest first, each oldest first. */
export async function readSquashGroups(git: GitRunner, hashes: readonly string[]): Promise<string[][]> {
  const { history } = await readRewriteRange(git, hashes);
  return squashGroups(history, new Set(await resolveCommits(git, hashes)));
}

/** The rewrite that squashes each group into one commit with its message. */
export async function planSquash(git: GitRunner, groups: readonly SquashGroup[]): Promise<Rewrite> {
  const resolved: SquashGroup[] = [];
  for (const group of groups) resolved.push({ hashes: await resolveCommits(git, group.hashes), message: group.message });
  const { upstream, history } = await readRewriteRange(git, resolved.flatMap(g => g.hashes));
  // In history order, whatever order they were selected in; squashPlan checks each group is still adjacent.
  for (const group of resolved) group.hashes = history.filter(h => group.hashes.includes(h));
  return { upstream, plan: squashPlan(history, resolved) };
}

/** The rewrite that drops `hashes`. */
export async function planDrop(git: GitRunner, hashes: readonly string[]): Promise<Rewrite> {
  const { upstream, history } = await readRewriteRange(git, hashes);
  return { upstream, plan: dropPlan(history, new Set(await resolveCommits(git, hashes))) };
}

async function resolveCommits(git: GitRunner, hashes: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const hash of hashes) {
    // `--end-of-options` keeps a selection from ever being read as an option.
    const full = (await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${hash}^{commit}`]).catch(() => '')).trim();
    if (!full) throw new Error(`Unknown commit ${hash}`);
    if (!out.includes(full)) out.push(full);
  }
  return out;
}
