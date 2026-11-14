// Acceptance tests for squashing and dropping a selection of commits (issue #123), against real git.
//
//   npm test        (Node 22.6+: runs TypeScript by stripping types; no dependencies needed)
//
// Every repository starts from the history of the issue, oldest first: x y z w a b c. Each commit adds a file
// named after it and edits a shared log file, so a commit folded into the wrong one shows in both its files
// and its message. A history is written as its commits oldest first, each as the names it holds: x|yz|w.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRebaseTodo, shQuote } from '../src/host/git/rebaseTodo.ts';
import { planDrop, planSquash, readSquashGroups, type GitRunner, type Rewrite } from '../src/host/git/historyRewrite.ts';
import { runner } from './helpers/gitRunner.ts';

const NAMES = ['x', 'y', 'z', 'w', 'a', 'b', 'c'];

interface Repo {
  dir: string;
  git: GitRunner;
  hash: Record<string, string>;
}

async function makeRepo(t: { after: (fn: () => void) => void }, names = NAMES, { sharedLog = true } = {}): Promise<Repo> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-squash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = runner(dir);
  await git(['init', '-q', '-b', 'main']);
  const hash: Record<string, string> = {};
  for (const name of names) await commit({ dir, git, hash }, name, sharedLog);
  return { dir, git, hash };
}

async function commit(repo: Repo, name: string, sharedLog = true): Promise<void> {
  fs.writeFileSync(path.join(repo.dir, `${name}.txt`), `${name}\n`);
  if (sharedLog) fs.appendFileSync(path.join(repo.dir, 'log.txt'), `${name}\n`);
  await repo.git(['add', '-A']);
  await repo.git(['commit', '-q', '-m', name]);
  repo.hash[name] = (await repo.git(['rev-parse', 'HEAD'])).trim();
}

