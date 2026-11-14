import type { GitRunner } from './historyRewrite';

// Deleting the local branch of a merged pull request without losing work. After a squash or rebase merge the
// branch's commits are not in the target branch, so `git branch -d` refuses: the branch is deleted with -D, but
// only when each of its commits is already somewhere safe — the pull request's head, or a remote branch.
//
// Kept free of vscode and simple-git so it runs, with real git, under the acceptance tests in test/.

export interface LocalBranchState {
  branch: string;
  /** Checked out in the worktree git runs in: the target branch is checked out first. */
  checkedOut: boolean;
  /** Another worktree that has the branch checked out: it can't be deleted from here. */
  otherWorktree?: string;
  /** Every commit of the branch is in one of the commits it was checked against: deleting it loses nothing. */
  safe: boolean;
}

export type LocalBranchNotDeletedReason = 'unsafe' | 'otherWorktree' | 'dirty' | 'noTarget';

export class LocalBranchNotDeleted extends Error {
  // A plain field, not a parameter property: the tests run this file by stripping its types.
  readonly reason: LocalBranchNotDeletedReason;
  constructor(reason: LocalBranchNotDeletedReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * The local branch of a pull request's source branch `remote/branch`: the one tracking it, else the one GitCharm's
 * checkout of the pull request made (pr/<author>/<number>), else the one with its name. For a fork's pull request
 * the source branch is not on `remote`, and a branch of the same name is the user's own (a fork's "main"): only
 * the checkout of the pull request counts.
 */
export async function findLocalBranch(
  git: GitRunner,
  remote: string,
  branch: string,
  { prNumber, fork = false }: { prNumber?: number; fork?: boolean } = {},
): Promise<string | undefined> {
  const out = await git(['for-each-ref', '--format=%(refname:short)%00%(upstream)', 'refs/heads/']);
  const rows = out.split('\n').filter(Boolean).map(l => l.split('\0'));
  // %(upstream) is read from the branch's config, so it is still there once the remote branch is gone.
  const tracking = fork ? undefined : rows.find(([, upstream]) => upstream === `refs/remotes/${remote}/${branch}`);
  if (tracking) return tracking[0];
  if (prNumber !== undefined) {
    const checkout = rows.find(([name]) => new RegExp(`^pr/[^/]+/${prNumber}$`).test(name));
    if (checkout) return checkout[0];
  }
  return fork ? undefined : rows.find(([name]) => name === branch)?.[0];
}

export async function hasRemoteBranch(git: GitRunner, remote: string, branch: string): Promise<boolean> {
  return (await resolve(git, `refs/remotes/${remote}/${branch}`)) !== undefined;
}

/**
 * Where `branch` is checked out, and whether it is safe to delete: its tip is in one of `keep` (commits or refs,
 * e.g. the pull request's head and the remote branches) — those that don't exist locally are skipped.
 */
export async function inspectLocalBranch(git: GitRunner, branch: string, keep: readonly string[]): Promise<LocalBranchState> {
  const tip = await resolve(git, `refs/heads/${branch}`);
  if (!tip) throw new Error(`Branch ${branch} does not exist`);
  let safe = false;
  for (const ref of keep) {
    const commit = await resolve(git, ref);
    if (commit && await git(['merge-base', '--is-ancestor', tip, commit]).then(() => true, () => false)) { safe = true; break; }
  }
  const here = (await git(['rev-parse', '--show-toplevel'])).trim();
  let checkedOut = false;
  let otherWorktree: string | undefined;
  for (const { path, head } of parseWorktrees(await git(['worktree', 'list', '--porcelain']))) {
    if (head !== `refs/heads/${branch}`) continue;
    if (samePath(path, here)) checkedOut = true;
    else otherWorktree = path;
  }
  return { branch, checkedOut, otherWorktree, safe };
}

/**
 * Deletes the branch `inspectLocalBranch` found safe to delete. When it is checked out, the target branch is
 * checked out first — brought up to date with `remote/targetBranch` when it can fast-forward — so uncommitted
 * changes to tracked files stop it. Resolves to the branch checked out instead, if any.
 */
export async function deleteLocalBranch(
  git: GitRunner,
  state: LocalBranchState,
  { remote, targetBranch }: { remote: string; targetBranch: string },
): Promise<{ checkedOut?: string }> {
  if (!state.safe) throw new LocalBranchNotDeleted('unsafe', `Branch ${state.branch} has commits that are not in the pull request`);
  if (state.otherWorktree) throw new LocalBranchNotDeleted('otherWorktree', `Branch ${state.branch} is checked out in ${state.otherWorktree}`);
  let checkedOut: string | undefined;
  if (state.checkedOut) {
    if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim()) {
      throw new LocalBranchNotDeleted('dirty', `Branch ${state.branch} is checked out with uncommitted changes`);
    }
    const remoteTarget = `refs/remotes/${remote}/${targetBranch}`;
    if (await resolve(git, `refs/heads/${targetBranch}`)) {
      await git(['switch', targetBranch]);
      // Up to date when it can be; a target branch with commits of its own is left as it is.
      if (await resolve(git, remoteTarget)) await git(['merge', '--ff-only', '--quiet', remoteTarget]).catch(() => undefined);
    } else if (await resolve(git, remoteTarget)) {
      await git(['switch', '--track', '-c', targetBranch, `${remote}/${targetBranch}`]);
    } else {
      throw new LocalBranchNotDeleted('noTarget', `Branch ${state.branch} is checked out and ${targetBranch} can't be checked out instead`);
    }
    checkedOut = targetBranch;
  }
  // -D: after a squash or rebase merge -d refuses, though `safe` says every commit is kept elsewhere.
  await git(['branch', '-D', state.branch]);
  return { checkedOut };
}

/** Drops the remote-tracking branch of a branch deleted on the remote, without a fetch. */
export async function dropRemoteTrackingBranch(git: GitRunner, remote: string, branch: string): Promise<void> {
  await git(['branch', '--delete', '--remotes', `${remote}/${branch}`]).catch(() => undefined);
}

async function resolve(git: GitRunner, ref: string): Promise<string | undefined> {
  const out = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).catch(() => '');
  return out.trim() || undefined;
}

function parseWorktrees(out: string): { path: string; head?: string }[] {
  return out.split('\n\n').map(block => {
    const lines = block.split('\n');
    return {
      path: lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length) ?? '',
      head: lines.find(l => l.startsWith('branch '))?.slice('branch '.length),
    };
  }).filter(w => w.path);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths compare without case.
  return /^[a-z]:/i.test(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
