import type {
  ActionResult, ChangedFile, CiCheck, CiStatus, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs,
  ListPullRequestsOptions, ListPullRequestsResult, MergeStrategy, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestEvent, PullRequestLabel, PullRequestProvider,
  PullRequestStateFilter, PullRequestSummary, PullRequestUser, SubmitReviewInput, UnsupportedResult, UpdatePullRequestInput,
} from '../types';
import { httpJson, HttpJsonError } from '../httpJson';
import { formatApiError } from '../formatApiError';

const PAGE_SIZE = 30;

const CAPABILITIES: PullRequestCapabilities = {
  canMerge: true,
  mergeStrategies: ['merge', 'squash', 'rebase', 'fastForward'],
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
  canFilterMentions: false,
};

interface RawGiteaPr {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable?: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; repo: { full_name: string } | null };
  user: { login: string; avatar_url: string } | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
  comments?: number;
  requested_reviewers?: { login: string; avatar_url: string }[];
  assignees?: { login: string; avatar_url: string }[];
  labels?: { name: string; color: string }[];
}

interface RawGiteaUser {
  login: string;
}

interface RawGiteaIssueComment {
  id: number;
  body: string;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  html_url: string;
}

/** Gitea/Forgejo's `/timeline` entries: `type` is the discriminant, most fields optional since they only
 * apply to specific types. old_title/new_title for renames, label for label add/remove, ref_issue's target
 * branch fields aren't exposed by this endpoint (no baseChanged support here, unlike GitHub). */
interface RawGiteaTimelineEntry {
  id: number;
  type: string;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  old_title?: string;
  new_title?: string;
  label?: { name: string; color: string };
  assignee?: { login: string; avatar_url: string } | null;
}

interface RawGiteaFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'changed';
  additions: number;
  deletions: number;
}

interface RawGiteaContent {
  content: string;
  encoding: 'base64';
}

interface RawGiteaCommit {
  sha: string;
  parents?: { sha: string }[];
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string; avatar_url: string } | null;
  files?: RawGiteaFile[];
}

interface RawGiteaCombinedStatus {
  state: 'pending' | 'success' | 'error' | 'failure' | 'warning' | string;
  statuses?: { target_url?: string }[];
}

interface RawGiteaStatus {
  id: number;
  status: 'pending' | 'success' | 'error' | 'failure' | 'warning' | string;
  context: string;
  target_url?: string;
  created_at?: string;
  updated_at?: string;
}

function mapFileStatus(status: RawGiteaFile['status']): ChangedFile['status'] {
  if (status === 'added' || status === 'copied') return 'added';
  if (status === 'deleted') return 'deleted';
  if (status === 'renamed') return 'renamed';
  return 'modified';
}

function mapMergeableState(pr: RawGiteaPr): PullRequestDetail['mergeableState'] {
  if (pr.mergeable === true) return 'mergeable';
  if (pr.mergeable === false) return 'conflicting';
  return 'unknown';
}

