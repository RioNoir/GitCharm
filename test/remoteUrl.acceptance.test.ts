// Acceptance tests for resolving the URL a remote is actually fetched from, against real git.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { effectiveRemoteUrl } from '../src/host/git/remoteUrl.ts';
import { runner } from './helpers/gitRunner.ts';

const MIRROR = 'https://gitlab.com/acme/lib.git';

type T = { after: (fn: () => void) => void };

async function repo(t: T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-remote-url-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = runner(dir);
  await git(['init', '-q']);
  await git(['remote', 'add', 'origin', MIRROR]);
  return git;
}

test('applies url.<base>.insteadOf to the configured URL', async t => {
  const git = await repo(t);
  await git(['config', 'url.ssh://git@forgejo.local:2222/acme/.insteadOf', 'https://gitlab.com/acme/']);
  assert.equal(await effectiveRemoteUrl(git, 'origin', MIRROR), 'ssh://git@forgejo.local:2222/acme/lib.git');
});

test('ignores pushInsteadOf, which only rewrites pushes', async t => {
  const git = await repo(t);
  await git(['config', 'url.git@push.local:acme/.pushInsteadOf', 'https://gitlab.com/acme/']);
  assert.equal(await effectiveRemoteUrl(git, 'origin', MIRROR), MIRROR);
});

test('returns the configured URL when no rule applies', async t => {
  const git = await repo(t);
  assert.equal(await effectiveRemoteUrl(git, 'origin', MIRROR), MIRROR);
});

test('falls back to the configured URL when git cannot resolve the remote', async t => {
  const git = await repo(t);
  assert.equal(await effectiveRemoteUrl(git, 'missing', 'https://example.com/x/y.git'), 'https://example.com/x/y.git');
});
