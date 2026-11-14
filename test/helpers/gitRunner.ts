// Runs git for the acceptance tests, isolated from the user's own git config.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitRunner } from '../../src/host/git/historyRewrite.ts';

/** A GitRunner for the repository (or the directory) at `dir`. */
export function runner(dir: string): GitRunner {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-home-'));
  const env = {
    ...process.env,
    // The user's own git config (signing, hooks, a default editor) must not change what the tests see.
    HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    LC_ALL: 'C',
  };
  return args => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, env, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { message: `git ${args.join(' ')}: ${stderr || err.message}` }));
      else resolve(stdout);
    });
  });
}
