import * as vscode from 'vscode';
import type { ForgeProvider } from './remoteUrlParser';

export interface BitbucketCredentials {
  email: string;
  apiToken: string;
}

export class PatCredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(provider: ForgeProvider, host: string): string {
    return `gitcharm.pat.${provider}.${host}`;
  }

  async get(provider: ForgeProvider, host: string): Promise<string | undefined> {
    return this.secrets.get(this.key(provider, host));
  }

  async set(provider: ForgeProvider, host: string, token: string): Promise<void> {
    await this.secrets.store(this.key(provider, host), token);
  }

  async delete(provider: ForgeProvider, host: string): Promise<void> {
    await this.secrets.delete(this.key(provider, host));
  }

  /**
   * Bitbucket Cloud API Tokens authenticate via Basic auth with the account email as
   * username (unlike App Passwords, which used the Bitbucket username with Basic auth,
   * or a bearer-only token) — so Bitbucket needs both an email and a token, stored
   * together as "email\0token" under the same secret used by get/set/delete.
   */
  async getBitbucketCredentials(host: string): Promise<BitbucketCredentials | undefined> {
    const raw = await this.get('bitbucket', host);
    if (!raw) return undefined;
    const [email, apiToken] = raw.split('\0');
    if (!email || !apiToken) return undefined;
    return { email, apiToken };
  }

  async setBitbucketCredentials(host: string, credentials: BitbucketCredentials): Promise<void> {
    await this.set('bitbucket', host, `${credentials.email}\0${credentials.apiToken}`);
  }
}
