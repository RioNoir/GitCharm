import * as vscode from 'vscode';
import type { ForgeProvider } from './remoteUrlParser';

export interface BitbucketCredentials {
  email: string;
  apiToken: string;
}

export interface PatAccount {
  id: string;
  provider: ForgeProvider;
  host: string;
  label: string;
}

const ACCOUNTS_INDEX_KEY = 'gitcharm.pullRequests.patAccounts';

export class PatCredentialStore {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly globalState: vscode.Memento,
  ) {}

  private key(provider: ForgeProvider, host: string, accountId: string): string {
    return `gitcharm.pat.${provider}.${host}.${accountId}`;
  }

  private index(): PatAccount[] {
    return this.globalState.get<PatAccount[]>(ACCOUNTS_INDEX_KEY, []);
  }

  private async saveIndex(accounts: PatAccount[]): Promise<void> {
    await this.globalState.update(ACCOUNTS_INDEX_KEY, accounts);
  }

  /** All saved accounts, optionally filtered to a single (provider, host) pair. */
  listAccounts(provider?: ForgeProvider, host?: string): PatAccount[] {
    const accounts = this.index();
    if (!provider) return accounts;
    return accounts.filter(a => a.provider === provider && (!host || a.host === host));
  }

  getAccount(accountId: string): PatAccount | undefined {
    return this.index().find(a => a.id === accountId);
  }

  async get(accountId: string): Promise<string | undefined> {
    const account = this.getAccount(accountId);
    if (!account) return undefined;
    return this.secrets.get(this.key(account.provider, account.host, accountId));
  }

  /** Adds a new account (token already validated by the caller) and returns its generated id. */
  async addAccount(provider: ForgeProvider, host: string, label: string, token: string): Promise<string> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.secrets.store(this.key(provider, host, id), token);
    await this.saveIndex([...this.index(), { id, provider, host, label }]);
    return id;
  }

  async renameAccount(accountId: string, label: string): Promise<void> {
    await this.saveIndex(this.index().map(a => (a.id === accountId ? { ...a, label } : a)));
  }

  async removeAccount(accountId: string): Promise<void> {
    const account = this.getAccount(accountId);
    if (!account) return;
    await this.secrets.delete(this.key(account.provider, account.host, accountId));
    await this.saveIndex(this.index().filter(a => a.id !== accountId));
  }

  /**
   * Bitbucket Cloud API Tokens authenticate via Basic auth with the account email as
   * username (unlike App Passwords, which used the Bitbucket username with Basic auth,
   * or a bearer-only token) — so Bitbucket needs both an email and a token, stored
   * together as "email\0token" under the same secret used by get/addAccount.
   */
  async getBitbucketCredentials(accountId: string): Promise<BitbucketCredentials | undefined> {
    const raw = await this.get(accountId);
    if (!raw) return undefined;
    const [email, apiToken] = raw.split('\0');
    if (!email || !apiToken) return undefined;
    return { email, apiToken };
  }

  async addBitbucketAccount(host: string, label: string, credentials: BitbucketCredentials): Promise<string> {
    return this.addAccount('bitbucket', host, label, `${credentials.email}\0${credentials.apiToken}`);
  }
}