const REVIEW_EVENT_MAP: Record<SubmitReviewInput['event'], string> = {
  approve: 'APPROVED',
  requestChanges: 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

function mapState(pr: RawGiteaPr): PullRequestSummary['state'] {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

function mapPr(pr: RawGiteaPr): PullRequestSummary {
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
    labels: (pr.labels ?? []).map(l => ({ id: l.name, name: l.name, color: l.color.replace(/^#/, '') })),
  };
}

/**
 * Gitea's PR list endpoint only supports state=open|closed|all — "merged" is a client-side refinement of
 * "closed", and an arbitrary subset of states is likewise resolved client-side after fetching the broadest
 * state that covers the requested set.
 */
function apiState(states: PullRequestStateFilter[]): 'open' | 'closed' | 'all' {
  // Gitea has no server-side "draft" state — drafts are just open PRs with a flag, so wanting drafts means fetching "open".
  const wantsOpen = states.includes('open') || states.includes('draft');
  const wantsClosedLike = states.includes('closed') || states.includes('merged');
  if (wantsOpen && wantsClosedLike) return 'all';
  return wantsOpen ? 'open' : 'closed';
}

function parseXTotalCount(headers: Headers): number | undefined {
  const raw = headers.get('x-total-count');
  if (!raw) return undefined;
  const total = Number(raw);
  return Number.isFinite(total) ? total : undefined;
}

export class GiteaProvider implements PullRequestProvider {
  readonly kind = 'gitea' as const;
  private cachedUsername: string | undefined;

  constructor(
    private readonly host: string,
    private readonly getToken: () => Promise<string | undefined>,
  ) {}

  private apiBase(): string {
    return `https://${this.host}/api/v1`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `token ${token}`;
    return headers;
  }

  async hasCredentials(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  async getCurrentUsername(): Promise<string | undefined> {
    if (this.cachedUsername) return this.cachedUsername;
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGiteaUser>(`${this.apiBase()}/user`, { headers });
      this.cachedUsername = data.login;
      return data.login;
    } catch {
      return undefined;
    }
  }

  async listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const headers = await this.headers();

    // A bare PR number goes straight to a single get-by-number call — precise, and far cheaper than a search.
    const numberMatch = options.search?.trim().match(/^#?(\d+)$/);
    if (numberMatch) {
      try {
        const { data } = await httpJson<RawGiteaPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${numberMatch[1]}`, { headers });
        const pr = mapPr(data);
        return { items: options.states.includes(pr.state) ? [pr] : [], hasMore: false };
      } catch (err) {
        if (err instanceof HttpJsonError && err.status === 404) return { items: [], hasMore: false };
        throw err;
      }
    }

    // Assigned/review-requested/search deviate to the issues endpoint (Gitea PRs are issues under the hood, same
    // trick already used elsewhere in this provider for assignees/labels) — the plain /pulls list has no such filters.
    if (options.assignedToMe || options.reviewRequestedToMe || options.search) {
      const params = new URLSearchParams({
        type: 'pulls', state: apiState(options.states), limit: String(PAGE_SIZE), page: String(options.page),
      });
      if (options.assignedToMe) params.set('assigned', 'true');
      if (options.search) params.set('q', options.search);
      if (options.reviewRequestedToMe) params.set('review_requested', 'true');
      let data: RawGiteaPr[];
      try {
        ({ data } = await httpJson<RawGiteaPr[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues?${params.toString()}`, { headers }));
      } catch (err) {
        // review_requested isn't supported on older Gitea/Forgejo versions — retry once without it rather than failing the whole list.
        if (options.reviewRequestedToMe && err instanceof HttpJsonError && err.status >= 400 && err.status < 500) {
          params.delete('review_requested');
          ({ data } = await httpJson<RawGiteaPr[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues?${params.toString()}`, { headers }));
        } else {
          throw err;
        }
      }
      let items = data.map(mapPr).filter(pr => options.states.includes(pr.state));
      if (options.author === 'mine') {
        const username = await this.getCurrentUsername();
        if (username) items = items.filter(pr => pr.authorName === username);
      }
      return { items, hasMore: data.length === PAGE_SIZE };
    }

    const serverState = apiState(options.states);
    const params = new URLSearchParams({
      state: serverState,
      limit: String(PAGE_SIZE),
      page: String(options.page),
    });
    // Gitea's PR list has no server-side author filter — apply it client-side on this page.
    const url = `${this.apiBase()}/repos/${owner}/${repo}/pulls?${params.toString()}`;
    const { data, headers: responseHeaders } = await httpJson<RawGiteaPr[]>(url, { headers });
    // Drafts have no dedicated filter state — they fall under "open".
    let items = data.map(mapPr).filter(pr => options.states.includes(pr.state));
    // X-Total-Count reflects the server-side `state` filter only — reliable exactly when that filter isn't
    // further narrowed client-side: "open" alone (server state === requested states, drafts included either
    // way), and no client-side author filter (which would otherwise cut items the header still counts).
    const canTrustTotal = serverState === 'open' && !options.states.includes('closed') && !options.states.includes('merged')
      && options.author !== 'mine';
    if (options.author === 'mine') {
      const username = await this.getCurrentUsername();
      if (username) items = items.filter(pr => pr.authorName === username);
    }
    return { items, hasMore: data.length === PAGE_SIZE, totalCount: canTrustTotal ? parseXTotalCount(responseHeaders) : undefined };
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGiteaPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          body: input.description,
          head: input.sourceBranch,
          base: input.targetBranch,
        }),
      });
      return { ok: true, pr: mapPr(data) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  getCapabilities(): PullRequestCapabilities {
    return CAPABILITIES;
  }

  async getCheckoutSource(pr: PullRequestSummary): Promise<{ remote: string; refspec: string }> {
    // Gitea/Forgejo expose PR branches as regular refs under refs/pull/{index}/head, mirroring GitHub.
    return { remote: 'origin', refspec: `pull/${pr.number}/head` };
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const headers = await this.headers();
    const names: string[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<{ name: string }[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/branches?limit=100&page=${page}`, { headers },
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
        `${this.apiBase()}/repos/${owner}/${repo}/collaborators?limit=100&page=${page}`, { headers },
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
        `${this.apiBase()}/repos/${owner}/${repo}/labels?limit=100&page=${page}`, { headers },
      );
      labels.push(...data.map(l => ({ id: l.name, name: l.name, color: l.color.replace(/^#/, '') })));
      if (data.length < 100) break;
      page++;
    }
    return labels;
  }

  /** Gitea's combined-status endpoint covers both externally-posted CI statuses and native Gitea Actions runs (Actions publishes one status entry per job through this same system) — already aggregated server-side into one `state`. */
  private async getCiStatusForRef(owner: string, repo: string, ref: string): Promise<CiStatus | undefined> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGiteaCombinedStatus>(`${this.apiBase()}/repos/${owner}/${repo}/commits/${ref}/status`, { headers });
    if (!data.statuses || data.statuses.length === 0) return undefined;
    const state: CiStatus['state'] =
      data.state === 'success' ? 'success'
      : data.state === 'pending' ? 'pending'
      : 'failure';
    return { state, url: data.statuses[0]?.target_url };
  }

  /** The plural raw-list endpoint (as opposed to the singular combined-view one used for the aggregate) — one entry per CI system/Actions job, `context` doubling as the check's name. Paginated at 50/page: Gitea's server-side response-size cap defaults lower than GitHub/GitLab/Bitbucket's 100 and is admin-configurable on self-hosted instances, so this doesn't assume a higher ceiling holds. */
  async listChecks(owner: string, repo: string, headSha: string): Promise<CiCheck[]> {
    const headers = await this.headers();
    const statuses: RawGiteaStatus[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGiteaStatus[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/commits/${headSha}/statuses?limit=50&page=${page}`, { headers },
      );
      statuses.push(...data);
      if (data.length < 50) break;
      page++;
    }
    return statuses.map(s => ({
      id: String(s.id),
      name: s.context,
      state: s.status === 'success' ? 'success' : s.status === 'pending' ? 'pending' : 'failure',
      url: s.target_url,
      startedAt: s.created_at,
      completedAt: s.updated_at,
    }));
  }

  async getPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGiteaPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, { headers });

    // Both lookups below are independent, best-effort extras on top of the PR itself — run them in parallel.
    const [canWrite, ciStatus] = await Promise.all([
      (async () => {
        try {
          const { data: repoData } = await httpJson<{ permissions?: { push?: boolean } }>(`${this.apiBase()}/repos/${owner}/${repo}`, { headers });
          return repoData.permissions?.push ?? false;
        } catch {
          // Permission check is best-effort — default to no write access rather than fail the whole detail load.
          return false;
        }
      })(),
      this.getCiStatusForRef(owner, repo, data.head.sha).catch(() => undefined),
    ]);

    return {
      ...mapPr(data),
      description: data.body ?? '',
      merged: data.merged,
      mergeableState: mapMergeableState(data),
      headSha: data.head.sha,
      baseSha: data.base.sha,
      ciStatus,
      capabilities: CAPABILITIES,
      canWrite,
      reviewers: (data.requested_reviewers ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
      assignees: (data.assignees ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
      labels: (data.labels ?? []).map(l => ({ id: l.name, name: l.name, color: l.color.replace(/^#/, '') })),
    };
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
      return { ok: false, error: formatApiError(err) };
    }
  }

  /** Gitea/Forgejo mirror GitHub's schema — add/remove only, no direct "set" — diff against the PR's current requested_reviewers. */
  async updateReviewers(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGiteaPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, { headers });
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
      return { ok: false, error: formatApiError(err) };
    }
  }

  /** Gitea PRs are issues under the hood, same as GitHub — assignees use the issues endpoint. */
  async updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGiteaPr>(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}`, { headers });
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
      return { ok: false, error: formatApiError(err) };
    }
  }

  /** Gitea/Forgejo's issue-labels PUT endpoint does a true replace, and accepts label names directly alongside numeric IDs. */
  async updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/labels`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: labelIds }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  /** Gitea/Forgejo lets anyone with repo push access edit/delete ANY comment, not just their own — same rule
   * already used for canWrite in getPullRequestDetail. */
  private async getRepoCanWrite(owner: string, repo: string, headers: Record<string, string>): Promise<boolean> {
    try {
      const { data } = await httpJson<{ permissions?: { push?: boolean } }>(`${this.apiBase()}/repos/${owner}/${repo}`, { headers });
      return data.permissions?.push ?? false;
    } catch {
      return false;
    }
  }

  private mapComment(c: RawGiteaIssueComment, currentUsername: string | undefined, canWrite: boolean): PullRequestComment {
    const isOwn = !!currentUsername && c.user?.login === currentUsername;
    return {
      id: String(c.id),
      authorName: c.user?.login ?? 'unknown',
      authorAvatarUrl: c.user?.avatar_url,
      body: c.body,
      createdAt: c.created_at,
      url: c.html_url,
      canEdit: isOwn || canWrite,
      canDelete: isOwn || canWrite,
      canHide: false,
    };
  }

  async listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]> {
    const headers = await this.headers();
    const [{ data }, currentUsername, canWrite] = await Promise.all([
      httpJson<RawGiteaIssueComment[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, { headers }),
      this.getCurrentUsername(),
      this.getRepoCanWrite(owner, repo, headers),
    ]);
    return data.map(c => this.mapComment(c, currentUsername, canWrite));
  }

  /** Gitea/Forgejo's issue timeline endpoint is structurally similar to GitHub's (same lineage), returning a
   * single flat array of typed entries rather than GitHub's split REST/GraphQL story — no pagination loop
   * since `listComments` above already doesn't paginate this same issue-number-scoped API family. */
  async listEvents(owner: string, repo: string, number: number): Promise<PullRequestEvent[]> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGiteaTimelineEntry[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/timeline`, { headers });
    return data.map(mapGiteaTimelineEntry).filter((e): e is PullRequestEvent => e !== null);
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, currentUsername, canWrite] = await Promise.all([
        httpJson<RawGiteaIssueComment>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }),
        this.getCurrentUsername(),
        this.getRepoCanWrite(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapComment(data, currentUsername, canWrite) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateComment(owner: string, repo: string, _number: number, commentId: string, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, currentUsername, canWrite] = await Promise.all([
        httpJson<RawGiteaIssueComment>(`${this.apiBase()}/repos/${owner}/${repo}/issues/comments/${commentId}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }),
        this.getCurrentUsername(),
        this.getRepoCanWrite(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapComment(data, currentUsername, canWrite) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async deleteComment(owner: string, repo: string, _number: number, commentId: string): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/comments/${commentId}`, { method: 'DELETE', headers });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async hideComment(): Promise<UnsupportedResult> {
    return { ok: false, unsupported: true, error: 'Gitea has no concept of hiding a comment.' };
  }

  async unhideComment(): Promise<UnsupportedResult> {
    return { ok: false, unsupported: true, error: 'Gitea has no concept of hiding a comment.' };
  }

  async listChangedFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]> {
    const headers = await this.headers();
    const files: ChangedFile[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGiteaFile[]>(
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
      const { data } = await httpJson<RawGiteaContent>(
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
      const { data } = await httpJson<RawGiteaCommit[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100&page=${page}`, { headers },
      );
      commits.push(...data.map(c => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 8),
        message: c.commit.message,
        authorName: c.author?.login ?? c.commit.author?.name ?? 'unknown',
        authorAvatarUrl: c.author?.avatar_url,
        authoredAt: c.commit.author?.date ?? '',
        parentSha: c.parents?.[0]?.sha,
      })));
      if (data.length < 100) break;
      page++;
    }
    return commits;
  }

  async listCommitFiles(owner: string, repo: string, sha: string): Promise<ChangedFile[]> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGiteaCommit>(`${this.apiBase()}/repos/${owner}/${repo}/commits/${sha}`, { headers });
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
    // Gitea's merge "Do" enum: 'merge' | 'rebase' | 'rebase-merge' | 'squash' (also 'manually-merged', not used here).
    // 'rebase-merge' (rebase then create a merge commit) is the closest analog to our 'fastForward' option —
    // this mapping is a best-effort assumption and should be verified against a real Gitea/Forgejo instance.
    const doMap: Record<MergeStrategy, string> = {
      merge: 'merge',
      squash: 'squash',
      rebase: 'rebase',
      fastForward: 'rebase-merge',
    };
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/pulls/${number}/merge`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Do: doMap[strategy] }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async closePullRequest(owner: string, repo: string, number: number): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async reopenPullRequest(owner: string, repo: string, number: number): Promise<ActionResult | UnsupportedResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'open' }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
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
      return { ok: false, error: formatApiError(err) };
    }
  }
}

function mapGiteaTimelineEntry(entry: RawGiteaTimelineEntry): PullRequestEvent | null {
  const actorName = entry.user?.login ?? 'unknown';
  const actorAvatarUrl = entry.user?.avatar_url;
  const base = { id: String(entry.id), actorName, actorAvatarUrl, createdAt: entry.created_at };
  switch (entry.type) {
    case 'change_title':
      return { ...base, kind: 'renamed', previousTitle: entry.old_title, newTitle: entry.new_title };
    case 'label':
      return entry.label ? { ...base, kind: 'labeled', label: { id: entry.label.name, name: entry.label.name, color: entry.label.color.replace(/^#/, '') } } : null;
    case 'close':
      return { ...base, kind: 'closed' };
    case 'reopen':
      return { ...base, kind: 'reopened' };
    case 'merge_pull':
      return { ...base, kind: 'merged' };
    case 'assignees':
      return entry.assignee ? { ...base, kind: 'assigned', user: { id: entry.assignee.login, username: entry.assignee.login, avatarUrl: entry.assignee.avatar_url } } : null;
    default:
      return null;
  }
}
