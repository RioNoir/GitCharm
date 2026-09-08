import type {
  ActionResult, ChangedFile, CiCheck, CiStatus, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs,
  ListPullRequestsOptions, ListPullRequestsResult, MergeStrategy, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestLabel, PullRequestProvider, PullRequestSummary, PullRequestUser,
  SubmitReviewInput, UnsupportedResult, UpdatePullRequestInput,
} from '../types';
import { httpJson, HttpJsonError } from '../httpJson';

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
  };
}

/** Gitea's PR list endpoint only supports state=open|closed|all — "merged" is a client-side refinement of "closed". */
function apiState(state: ListPullRequestsOptions['state']): 'open' | 'closed' | 'all' {
  if (state === 'merged') return 'closed';
  if (state === 'all') return 'all';
  if (state === 'closed') return 'closed';
  return 'open';
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
    const params = new URLSearchParams({
      state: apiState(options.state),
      limit: String(PAGE_SIZE),
      page: String(options.page),
    });
    // Gitea's PR list has no server-side author filter — apply it client-side on this page.
    const url = `${this.apiBase()}/repos/${owner}/${repo}/pulls?${params.toString()}`;
    const { data } = await httpJson<RawGiteaPr[]>(url, { headers });
    let items = data.map(mapPr);
    if (options.state === 'merged') items = items.filter(pr => pr.state === 'merged');
    if (options.author === 'mine') {
      const username = await this.getCurrentUsername();
      if (username) items = items.filter(pr => pr.authorName === username);
    }
    return { items, hasMore: data.length === PAGE_SIZE };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGiteaIssueComment[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, { headers });
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
      const { data } = await httpJson<RawGiteaIssueComment>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, {
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
