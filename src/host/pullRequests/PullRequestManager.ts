import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { parseRemoteUrl, resolveProvider } from './remoteUrlParser';
import { createProvider } from './PullRequestProviderFactory';
import type { PatCredentialStore } from './PatCredentialStore';
import type { CreatePullRequestInput, CreatePullRequestResult, ForgeProvider, PullRequestConnectionStatus, PullRequestSummary } from './types';

const CACHE_TTL_MS = 45_000;

export interface RepoPullRequests {
  repoId: string;
  repoName: string;
  repoColor: string;
  connection: PullRequestConnectionStatus;
  pullRequests: PullRequestSummary[];
  error?: string;
}

interface CacheEntry {
  expiresAt: number;
  data: RepoPullRequests;
}

async function getGitHubToken(): Promise<string | undefined> {
  const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false, silent: true });
  return session?.accessToken;
}

function getHostProviderOverrides(): Record<string, string> {
  return vscode.workspace.getConfiguration('gitcharm').get<Record<string, string>>('pullRequests.hostProviderOverrides', {});
}

export class PullRequestManager {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly manager: WorkspaceGitManager,
    private readonly patStore: PatCredentialStore,
  ) {}

  invalidate(repoId?: string): void {
    if (repoId) this.cache.delete(repoId);
    else this.cache.clear();
  }

  private async resolveOrigin(repoId: string): Promise<{ owner: string; repo: string; host: string; provider: ReturnType<typeof parseRemoteUrl> } | null> {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return null;
    const remotes = await repo.getRemotesWithUrls();
    const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
    if (!origin?.fetchUrl) return null;
    const parsed = parseRemoteUrl(origin.fetchUrl);
    if (!parsed) return null;
    const resolved = resolveProvider(parsed, getHostProviderOverrides());
    return { owner: resolved.owner, repo: resolved.repo, host: resolved.host, provider: resolved };
  }

  private makeProvider(parsed: NonNullable<ReturnType<typeof parseRemoteUrl>>) {
    return createProvider(parsed, {
      getGitHubToken,
      getPatToken: (provider: ForgeProvider, host: string) => this.patStore.get(provider, host),
    });
  }

  async getConnectionStatus(repoId: string): Promise<PullRequestConnectionStatus> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider) {
      return { repoId, provider: 'unknown', host: '', connected: false, detectionFailed: true };
    }
    const provider = this.makeProvider(resolved.provider);
    if (!provider) {
      return { repoId, provider: resolved.provider.provider, host: resolved.host, connected: false, detectionFailed: resolved.provider.provider === 'unknown' };
    }
    const connected = await provider.hasCredentials();
    return { repoId, provider: resolved.provider.provider, host: resolved.host, connected, detectionFailed: false };
  }

  async listForRepo(repoId: string, repoName: string, repoColor: string, forceRefresh = false): Promise<RepoPullRequests> {
    const cached = this.cache.get(repoId);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.data;

    const connection = await this.getConnectionStatus(repoId);
    let result: RepoPullRequests;

    if (connection.detectionFailed) {
      result = { repoId, repoName, repoColor, connection, pullRequests: [] };
    } else if (!connection.connected) {
      result = { repoId, repoName, repoColor, connection, pullRequests: [] };
    } else {
      const resolved = await this.resolveOrigin(repoId);
      const provider = resolved?.provider ? this.makeProvider(resolved.provider) : null;
      if (!resolved || !provider) {
        result = { repoId, repoName, repoColor, connection, pullRequests: [], error: 'Unable to resolve provider for this repo' };
      } else {
        try {
          const pullRequests = await provider.listPullRequests(resolved.owner, resolved.repo);
          result = { repoId, repoName, repoColor, connection, pullRequests };
        } catch (err) {
          result = { repoId, repoName, repoColor, connection, pullRequests: [], error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    this.cache.set(repoId, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  async getAllPullRequests(forceRefresh = false): Promise<RepoPullRequests[]> {
    const metas = this.manager.getRepoMetas().filter(m => (m.depth ?? 0) === 0 && !m.isWorktree);
    const results = await Promise.allSettled(
      metas.map(meta => this.listForRepo(meta.id, meta.name, meta.color, forceRefresh)),
    );
    return results.map((r, i) => r.status === 'fulfilled'
      ? r.value
      : { repoId: metas[i].id, repoName: metas[i].name, repoColor: metas[i].color, connection: { repoId: metas[i].id, provider: 'unknown' as const, host: '', connected: false, detectionFailed: true }, pullRequests: [], error: String(r.reason) });
  }

  async createPullRequest(repoId: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider) return { ok: false, error: 'Unable to resolve provider for this repo' };
    const provider = this.makeProvider(resolved.provider);
    if (!provider) return { ok: false, error: 'Unsupported or undetected provider for this repo' };
    const result = await provider.createPullRequest(resolved.owner, resolved.repo, input);
    if (result.ok) this.invalidate(repoId);
    return result;
  }

  /** Validates a PAT by making a lightweight authenticated call, then stores it if valid. */
  async connectWithPat(repoId: string, token: string): Promise<{ ok: boolean; error?: string }> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider || resolved.provider.provider === 'unknown') {
      return { ok: false, error: 'Unable to resolve a forge provider for this repo' };
    }
    const { provider: forgeProvider, host } = resolved.provider;
    const valid = await validateToken(forgeProvider, host, token);
    if (!valid.ok) return valid;
    await this.patStore.set(forgeProvider, host, token);
    this.invalidate(repoId);
    return { ok: true };
  }

  async disconnect(repoId: string): Promise<void> {
    const resolved = await this.resolveOrigin(repoId);
    if (resolved?.provider && resolved.provider.provider !== 'unknown') {
      await this.patStore.delete(resolved.provider.provider, resolved.host);
    }
    this.invalidate(repoId);
  }
}

async function validateToken(provider: ForgeProvider, host: string, token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    let url: string;
    let headers: Record<string, string>;
    switch (provider) {
      case 'gitlab':
        url = `https://${host}/api/v4/user`;
        headers = { 'PRIVATE-TOKEN': token };
        break;
      case 'gitea':
        url = `https://${host}/api/v1/user`;
        headers = { Authorization: `token ${token}` };
        break;
      case 'bitbucket':
        url = 'https://api.bitbucket.org/2.0/user';
        headers = { Authorization: `Bearer ${token}` };
        break;
      default:
        return { ok: false, error: `Unsupported provider: ${provider}` };
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, error: `Token validation failed: HTTP ${res.status} ${res.statusText}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
