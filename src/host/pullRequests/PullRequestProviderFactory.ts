import type { ParsedRemote } from './remoteUrlParser';
import type { PullRequestProvider } from './types';
import type { BitbucketCredentials } from './PatCredentialStore';
import { GitHubProvider } from './providers/GitHubProvider';
import { GitLabProvider } from './providers/GitLabProvider';
import { BitbucketProvider } from './providers/BitbucketProvider';
import { GiteaProvider } from './providers/GiteaProvider';

export interface ProviderFactoryDeps {
  getGitHubToken: () => Promise<string | undefined>;
  /** Already resolved to the specific account bound to (or inferred for) the calling repo — see PullRequestManager.resolveAccountId(). */
  getPatToken: () => Promise<string | undefined>;
  getBitbucketCredentials: () => Promise<BitbucketCredentials | undefined>;
}

export function createProvider(parsed: ParsedRemote, deps: ProviderFactoryDeps): PullRequestProvider | null {
  switch (parsed.provider) {
    case 'github':
      return new GitHubProvider(parsed.host, deps.getGitHubToken);
    case 'gitlab':
      return new GitLabProvider(parsed.host, deps.getPatToken);
    case 'bitbucket':
      return new BitbucketProvider(deps.getBitbucketCredentials);
    case 'gitea':
      return new GiteaProvider(parsed.host, deps.getPatToken);
    default:
      return null;
  }
}
