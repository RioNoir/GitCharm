import type { GitRunner } from './historyRewrite';

// The URL git actually fetches a remote from. A remote's configured URL can be rewritten by
// `url.<base>.insteadOf` rules — e.g. .gitmodules and origin pointing at a public mirror that
// developers redirect to their own forge — and VS Code's git API reports the URL as written in
// the config, not the rewritten one. `git remote get-url` applies the rewrites, like every git
// command that talks to the remote.
//
// Kept free of vscode and simple-git so it runs, with real git, under the acceptance tests in test/.

/**
 * The fetch URL of `remote` with `insteadOf` rewrites applied. Falls back to `configuredUrl`
 * when git can't tell (no such remote, git failing), so callers never end up with less than
 * what they had.
 */
export async function effectiveRemoteUrl(git: GitRunner, remote: string, configuredUrl: string): Promise<string> {
  try {
    const url = (await git(['remote', 'get-url', remote])).trim();
    return url || configuredUrl;
  } catch {
    return configuredUrl;
  }
}
