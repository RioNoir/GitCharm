import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import type { ActionResult, PostCommentResult, PullRequestConnectionStatus, PullRequestLabel, PullRequestUser, UnsupportedResult } from '../pullRequests/types';
import { logError, logWarn } from '../utils/Logger';
import { createIssueProvider } from './IssueProviderFactory';
import {
  IssueTrackerDisabledError,
  type CreateIssueInput, type CreateIssueResult, type IssueAuthorFilter, type IssueCapabilities, type IssueComment, type IssueDetail,
  type IssueEvent, type IssueProvider, type IssueStateFilter, type IssueSummary, type LinkedIssue, type LinkedPullRequest,
  type ListIssuesOptions, type UpdateIssueInput,
} from './types';

const CACHE_TTL_MS = 45_000;

export interface IssueFilters {
  /** Non-empty set of states to include. */
  states: IssueStateFilter[];
  author: IssueAuthorFilter;
  assignedToMe: boolean;
  mentioningMe: boolean;
  /** Free-text search, or a bare issue number. Empty string = no search. */
  search: string;
}

export const DEFAULT_ISSUE_FILTERS: IssueFilters = { states: ['open'], author: 'all', assignedToMe: false, mentioningMe: false, search: '' };

/** The filters a repo starts with until they're changed for it — gitcharm.issues.defaultFilter. */
function configuredDefaultFilters(): IssueFilters {
  switch (vscode.workspace.getConfiguration('gitcharm.issues').get<string>('defaultFilter', 'open')) {
    case 'mine': return { ...DEFAULT_ISSUE_FILTERS, author: 'mine' };
    case 'assignedToMe': return { ...DEFAULT_ISSUE_FILTERS, assignedToMe: true };
    case 'mentioningMe': return { ...DEFAULT_ISSUE_FILTERS, mentioningMe: true };
    default: return DEFAULT_ISSUE_FILTERS;
  }
}

function isIssueFilters(v: unknown): v is IssueFilters {
  if (!v || typeof v !== 'object') return false;
  const f = v as Partial<IssueFilters>;
  return Array.isArray(f.states) && f.states.length > 0 && f.states.every(s => s === 'open' || s === 'closed')
    && (f.author === 'all' || f.author === 'mine')
    && typeof f.assignedToMe === 'boolean' && typeof f.mentioningMe === 'boolean' && typeof f.search === 'string';
}

function sameFilters(a: IssueFilters, b: IssueFilters): boolean {
  return a.author === b.author && a.assignedToMe === b.assignedToMe && a.mentioningMe === b.mentioningMe && a.search === b.search
    && a.states.length === b.states.length && a.states.every(s => b.states.includes(s));
}

function toListOptions(filters: IssueFilters, cursor?: string): ListIssuesOptions {
  return {
    states: filters.states, author: filters.author, assignedToMe: filters.assignedToMe, mentioningMe: filters.mentioningMe,
    search: filters.search || undefined, cursor,
  };
}

export interface RepoIssues {
  repoId: string;
  repoName: string;
  repoColor: string;
  /** Same connection as the Pull Requests tab — one account per repository serves both. */
  connection: PullRequestConnectionStatus;
  issues: IssueSummary[];
  hasMore: boolean;
  /** Cursor of the next page (see ListIssuesOptions.cursor). */
  nextCursor?: string;
  totalCount?: number;
  /** The repository has its issue tracker turned off. */
  trackerDisabled?: boolean;
  error?: string;
  /** Client-side only placeholder while this repo's result is still streaming in. Never set by the host. */
  pending?: boolean;
}

interface CacheEntry {
  expiresAt: number;
  filters: IssueFilters;
  data: RepoIssues;
}

const REPO_ISSUE_FILTERS_KEY = 'gitcharm.issues.repoFilters';

