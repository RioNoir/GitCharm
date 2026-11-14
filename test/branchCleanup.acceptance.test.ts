// Acceptance tests for deleting the local branch of a merged pull request, against real git.
//
//   npm test
//
// Each test clones a bare "remote" holding main and a pushed feature branch `feat`, the pull request's
// source. Merges are done the way a forge does them: on the remote's main, then fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitRunner } from '../src/host/git/historyRewrite.ts';
import {
  deleteLocalBranch, dropRemoteTrackingBranch, findLocalBranch, hasRemoteBranch, inspectLocalBranch, LocalBranchNotDeleted,
} from '../src/host/git/branchCleanup.ts';
import { runner } from './helpers/gitRunner.ts';

interface Clone {
  dir: string;
  git: GitRunner;
  /** Runs git in the bare remote. */
  remote: GitRunner;
  /** The head of the pull request: feat's tip as pushed. */
  headSha: string;
}

type T = { after: (fn: () => void) => void };

async function setup(t: T): Promise<Clone> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remoteDir = path.join(root, 'remote.git');
  const dir = path.join(root, 'clone');
  const remote = runner(root);
  await remote(['init', '-q', '--bare', '-b', 'main', remoteDir]);
  await remote(['clone', '-q', remoteDir, dir]);
  const git = runner(dir);
  await commit(git, dir, 'base');
  await git(['push', '-q', 'origin', 'HEAD:main']);
  await git(['switch', '-q', '-c', 'feat']);
  await commit(git, dir, 'f1');
  await commit(git, dir, 'f2');
  await git(['push', '-q', '-u', 'origin', 'feat']);
  const headSha = (await git(['rev-parse', 'HEAD'])).trim();
  return { dir, git, remote: runner(remoteDir), headSha };
}

async function commit(git: GitRunner, dir: string, name: string): Promise<void> {
  fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', name]);
}

/** Squash-merges feat into the remote's main, as a forge does, deletes the remote branch if asked, and fetches. */
async function squashMerge(c: Clone, { deleteRemote = false } = {}): Promise<void> {
  const tree = (await c.remote(['rev-parse', `${c.headSha}^{tree}`])).trim();
  const main = (await c.remote(['rev-parse', 'main'])).trim();
  const merged = (await c.remote(['commit-tree', tree, '-p', main, '-m', 'feat (squashed)'])).trim();
  await c.remote(['update-ref', 'refs/heads/main', merged]);
  if (deleteRemote) await c.remote(['branch', '-D', 'feat']);
  await c.git(['fetch', '-q', '--prune', 'origin']);
}

const current = async (c: Clone) => (await c.git(['branch', '--show-current'])).trim();
const exists = async (c: Clone, branch: string) => c.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
const keepRefs = (c: Clone) => [c.headSha, 'refs/remotes/origin/feat', 'refs/remotes/origin/main'];

// --- Finding the branch ------------------------------------------------------------------------------------

test('the local branch is the one tracking the source branch, whatever its name', async t => {
  const c = await setup(t);
  await c.git(['switch', '-q', '-c', 'my-feat', '--track', 'origin/feat']);
  await c.git(['branch', '-q', '-D', 'feat']);
  assert.equal(await findLocalBranch(c.git, 'origin', 'feat'), 'my-feat');
});

test('without one tracking it, the local branch with the same name', async t => {
  const c = await setup(t);
  await c.git(['branch', '--unset-upstream', 'feat']);
  assert.equal(await findLocalBranch(c.git, 'origin', 'feat'), 'feat');
});

test('the tracking branch is still found once the remote branch is gone', async t => {
  const c = await setup(t);
  await squashMerge(c, { deleteRemote: true });
  assert.equal(await hasRemoteBranch(c.git, 'origin', 'feat'), false);
  assert.equal(await findLocalBranch(c.git, 'origin', 'feat'), 'feat');
});

test('the branch made by checking out the pull request is found by its number', async t => {
  const c = await setup(t);
  await c.git(['switch', '-q', '-c', 'pr/someone/42', '--no-track', 'feat']);
  await c.git(['branch', '-q', '--unset-upstream', 'feat']);
  await c.git(['branch', '-q', '-m', 'feat', 'unrelated']);
  assert.equal(await findLocalBranch(c.git, 'origin', 'feat', { prNumber: 42 }), 'pr/someone/42');
  assert.equal(await findLocalBranch(c.git, 'origin', 'feat', { prNumber: 4 }), undefined);
});

test('for a fork\'s pull request only the checkout of the pull request counts', async t => {
  const c = await setup(t);
  // A fork's pull request from its "main": the local main, tracking origin/main, is the user's own.
  assert.equal(await findLocalBranch(c.git, 'origin', 'main', { fork: true }), undefined);
  assert.equal(await findLocalBranch(c.git, 'origin', 'feat', { fork: true }), undefined);
  await c.git(['branch', '-q', 'pr/someone/7', 'feat']);
  assert.equal(await findLocalBranch(c.git, 'origin', 'main', { fork: true, prNumber: 7 }), 'pr/someone/7');
});

test('no local branch: nothing found', async t => {
  const c = await setup(t);
  await c.git(['switch', '-q', 'main']);
  await c.git(['branch', '-q', '-D', 'feat']);
  assert.equal(await findLocalBranch(c.git, 'origin', 'feat'), undefined);
});

// --- Safety ------------------------------------------------------------------------------------------------

