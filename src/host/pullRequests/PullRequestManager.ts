import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { parseRemoteUrl, resolveProvider } from './remoteUrlParser';
import { createProvider } from './PullRequestProviderFactory';
import type { BitbucketCredentials, PatAccount, PatCredentialStore } from './PatCredentialStore';
import { logError, logWarn } from '../utils/Logger';
import type {
  ActionResult, ChangedFile, CiCheck, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs, ForgeProvider,
  ListPullRequestsOptions, MergeStrategy, PostCommentResult, PullRequestAuthorFilter, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestConnectionStatus, PullRequestDetail, PullRequestLabel, PullRequestProvider,
  PullRequestStateFilter, PullRequestSummary, PullRequestUser, SubmitReviewInput, UnsupportedResult, UpdatePullRequestInput,
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

const GITHUB_ACCOUNT_ID_PREFIX = 'github:';

/** `githubAccountId` is a raw `AuthenticationSessionAccountInformation.id` (not the `github:`-prefixed binding form). */
async function getGitHubToken(githubAccountId?: string): Promise<string | undefined> {
  const options: vscode.AuthenticationGetSessionOptions = { createIfNone: false, silent: true };
  if (githubAccountId) {
    const accounts = await vscode.authentication.getAccounts('github');
    const account = accounts.find(a => a.id === githubAccountId);
    if (account) options.account = account;
  }
  const session = await vscode.authentication.getSession('github', ['repo'], options);
  return session?.accessToken;
}

function getHostProviderOverrides(): Record<string, string> {
  return vscode.workspace.getConfiguration('gitcharm').get<Record<string, string>>('pullRequests.hostProviderOverrides', {});
}

function sameFilters(a: PullRequestFilters, b: PullRequestFilters): boolean {
  return a.state === b.state && a.author === b.author;
}

const REPO_ACCOUNT_BINDING_KEY = 'gitcharm.pullRequests.repoAccountBindings';

export class PullRequestManager {
  private cache = new Map<string, CacheEntry>();
  /** One provider instance per repo, reused across calls so each provider's own in-memory caches (e.g. GitLab's label-color cache, cached username) actually persist instead of being thrown away and re-fetched on every single request. */
  private providerCache = new Map<string, PullRequestProvider>();

  constructor(
    private readonly manager: WorkspaceGitManager,
    private readonly patStore: PatCredentialStore,
    private readonly workspaceState: vscode.Memento,
  ) {}

  invalidate(repoId?: string): void {
    if (repoId) {
      this.cache.delete(repoId);
      this.providerCache.delete(repoId);
    } else {
      this.cache.clear();
      this.providerCache.clear();
    }
  }

  private bindings(): Record<string, string> {
    return this.workspaceState.get<Record<string, string>>(REPO_ACCOUNT_BINDING_KEY, {});
  }

  private async setBinding(repoId: string, accountId: string | undefined): Promise<void> {
    const bindings = { ...this.bindings() };
    if (accountId) bindings[repoId] = accountId;
    else delete bindings[repoId];
    await this.workspaceState.update(REPO_ACCOUNT_BINDING_KEY, bindings);
  }

  /** Accounts saved for this repo's host, plus the currently-bound one (if any) and whether a choice is required. */
  async getAccountOptions(repoId: string): Promise<{ host: string; provider: ForgeProvider; accounts: PatAccount[]; boundAccountId?: string } | null> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved?.provider || resolved.provider.provider === 'unknown' || resolved.provider.provider === 'github') return null;
    const accounts = this.patStore.listAccounts(resolved.provider.provider, resolved.host);
    return { host: resolved.host, provider: resolved.provider.provider, accounts, boundAccountId: this.bindings()[repoId] };
  }

  /** GitHub accounts currently signed into VS Code (independent of any repo — GitHub sessions aren't stored by GitCharm). */
  async listGitHubAccounts(): Promise<vscode.AuthenticationSessionAccountInformation[]> {
    return [...await vscode.authentication.getAccounts('github')];
  }

  /** Which VS Code GitHub account (if any) this repo is explicitly bound to. */
  getGitHubAccountBinding(repoId: string): string | undefined {
    const bound = this.bindings()[repoId];
    return bound?.startsWith(GITHUB_ACCOUNT_ID_PREFIX) ? bound.slice(GITHUB_ACCOUNT_ID_PREFIX.length) : undefined;
  }

  async assignGitHubAccount(repoId: string, githubAccountId: string | undefined): Promise<void> {
    await this.setBinding(repoId, githubAccountId ? `${GITHUB_ACCOUNT_ID_PREFIX}${githubAccountId}` : undefined);
    this.invalidate(repoId);
  }

  async assignAccount(repoId: string, accountId: string | undefined): Promise<void> {
    await this.setBinding(repoId, accountId);
    this.invalidate(repoId);
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

  /**
   * Picks which saved PAT account a repo should use: an explicit binding wins; otherwise, if
   * exactly one account is saved for that (provider, host), it's used automatically (keeps the
   * single-account case working with no setup); with zero or multiple accounts and no binding,
   * no account can be chosen automatically — the caller must assign one explicitly.
   */
  private resolveAccountId(repoId: string, provider: ForgeProvider, host: string): string | undefined {
    const bound = this.bindings()[repoId];
    if (bound && this.patStore.getAccount(bound)) return bound;
    const candidates = this.patStore.listAccounts(provider, host);
    return candidates.length === 1 ? candidates[0].id : undefined;
  }

  private makeProvider(repoId: string, parsed: NonNullable<ReturnType<typeof parseRemoteUrl>>) {
    const cached = this.providerCache.get(repoId);
    if (cached) return cached;

    const accountId = this.resolveAccountId(repoId, parsed.provider, parsed.host);
    const githubAccountId = this.getGitHubAccountBinding(repoId);
    const provider = createProvider(parsed, {
      getGitHubToken: () => getGitHubToken(githubAccountId),
      getPatToken: () => accountId ? this.patStore.get(accountId) : Promise.resolve(undefined),
      getBitbucketCredentials: () => accountId ? this.patStore.getBitbucketCredentials(accountId) : Promise.resolve(undefined),
    });
    if (provider) this.providerCache.set(repoId, provider);
    return provider;
  }

  async getConnectionStatus(repoId: string): Promise<PullRequestConnectionStatus> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider) {
      return { repoId, provider: 'unknown', host: '', connected: false, detectionFailed: true };
    }
    const provider = this.makeProvider(repoId, resolved.provider);
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
      const provider = resolved?.provider ? this.makeProvider(repoId, resolved.provider) : null;
      if (!resolved || !provider) {
        result = { repoId, repoName, repoColor, connection, pullRequests: [], page: 1, hasMore: false, error: 'Unable to resolve provider for this repo' };
      } else {
        try {
          const options: ListPullRequestsOptions = { state: filters.state, author: filters.author, page: 1 };
          const { items, hasMore } = await provider.listPullRequests(resolved.owner, resolved.repo, options);
          result = { repoId, repoName, repoColor, connection, pullRequests: items, page: 1, hasMore };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError('pullrequest-list', `Failed to list pull requests for ${repoName}`, message);
          result = { repoId, repoName, repoColor, connection, pullRequests: [], page: 1, hasMore: false, error: message };
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
    const provider = resolved?.provider ? this.makeProvider(repoId, resolved.provider) : null;
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
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-load-more', `Failed to load more pull requests for ${cached.data.repoName}`, message);
      const result: RepoPullRequests = { ...cached.data, error: message };
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
    const provider = this.makeProvider(repoId, resolved.provider);
    if (!provider) return { ok: false, error: 'Unsupported or undetected provider for this repo' };
    const result = await provider.createPullRequest(resolved.owner, resolved.repo, input);
    if (result.ok) this.invalidate(repoId);
    else logError('pullrequest-create', `Failed to create pull request for ${resolved.owner}/${resolved.repo}`, result.error);
    return result;
  }

  /**
   * Validates a PAT by making a lightweight authenticated call, then saves it as a new account
   * (labeled, so multiple accounts can coexist for the same provider/host) and binds this repo to
   * it. Not used for Bitbucket — see connectBitbucket().
   */
  async connectWithPat(repoId: string, token: string, label: string): Promise<{ ok: boolean; error?: string }> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider || resolved.provider.provider === 'unknown') {
      return { ok: false, error: 'Unable to resolve a forge provider for this repo' };
    }
    const { provider: forgeProvider, host } = resolved.provider;
    if (forgeProvider === 'bitbucket') return { ok: false, error: 'Bitbucket requires an account email in addition to the API token' };
    const valid = await validateToken(forgeProvider, host, { apiToken: token });
    if (!valid.ok) {
      logWarn('pullrequest-connect-pat', `Token validation failed for ${host}`, valid.error);
      return valid;
    }
    const accountId = await this.patStore.addAccount(forgeProvider, host, label, token);
    await this.setBinding(repoId, accountId);
    this.invalidate(repoId);
    return { ok: true };
  }

  /**
   * Connects Bitbucket Cloud using an API Token (Basic auth requires the account email,
   * unlike the other providers' single-token bearer/header schemes).
   */
  async connectBitbucket(repoId: string, label: string, credentials: BitbucketCredentials): Promise<{ ok: boolean; error?: string }> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider || resolved.provider.provider !== 'bitbucket') {
      return { ok: false, error: 'This repo is not detected as a Bitbucket repository' };
    }
    const valid = await validateToken('bitbucket', resolved.host, credentials);
    if (!valid.ok) {
      logWarn('pullrequest-connect-bitbucket', `Token validation failed for ${resolved.host}`, valid.error);
      return valid;
    }
    const accountId = await this.patStore.addBitbucketAccount(resolved.host, label, credentials);
    await this.setBinding(repoId, accountId);
    this.invalidate(repoId);
    return { ok: true };
  }

  /** Unbinds this repo from its account (the account itself, and any other repo bound to it, is untouched). */
  async disconnect(repoId: string): Promise<void> {
    await this.setBinding(repoId, undefined);
    this.invalidate(repoId);
  }

  /**
   * Validates and saves a new account for an explicitly-given (provider, host) pair, without
   * binding it to any repo — used by the "Add provider account" credential-management flow, which
   * isn't tied to a repo already open in the workspace. The account can be assigned to repos afterwards.
   */
  async addAccountStandalone(provider: ForgeProvider, host: string, label: string, credentials: TokenCredentials): Promise<{ ok: boolean; error?: string; accountId?: string }> {
    const valid = await validateToken(provider, host, credentials);
    if (!valid.ok) {
      logWarn('pullrequest-add-account', `Token validation failed for ${host}`, valid.error);
      return valid;
    }
    const accountId = provider === 'bitbucket'
      ? await this.patStore.addBitbucketAccount(host, label, { email: credentials.email!, apiToken: credentials.apiToken })
      : await this.patStore.addAccount(provider, host, label, credentials.apiToken);
    return { ok: true, accountId };
  }

  listAccounts(): PatAccount[] {
    return this.patStore.listAccounts();
  }

  /** Permanently deletes a saved account and unbinds every repo that was using it. */
  async removeAccount(accountId: string): Promise<void> {
    await this.patStore.removeAccount(accountId);
    const bindings = this.bindings();
    const affectedRepoIds = Object.entries(bindings).filter(([, id]) => id === accountId).map(([repoId]) => repoId);
    for (const repoId of affectedRepoIds) await this.setBinding(repoId, undefined);
    this.invalidate();
  }

  private async resolveProviderAndTarget(repoId: string): Promise<{ owner: string; repo: string; provider: PullRequestProvider } | { error: string }> {
    const resolved = await this.resolveOrigin(repoId);
    if (!resolved || !resolved.provider) return { error: 'Unable to resolve provider for this repo' };
    const provider = this.makeProvider(repoId, resolved.provider);
    if (!provider) return { error: 'Unsupported or undetected provider for this repo' };
    return { owner: resolved.owner, repo: resolved.repo, provider };
  }

  async getCapabilities(repoId: string): Promise<PullRequestCapabilities | null> {
    const target = await this.resolveProviderAndTarget(repoId);
    return 'error' in target ? null : target.provider.getCapabilities();
  }

  async getCurrentUsername(repoId: string): Promise<string | undefined> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return undefined;
    return target.provider.getCurrentUsername();
  }

  async getPullRequestDetail(repoId: string, number: number): Promise<PullRequestDetail | { error: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return target;
    try {
      return await target.provider.getPullRequestDetail(target.owner, target.repo, number);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-detail', `Failed to load detail for PR #${number}`, message);
      return { error: message };
    }
  }

  async updatePullRequest(repoId: string, number: number, input: UpdatePullRequestInput): Promise<ActionResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.updatePullRequest(target.owner, target.repo, number, input);
    if (result.ok) this.invalidate(repoId);
    else logError('pullrequest-update', `Failed to update PR #${number}`, result.error);
    return result;
  }

  /** Branches of the PR's BASE (target) repo — always a remote API call, since that repo may differ from the local `origin` (e.g. a fork's upstream). */
  async listTargetBranches(repoId: string, targetRepoFullName: string): Promise<{ items: string[]; error?: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    const [owner, repo] = targetRepoFullName.split('/');
    if (!owner || !repo) return { items: [], error: `Invalid repository name: ${targetRepoFullName}` };
    try {
      return { items: await target.provider.listBranches(owner, repo) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-list-branches', `Failed to load branches for ${targetRepoFullName}`, message);
      return { items: [], error: message };
    }
  }

  /** Candidate users for the reviewer/assignee pickers, scoped to the PR's BASE (target) repo. */
  async listCollaborators(repoId: string, targetRepoFullName: string): Promise<{ items: PullRequestUser[]; error?: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    const [owner, repo] = targetRepoFullName.split('/');
    if (!owner || !repo) return { items: [], error: `Invalid repository name: ${targetRepoFullName}` };
    try {
      return { items: await target.provider.listCollaborators(owner, repo) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-list-collaborators', `Failed to load collaborators for ${targetRepoFullName}`, message);
      return { items: [], error: message };
    }
  }

  async updateReviewers(repoId: string, number: number, userIds: string[]): Promise<ActionResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.updateReviewers(target.owner, target.repo, number, userIds);
    if (result.ok) this.invalidate(repoId);
    else logError('pullrequest-update-reviewers', `Failed to update reviewers for PR #${number}`, result.error);
    return result;
  }

  async updateAssignees(repoId: string, number: number, userIds: string[]): Promise<ActionResult | UnsupportedResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.updateAssignees(target.owner, target.repo, number, userIds);
    if (result.ok) this.invalidate(repoId);
    else logError('pullrequest-update-assignees', `Failed to update assignees for PR #${number}`, result.error);
    return result;
  }

  /** Every label defined on the PR's BASE (target) repo, for the label picker. */
  async listAvailableLabels(repoId: string, targetRepoFullName: string): Promise<{ items: PullRequestLabel[]; error?: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    const [owner, repo] = targetRepoFullName.split('/');
    if (!owner || !repo) return { items: [], error: `Invalid repository name: ${targetRepoFullName}` };
    try {
      return { items: await target.provider.listAvailableLabels(owner, repo) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-list-labels', `Failed to load labels for ${targetRepoFullName}`, message);
      return { items: [], error: message };
    }
  }

  async updateLabels(repoId: string, number: number, labelIds: string[]): Promise<ActionResult | UnsupportedResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.updateLabels(target.owner, target.repo, number, labelIds);
    if (result.ok) this.invalidate(repoId);
    else logError('pullrequest-update-labels', `Failed to update labels for PR #${number}`, result.error);
    return result;
  }

  async listComments(repoId: string, number: number): Promise<{ items: PullRequestComment[]; error?: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    try {
      return { items: await target.provider.listComments(target.owner, target.repo, number) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-list-comments', `Failed to load comments for PR #${number}`, message);
      return { items: [], error: message };
    }
  }

  async postComment(repoId: string, number: number, body: string): Promise<PostCommentResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.postComment(target.owner, target.repo, number, body);
    if (!result.ok) logError('pullrequest-post-comment', `Failed to post comment on PR #${number}`, result.error);
    return result;
  }

  async listChangedFiles(repoId: string, number: number): Promise<{ items: ChangedFile[]; error?: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    try {
      return { items: await target.provider.listChangedFiles(target.owner, target.repo, number) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-list-files', `Failed to load changed files for PR #${number}`, message);
      return { items: [], error: message };
    }
  }

  async getFileDiff(repoId: string, number: number, file: ChangedFile, refs: FileDiffRefs): Promise<FileDiffContent | { error: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return target;
    try {
      return await target.provider.getFileDiff(target.owner, target.repo, number, file, refs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-file-diff', `Failed to load diff for ${file.path} in PR #${number}`, message);
      return { error: message };
    }
  }

  async listCommits(repoId: string, number: number): Promise<{ items: PullRequestCommit[]; error?: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    try {
      return { items: await target.provider.listCommits(target.owner, target.repo, number) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-list-commits', `Failed to load commits for PR #${number}`, message);
      return { items: [], error: message };
    }
  }

  /** `headSha` is the PR's own `headSha` (from `PullRequestDetail`), already known to the caller once the detail has loaded — avoids a redundant detail re-fetch just to learn the commit to check. */
  async listChecks(repoId: string, headSha: string): Promise<{ items: CiCheck[]; error?: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    try {
      return { items: await target.provider.listChecks(target.owner, target.repo, headSha) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-list-checks', `Failed to load checks for commit ${headSha}`, message);
      return { items: [], error: message };
    }
  }

  async listCommitFiles(repoId: string, sha: string): Promise<{ items: ChangedFile[]; error?: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    try {
      return { items: await target.provider.listCommitFiles(target.owner, target.repo, sha) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-list-commit-files', `Failed to load changed files for commit ${sha}`, message);
      return { items: [], error: message };
    }
  }

  /** Diffs a single commit's file against its parent — reuses the same per-file blob-fetch strategy as the whole-PR diff. */
  async getCommitFileDiff(repoId: string, number: number, file: ChangedFile, commitSha: string, parentSha: string | undefined): Promise<FileDiffContent | { error: string }> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return target;
    try {
      return await target.provider.getFileDiff(target.owner, target.repo, number, file, { baseSha: parentSha ?? commitSha, headSha: commitSha });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('pullrequest-commit-file-diff', `Failed to load diff for ${file.path} in commit ${commitSha}`, message);
      return { error: message };
    }
  }

  async mergePullRequest(repoId: string, number: number, strategy: MergeStrategy): Promise<ActionResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.mergePullRequest(target.owner, target.repo, number, strategy);
    if (result.ok) this.invalidate(repoId);
    else logError('pullrequest-merge', `Failed to merge PR #${number}`, result.error);
    return result;
  }

  async closePullRequest(repoId: string, number: number): Promise<ActionResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.closePullRequest(target.owner, target.repo, number);
    if (result.ok) this.invalidate(repoId);
    else logError('pullrequest-close', `Failed to close PR #${number}`, result.error);
    return result;
  }

  async reopenPullRequest(repoId: string, number: number): Promise<ActionResult | UnsupportedResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.reopenPullRequest(target.owner, target.repo, number);
    if (result.ok) this.invalidate(repoId);
    else logError('pullrequest-reopen', `Failed to reopen PR #${number}`, result.error);
    return result;
  }

  async submitReview(repoId: string, number: number, input: SubmitReviewInput): Promise<ActionResult | UnsupportedResult> {
    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.submitReview(target.owner, target.repo, number, input);
    if (!result.ok) logError('pullrequest-review', `Failed to submit review for PR #${number}`, result.error);
    return result;
  }

  /**
   * Fetches a PR's head and checks it out locally, into one of two branch naming modes:
   * - 'pr': always a dedicated `pr/{author}/{number}` branch (never touches the real source branch name).
   * - 'branch': the PR's actual source branch name, created or updated in place — the user's explicit
   *   choice to track the real branch (e.g. to keep pushing to it), not just inspect the PR's contents.
   */
  async checkoutPullRequest(repoId: string, pr: PullRequestSummary, mode: 'pr' | 'branch'): Promise<ActionResult & { branchName?: string }> {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return { ok: false, error: 'Repository not found' };

    const target = await this.resolveProviderAndTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };

    const remotes = await repo.getRemotesWithUrls();
    if (remotes.length === 0) return { ok: false, error: 'No remote configured for this repository' };

    const safeAuthor = pr.authorName.replace(/[^a-zA-Z0-9_-]/g, '-');
    const branchName = mode === 'branch' ? pr.sourceBranch : `pr/${safeAuthor}/${pr.number}`;
    const { remote, refspec } = await target.provider.getCheckoutSource(pr);

    try {
      await repo.checkoutPullRequest(remote, refspec, branchName);
      return { ok: true, branchName };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: redactCredentialsInUrls(message) };
    }
  }
}

/** Strips embedded `user:pass@` credentials from any URL in a git error message before it's logged or shown — `getCheckoutSource` may fetch from a literal credential-embedded URL (e.g. Bitbucket) rather than a named remote, and git's own error text echoes the URL verbatim. */
export function redactCredentialsInUrls(message: string): string {
  return message.replace(/(https?:\/\/)[^/@\s]+@/g, '$1');
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
