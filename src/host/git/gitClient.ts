import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import { parseEnv } from '@simple-git/argv-parser';

// Git localizes its human-readable output via gettext, but we parse that output as English
// (e.g. "3 files changed", "ahead 2", "Your local changes…"), so a user with git in another
// language would get empty stats and missed conflict detection. Pin the locale the same way
// VS Code's built-in git extension does.
const GIT_ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  LC_ALL: 'en_US.UTF-8',
  LANG: 'en_US.UTF-8',
};

// simple-git vets any env passed via .env() and rejects variables like GIT_SSH_COMMAND or
// GIT_ASKPASS unless the matching unsafe flag is set. Without .env() the child inherited
// process.env unchecked, so allow exactly the categories our own environment triggers —
// keeping parity with before while every other safety check stays on.
const INHERITED_ENV_ALLOWANCES: Partial<SimpleGitOptions['unsafe']> = Object.fromEntries(
  parseEnv(GIT_ENV).vulnerabilities.map(v => [v.category, true]),
);

export function createGit(baseDir?: string, options: Partial<SimpleGitOptions> = {}): SimpleGit {
  const git = simpleGit({
    ...options,
    ...(baseDir !== undefined ? { baseDir } : {}),
    // By default git prints non-ASCII paths quoted and octal-escaped ("\350\257\264.txt"),
    // which breaks every path we parse from status/diff/log output for CJK or accented names.
    config: ['core.quotePath=false', ...(options.config ?? [])],
    unsafe: { ...INHERITED_ENV_ALLOWANCES, ...options.unsafe },
  });
  return git.env(GIT_ENV);
}
