import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { parseRemoteUrl, resolveProvider } from './remoteUrlParser';
import { createProvider } from './PullRequestProviderFactory';
import type { BitbucketCredentials, PatCredentialStore } from './PatCredentialStore';
import type {
  ActionResult, ChangedFile, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs, ForgeProvider,
  ListPullRequestsOptions, MergeStrategy, PostCommentResult, PullRequestAuthorFilter, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestConnectionStatus, PullRequestDetail, PullRequestProvider,
  PullRequestStateFilter, PullRequestSummary, SubmitReviewInput, UnsupportedResult,
} from './types';

const CACHE_TTL_MS = 45_000;

export interface PullRequestFilters {
  state: PullRequestStateFilter;
  author: PullRequestAuthorFilter;
}

export const DEFAULT_PR_FILTERS: PullRequestFilters = { state: 'open', author: 'all' };

export interface RepoPullRequests {
  repoId: string;
  repoName: string;
  repoColor: string;
  connection: PullRequestConnectionStatus;
  pullRequests: PullRequestSummary[];
  page: number;
  hasMore: boolean;
  error?: string;
}

interface CacheEntry {
  expiresAt: number;
  filters: PullRequestFilters;
  data: RepoPullRequests;
}

async function getGitHubToken(): Promise<string | undefined> {
  const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false, silent: true });
  return session?.accessToken;
}

function getHostProviderOverrides(): Record<string, string> {
  return vscode.workspace.getConfiguration('gitcharm').get<Record<string, string>>('pullRequests.hostProviderOverrides', {});
}

