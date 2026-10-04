// The cloud integrations GitCharm can connect to, described once. Features (pull requests today, issues
// later) read accounts through this catalog instead of knowing how each service authenticates.
// No vscode import: the settings webview bundles this file too.

/** Services with accounts. Forges for now; issue trackers (Jira, Linear…) will join this union. */
export type IntegrationProvider = 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'azure';

/** What an integration's accounts can be used for. */
export type IntegrationCapability = 'pullRequests' | 'issues';

export type IntegrationAuth =
  /** VS Code's built-in accounts (Accounts menu); GitCharm stores nothing. */
  | 'vscode'
  /** A personal access token. */
  | 'token'
  /** An account email plus an API token (Basic auth). */
  | 'emailToken'  /** Microsoft accounts signed into VS Code, or a personal access token (Azure DevOps Services). */
  | 'microsoftOrToken';

export interface IntegrationDefinition {
  /** Unique per entry: one provider can have a cloud and a self-hosted entry. */
  id: string;
  provider: IntegrationProvider;
  label: string;
  auth: IntegrationAuth;
  /** The cloud host; undefined for self-hosted entries, whose host the user enters. */
  host?: string;
  /** Placeholder for the host field of self-hosted entries. */
  hostPlaceholder?: string;
  capabilities: IntegrationCapability[];
  /** Page where a token is created; `{host}` is replaced by the account's host. */
  tokenUrl?: string;
  /** Scopes or permissions the token needs, shown next to the token field. */
  tokenScopes?: string;
  /** The add-account form asks for an organization, used to verify the token (Azure DevOps Services). */
  organizationField?: boolean;
  /** The host field takes a full URL (scheme, port and path kept), used to verify the token (Azure DevOps Server). */
  urlField?: boolean;
}

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  { id: 'github', provider: 'github', label: 'GitHub', auth: 'vscode', host: 'github.com', capabilities: ['pullRequests', 'issues'] },
  {
    id: 'gitlab', provider: 'gitlab', label: 'GitLab', auth: 'token', host: 'gitlab.com', capabilities: ['pullRequests', 'issues'],
    tokenUrl: 'https://{host}/-/user_settings/personal_access_tokens?name=GitCharm&scopes=api', tokenScopes: 'api',
  },
  {
    id: 'gitlab-self-hosted', provider: 'gitlab', label: 'GitLab Self-Hosted', auth: 'token', hostPlaceholder: 'gitlab.mycompany.com', capabilities: ['pullRequests', 'issues'],
    tokenUrl: 'https://{host}/-/user_settings/personal_access_tokens?name=GitCharm&scopes=api', tokenScopes: 'api',
  },
  {
    id: 'bitbucket', provider: 'bitbucket', label: 'Bitbucket Cloud', auth: 'emailToken', host: 'bitbucket.org', capabilities: ['pullRequests', 'issues'],
    tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  },
  {
    id: 'gitea', provider: 'gitea', label: 'Gitea / Forgejo', auth: 'token', hostPlaceholder: 'codeberg.org', capabilities: ['pullRequests', 'issues'],
    tokenUrl: 'https://{host}/user/settings/applications',
  },
  {
    id: 'azure', provider: 'azure', label: 'Azure DevOps', auth: 'microsoftOrToken', host: 'dev.azure.com', capabilities: ['pullRequests', 'issues'],
    tokenUrl: 'https://dev.azure.com/{organization}/_usersSettings/tokens', organizationField: true,
    tokenScopes: 'Code (Read & write), Work Items (Read & write), Build (Read), Project and Team (Read), Identity (Read)',
  },
  {
    id: 'azure-server', provider: 'azure', label: 'Azure DevOps Server', auth: 'token', hostPlaceholder: 'https://devops.mycompany.com/DefaultCollection',
    capabilities: ['pullRequests', 'issues'], tokenUrl: '{url}/_usersSettings/tokens', urlField: true,
    tokenScopes: 'Code (Read & write), Work Items (Read & write), Build (Read), Project and Team (Read), Identity (Read)',
  },
];

/** The catalog entry an account (provider + host) belongs to: the cloud entry for its host, else the self-hosted one. */
export function integrationFor(provider: IntegrationProvider, host: string): IntegrationDefinition | undefined {
  return INTEGRATIONS.find(i => i.provider === provider && i.host === host)
    ?? INTEGRATIONS.find(i => i.provider === provider && !i.host)
    ?? INTEGRATIONS.find(i => i.provider === provider);
}
