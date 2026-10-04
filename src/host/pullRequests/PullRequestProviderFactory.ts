import type { ParsedRemote } from './remoteUrlParser';
import type { PullRequestProvider } from './types';
import type { BitbucketCredentials } from '../integrations/IntegrationAccountStore';
import { GitHubProvider } from './providers/GitHubProvider';
import { GitLabProvider } from './providers/GitLabProvider';
import { BitbucketProvider } from './providers/BitbucketProvider';
import { GiteaProvider } from './providers/GiteaProvider';
import { AzureDevOpsProvider } from './providers/AzureDevOpsProvider';
import { AzureDevOpsClient, patAuthorization } from './azureDevOpsClient';

export interface ProviderFactoryDeps {
  getGitHubToken: () => Promise<string | undefined>;
  /** Already resolved to the specific account bound to (or inferred for) the calling repo — see PullRequestManager.resolveAccountId(). */
  getPatToken: () => Promise<string | undefined>;
  getBitbucketCredentials: () => Promise<BitbucketCredentials | undefined>;
  /** Azure DevOps Services: a Microsoft account token, used when the repo isn't assigned a personal access token. */
  getMicrosoftToken: () => Promise<string | undefined>;
  /** Azure DevOps: the API root to use, when it differs from the one parsed from the remote (see ParsedRemote.apiBaseGuessed). */
  azureApiBase?: string;
}

/** The Azure DevOps API client for a repo — shared shape for pull requests and work items. */
export function createAzureDevOpsClient(parsed: ParsedRemote, deps: ProviderFactoryDeps): AzureDevOpsClient | null {
  const apiBase = deps.azureApiBase ?? parsed.apiBase;
  if (!apiBase) return null;
  return new AzureDevOpsClient(apiBase, async () => {
    const pat = await deps.getPatToken();
    if (pat) return patAuthorization(pat);
    const token = await deps.getMicrosoftToken();
    return token ? `Bearer ${token}` : undefined;
  });
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
    case 'azure': {
      const client = createAzureDevOpsClient(parsed, deps);
      return client ? new AzureDevOpsProvider(client) : null;
    }
    default:
      return null;
  }
}
