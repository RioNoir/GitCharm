import * as vscode from 'vscode';
import type { ForgeProvider } from './remoteUrlParser';

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
}
