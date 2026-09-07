import type {
  ActionResult, ChangedFile, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent,
  ListPullRequestsOptions, ListPullRequestsResult, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestProvider, PullRequestSummary, UnsupportedResult,
} from '../types';
import { httpJson } from '../httpJson';

const PAGE_SIZE = 30;

const CAPABILITIES: PullRequestCapabilities = {
  canMerge: true,
  mergeStrategies: ['merge', 'squash'],
  canClose: true,
  canReopen: true,
  hasMergeableState: true,
  canApprove: true,
  canRequestChanges: false,
  canCommentReview: false,
  hasUnifiedDiffText: false,
};

/** Detail/comment/merge/review methods below are implemented in Phase D — Phase A-C only target GitHub. */
const NOT_YET_IMPLEMENTED = 'GitLab pull request detail is not yet implemented';

interface RawGitLabMr {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft: boolean;
  work_in_progress: boolean;
  source_branch: string;
  target_branch: string;
  author: { username: string; avatar_url: string } | null;
  created_at: string;
  updated_at: string;
  user_notes_count?: number;
}

interface RawGitLabUser {
  username: string;
}

function mapState(mr: RawGitLabMr): PullRequestSummary['state'] {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed' || mr.state === 'locked') return 'closed';
  if (mr.draft || mr.work_in_progress) return 'draft';
  return 'open';
}

function mapMr(mr: RawGitLabMr): PullRequestSummary {
  return {
    id: String(mr.id),
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    state: mapState(mr),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    authorName: mr.author?.username ?? 'unknown',
    authorAvatarUrl: mr.author?.avatar_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    commentCount: mr.user_notes_count,
  };
}

function apiState(state: ListPullRequestsOptions['state']): 'opened' | 'closed' | 'merged' | 'all' {
  if (state === 'open') return 'opened';
  return state;
}

export class GitLabProvider implements PullRequestProvider {
  readonly kind = 'gitlab' as const;
  private cachedUsername: string | undefined;

  constructor(
    private readonly host: string,
    private readonly getToken: () => Promise<string | undefined>,
  ) {}

  private apiBase(): string {
    return `https://${this.host}/api/v4`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['PRIVATE-TOKEN'] = token;
    return headers;
  }

  async hasCredentials(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  async getCurrentUsername(): Promise<string | undefined> {
    if (this.cachedUsername) return this.cachedUsername;
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitLabUser>(`${this.apiBase()}/user`, { headers });
      this.cachedUsername = data.username;
      return data.username;
    } catch {
      return undefined;
    }
  }

  async listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const headers = await this.headers();
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const params = new URLSearchParams({
      state: apiState(options.state),
      per_page: String(PAGE_SIZE),
      page: String(options.page),
    });
    if (options.author === 'mine') {
      const username = await this.getCurrentUsername();
      if (username) params.set('author_username', username);
    }
    const url = `${this.apiBase()}/projects/${projectId}/merge_requests?${params.toString()}`;
    const { data } = await httpJson<RawGitLabMr[]>(url, { headers });
    return { items: data.map(mapMr), hasMore: data.length === PAGE_SIZE };
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const headers = await this.headers();
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    try {
      const { data } = await httpJson<RawGitLabMr>(`${this.apiBase()}/projects/${projectId}/merge_requests`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: (input.draft ? 'Draft: ' : '') + input.title,
          description: input.description,
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
        }),
      });
      return { ok: true, pr: mapMr(data) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getCapabilities(): PullRequestCapabilities {
    return CAPABILITIES;
  }

  getCheckoutRefspec(number: number): string {
    return `merge-requests/${number}/head`;
  }

  async getPullRequestDetail(): Promise<PullRequestDetail> {
    throw new Error(NOT_YET_IMPLEMENTED);
  }

  async listComments(): Promise<PullRequestComment[]> {
    throw new Error(NOT_YET_IMPLEMENTED);
  }

  async postComment(): Promise<PostCommentResult> {
    return { ok: false, error: NOT_YET_IMPLEMENTED };
  }

  async listChangedFiles(): Promise<ChangedFile[]> {
    throw new Error(NOT_YET_IMPLEMENTED);
  }

  async getFileDiff(): Promise<FileDiffContent> {
    throw new Error(NOT_YET_IMPLEMENTED);
  }

  async listCommits(): Promise<PullRequestCommit[]> {
    throw new Error(NOT_YET_IMPLEMENTED);
  }

  async listCommitFiles(): Promise<ChangedFile[]> {
    throw new Error(NOT_YET_IMPLEMENTED);
  }

  async mergePullRequest(): Promise<ActionResult> {
    return { ok: false, error: NOT_YET_IMPLEMENTED };
  }

  async closePullRequest(): Promise<ActionResult> {
    return { ok: false, error: NOT_YET_IMPLEMENTED };
  }

  async reopenPullRequest(): Promise<ActionResult | UnsupportedResult> {
    return { ok: false, error: NOT_YET_IMPLEMENTED };
  }

  async submitReview(): Promise<ActionResult | UnsupportedResult> {
    return { ok: false, error: NOT_YET_IMPLEMENTED };
  }
}
