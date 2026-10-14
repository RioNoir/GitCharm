import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { isGitEnvKey, parseEnv } from '@simple-git/argv-parser';

// Git localizes its human-readable output via gettext, but we parse that output as English
// (e.g. "3 files changed", "ahead 2", "Your local changes…"), so a user with git in another
// language would get empty stats and missed conflict detection. Pin the locale the same way
// VS Code's built-in git extension does.
const GIT_ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  LC_ALL: 'en_US.UTF-8',
  LANG: 'en_US.UTF-8',
  // Read-only commands like `git status` otherwise rewrite .git/index to refresh its stat
  // cache. That write is a change event for every index watcher (ours and VS Code's), which
  // schedules another status run — in a workspace with many submodules, a refresh that keeps
  // feeding itself. Only optional locks are skipped; commands that modify the repo still lock.
  GIT_OPTIONAL_LOCKS: '0',
  // There's no terminal to prompt on: without this, a remote that needs credentials no
  // credential helper has fails with "could not read Username …: Device not configured".
  GIT_TERMINAL_PROMPT: '0',
};

// simple-git guards the variables that change what git runs (GIT_*, EDITOR, PAGER, SSH_ASKPASS…):
// passed through .env(), each one makes every command throw unless it's named in allowEnvironment
// and the unsafe category it falls under is allowed. GIT_ENV is the user's own environment — what git
// gets from a terminal, e.g. a GIT_SSH_COMMAND picking an SSH key — plus our own GIT_* settings, so
// allow exactly the variables it holds and the categories they trigger: git sees the same environment
// as before simple-git 4, while its checks on the command's arguments stay on.
const GUARDED_ENV_KEYS = Object.keys(GIT_ENV).filter(key => {
  const normalized = key.toLowerCase().trim();
  return normalized.startsWith('git_') || isGitEnvKey(normalized);
});
const INHERITED_ENV_ALLOWANCES: Partial<SimpleGitOptions['unsafe']> = Object.fromEntries(
  parseEnv(GIT_ENV).vulnerabilities.map(v => [v.category, true]),
);

export function createGit(baseDir?: string, options: Partial<SimpleGitOptions> = {}): SimpleGit {
  const git = simpleGit({
    ...options,
    ...(baseDir !== undefined ? { baseDir } : {}),
    // By default git prints non-ASCII paths quoted and octal-escaped ("\350\257\264.txt"),
    // which breaks every path we parse from status/diff/log output for CJK or accented names.
    //
    // diff.ignoreSubmodules=dirty: `git status` in a superproject otherwise runs a status in
    // every submodule, recursively, to report ones with uncommitted changes — 45 git
    // processes and seconds per call in a repo with 44 submodules, against ~150ms without.
    // A submodule whose checked-out commit moved is still reported; its uncommitted changes
    // show in its own entry, as GitCharm lists every submodule as a repository.
    config: ['core.quotePath=false', 'diff.ignoreSubmodules=dirty', ...(options.config ?? [])],
    unsafe: { ...INHERITED_ENV_ALLOWANCES, ...options.unsafe },
    allowEnvironment: [...GUARDED_ENV_KEYS, ...(options.allowEnvironment ?? [])],
  });
  return git.env(GIT_ENV);
}
