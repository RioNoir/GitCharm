import type { GitRunner } from './historyRewrite';

// Which refs the Log shows history from. `git log --all` walks every ref under refs/, and tools
// keep their own there: T3 Code's checkpoints (refs/t3/…), `git maintenance` prefetch refs,
// filter-branch backups (refs/original/…), notes. Their commits flooded the log (#140). The Log
// shows branches, remote branches and tags — what JetBrains IDEs show — plus every detached HEAD,
// which `--all` covered: this worktree's and the other worktrees'.
//
// Kept free of vscode and simple-git so it runs, with real git, under the acceptance tests in test/.

/** The ref namespaces the Log shows and watches: a change elsewhere under refs/ can't alter it. */
export const LOG_REF_NAMESPACES = ['refs/heads/', 'refs/remotes/', 'refs/tags/'] as const;

/** The commits of every worktree's detached HEAD (this one's included), from `git worktree list --porcelain`. */
export function detachedWorktreeHeads(porcelain: string): string[] {
  const heads = new Set<string>();
  for (const block of porcelain.trim().split(/\n\n+/)) {
    const lines = block.split('\n');
    if (!lines.includes('detached')) continue;
    const head = lines.find(line => line.startsWith('HEAD '))?.slice(5).trim();
    if (head && /^[0-9a-f]{40,64}$/.test(head) && !/^0+$/.test(head)) heads.add(head);
  }
  return Array.from(heads);
}

/** The revisions `git log` starts from for the unfiltered Log. */
export async function logRevisionArgs(git: GitRunner): Promise<string[]> {
  const porcelain = await git(['worktree', 'list', '--porcelain']).catch(() => '');
  return ['--branches', '--remotes', '--tags', ...detachedWorktreeHeads(porcelain)];
}
