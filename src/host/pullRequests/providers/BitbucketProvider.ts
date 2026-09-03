import type { CreatePullRequestInput, CreatePullRequestResult, PullRequestProvider, PullRequestSummary } from '../types';
import { httpJson } from '../httpJson';

const MAX_PAGES = 20;

interface RawBitbucketPr {
  id: number;
  title: string;
  links: { html: { href: string } };
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft?: boolean;
  source: { branch: { name: string } };
  destination: { branch: { name: string } };
  author: { display_name: string; nickname?: string; links: { avatar: { href: string } } } | null;
  created_on: string;
  updated_on: string;
  comment_count?: number;
}

interface RawBitbucketPage {
  values: RawBitbucketPr[];
  next?: string;
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

export class BitbucketProvider implements PullRequestProvider {
  readonly kind = 'bitbucket' as const;

  constructor(
    private readonly getToken: () => Promise<string | undefined>,
  ) {}

  private apiBase(): string {
    return 'https://api.bitbucket.org/2.0';
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async hasCredentials(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  async listPullRequests(owner: string, repo: string): Promise<PullRequestSummary[]> {
    const headers = await this.headers();
    const results: PullRequestSummary[] = [];
    let url: string | null = `${this.apiBase()}/repositories/${owner}/${repo}/pullrequests?state=OPEN&pagelen=50`;
    let page = 0;
    while (url && page < MAX_PAGES) {
      const result: { data: RawBitbucketPage } = await httpJson<RawBitbucketPage>(url, { headers });
      results.push(...result.data.values.map(mapPr));
      url = result.data.next ?? null;
      page++;
    }
    return results;
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
}
