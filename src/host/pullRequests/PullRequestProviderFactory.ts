import type { ForgeProvider, ParsedRemote } from './remoteUrlParser';
import type { PullRequestProvider } from './types';
import { GitHubProvider } from './providers/GitHubProvider';
import { GitLabProvider } from './providers/GitLabProvider';
import { BitbucketProvider } from './providers/BitbucketProvider';
import { GiteaProvider } from './providers/GiteaProvider';

export interface ProviderFactoryDeps {
  getGitHubToken: () => Promise<string | undefined>;
  getPatToken: (provider: ForgeProvider, host: string) => Promise<string | undefined>;
}

export function createProvider(parsed: ParsedRemote, deps: ProviderFactoryDeps): PullRequestProvider | null {
  switch (parsed.provider) {
    case 'github':
      return new GitHubProvider(parsed.host, deps.getGitHubToken);
    case 'gitlab':
      return new GitLabProvider(parsed.host, () => deps.getPatToken('gitlab', parsed.host));
    case 'bitbucket':
      return new BitbucketProvider(() => deps.getPatToken('bitbucket', parsed.host));
    case 'gitea':
      return new GiteaProvider(parsed.host, () => deps.getPatToken('gitea', parsed.host));
    default:
      return null;
  }
}