function sameFilters(a: PullRequestFilters, b: PullRequestFilters): boolean {
  return a.state === b.state && a.author === b.author;
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
      getBitbucketCredentials: (host: string) => this.patStore.getBitbucketCredentials(host),
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

  /** Loads the first page for a repo under the given filters, replacing any cached pages for that repo. */
  async listForRepo(repoId: string, repoName: string, repoColor: string, filters: PullRequestFilters, forceRefresh = false): Promise<RepoPullRequests> {
    const cached = this.cache.get(repoId);
    if (!forceRefresh && cached && sameFilters(cached.filters, filters) && cached.expiresAt > Date.now()) return cached.data;

    const connection = await this.getConnectionStatus(repoId);
    let result: RepoPullRequests;

    if (connection.detectionFailed || !connection.connected) {
      result = { repoId, repoName, repoColor, connection, pullRequests: [], page: 1, hasMore: false };
    } else {
      const resolved = await this.resolveOrigin(repoId);
      const provider = resolved?.provider ? this.makeProvider(resolved.provider) : null;
      if (!resolved || !provider) {
        result = { repoId, repoName, repoColor, connection, pullRequests: [], page: 1, hasMore: false, error: 'Unable to resolve provider for this repo' };
      } else {
        try {
          const options: ListPullRequestsOptions = { state: filters.state, author: filters.author, page: 1 };
          const { items, hasMore } = await provider.listPullRequests(resolved.owner, resolved.repo, options);
          result = { repoId, repoName, repoColor, connection, pullRequests: items, page: 1, hasMore };
        } catch (err) {
          result = { repoId, repoName, repoColor, connection, pullRequests: [], page: 1, hasMore: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    this.cache.set(repoId, { data: result, filters, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  /** Loads the next page for a repo and appends it to the cached list — used by infinite scroll. */
  async loadMore(repoId: string, filters: PullRequestFilters): Promise<RepoPullRequests | null> {
    const cached = this.cache.get(repoId);
    if (!cached || !sameFilters(cached.filters, filters) || !cached.data.hasMore) return cached?.data ?? null;

    const resolved = await this.resolveOrigin(repoId);
    const provider = resolved?.provider ? this.makeProvider(resolved.provider) : null;
    if (!resolved || !provider) return cached.data;

    const nextPage = cached.data.page + 1;
    try {
      const options: ListPullRequestsOptions = { state: filters.state, author: filters.author, page: nextPage };
      const { items, hasMore } = await provider.listPullRequests(resolved.owner, resolved.repo, options);
      const result: RepoPullRequests = {
        ...cached.data,
        pullRequests: [...cached.data.pullRequests, ...items],
        page: nextPage,
        hasMore,
      };
      this.cache.set(repoId, { data: result, filters, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    } catch (err) {
      const result: RepoPullRequests = { ...cached.data, error: err instanceof Error ? err.message : String(err) };
      this.cache.set(repoId, { data: result, filters, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }
  }

  async getAllPullRequests(filters: PullRequestFilters = DEFAULT_PR_FILTERS, forceRefresh = false): Promise<RepoPullRequests[]> {
    const metas = this.manager.getRepoMetas().filter(m => (m.depth ?? 0) === 0 && !m.isWorktree);
    const results = await Promise.allSettled(
      metas.map(meta => this.listForRepo(meta.id, meta.name, meta.color, filters, forceRefresh)),
    );
    return results.map((r, i) => r.status === 'fulfilled'
      ? r.value
      : {
          repoId: metas[i].id, repoName: metas[i].name, repoColor: metas[i].color,
          connection: { repoId: metas[i].id, provider: 'unknown' as const, host: '', connected: false, detectionFailed: true },
          pullRequests: [], page: 1, hasMore: false, error: String(r.reason),
        });
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

  /** Validates a PAT by making a lightweight authenticated call, then stores it if valid. Not used for Bitbucket — see connectBitbucket(). */
  async connectWithPat(repoId: string, token: string): Promise<{ ok: boolean; error?: string }> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider || resolved.provider.provider === 'unknown') {
      return { ok: false, error: 'Unable to resolve a forge provider for this repo' };
    }
    const { provider: forgeProvider, host } = resolved.provider;
    if (forgeProvider === 'bitbucket') return { ok: false, error: 'Bitbucket requires an account email in addition to the API token' };
    const valid = await validateToken(forgeProvider, host, { apiToken: token });
    if (!valid.ok) return valid;
    await this.patStore.set(forgeProvider, host, token);
    this.invalidate(repoId);
    return { ok: true };
  }

  /**
   * Connects Bitbucket Cloud using an API Token (Basic auth requires the account email,
   * unlike the other providers' single-token bearer/header schemes).
   */
  async connectBitbucket(repoId: string, credentials: BitbucketCredentials): Promise<{ ok: boolean; error?: string }> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider || resolved.provider.provider !== 'bitbucket') {
      return { ok: false, error: 'This repo is not detected as a Bitbucket repository' };
    }
    const valid = await validateToken('bitbucket', resolved.host, credentials);
    if (!valid.ok) return valid;
    await this.patStore.setBitbucketCredentials(resolved.host, credentials);
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

  private async resolveProviderAndTarget(repoId: string): Promise<{ owner: string; repo: string; provider: PullRequestProvider } | { error: string }> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider) return { error: 'Unable to resolve provider for this repo' };
    const provider = this.makeProvider(resolved.provider);
    if (!provider) return { error: 'Unsupported or undetected provider for this repo' };
    return { owner: resolved.owner, repo: resolved.repo, provider };
  }

  async getCapabilities(repoId: string): Promise<PullRequestCapabilities | null> {
    const target = await this.resolveProviderAndTarget(repoId);
    return 'error' in target ? null : target.provider.getCapabilities();
  }

  async getPullRequestDetail(repoId: string, number: number): Promise<PullRequestDetail | { error: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return target;
    try {
      return await target.provider.getPullRequestDetail(target.owner, target.repo, number);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listComments(repoId: string, number: number): Promise<PullRequestComment[]> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return [];
    try {
      return await target.provider.listComments(target.owner, target.repo, number);
    } catch {
      return [];
    }
  }

  async postComment(repoId: string, number: number, body: string): Promise<PostCommentResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    return target.provider.postComment(target.owner, target.repo, number, body);
  }

  async listChangedFiles(repoId: string, number: number): Promise<ChangedFile[]> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return [];
    try {
      return await target.provider.listChangedFiles(target.owner, target.repo, number);
    } catch {
      return [];
    }
  }

  async getFileDiff(repoId: string, number: number, file: ChangedFile, refs: FileDiffRefs): Promise<FileDiffContent | { error: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return target;
    try {
      return await target.provider.getFileDiff(target.owner, target.repo, number, file, refs);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listCommits(repoId: string, number: number): Promise<PullRequestCommit[]> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return [];
    try {
      return await target.provider.listCommits(target.owner, target.repo, number);
    } catch {
      return [];
    }
  }

  async listCommitFiles(repoId: string, sha: string): Promise<ChangedFile[]> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return [];
    try {
      return await target.provider.listCommitFiles(target.owner, target.repo, sha);
    } catch {
      return [];
    }
  }

  /** Diffs a single commit's file against its parent — reuses the same per-file blob-fetch strategy as the whole-PR diff. */
  async getCommitFileDiff(repoId: string, number: number, file: ChangedFile, commitSha: string, parentSha: string | undefined): Promise<FileDiffContent | { error: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return target;
    try {
      return await target.provider.getFileDiff(target.owner, target.repo, number, file, { baseSha: parentSha ?? commitSha, headSha: commitSha });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async mergePullRequest(repoId: string, number: number, strategy: MergeStrategy): Promise<ActionResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.mergePullRequest(target.owner, target.repo, number, strategy);
    if (result.ok) this.invalidate(repoId);
    return result;
  }

  async closePullRequest(repoId: string, number: number): Promise<ActionResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.closePullRequest(target.owner, target.repo, number);
    if (result.ok) this.invalidate(repoId);
    return result;
  }

  async reopenPullRequest(repoId: string, number: number): Promise<ActionResult | UnsupportedResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.reopenPullRequest(target.owner, target.repo, number);
    if (result.ok) this.invalidate(repoId);
    return result;
  }

  async submitReview(repoId: string, number: number, input: SubmitReviewInput): Promise<ActionResult | UnsupportedResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    return target.provider.submitReview(target.owner, target.repo, number, input);
  }

  /**
   * Fetches a PR's head and checks it out locally. If the PR's source branch isn't from a fork
   * and a local branch with that same name already exists, that branch is updated and checked out
   * in place — otherwise falls back to a dedicated `pr/{author}/{number}` branch.
   */
  async checkoutPullRequest(repoId: string, pr: PullRequestSummary): Promise<ActionResult & { branchName?: string }> {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return { ok: false, error: 'Repository not found' };

    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };

    const remotes = await repo.getRemotesWithUrls();
    const originName = remotes.find(r => r.name === 'origin')?.name ?? remotes[0]?.name;
    if (!originName) return { ok: false, error: 'No remote configured for this repository' };

    const isFork = !!pr.sourceRepoFullName && pr.sourceRepoFullName !== pr.targetRepoFullName;
    let branchName: string;
    if (!isFork && await repo.localBranchExists(pr.sourceBranch)) {
      branchName = pr.sourceBranch;
    } else {
      const safeAuthor = pr.authorName.replace(/[^a-zA-Z0-9_-]/g, '-');
      branchName = `pr/${safeAuthor}/${pr.number}`;
    }
    const refspec = target.provider.getCheckoutRefspec(pr.number);

    try {
      await repo.checkoutPullRequest(originName, refspec, branchName);
      return { ok: true, branchName };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

interface TokenCredentials {
  apiToken: string;
  email?: string; // required for Bitbucket, which authenticates via Basic auth
}

async function validateToken(provider: ForgeProvider, host: string, credentials: TokenCredentials): Promise<{ ok: boolean; error?: string }> {
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
        if (!credentials.email) return { ok: false, error: 'Bitbucket requires an account email' };
        url = 'https://api.bitbucket.org/2.0/user';
        const basic = Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64');
        headers = { Authorization: `Basic ${basic}` };
        break;
      }
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
