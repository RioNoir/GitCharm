import type {
  ActionResult, ChangedFile, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent,
  ListPullRequestsOptions, ListPullRequestsResult, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestProvider, PullRequestSummary, UnsupportedResult,
} from '../types';
import { httpJson } from '../httpJson';

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
};

/** Detail/comment/merge/review methods below are implemented in Phase D — Phase A-C only target GitHub. */
const NOT_YET_IMPLEMENTED = 'Gitea pull request detail is not yet implemented';

interface RawGiteaPr {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  head: { ref: string };
  base: { ref: string };
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  updated_at: string;
  comments?: number;
}

interface RawGiteaUser {
  login: string;
}

function mapState(pr: RawGiteaPr): PullRequestSummary['state'] {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

function mapPr(pr: RawGiteaPr): PullRequestSummary {
  return {
    id: String(pr.id),
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: mapState(pr),
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
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

  getCheckoutRefspec(number: number): string {
    // Gitea/Forgejo expose PR branches as regular refs under refs/pull/{index}/head, mirroring GitHub.
    return `pull/${number}/head`;
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