test('a branch at the pull request head is safe to delete', async t => {
  const c = await setup(t);
  await squashMerge(c, { deleteRemote: true });
  const state = await inspectLocalBranch(c.git, 'feat', keepRefs(c));
  assert.deepEqual(state, { branch: 'feat', checkedOut: true, otherWorktree: undefined, safe: true });
});

test('a branch behind the pull request head is safe to delete', async t => {
  const c = await setup(t);
  await c.git(['reset', '-q', '--hard', 'HEAD~1']);
  await squashMerge(c, { deleteRemote: true });
  assert.equal((await inspectLocalBranch(c.git, 'feat', keepRefs(c))).safe, true);
});

test('a branch with commits that are not in the pull request is not safe, and is kept', async t => {
  const c = await setup(t);
  await commit(c.git, c.dir, 'local-only');
  await squashMerge(c, { deleteRemote: true });
  const state = await inspectLocalBranch(c.git, 'feat', keepRefs(c));
  assert.equal(state.safe, false);
  await assert.rejects(deleteLocalBranch(c.git, state, { remote: 'origin', targetBranch: 'main' }),
    (e: unknown) => e instanceof LocalBranchNotDeleted && e.reason === 'unsafe');
  assert.equal(await exists(c, 'feat'), true);
});

test('commits only in the remote branch still count as kept', async t => {
  const c = await setup(t);
  await commit(c.git, c.dir, 'pushed-later');
  await c.git(['push', '-q', 'origin', 'feat']);
  // The pull request was merged at its earlier head, but the remote branch still holds the later commit.
  assert.equal((await inspectLocalBranch(c.git, 'feat', keepRefs(c))).safe, true);
});

// --- Deleting ----------------------------------------------------------------------------------------------

test('after a squash merge the branch is deleted, though git branch -d refuses', async t => {
  const c = await setup(t);
  await c.git(['switch', '-q', 'main']);
  await squashMerge(c, { deleteRemote: true });
  await assert.rejects(c.git(['branch', '-d', 'feat']), /not fully merged/);
  const result = await deleteLocalBranch(c.git, await inspectLocalBranch(c.git, 'feat', keepRefs(c)), { remote: 'origin', targetBranch: 'main' });
  assert.deepEqual(result, { checkedOut: undefined });
  assert.equal(await exists(c, 'feat'), false);
});

test('a checked-out branch: the target branch is checked out and brought up to date first', async t => {
  const c = await setup(t);
  await squashMerge(c, { deleteRemote: true });
  const result = await deleteLocalBranch(c.git, await inspectLocalBranch(c.git, 'feat', keepRefs(c)), { remote: 'origin', targetBranch: 'main' });
  assert.deepEqual(result, { checkedOut: 'main' });
  assert.equal(await current(c), 'main');
  assert.equal((await c.git(['rev-parse', 'main'])).trim(), (await c.git(['rev-parse', 'origin/main'])).trim());
  assert.equal(await exists(c, 'feat'), false);
});

test('a target branch with no local branch yet is created, tracking the remote one', async t => {
  const c = await setup(t);
  await c.git(['branch', '-q', '-D', 'main']);
  await squashMerge(c, { deleteRemote: true });
  await deleteLocalBranch(c.git, await inspectLocalBranch(c.git, 'feat', keepRefs(c)), { remote: 'origin', targetBranch: 'main' });
  assert.equal(await current(c), 'main');
  assert.equal((await c.git(['rev-parse', '--abbrev-ref', 'main@{upstream}'])).trim(), 'origin/main');
});

test('a checked-out branch with uncommitted changes is kept, and stays checked out', async t => {
  const c = await setup(t);
  fs.appendFileSync(path.join(c.dir, 'f1.txt'), 'wip\n');
  await squashMerge(c, { deleteRemote: true });
  await assert.rejects(deleteLocalBranch(c.git, await inspectLocalBranch(c.git, 'feat', keepRefs(c)), { remote: 'origin', targetBranch: 'main' }),
    (e: unknown) => e instanceof LocalBranchNotDeleted && e.reason === 'dirty');
  assert.equal(await current(c), 'feat');
  assert.match(fs.readFileSync(path.join(c.dir, 'f1.txt'), 'utf8'), /wip/);
});

test('a branch checked out in another worktree is kept', async t => {
  const c = await setup(t);
  await c.git(['switch', '-q', 'main']);
  const other = path.join(path.dirname(c.dir), 'other');
  await c.git(['worktree', 'add', '-q', other, 'feat']);
  await squashMerge(c, { deleteRemote: true });
  const state = await inspectLocalBranch(c.git, 'feat', keepRefs(c));
  assert.equal(state.checkedOut, false);
  assert.equal(fs.realpathSync(state.otherWorktree!), fs.realpathSync(other));
  await assert.rejects(deleteLocalBranch(c.git, state, { remote: 'origin', targetBranch: 'main' }),
    (e: unknown) => e instanceof LocalBranchNotDeleted && e.reason === 'otherWorktree');
  assert.equal(await exists(c, 'feat'), true);
});

// --- Remote-tracking branch --------------------------------------------------------------------------------

test('the remote-tracking branch of a deleted remote branch is dropped without a fetch', async t => {
  const c = await setup(t);
  await squashMerge(c);
  await c.remote(['branch', '-D', 'feat']);
  assert.equal(await hasRemoteBranch(c.git, 'origin', 'feat'), true);
  await dropRemoteTrackingBranch(c.git, 'origin', 'feat');
  assert.equal(await hasRemoteBranch(c.git, 'origin', 'feat'), false);
  // Dropping one that is already gone is no error.
  await dropRemoteTrackingBranch(c.git, 'origin', 'feat');
});