/** Lists and edits issues, on the forge connection PullRequestManager already holds for each repository. */
export class IssueManager {
  private cache = new Map<string, CacheEntry>();
  private providerCache = new Map<string, IssueProvider>();

  constructor(
    private readonly manager: WorkspaceGitManager,
    private readonly pullRequestManager: PullRequestManager,
    private readonly workspaceState: vscode.Memento,
  ) {
    // An account switch or a forge override drops the PR provider; the issue provider holds the same credentials.
    pullRequestManager.onDidInvalidate(repoId => {
      if (repoId) this.providerCache.delete(repoId);
      else this.providerCache.clear();
    });
  }

  invalidate(repoId?: string): void {
    if (repoId) {
      this.cache.delete(repoId);
      this.providerCache.delete(repoId);
    } else {
      this.cache.clear();
      this.providerCache.clear();
    }
  }

  private repoFilters(): Record<string, IssueFilters> {
    return this.workspaceState.get<Record<string, IssueFilters>>(REPO_ISSUE_FILTERS_KEY, {});
  }

  getFiltersForRepo(repoId: string): IssueFilters {
    const stored = this.repoFilters()[repoId];
    return stored && isIssueFilters(stored) ? stored : configuredDefaultFilters();
  }

  async setFiltersForRepo(repoId: string, filters: IssueFilters): Promise<void> {
    await this.workspaceState.update(REPO_ISSUE_FILTERS_KEY, { ...this.repoFilters(), [repoId]: filters });
    this.cache.delete(repoId);
  }

  private async resolveTarget(repoId: string): Promise<{ owner: string; repo: string; provider: IssueProvider } | { error: string }> {
    const context = await this.pullRequestManager.resolveForgeContext(repoId);
    if (!context) return { error: vscode.l10n.t('Unable to resolve provider for this repo') };
    let provider = this.providerCache.get(repoId);
    if (!provider) {
      provider = createIssueProvider(context.parsed, context.deps) ?? undefined;
      if (!provider) return { error: vscode.l10n.t('Unsupported or undetected provider for this repo') };
      this.providerCache.set(repoId, provider);
    }
    return { owner: context.owner, repo: context.repo, provider };
  }

  async getCapabilities(repoId: string): Promise<IssueCapabilities | null> {
    const target = await this.resolveTarget(repoId);
    return 'error' in target ? null : target.provider.getCapabilities();
  }

  async getCurrentUsername(repoId: string): Promise<string | undefined> {
    const target = await this.resolveTarget(repoId);
    return 'error' in target ? undefined : target.provider.getCurrentUsername();
  }

  /** "owner/repo" of the repository's forge project — what label, assignee and mention lookups are scoped to. */
  async getRepoFullName(repoId: string): Promise<string | undefined> {
    const target = await this.resolveTarget(repoId);
    return 'error' in target ? undefined : `${target.owner}/${target.repo}`;
  }

