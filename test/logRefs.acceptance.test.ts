// Acceptance tests for the refs the Log shows history from, against real git (#140).
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detachedWorktreeHeads, logRevisionArgs } from '../src/host/git/logRefs.ts';
import { runner } from './helpers/gitRunner.ts';

type T = { after: (fn: () => void) => void };

function tempDir(t: T): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-log-refs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function subjects(git: ReturnType<typeof runner>): Promise<string[]> {
  const out = await git(['log', '--format=%s', ...await logRevisionArgs(git)]);
  return out.split('\n').filter(Boolean).sort();
}

test('leaves out commits only reachable from refs outside branches, remotes and tags', async t => {
  const root = tempDir(t);
  const git = runner(root);
  await git(['init', '-q', '-b', 'main']);
  await git(['commit', '-q', '--allow-empty', '-m', 'base']);
  await git(['tag', 'v1']);
  await git(['switch', '-q', '-c', 'feature']);
  await git(['commit', '-q', '--allow-empty', '-m', 'on feature']);
  await git(['switch', '-q', 'main']);
  // T3 Code's checkpoints, and other tools' private refs, live in their own namespaces.
  const tree = (await git(['rev-parse', 'HEAD^{tree}'])).trim();
  const checkpoint = (await git(['commit-tree', tree, '-p', 'HEAD', '-m', 't3 checkpoint'])).trim();
  await git(['update-ref', 'refs/t3/orchestration-v2/checkpoints/1', checkpoint]);
  await git(['update-ref', 'refs/original/refs/heads/main', checkpoint]);

  assert.deepEqual(await subjects(git), ['base', 'on feature']);
});

test('keeps the detached HEAD of this worktree and of the other worktrees', async t => {
  const root = tempDir(t);
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(main);
  const git = runner(main);
  await git(['init', '-q', '-b', 'main']);
  await git(['commit', '-q', '--allow-empty', '-m', 'base']);
  await git(['worktree', 'add', '-q', '--detach', linked]);
  await runner(linked)(['commit', '-q', '--allow-empty', '-m', 'detached in linked worktree']);
  await git(['checkout', '-q', '--detach']);
  await git(['commit', '-q', '--allow-empty', '-m', 'detached here']);

  assert.deepEqual(await subjects(git), ['base', 'detached here', 'detached in linked worktree']);
});

test('an empty repository has nothing to show and no error', async t => {
  const git = runner(tempDir(t));
  await git(['init', '-q', '-b', 'main']);
  assert.deepEqual(await subjects(git), []);
});

test('parses only detached worktrees, skipping the unborn all-zero HEAD', () => {
  const porcelain = [
    'worktree /a', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
    'worktree /b', 'HEAD 2222222222222222222222222222222222222222', 'detached', '',
    'worktree /c', 'HEAD 0000000000000000000000000000000000000000', 'detached', '',
  ].join('\n');
  assert.deepEqual(detachedWorktreeHeads(porcelain), ['2222222222222222222222222222222222222222']);
});
