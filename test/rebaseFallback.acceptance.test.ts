// Cursor's git extension API repository has no rebase method (issue #141). GitCharm must
// still rebase, through git, when that method is missing — and keep using it when it exists.
//
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';
import { GITCHARM_API_REPOS } from './helpers/vscodeRebaseStub.ts';
import { runner } from './helpers/gitRunner.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-rebase-home-'));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

interface ApiRepo {
  rootUri: { fsPath: string };
  state: {
    HEAD?: { name?: string; upstream?: { remote: string; name: string } };
    remotes: { name: string }[];
  };
  fetch: () => Promise<void>;
  status: () => Promise<void>;
  rebase?: (branch: string) => Promise<void>;
}

let api: {
  rebase: (root: string, onto: string) => Promise<void>;
  pullRebase: (root: string) => Promise<string>;
};
let bundle = '';

before(async () => {
  bundle = path.join(os.tmpdir(), `gitcharm-rebase-fallback-${process.pid}.cjs`);
  const here = path.dirname(fileURLToPath(import.meta.url));
  await esbuild.build({
    absWorkingDir: path.resolve(here, '..'),
    entryPoints: [path.join(here, 'helpers/rebaseFallbackEntry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    alias: { vscode: path.join(here, 'helpers/vscodeRebaseStub.ts') },
    logLevel: 'silent',
  });
  api = createRequire(import.meta.url)(bundle);
});

after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function useApiRepo(dir: string, repo: Omit<ApiRepo, 'rootUri' | 'status'> & { status?: ApiRepo['status'] }): void {
  const full: ApiRepo = { status: async () => undefined, ...repo, rootUri: { fsPath: dir } };
  const g = globalThis as Record<string, Map<string, ApiRepo> | undefined>;
  const repos = g[GITCHARM_API_REPOS] ?? new Map<string, ApiRepo>();
  repos.set(dir, full);
  g[GITCHARM_API_REPOS] = repos;
}

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-rebase-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    (globalThis as Record<string, Map<string, ApiRepo> | undefined>)[GITCHARM_API_REPOS]?.delete(dir);
  });
  return dir;
}

async function commit(dir: string, name: string): Promise<void> {
  fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  const git = runner(dir);
  await git(['add', `${name}.txt`]);
  await git(['commit', '-q', '-m', name]);
}

async function subjects(dir: string): Promise<string> {
  return (await runner(dir)(['log', '--reverse', '--format=%s'])).trim().split('\n').join('|');
}

/** main is a|c, feature (checked out) is a|b. Rebase onto main should yield a|c|b. */
async function fork(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = scratch(t);
  const git = runner(dir);
  await git(['init', '-q', '-b', 'main']);
  await commit(dir, 'a');
  await git(['checkout', '-q', '-b', 'feature']);
  await commit(dir, 'b');
  await git(['checkout', '-q', 'main']);
  await commit(dir, 'c');
  await git(['checkout', '-q', 'feature']);
  return dir;
}

test('rebase uses the VS Code API when that repository implements rebase', async (t) => {
  const dir = await fork(t);
  const calls: string[] = [];
  useApiRepo(dir, {
    state: { HEAD: { name: 'feature' }, remotes: [] },
    fetch: async () => undefined,
    rebase: async (onto) => { calls.push(onto); },
  });
  await api.rebase(dir, 'main');
  assert.deepEqual(calls, ['main']);
  assert.equal(await subjects(dir), 'a|b');
});

test('rebase falls back to git when the VS Code API repository has no rebase', async (t) => {
  const dir = await fork(t);
  useApiRepo(dir, {
    state: { HEAD: { name: 'feature' }, remotes: [] },
    fetch: async () => undefined,
  });
  await api.rebase(dir, 'main');
  assert.equal(await subjects(dir), 'a|c|b');
});

test('rebase keeps staged changes instead of refusing to start', async (t) => {
  const dir = await fork(t);
  useApiRepo(dir, {
    state: { HEAD: { name: 'feature' }, remotes: [] },
    fetch: async () => undefined,
  });
  const git = runner(dir);
  fs.writeFileSync(path.join(dir, 'wip.txt'), 'wip\n');
  await git(['add', 'wip.txt']);
  fs.appendFileSync(path.join(dir, 'b.txt'), 'local\n');
  await api.rebase(dir, 'main');
  assert.equal(await subjects(dir), 'a|c|b');
  const status = (await git(['status', '--porcelain'])).replace(/\n$/, '').split('\n').filter(line => line !== '').sort();
  assert.deepEqual(status, [' M b.txt', 'A  wip.txt']);
  assert.equal((await git(['stash', 'list'])).trim(), '');
});

test('pull rebase fetches through the API and rebases with git when rebase is missing', async (t) => {
  const root = scratch(t);
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  await runner(root)(['init', '--bare', '-q', '-b', 'main', bare]);
  await runner(root)(['clone', '-q', bare, work]);
  await commit(work, 'base');
  await runner(work)(['push', '-q', '-u', 'origin', 'main']);
  await commit(work, 'local');
  await runner(root)(['clone', '-q', bare, other]);
  await commit(other, 'remote');
  await runner(other)(['push', '-q', 'origin', 'main']);

  let fetched = false;
  useApiRepo(work, {
    state: { HEAD: { name: 'main', upstream: { remote: 'origin', name: 'main' } }, remotes: [{ name: 'origin' }] },
    fetch: async () => { fetched = true; await runner(work)(['fetch', '-q']); },
  });
  assert.equal(await api.pullRebase(work), 'pulled (rebase)');
  assert.equal(fetched, true);
  assert.equal(await subjects(work), 'base|remote|local');
});

test('pull rebase keeps the API rebase when the repository implements it', async (t) => {
  const dir = scratch(t);
  await runner(dir)(['init', '-q', '-b', 'main']);
  await commit(dir, 'base');
  const calls: string[] = [];
  let fetched = false;
  useApiRepo(dir, {
    state: { HEAD: { name: 'main', upstream: { remote: 'origin', name: 'main' } }, remotes: [{ name: 'origin' }] },
    fetch: async () => { fetched = true; },
    rebase: async (onto) => { calls.push(onto); },
  });
  assert.equal(await api.pullRebase(dir), 'pulled (rebase)');
  assert.equal(fetched, true);
  assert.deepEqual(calls, ['origin/main']);
  assert.equal(await subjects(dir), 'base');
});
