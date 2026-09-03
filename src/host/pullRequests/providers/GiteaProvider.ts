import type { CreatePullRequestInput, CreatePullRequestResult, PullRequestProvider, PullRequestSummary } from '../types';
import { httpJson } from '../httpJson';

const MAX_PAGES = 20;

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

export class GiteaProvider implements PullRequestProvider {
  readonly kind = 'gitea' as const;

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

  async listPullRequests(owner: string, repo: string): Promise<PullRequestSummary[]> {
    const headers = await this.headers();
    const results: PullRequestSummary[] = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      const url = `${this.apiBase()}/repos/${owner}/${repo}/pulls?state=open&limit=50&page=${page}`;
      const { data } = await httpJson<RawGiteaPr[]>(url, { headers });
      results.push(...data.map(mapPr));
      if (data.length < 50) break;
      page++;
    }
    return results;
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
}