/** The history of HEAD, oldest first, as `x|yz|w`: each commit by the files it adds, checked against its message. */
async function history(repo: Repo): Promise<string> {
  const hashes = (await repo.git(['rev-list', '--reverse', 'HEAD'])).trim().split('\n');
  const commits: string[] = [];
  for (const hash of hashes) {
    const files = (await repo.git(['diff-tree', '--root', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', hash]))
      .trim().split('\n').filter(f => f !== 'log.txt' && f !== '').map(f => f.replace(/\.txt$/, '')).sort((p, q) => NAMES.indexOf(p) - NAMES.indexOf(q));
    const message = (await repo.git(['log', '-1', '--format=%B', hash])).trim().split(/\n\n+/).join('');
    assert.equal(message, files.join(''), `commit ${hash.slice(0, 8)}: its message names other commits than its changes`);
    commits.push(files.join(''));
  }
  return commits.join('|');
}

const tree = async (repo: Repo) => (await repo.git(['rev-parse', 'HEAD^{tree}'])).trim();
const names = (repo: Repo, hashes: string[]) => hashes.map(h => Object.keys(repo.hash).find(n => repo.hash[n] === h) ?? h);

/** Carries out a rewrite as GitService.interactiveRebase does: our todo copied over git's, no editor. */
async function run(repo: Repo, rewrite: Rewrite): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-todo-'));
  try {
    const todo = buildRebaseTodo(rewrite.plan, new Map(), (index, message) => {
      const file = path.join(dir, `message-${index}`);
      fs.writeFileSync(file, `${message}\n`);
      return file;
    });
    const todoFile = path.join(dir, 'git-rebase-todo');
    fs.writeFileSync(todoFile, todo);
    await repo.git(['-c', `sequence.editor=cp ${shQuote(todoFile)}`, '-c', 'core.editor=true',
      'rebase', '--interactive', '--autostash', ...(rewrite.upstream ? [rewrite.upstream] : ['--root'])]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Squashes the selection as the panels do: one squash per run of adjacent commits, its message the joined messages. */
async function squash(repo: Repo, selection: string[]): Promise<void> {
  const groups = await readSquashGroups(repo.git, selection.map(n => repo.hash[n] ?? n));
  assert.ok(groups.length > 0, 'nothing to squash');
  await run(repo, await planSquash(repo.git, groups.map(hashes => ({ hashes, message: names(repo, hashes).join('\n\n') }))));
}

async function drop(repo: Repo, selection: string[]): Promise<void> {
  await run(repo, await planDrop(repo.git, selection.map(n => repo.hash[n])));
}

/** What GitCharm 0.8.3 did: reset to the oldest selected commit's parent, then commit (squash) or not (drop). */
async function legacySquash(repo: Repo, selection: string[]): Promise<void> {
  const oldest = NAMES.find(n => selection.includes(n))!;
  await repo.git(['reset', '--soft', `${repo.hash[oldest]}^`]);
  await repo.git(['commit', '-q', '-m', selection.join('\n\n')]);
}
async function legacyDrop(repo: Repo, selection: string[]): Promise<void> {
  const oldest = NAMES.find(n => selection.includes(n))!;
  await repo.git(['reset', '--hard', `${repo.hash[oldest]}^`]);
}

// --- The defect, as reported -------------------------------------------------------------------------------

test('legacy squash folds every later commit into the selection (issue #123, example 1)', async t => {
  const repo = await makeRepo(t);
  await legacySquash(repo, ['y', 'z']);
  // The squashed commit holds w, a, b and c too, which its message doesn't even name.
  await assert.rejects(history(repo), /its message names other commits than its changes/);
  assert.equal((await repo.git(['rev-list', '--count', 'HEAD'])).trim(), '2');
});

test('legacy drop deletes every later commit, selected or not', async t => {
  const repo = await makeRepo(t);
  await legacyDrop(repo, ['y', 'a']);
  assert.equal(await history(repo), 'x');
});

test('legacy squash commits whatever was staged into the squash', async t => {
  const repo = await makeRepo(t);
  fs.writeFileSync(path.join(repo.dir, 'staged.txt'), 'wip\n');
  await repo.git(['add', 'staged.txt']);
  await legacySquash(repo, ['b', 'c']);
  assert.match(await repo.git(['show', '--name-only', '--format=', 'HEAD']), /staged\.txt/);
});

// --- Squash: ground truth ----------------------------------------------------------------------------------

test('example 1: squashing y z leaves the commits after them alone', async t => {
  const repo = await makeRepo(t);
  const before = await tree(repo);
  await squash(repo, ['y', 'z']);
  assert.equal(await history(repo), 'x|yz|w|a|b|c');
  assert.equal(await tree(repo), before);
});

test('example 2: squashing y z a b squashes each run of adjacent commits on its own', async t => {
  const repo = await makeRepo(t);
  const before = await tree(repo);
  await squash(repo, ['y', 'z', 'a', 'b']);
  assert.equal(await history(repo), 'x|yz|w|ab|c');
  assert.equal(await tree(repo), before);
});

test('the commits up to HEAD squash into one, as before', async t => {
  const repo = await makeRepo(t);
  await squash(repo, ['a', 'b', 'c']);
  assert.equal(await history(repo), 'x|y|z|w|abc');
});

test('the selection order does not matter, nor do short hashes', async t => {
  const repo = await makeRepo(t);
  await squash(repo, [repo.hash.z.slice(0, 8), repo.hash.y]);
  assert.equal(await history(repo), 'x|yz|w|a|b|c');
});

test('a run starting at the root commit squashes into a new root', async t => {
  const repo = await makeRepo(t);
  await squash(repo, ['x', 'y']);
  assert.equal(await history(repo), 'xy|z|w|a|b|c');
});

test('the whole history squashes into one commit', async t => {
  const repo = await makeRepo(t);
  await squash(repo, NAMES);
  assert.equal(await history(repo), 'xyzwabc');
});

test('a selected commit with no selected neighbour stays as it is', async t => {
  const repo = await makeRepo(t);
  await squash(repo, ['x', 'y', 'w', 'a', 'c']);
  assert.equal(await history(repo), 'xy|z|wa|b|c');
});

test('a selection without two adjacent commits has nothing to squash', async t => {
  const repo = await makeRepo(t);
  assert.deepEqual(await readSquashGroups(repo.git, [repo.hash.y, repo.hash.a]), []);
});

test('uncommitted changes, staged or not, stay out of the squash and are kept', async t => {
  const repo = await makeRepo(t);
  fs.writeFileSync(path.join(repo.dir, 'staged.txt'), 'wip\n');
  await repo.git(['add', 'staged.txt']);
  fs.appendFileSync(path.join(repo.dir, 'log.txt'), 'unstaged\n');
  await squash(repo, ['b', 'c']);
  assert.equal(await history(repo), 'x|y|z|w|a|bc');
  assert.equal((await repo.git(['status', '--porcelain'])).split('\n').filter(Boolean).sort().join(','), ' M log.txt,A  staged.txt');
});

test('the squashed commit keeps the message it was given', async t => {
  const repo = await makeRepo(t);
  const groups = await readSquashGroups(repo.git, [repo.hash.y, repo.hash.z]);
  await run(repo, await planSquash(repo.git, groups.map(hashes => ({ hashes, message: 'Edited\n\nbody' }))));
  assert.equal((await repo.git(['log', '-1', '--format=%B', 'HEAD~4'])).trim(), 'Edited\n\nbody');
  assert.equal((await repo.git(['log', '--format=%s', 'HEAD~3..HEAD'])).trim(), 'c\nb\na');
});

test('a squash group that is no longer adjacent is refused', async t => {
  const repo = await makeRepo(t);
  await assert.rejects(planSquash(repo.git, [{ hashes: [repo.hash.y, repo.hash.a], message: 'm' }]), /adjacent/);
});

test('a merge between the selection and HEAD is refused rather than flattened', async t => {
  const repo = await makeRepo(t, ['x', 'y', 'z'], { sharedLog: false });
  await repo.git(['checkout', '-q', '-b', 'side', repo.hash.y]);
  await commit(repo, 'w', false);
  await repo.git(['checkout', '-q', 'main']);
  await repo.git(['merge', '-q', '--no-ff', '-m', 'merge', 'side']);
  const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
  await assert.rejects(readSquashGroups(repo.git, [repo.hash.x, repo.hash.y]), /merge/);
  assert.equal((await repo.git(['rev-parse', 'HEAD'])).trim(), head);
});

test('a commit that is not on the current branch is refused', async t => {
  const repo = await makeRepo(t, ['x', 'y']);
  await repo.git(['checkout', '-q', '-b', 'side', repo.hash.x]);
  await commit(repo, 'z');
  await repo.git(['checkout', '-q', 'main']);
  await assert.rejects(readSquashGroups(repo.git, [repo.hash.x, repo.hash.z]), /not on the current branch/);
});

// --- Drop: ground truth ------------------------------------------------------------------------------------

test('dropping y a removes only them', async t => {
  // With the shared log file, every later commit would depend on y and a: dropping them would conflict.
  const repo = await makeRepo(t, NAMES, { sharedLog: false });
  await drop(repo, ['y', 'a']);
  assert.equal(await history(repo), 'x|z|w|b|c');
});

test('dropping the commits up to HEAD removes them, as before', async t => {
  const repo = await makeRepo(t);
  await drop(repo, ['b', 'c']);
  assert.equal(await history(repo), 'x|y|z|w|a');
});

test('dropping a commit a later one depends on fails with a conflict', async t => {
  const repo = await makeRepo(t);
  await assert.rejects(drop(repo, ['y']), /conflict/i);
});
