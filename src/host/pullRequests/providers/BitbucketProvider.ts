import type {
  ActionResult, ChangedFile, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent,
  ListPullRequestsOptions, ListPullRequestsResult, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestProvider, PullRequestSummary, UnsupportedResult,
} from '../types';
import type { BitbucketCredentials } from '../PatCredentialStore';
import { httpJson } from '../httpJson';

const PAGE_SIZE = 30;

const CAPABILITIES: PullRequestCapabilities = {
  canMerge: true,
  mergeStrategies: ['merge', 'squash', 'fastForward'],
  canClose: true,
  canReopen: false,
  hasMergeableState: false,
  canApprove: true,
  canRequestChanges: true,
  canCommentReview: false,
  hasUnifiedDiffText: true,
};

/** Detail/comment/merge/review methods below are implemented in Phase D — Phase A-C only target GitHub. */
const NOT_YET_IMPLEMENTED = 'Bitbucket pull request detail is not yet implemented';

interface RawBitbucketPr {
  id: number;
  title: string;
  links: { html: { href: string } };
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft?: boolean;
  source: { branch: { name: string } };
  destination: { branch: { name: string } };
  author: { display_name: string; nickname?: string; uuid?: string; links: { avatar: { href: string } } } | null;
  created_on: string;
  updated_on: string;
  comment_count?: number;
}

interface RawBitbucketPage {
  values: RawBitbucketPr[];
  next?: string;
}

interface RawBitbucketUser {
  username?: string;
  nickname?: string;
  uuid: string;
}

function mapState(pr: RawBitbucketPr): PullRequestSummary['state'] {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'DECLINED' || pr.state === 'SUPERSEDED') return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

function mapPr(pr: RawBitbucketPr): PullRequestSummary {
  return {
    id: String(pr.id),
    number: pr.id,
    title: pr.title,
    url: pr.links.html.href,
    state: mapState(pr),
    sourceBranch: pr.source.branch.name,
    targetBranch: pr.destination.branch.name,
    authorName: pr.author?.display_name ?? pr.author?.nickname ?? 'unknown',
    authorAvatarUrl: pr.author?.links?.avatar?.href,
    createdAt: pr.created_on,
    updatedAt: pr.updated_on,
    commentCount: pr.comment_count,
  };
}

/** Bitbucket Cloud has no single "all" state — the query filter is repeated per accepted value, or omitted entirely for "all". */
function apiStates(state: ListPullRequestsOptions['state']): string[] {
  if (state === 'open') return ['OPEN'];
  if (state === 'merged') return ['MERGED'];
  if (state === 'closed') return ['DECLINED', 'SUPERSEDED'];
  return [];
}

export class BitbucketProvider implements PullRequestProvider {
  readonly kind = 'bitbucket' as const;
  private cachedUsername: string | undefined;

  constructor(
    private readonly getCredentials: () => Promise<BitbucketCredentials | undefined>,
  ) {}

  private apiBase(): string {
    return 'https://api.bitbucket.org/2.0';
  }

  private async headers(): Promise<Record<string, string>> {
    const credentials = await this.getCredentials();
    const headers: Record<string, string> = {};
    if (credentials) {
      const basic = Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    }
    return headers;
  }

  async hasCredentials(): Promise<boolean> {
    return (await this.getCredentials()) !== undefined;
  }

  async getCurrentUsername(): Promise<string | undefined> {
    if (this.cachedUsername) return this.cachedUsername;
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawBitbucketUser>(`${this.apiBase()}/user`, { headers });
      this.cachedUsername = data.username ?? data.nickname ?? data.uuid;
      return this.cachedUsername;
    } catch {
      return undefined;
    }
  }

  async listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const headers = await this.headers();
    const params = new URLSearchParams({ pagelen: String(PAGE_SIZE), page: String(options.page) });
    for (const s of apiStates(options.state)) params.append('state', s);
    if (options.author === 'mine') {
      const username = await this.getCurrentUsername();
      if (username) params.set('q', `author.username="${username}"`);
    }
    const url = `${this.apiBase()}/repositories/${owner}/${repo}/pullrequests?${params.toString()}`;
    const result: { data: RawBitbucketPage } = await httpJson<RawBitbucketPage>(url, { headers });
    return { items: result.data.values.map(mapPr), hasMore: !!result.data.next };
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawBitbucketPr>(`${this.apiBase()}/repositories/${owner}/${repo}/pullrequests`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          source: { branch: { name: input.sourceBranch } },
          destination: { branch: { name: input.targetBranch } },
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
    // Bitbucket Cloud exposes PR branches as regular refs under refs/pull-requests/{id}/from.
    return `pull-requests/${number}/from`;
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
    return { ok: false, unsupported: true, error: 'Bitbucket does not support reopening a declined pull request. This is a permanent platform limitation.' };
  }

  async submitReview(): Promise<ActionResult | UnsupportedResult> {
    return { ok: false, error: NOT_YET_IMPLEMENTED };
  }
}
