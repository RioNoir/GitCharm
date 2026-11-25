// The editor's git API labels every "failed to push some refs" as PushRejected.
// A server hook (TAPD, a protected branch) must not be reported as "pull first",
// and must not offer a force push. A real non-fast-forward still should.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const TAPD_STDERR = [
  'remote: | Push [d055091f] failed. Because it contains a tapd item[--story=140491905], which does not match statuses: 新建需求;需求已规划;需求设计中;待开发;开发中;测试中;已关闭',
  'remote: +----------------------------------------------------------------',
  'remote: Processing pre-receive: push-check: 2, done',
  ' ! [remote rejected]       feat-yurini-apollo-full-switch-cleanup -> feat-yurini-apollo-full-switch-cleanup (Rejected by tapd-check)',
  "error: failed to push some refs to 'https://git.woa.com/tmsrd/tms-frontend.git'",
].join('\n');

const NON_FF_STDERR = [
  ' ! [rejected]        main -> main (non-fast-forward)',
  "error: failed to push some refs to 'https://github.com/example/repo.git'",
  'hint: Updates were rejected because the tip of your current branch is behind',
  'hint: its remote counterpart. Integrate the remote changes before pushing again.',
].join('\n');

let api: {
  formatGitError: (e: unknown) => string;
  isPushRejected: (e: unknown) => boolean;
};
let bundle = '';

before(async () => {
  bundle = path.join(os.tmpdir(), `gitcharm-push-rejection-${process.pid}.cjs`);
  const here = path.dirname(fileURLToPath(import.meta.url));
  await esbuild.build({
    absWorkingDir: path.resolve(here, '..'),
    entryPoints: [path.join(here, 'helpers/pushRejectionEntry.ts')],
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
});

test('a remote policy check is not reported as the branch being behind', () => {
  const error = { message: 'Failed to execute git', stderr: TAPD_STDERR, gitErrorCode: 'PushRejected' };
  const message = api.formatGitError(error);
  assert.match(message, /Rejected by tapd-check/);
  assert.match(message, /140491905/);
  assert.doesNotMatch(message, /Pull or fetch first/);
  assert.equal(api.isPushRejected(error), false);
});

test('a non-fast-forward rejection still asks to pull first', () => {
  const error = { message: 'Failed to execute git', stderr: NON_FF_STDERR, gitErrorCode: 'PushRejected' };
  assert.match(api.formatGitError(error), /Pull or fetch first/);
  assert.equal(api.isPushRejected(error), true);
});

test('a local pre-push hook is not treated as the remote being ahead', () => {
  const error = {
    message: 'Failed to execute git',
    stderr: 'husky - pre-push hook exited with code 1\nerror: failed to push some refs to \'origin\'',
    gitErrorCode: 'PushRejected',
  };
  assert.doesNotMatch(api.formatGitError(error), /Pull or fetch first/);
  assert.equal(api.isPushRejected(error), false);
});

test('a stale force-with-lease rejection still counts as the remote having moved', () => {
  const error = {
    message: 'Failed to execute git',
    stderr: ' ! [rejected]        main -> main (stale info)\nerror: failed to push some refs to \'origin\'',
    gitErrorCode: 'ForcePushWithLeaseRejected',
  };
  assert.match(api.formatGitError(error), /Force push rejected/);
  assert.equal(api.isPushRejected(error), true);
});
