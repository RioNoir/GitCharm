import type { ParsedRemote } from '../pullRequests/remoteUrlParser';
import { createAzureDevOpsClient, type ProviderFactoryDeps } from '../pullRequests/PullRequestProviderFactory';
import type { IssueProvider } from './types';
import { GitHubIssueProvider } from './providers/GitHubIssueProvider';
import { GitLabIssueProvider } from './providers/GitLabIssueProvider';
import { BitbucketIssueProvider } from './providers/BitbucketIssueProvider';
import { GiteaIssueProvider } from './providers/GiteaIssueProvider';
import { AzureDevOpsIssueProvider } from './providers/AzureDevOpsIssueProvider';

/** Same dependencies as the pull request providers — issues use the account the repository is connected with. */
export function createIssueProvider(parsed: ParsedRemote, deps: ProviderFactoryDeps): IssueProvider | null {
  switch (parsed.provider) {
    case 'github':
      return new GitHubIssueProvider(parsed.host, deps.getGitHubToken);
    case 'gitlab':
      return new GitLabIssueProvider(parsed.host, deps.getPatToken);
    case 'bitbucket':
      return new BitbucketIssueProvider(deps.getBitbucketCredentials);
    case 'gitea':
      return new GiteaIssueProvider(parsed.host, deps.getPatToken);
    case 'azure': {
      const client = createAzureDevOpsClient(parsed, deps);
      return client ? new AzureDevOpsIssueProvider(client) : null;
    }
    default:
      return null;
  }
}
