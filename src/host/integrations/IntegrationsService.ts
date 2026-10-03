import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import { forgeProviderLabel } from '../pullRequests/remoteUrlParser';
import { INTEGRATIONS, integrationFor } from '../types/integrations';
import type { IntegrationAccountMsg, IntegrationRepoMsg, IntegrationsState } from '../types/messages';
import type { IntegrationAccountStore } from './IntegrationAccountStore';

const GITHUB_BINDING_PREFIX = 'github:';

/**
 * What the Cloud Integrations page shows and does: the accounts of every integration, and which account each
 * repository of the workspace uses. Repository bindings still live in PullRequestManager, the only feature
 * using accounts so far; this service is the place other features (issues…) will plug into.
 */
export class IntegrationsService {
  constructor(
    private readonly store: IntegrationAccountStore,
    private readonly pullRequests: PullRequestManager,
    private readonly manager: WorkspaceGitManager,
  ) {}

  /** Fires whenever what getState() returns may have changed. */
  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.Disposable.from(
      this.store.onDidChange(listener),
      this.pullRequests.onDidChangeBindings(listener),
      vscode.authentication.onDidChangeSessions(e => { if (e.provider.id === 'github') listener(); }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('gitcharm.pullRequests.hostProviderOverrides')) return;
        this.pullRequests.invalidate(); // the forge detected for a host may have changed
        listener();
      }),
    );
  }

  async getState(): Promise<IntegrationsState> {
    const metas = this.manager.getRepoMetas();
    const githubAccounts = await this.githubAccounts();

    const repos: IntegrationRepoMsg[] = await Promise.all(metas.map(async meta => {
      const status = await this.pullRequests.getConnectionStatus(meta.id);
      const binding = this.pullRequests.getBinding(meta.id);
      const base = {
        repoId: meta.id, name: meta.name, color: meta.color, host: status.host, connected: status.connected,
        providerLabel: status.provider === 'unknown' ? '' : forgeProviderLabel(status.provider),
      };
      if (status.provider === 'unknown' || status.detectionFailed) {
        return { ...base, detectionFailed: true, options: [] };
      }
      if (status.provider === 'github') {
        return {
          ...base, detectionFailed: false, integrationId: 'github',
          value: binding?.startsWith(GITHUB_BINDING_PREFIX) ? binding : '',
          options: [
            { value: '', label: vscode.l10n.t('Default VS Code account') },
            ...githubAccounts.map(a => ({ value: `${GITHUB_BINDING_PREFIX}${a.id}`, label: a.label })),
          ],
        };
      }
      const accounts = this.store.listAccounts(status.provider, status.host);
      return {
        ...base, detectionFailed: false, integrationId: integrationFor(status.provider, status.host)?.id,
        value: binding && accounts.some(a => a.id === binding) ? binding : '',
        options: [
          { value: '', label: vscode.l10n.t('Not connected') },
          ...accounts.map(a => ({ value: a.id, label: a.label })),
        ],
      };
    }));

    const repoNamesFor = (value: string) => repos.filter(r => r.value === value).map(r => r.name);
    const accounts: Record<string, IntegrationAccountMsg[]> = Object.fromEntries(INTEGRATIONS.map(i => [i.id, []]));
    accounts.github = githubAccounts.map(a => ({
      id: `${GITHUB_BINDING_PREFIX}${a.id}`, label: a.label, host: 'github.com', repoNames: repoNamesFor(`${GITHUB_BINDING_PREFIX}${a.id}`),
    }));
    for (const account of this.store.listAccounts()) {
      const integration = integrationFor(account.provider, account.host);
      if (!integration) continue;
      accounts[integration.id].push({ id: account.id, label: account.label, host: account.host, repoNames: repoNamesFor(account.id) });
    }
    return { accounts, repos };
  }

  /** Validates the token with the service, then saves the account (not assigned to any repository). */
  async addAccount(integrationId: string, input: { host?: string; label?: string; email?: string; token: string }): Promise<{ ok: boolean; error?: string }> {
    const integration = INTEGRATIONS.find(i => i.id === integrationId);
    if (!integration || integration.auth === 'vscode') return { ok: false, error: vscode.l10n.t('Unsupported provider: {0}', integrationId) };
    const host = integration.host ?? normalizeHost(input.host ?? '');
    if (!host) return { ok: false, error: vscode.l10n.t('Enter the host of the server.') };
    const email = input.email?.trim();
    if (integration.auth === 'emailToken' && !email) return { ok: false, error: vscode.l10n.t('Bitbucket requires an account email') };
    const label = input.label?.trim() || email || host;
    return this.pullRequests.addAccountStandalone(integration.provider, host, label, { apiToken: input.token.trim(), email });
  }

  async renameAccount(accountId: string, label: string): Promise<void> {
    if (!label.trim()) return;
    await this.pullRequests.renameAccount(accountId, label.trim());
  }

  /** Asks first: every repository using the account is disconnected. */
  async removeAccount(accountId: string): Promise<boolean> {
    const account = this.store.getAccount(accountId);
    if (!account) return false;
    const remove = vscode.l10n.t('Remove');
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Remove the "{0}" account? Any repo assigned to it will be disconnected.', account.label), { modal: true }, remove);
    if (confirm !== remove) return false;
    await this.pullRequests.removeAccount(accountId);
    return true;
  }

  /** Opens VS Code's GitHub sign-in, letting the user pick or add an account. */
  async addGitHubAccount(): Promise<void> {
    // clearSessionPreference is what prompts VS Code's account chooser — forceNewSession alone just
    // re-authenticates whichever account is already preferred.
    await vscode.authentication.getSession('github', ['repo'], { createIfNone: true, clearSessionPreference: true });
    this.pullRequests.invalidate();
  }

  /** `value` is an option value from getState(): '' unassigns. */
  async assign(repoId: string, value: string): Promise<void> {
    if (value.startsWith(GITHUB_BINDING_PREFIX)) await this.pullRequests.assignGitHubAccount(repoId, value.slice(GITHUB_BINDING_PREFIX.length));
    else if (value) await this.pullRequests.assignAccount(repoId, value);
    else await this.pullRequests.disconnect(repoId);
  }

  private async githubAccounts(): Promise<readonly vscode.AuthenticationSessionAccountInformation[]> {
    try {
      return await vscode.authentication.getAccounts('github');
    } catch {
      return [];
    }
  }
}

/** "https://git.example.com/group/" -> "git.example.com". */
function normalizeHost(raw: string): string {
  return raw.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}
