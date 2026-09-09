import type {
  ActionResult, ChangedFile, CiCheck, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs,
  ListPullRequestsOptions, ListPullRequestsResult, MergeStrategy, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestLabel, PullRequestProvider, PullRequestStateFilter,
  PullRequestSummary, PullRequestUser, SubmitReviewInput, UnsupportedResult, UpdatePullRequestInput,
} from '../types';
import { httpJson, HttpJsonError } from '../httpJson';

const PAGE_SIZE = 30;

const CAPABILITIES: PullRequestCapabilities = {
  canMerge: true,
  mergeStrategies: ['merge', 'squash', 'rebase'],
  canClose: true,
  canReopen: true,
  hasMergeableState: true,
  canApprove: true,
  canRequestChanges: true,
  canCommentReview: true,
  hasUnifiedDiffText: true,
  canManageReviewers: true,
  canManageAssignees: true,
  canManageLabels: true,
  canFilterAssignee: true,
  canFilterReviewRequested: true,
  canFilterMentions: true,
};

interface RawGitHubPr {
  id: number;
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged_at: string | null;
  merged?: boolean;
  mergeable: boolean | null;
  mergeable_state?: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; repo: { full_name: string; permissions?: { push: boolean } } | null };
  user: { login: string; avatar_url: string } | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
  comments?: number;
  requested_reviewers?: { login: string; avatar_url: string }[];
  assignees?: { login: string; avatar_url: string }[];
  labels?: { name: string; color: string }[];
}

interface RawGitHubUser {
  login: string;
}

/** GitHub's Search API returns "issue"-shaped results — no `head`/`base`, so no branch info is available without an extra per-item fetch (deliberately not done, see mapSearchIssue). */
interface RawGitHubSearchIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  pull_request?: { merged_at: string | null };
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  updated_at: string;
  comments?: number;
  labels?: { name: string; color: string }[];
  assignees?: { login: string; avatar_url: string }[];
}

interface RawGitHubSearchResult {
  items: RawGitHubSearchIssue[];
  total_count: number;
}

interface RawGitHubIssueComment {
  id: number;
  body: string;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  html_url: string;
}

interface RawGitHubFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
}

interface RawGitHubContent {
  content: string;
  encoding: 'base64';
}

interface RawGitHubCheckRun {
  id: number;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  html_url: string;
  name: string;
  started_at?: string | null;
  completed_at?: string | null;
}

/** GitHub's legacy "commit status" API (external CI not integrated with Checks/Actions) — a separate system from check-runs, no single endpoint merges both. */
interface RawGitHubLegacyStatus {
  id: number;
  state: string;
  context: string;
  target_url: string | null;
  created_at: string;
  updated_at: string;
}

interface RawGitHubCommit {
  sha: string;
  parents: { sha: string }[];
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string; avatar_url: string } | null;
  files?: RawGitHubFile[];
}

