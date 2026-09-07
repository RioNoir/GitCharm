import type {
  ActionResult, ChangedFile, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs,
  ListPullRequestsOptions, ListPullRequestsResult, MergeStrategy, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestProvider, PullRequestSummary,
  SubmitReviewInput, UnsupportedResult,
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
  base: { ref: string; sha: string; repo: { full_name: string } | null };
  user: { login: string; avatar_url: string } | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
  comments?: number;
}

interface RawGitHubUser {
  login: string;
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
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  html_url: string;
  name: string;
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

/** GitHub's PR list endpoint only supports state=open|closed|all — "merged" is a client-side refinement of "closed". */
function apiState(state: ListPullRequestsOptions['state']): 'open' | 'closed' | 'all' {
  if (state === 'merged') return 'closed';
  if (state === 'all') return 'all';
  if (state === 'closed') return 'closed';
  return 'open';
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

  getCheckoutRefspec(number: number): string {
    return `pull/${number}/head`;
  }

  async listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const headers = await this.headers();
    const params = new URLSearchParams({
      state: apiState(options.state),
      per_page: String(PAGE_SIZE),
      page: String(options.page),
    });
    if (options.author === 'mine') {
      const username = await this.getCurrentUsername();
      if (username) params.set('creator', username);
    }
    const url = `${this.apiBase()}/repos/${owner}/${repo}/pulls?${params.toString()}`;
    const { data } = await httpJson<RawGitHubPr[]>(url, { headers });
    let items = data.map(mapPr);
    // "merged" isn't a real API state — filter the closed page down to merged-only PRs.
    if (options.state === 'merged') items = items.filter(pr => pr.state === 'merged');
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
    };
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
