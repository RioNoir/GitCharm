import * as vscode from 'vscode';
import type { IntegrationProvider } from '../types/integrations';

// Checks a token against the service before it's saved, with the lightest authenticated call each API has.

export interface TokenCredentials {
  apiToken: string;
  email?: string; // required for Bitbucket, which authenticates via Basic auth
}

export async function validateToken(provider: IntegrationProvider, host: string, credentials: TokenCredentials): Promise<{ ok: boolean; error?: string }> {
  try {
    let url: string;
    let headers: Record<string, string>;
    switch (provider) {
      case 'gitlab':
        url = `https://${host}/api/v4/user`;
        headers = { 'PRIVATE-TOKEN': credentials.apiToken };
        break;
      case 'gitea':
        url = `https://${host}/api/v1/user`;
        headers = { Authorization: `token ${credentials.apiToken}` };
        break;
      case 'bitbucket': {
        if (!credentials.email) return { ok: false, error: vscode.l10n.t('Bitbucket requires an account email') };
        url = 'https://api.bitbucket.org/2.0/user';
        const basic = Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64');
        headers = { Authorization: `Basic ${basic}` };
        break;
      }
      default:
        return { ok: false, error: vscode.l10n.t('Unsupported provider: {0}', provider) };
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, error: vscode.l10n.t('Token validation failed: HTTP {0} {1}', res.status, res.statusText) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