function mapState(pr: RawGitHubPr): PullRequestSummary['state'] {
  if (pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

function mapPr(pr: RawGitHubPr): PullRequestSummary {
  const isFork = !!pr.head.repo && !!pr.base.repo && pr.head.repo.full_name !== pr.base.repo.full_name;
  return {
    id: String(pr.id),
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: mapState(pr),
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    sourceRepoFullName: isFork ? pr.head.repo!.full_name : undefined,
    targetRepoFullName: pr.base.repo?.full_name,
    authorName: pr.user?.login ?? 'unknown',
    authorAvatarUrl: pr.user?.avatar_url,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    commentCount: pr.comments,
    assignees: (pr.assignees ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
    reviewers: (pr.requested_reviewers ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
    labels: (pr.labels ?? []).map(l => ({ id: l.name, name: l.name, color: l.color })),
  };
}

function mapSearchState(issue: RawGitHubSearchIssue): PullRequestSummary['state'] {
  if (issue.pull_request?.merged_at) return 'merged';
  if (issue.state === 'closed') return 'closed';
  if (issue.draft) return 'draft';
  return 'open';
}

/** Search API results have no branch info (see RawGitHubSearchIssue) — sourceBranch/targetBranch are left empty, which the list UI hides rather than showing a bare "→". */
function mapSearchIssue(issue: RawGitHubSearchIssue): PullRequestSummary {
  return {
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: mapSearchState(issue),
    sourceBranch: '',
    targetBranch: '',
    authorName: issue.user?.login ?? 'unknown',
    authorAvatarUrl: issue.user?.avatar_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    commentCount: issue.comments,
    assignees: (issue.assignees ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
    labels: (issue.labels ?? []).map(l => ({ id: l.name, name: l.name, color: l.color })),
  };
}

function mapMergeableState(pr: RawGitHubPr): PullRequestDetail['mergeableState'] {
  if (pr.mergeable_state === 'clean') return 'mergeable';
  if (pr.mergeable_state === 'dirty' || pr.mergeable_state === 'blocked') return 'conflicting';
  return 'unknown';
}

function mapFileStatus(status: RawGitHubFile['status']): ChangedFile['status'] {
  if (status === 'added' || status === 'copied') return 'added';
  if (status === 'removed') return 'deleted';
  if (status === 'renamed') return 'renamed';
  return 'modified';
}

/**
 * GitHub's PR list endpoint only supports state=open|closed|all — "merged" is a client-side refinement of
 * "closed" (a merged PR is also `state: 'closed'` on GitHub), and an arbitrary subset of states (e.g. just
 * open+merged, excluding closed-unmerged) is likewise resolved client-side after fetching the broadest state
 * that covers the requested set.
 */
function apiState(states: PullRequestStateFilter[]): 'open' | 'closed' | 'all' {
  // GitHub has no server-side "draft" state — drafts are just open PRs with a flag, so wanting drafts means fetching "open".
  const wantsOpen = states.includes('open') || states.includes('draft');
  const wantsClosedLike = states.includes('closed') || states.includes('merged');
  if (wantsOpen && wantsClosedLike) return 'all';
  return wantsOpen ? 'open' : 'closed';
}

const REVIEW_EVENT_MAP: Record<SubmitReviewInput['event'], string> = {
  approve: 'APPROVE',
  requestChanges: 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

export class GitHubProvider implements PullRequestProvider {
  readonly kind = 'github' as const;
  private cachedUsername: string | undefined;

  constructor(
    private readonly host: string,
    private readonly getToken: () => Promise<string | undefined>,
  ) {}

  private apiBase(): string {
    return this.host === 'github.com' ? 'https://api.github.com' : `https://${this.host}/api/v3`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async hasCredentials(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  async getCurrentUsername(): Promise<string | undefined> {
    if (this.cachedUsername) return this.cachedUsername;
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitHubUser>(`${this.apiBase()}/user`, { headers });
      this.cachedUsername = data.login;
      return data.login;
    } catch {
      return undefined;
    }
  }

  getCapabilities(): PullRequestCapabilities {
    return CAPABILITIES;
  }

  async getCheckoutSource(pr: PullRequestSummary): Promise<{ remote: string; refspec: string }> {
    return { remote: 'origin', refspec: `pull/${pr.number}/head` };
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const headers = await this.headers();
    const names: string[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<{ name: string }[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/branches?per_page=100&page=${page}`, { headers },
      );
      names.push(...data.map(b => b.name));
      if (data.length < 100) break;
      page++;
    }
    return names;
  }

  async listCollaborators(owner: string, repo: string): Promise<PullRequestUser[]> {
    const headers = await this.headers();
    const users: PullRequestUser[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<{ login: string; avatar_url: string }[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/collaborators?per_page=100&page=${page}`, { headers },
      );
      users.push(...data.map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })));
      if (data.length < 100) break;
      page++;
    }
    return users;
  }

  async listAvailableLabels(owner: string, repo: string): Promise<PullRequestLabel[]> {
    const headers = await this.headers();
    const labels: PullRequestLabel[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<{ name: string; color: string }[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/labels?per_page=100&page=${page}`, { headers },
      );
      labels.push(...data.map(l => ({ id: l.name, name: l.name, color: l.color })));
      if (data.length < 100) break;
      page++;
    }
    return labels;
  }

  async listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const headers = await this.headers();

    // A bare PR number goes straight to a single get-by-number call — precise, and far cheaper than a search.
    const numberMatch = options.search?.trim().match(/^#?(\d+)$/);
    if (numberMatch) {
      try {
        const { data } = await httpJson<RawGitHubPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${numberMatch[1]}`, { headers });
        const pr = mapPr(data);
        return { items: options.states.includes(pr.state) ? [pr] : [], hasMore: false };
      } catch (err) {
        if (err instanceof HttpJsonError && err.status === 404) return { items: [], hasMore: false };
        throw err;
      }
    }

    const needsSearch = options.assignedToMe || options.reviewRequestedToMe || options.mentioningMe || !!options.search;
    if (needsSearch) {
      const username = (options.assignedToMe || options.reviewRequestedToMe || options.mentioningMe) ? await this.getCurrentUsername() : undefined;
      const qParts = [`repo:${owner}/${repo}`, 'is:pr'];
      qParts.push(...options.states.map(s => `is:${s}`));
      if (options.assignedToMe && username) qParts.push(`assignee:${username}`);
      if (options.reviewRequestedToMe && username) qParts.push(`review-requested:${username}`);
      if (options.mentioningMe && username) qParts.push(`mentions:${username}`);
      if (options.author === 'mine') {
        const authorUsername = username ?? await this.getCurrentUsername();
        if (authorUsername) qParts.push(`author:${authorUsername}`);
      }
      if (options.search) qParts.push(options.search);
      const params = new URLSearchParams({ q: qParts.join(' '), per_page: String(PAGE_SIZE), page: String(options.page) });
      const { data } = await httpJson<RawGitHubSearchResult>(`${this.apiBase()}/search/issues?${params.toString()}`, { headers });
      return { items: data.items.map(mapSearchIssue), hasMore: data.items.length === PAGE_SIZE };
    }

    const params = new URLSearchParams({
      state: apiState(options.states),
      per_page: String(PAGE_SIZE),
      page: String(options.page),
    });
    if (options.author === 'mine') {
      const username = await this.getCurrentUsername();
      if (username) params.set('creator', username);
    }
    const url = `${this.apiBase()}/repos/${owner}/${repo}/pulls?${params.toString()}`;
    const { data } = await httpJson<RawGitHubPr[]>(url, { headers });
    const items = data.map(mapPr).filter(pr => options.states.includes(pr.state));
    return { items, hasMore: data.length === PAGE_SIZE };
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitHubPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          body: input.description,
          head: input.sourceBranch,
          base: input.targetBranch,
          draft: input.draft ?? false,
        }),
      });
      return { ok: true, pr: mapPr(data) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGitHubPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, { headers });

    let ciStatus: PullRequestDetail['ciStatus'];
    try {
      const { data: checkRuns } = await httpJson<{ check_runs: RawGitHubCheckRun[] }>(
        `${this.apiBase()}/repos/${owner}/${repo}/commits/${data.head.sha}/check-runs`, { headers },
      );
      if (checkRuns.check_runs.length > 0) {
        const hasFailure = checkRuns.check_runs.some(r => r.conclusion === 'failure' || r.conclusion === 'timed_out');
        const hasPending = checkRuns.check_runs.some(r => r.status !== 'completed');
        ciStatus = {
          state: hasFailure ? 'failure' : hasPending ? 'pending' : 'success',
          url: checkRuns.check_runs[0]?.html_url,
        };
      }
    } catch {
      // CI status is non-critical — leave undefined on any failure.
    }

    return {
      ...mapPr(data),
      description: data.body ?? '',
      merged: !!data.merged_at,
      mergeableState: mapMergeableState(data),
      headSha: data.head.sha,
      baseSha: data.base.sha,
      ciStatus,
      capabilities: CAPABILITIES,
      canWrite: data.base.repo?.permissions?.push ?? false,
      reviewers: (data.requested_reviewers ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
      assignees: (data.assignees ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
      labels: (data.labels ?? []).map(l => ({ id: l.name, name: l.name, color: l.color })),
    };
  }

  /** Unions two separate systems GitHub never merges into one list: check-runs (Actions/Checks-integrated apps) and legacy commit statuses (external CI not using Checks). */
  async listChecks(owner: string, repo: string, headSha: string): Promise<CiCheck[]> {
    const headers = await this.headers();
    const [checkRuns, legacyStatuses] = await Promise.all([
      httpJson<{ check_runs: RawGitHubCheckRun[] }>(
        `${this.apiBase()}/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`, { headers },
      ).then(({ data }) => data.check_runs).catch(() => []),
      httpJson<RawGitHubLegacyStatus[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/commits/${headSha}/statuses?per_page=100`, { headers },
      ).then(({ data }) => data).catch(() => []),
    ]);

    const fromCheckRuns: CiCheck[] = checkRuns.map(r => ({
      id: String(r.id),
      name: r.name,
      state: r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped' ? 'success'
        : r.status !== 'completed' ? 'pending'
        : 'failure',
      url: r.html_url,
      startedAt: r.started_at ?? undefined,
      completedAt: r.completed_at ?? undefined,
    }));
    const fromLegacyStatuses: CiCheck[] = legacyStatuses.map(s => ({
      id: String(s.id),
      name: s.context,
      state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure',
      url: s.target_url ?? undefined,
      startedAt: s.created_at,
      completedAt: s.updated_at,
    }));
    return [...fromCheckRuns, ...fromLegacyStatuses];
  }

  async updatePullRequest(owner: string, repo: string, number: number, input: UpdatePullRequestInput): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.title, base: input.targetBranch }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GitHub has no "set reviewers" endpoint, only add/remove — diffs against the PR's current requested_reviewers first. */
  async updateReviewers(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitHubPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, { headers });
      const current = (data.requested_reviewers ?? []).map(u => u.login);
      const toAdd = userIds.filter(id => !current.includes(id));
      const toRemove = current.filter(id => !userIds.includes(id));
      if (toAdd.length > 0) {
        await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewers: toAdd }),
        });
      }
      if (toRemove.length > 0) {
        await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, {
          method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewers: toRemove }),
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GitHub PRs are issues under the hood — assignees have their own add/remove endpoints, same diff-against-current approach as reviewers. */
  async updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitHubPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, { headers });
      const current = (data.assignees ?? []).map(u => u.login);
      const toAdd = userIds.filter(id => !current.includes(id));
      const toRemove = current.filter(id => !userIds.includes(id));
      if (toAdd.length > 0) {
        await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/assignees`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ assignees: toAdd }),
        });
      }
      if (toRemove.length > 0) {
        await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/assignees`, {
          method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ assignees: toRemove }),
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GitHub's issue labels endpoint (PRs are issues under the hood) does a true replace with a single PUT, unlike reviewers/assignees which only have add/remove. */
  async updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/labels`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: labelIds }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGitHubIssueComment[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, { headers });
    return data.map(c => ({
      id: String(c.id),
      authorName: c.user?.login ?? 'unknown',
      authorAvatarUrl: c.user?.avatar_url,
      body: c.body,
      createdAt: c.created_at,
      url: c.html_url,
    }));
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitHubIssueComment>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      return {
        ok: true,
        comment: {
          id: String(data.id),
          authorName: data.user?.login ?? 'unknown',
          authorAvatarUrl: data.user?.avatar_url,
          body: data.body,
          createdAt: data.created_at,
          url: data.html_url,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listChangedFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]> {
    const headers = await this.headers();
    const files: ChangedFile[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGitHubFile[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`, { headers },
      );
      files.push(...data.map(f => ({
        path: f.filename,
        oldPath: f.previous_filename,
        status: mapFileStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
      })));
      if (data.length < 100) break;
      page++;
    }
    return files;
  }

  private async getBlobAtRef(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitHubContent>(
        `${this.apiBase()}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, { headers },
      );
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
      if (err instanceof HttpJsonError && err.status === 404) return '';
      throw err;
    }
  }

  async getFileDiff(owner: string, repo: string, number: number, file: ChangedFile, refs: FileDiffRefs): Promise<FileDiffContent> {
    const [beforeContent, afterContent] = await Promise.all([
      file.status === 'added' ? Promise.resolve('') : this.getBlobAtRef(owner, repo, file.oldPath ?? file.path, refs.baseSha),
      file.status === 'deleted' ? Promise.resolve('') : this.getBlobAtRef(owner, repo, file.path, refs.headSha),
    ]);
    return { path: file.path, oldPath: file.oldPath, beforeContent, afterContent };
  }

  async listCommits(owner: string, repo: string, number: number): Promise<PullRequestCommit[]> {
    const headers = await this.headers();
    const commits: PullRequestCommit[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGitHubCommit[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100&page=${page}`, { headers },
      );
      commits.push(...data.map(c => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 8),
        message: c.commit.message,
        authorName: c.author?.login ?? c.commit.author?.name ?? 'unknown',
        authorAvatarUrl: c.author?.avatar_url,
        authoredAt: c.commit.author?.date ?? '',
        parentSha: c.parents[0]?.sha,
      })));
      if (data.length < 100) break;
      page++;
    }
    return commits;
  }

  async listCommitFiles(owner: string, repo: string, sha: string): Promise<ChangedFile[]> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGitHubCommit>(`${this.apiBase()}/repos/${owner}/${repo}/commits/${sha}`, { headers });
    return (data.files ?? []).map(f => ({
      path: f.filename,
      oldPath: f.previous_filename,
      status: mapFileStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
    }));
  }

  async mergePullRequest(owner: string, repo: string, number: number, strategy: MergeStrategy): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}/merge`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ merge_method: strategy }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async closePullRequest(owner: string, repo: string, number: number): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reopenPullRequest(owner: string, repo: string, number: number): Promise<ActionResult | UnsupportedResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'open' }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async submitReview(owner: string, repo: string, number: number, input: SubmitReviewInput): Promise<ActionResult | UnsupportedResult> {
    if ((input.event === 'requestChanges' || input.event === 'comment') && !input.body?.trim()) {
      return { ok: false, error: 'A comment body is required for this review type' };
    }
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}/reviews`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: REVIEW_EVENT_MAP[input.event], body: input.body }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