  /** Loads the first page for a repo under its own persisted filters, replacing any cached pages for that repo. */
  async listForRepo(repoId: string, repoName: string, repoColor: string, forceRefresh = false): Promise<RepoIssues> {
    const filters = this.getFiltersForRepo(repoId);
    const cached = this.cache.get(repoId);
    if (!forceRefresh && cached && sameFilters(cached.filters, filters) && cached.expiresAt > Date.now()) return cached.data;

    const connection = await this.pullRequestManager.getConnectionStatus(repoId);
    let result: RepoIssues;
    if (connection.detectionFailed || !connection.connected) {
      result = { repoId, repoName, repoColor, connection, issues: [], hasMore: false };
    } else {
      const target = await this.resolveTarget(repoId);
      if ('error' in target) {
        result = { repoId, repoName, repoColor, connection, issues: [], hasMore: false, error: target.error };
      } else {
        try {
          const { items, nextCursor, totalCount } = await target.provider.listIssues(target.owner, target.repo, toListOptions(filters));
          result = { repoId, repoName, repoColor, connection, issues: items, hasMore: !!nextCursor, nextCursor, totalCount };
        } catch (err) {
          if (err instanceof IssueTrackerDisabledError) {
            result = { repoId, repoName, repoColor, connection, issues: [], hasMore: false, trackerDisabled: true };
          } else {
            const message = err instanceof Error ? err.message : String(err);
            logError('issue-list', `Failed to list issues for ${repoName}`, message);
            result = { repoId, repoName, repoColor, connection, issues: [], hasMore: false, error: message };
          }
        }
      }
    }

    this.cache.set(repoId, { data: result, filters, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  /** Loads the next page for a repo and appends it to the cached list — used by infinite scroll. */
  async loadMore(repoId: string): Promise<RepoIssues | null> {
    const filters = this.getFiltersForRepo(repoId);
    const cached = this.cache.get(repoId);
    if (!cached || !sameFilters(cached.filters, filters) || !cached.data.nextCursor) return cached?.data ?? null;

    const target = await this.resolveTarget(repoId);
    if ('error' in target) return cached.data;
    try {
      const { items, nextCursor } = await target.provider.listIssues(target.owner, target.repo, toListOptions(filters, cached.data.nextCursor));
      const seen = new Set(cached.data.issues.map(i => i.number));
      const result: RepoIssues = {
        ...cached.data,
        issues: [...cached.data.issues, ...items.filter(i => !seen.has(i.number))],
        hasMore: !!nextCursor,
        nextCursor,
      };
      this.cache.set(repoId, { data: result, filters, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('issue-load-more', `Failed to load more issues for ${cached.data.repoName}`, message);
      const result: RepoIssues = { ...cached.data, error: message };
      this.cache.set(repoId, { data: result, filters, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }
  }

  private eligibleRepoMetas() {
    return this.manager.getRepoMetas().filter(m => (m.depth ?? 0) === 0 && !m.isWorktree);
  }

  eligibleRepoIds(): string[] {
    return this.eligibleRepoMetas().map(m => m.id);
  }

  async getAllIssues(forceRefresh = false): Promise<RepoIssues[]> {
    const metas = this.eligibleRepoMetas();
    const results = await Promise.allSettled(metas.map(meta => this.listForRepo(meta.id, meta.name, meta.color, forceRefresh)));
    return results.map((r, i) => r.status === 'fulfilled'
      ? r.value
      : {
          repoId: metas[i].id, repoName: metas[i].name, repoColor: metas[i].color,
          connection: { repoId: metas[i].id, provider: 'unknown' as const, host: '', connected: false, detectionFailed: true },
          issues: [], hasMore: false, error: String(r.reason),
        });
  }

  /** Reports each repo's result as soon as it's ready, so the slowest forge doesn't hold the whole tab back. */
  async getAllIssuesStreaming(forceRefresh: boolean, onRepoReady: (repo: RepoIssues) => void): Promise<void> {
    await Promise.all(this.eligibleRepoMetas().map(async meta => {
      try {
        onRepoReady(await this.listForRepo(meta.id, meta.name, meta.color, forceRefresh));
      } catch (err) {
        onRepoReady({
          repoId: meta.id, repoName: meta.name, repoColor: meta.color,
          connection: { repoId: meta.id, provider: 'unknown' as const, host: '', connected: false, detectionFailed: true },
          issues: [], hasMore: false, error: String(err),
        });
      }
    }));
  }

  /** Open issues matching `query` (a title fragment or a number), for the commit message's issue reference picker. */
  async searchOpenIssues(repoId: string, query: string): Promise<{ items: IssueSummary[]; error?: string }> {
    const target = await this.resolveTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    try {
      const { items } = await target.provider.listIssues(target.owner, target.repo, {
        states: ['open'], author: 'all', search: query.trim() || undefined,
      });
      return { items };
    } catch (err) {
      if (err instanceof IssueTrackerDisabledError) return { items: [], error: vscode.l10n.t('The issue tracker is turned off for this repository.') };
      const message = err instanceof Error ? err.message : String(err);
      logWarn('issue-search', `Failed to search issues`, message);
      return { items: [], error: message };
    }
  }

  async getIssueDetail(repoId: string, number: number): Promise<IssueDetail | { error: string }> {
    const target = await this.resolveTarget(repoId);
    if ('error' in target) return target;
    try {
      return await target.provider.getIssueDetail(target.owner, target.repo, number);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('issue-detail', `Failed to load detail for issue #${number}`, message);
      return { error: message };
    }
  }

  async createIssue(repoId: string, input: CreateIssueInput): Promise<CreateIssueResult> {
    const target = await this.resolveTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await target.provider.createIssue(target.owner, target.repo, input);
    if (result.ok) this.cache.delete(repoId);
    if (result.error) logError('issue-create', `Failed to create issue for ${target.owner}/${target.repo}`, result.error);
    return result;
  }

  /** Runs one of the provider's write actions, logging failures and dropping the repo's cached list on success. */
  private async runAction<R extends ActionResult | UnsupportedResult | PostCommentResult>(
    repoId: string, logContext: string, describe: string, action: (provider: IssueProvider, owner: string, repo: string) => Promise<R>,
  ): Promise<R | ActionResult> {
    const target = await this.resolveTarget(repoId);
    if ('error' in target) return { ok: false, error: target.error };
    const result = await action(target.provider, target.owner, target.repo);
    if (result.ok) this.cache.delete(repoId);
    else if (!('unsupported' in result)) logError(logContext, `Failed to ${describe}`, result.error);
    return result;
  }

  updateIssue(repoId: string, number: number, input: UpdateIssueInput): Promise<ActionResult> {
    return this.runAction(repoId, 'issue-update', `update issue #${number}`, (p, o, r) => p.updateIssue(o, r, number, input));
  }

  closeIssue(repoId: string, number: number): Promise<ActionResult> {
    return this.runAction(repoId, 'issue-close', `close issue #${number}`, (p, o, r) => p.closeIssue(o, r, number));
  }

  reopenIssue(repoId: string, number: number): Promise<ActionResult> {
    return this.runAction(repoId, 'issue-reopen', `reopen issue #${number}`, (p, o, r) => p.reopenIssue(o, r, number));
  }

  updateAssignees(repoId: string, number: number, userIds: string[]): Promise<ActionResult | UnsupportedResult> {
    return this.runAction(repoId, 'issue-update-assignees', `update assignees for issue #${number}`, (p, o, r) => p.updateAssignees(o, r, number, userIds));
  }

  updateLabels(repoId: string, number: number, labelIds: string[]): Promise<ActionResult | UnsupportedResult> {
    return this.runAction(repoId, 'issue-update-labels', `update labels for issue #${number}`, (p, o, r) => p.updateLabels(o, r, number, labelIds));
  }

  postComment(repoId: string, number: number, body: string): Promise<PostCommentResult> {
    return this.runAction(repoId, 'issue-post-comment', `post comment on issue #${number}`, (p, o, r) => p.postComment(o, r, number, body));
  }

  updateComment(repoId: string, number: number, commentId: string, body: string): Promise<PostCommentResult> {
    return this.runAction(repoId, 'issue-update-comment', `update comment ${commentId} on issue #${number}`, (p, o, r) => p.updateComment(o, r, number, commentId, body));
  }

  deleteComment(repoId: string, number: number, commentId: string): Promise<ActionResult> {
    return this.runAction(repoId, 'issue-delete-comment', `delete comment ${commentId} on issue #${number}`, (p, o, r) => p.deleteComment(o, r, number, commentId));
  }

  /** Runs one of the provider's list calls, turning a failure into a logged `{items: [], error}`. */
  private async runList<T>(repoId: string, logContext: string, describe: string, list: (provider: IssueProvider, owner: string, repo: string) => Promise<T[]>): Promise<{ items: T[]; error?: string }> {
    const target = await this.resolveTarget(repoId);
    if ('error' in target) return { items: [], error: target.error };
    try {
      return { items: await list(target.provider, target.owner, target.repo) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(logContext, `Failed to load ${describe}`, message);
      return { items: [], error: message };
    }
  }

  listComments(repoId: string, number: number): Promise<{ items: IssueComment[]; error?: string }> {
    return this.runList(repoId, 'issue-list-comments', `comments for issue #${number}`, (p, o, r) => p.listComments(o, r, number));
  }

  listEvents(repoId: string, number: number): Promise<{ items: IssueEvent[]; error?: string }> {
    return this.runList(repoId, 'issue-list-events', `events for issue #${number}`, (p, o, r) => p.listEvents(o, r, number));
  }

  listLinkedPullRequests(repoId: string, number: number): Promise<{ items: LinkedPullRequest[]; error?: string }> {
    return this.runList(repoId, 'issue-linked-prs', `pull requests linked to issue #${number}`, (p, o, r) => p.listLinkedPullRequests(o, r, number));
  }

  listIssuesClosedByPullRequest(repoId: string, prNumber: number, prDescription: string): Promise<{ items: LinkedIssue[]; error?: string }> {
    return this.runList(repoId, 'pullrequest-linked-issues', `issues closed by PR #${prNumber}`, (p, o, r) => p.listIssuesClosedByPullRequest(o, r, prNumber, prDescription));
  }

  /** Candidate assignees — the repository members the PR reviewer picker also lists. */
  async listAssignableUsers(repoId: string): Promise<{ items: PullRequestUser[]; error?: string }> {
    const fullName = await this.getRepoFullName(repoId);
    if (!fullName) return { items: [], error: vscode.l10n.t('Unable to resolve provider for this repo') };
    return this.pullRequestManager.listCollaborators(repoId, fullName);
  }

  /** Every label defined on the repository — the same list the PR label picker shows. */
  async listAvailableLabels(repoId: string): Promise<{ items: PullRequestLabel[]; error?: string }> {
    const fullName = await this.getRepoFullName(repoId);
    if (!fullName) return { items: [], error: vscode.l10n.t('Unable to resolve provider for this repo') };
    return this.pullRequestManager.listAvailableLabels(repoId, fullName);
  }

  listMentionCandidates(repoId: string): Promise<PullRequestUser[]> {
    return this.pullRequestManager.listMentionCandidates(repoId);
  }
}

/**
 * A branch name for an issue, from gitcharm.issues.branchNameTemplate: `{number}`, `{title}` (lowercased, words
 * joined by hyphens, cut at 50 characters) and `{user}` (the forge username). Final sanitizing is left to the
 * branch name prompt, which applies the same rules as the built-in Git extension.
 */
export function issueBranchName(issue: Pick<IssueSummary, 'number' | 'title'>, username: string | undefined): string {
  const template = vscode.workspace.getConfiguration('gitcharm.issues').get<string>('branchNameTemplate', '{number}-{title}') || '{number}-{title}';
  const slug = issue.title
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return template
    .replace(/\{number\}/g, String(issue.number))
    .replace(/\{title\}/g, slug || 'issue')
    .replace(/\{user\}/g, (username ?? '').trim().replace(/\s+/g, '-').toLowerCase())
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '');
}

/** The text inserted into a commit message for an issue, from gitcharm.issues.commitReferenceTemplate. */
export function issueCommitReference(issue: Pick<IssueSummary, 'number' | 'title'>): string {
  const template = vscode.workspace.getConfiguration('gitcharm.issues').get<string>('commitReferenceTemplate', '#{number}') || '#{number}';
  return template.replace(/\{number\}/g, String(issue.number)).replace(/\{title\}/g, issue.title);
}
