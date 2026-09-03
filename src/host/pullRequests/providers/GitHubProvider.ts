import type { CreatePullRequestInput, CreatePullRequestResult, PullRequestProvider, PullRequestSummary } from '../types';
import { httpJson } from '../httpJson';

const MAX_PAGES = 20; // 20 * 100 = 2000 PR safety cap

interface RawGitHubPr {
  id: number;
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged_at: string | null;
  head: { ref: string };
  base: { ref: string };
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  updated_at: string;
  comments?: number;
}

function mapState(pr: RawGitHubPr): PullRequestSummary['state'] {
  if (pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

function mapPr(pr: RawGitHubPr): PullRequestSummary {
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

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export class GitHubProvider implements PullRequestProvider {
  readonly kind = 'github' as const;

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

  async listPullRequests(owner: string, repo: string): Promise<PullRequestSummary[]> {
    const headers = await this.headers();
    const results: PullRequestSummary[] = [];
    let url: string | null = `${this.apiBase()}/repos/${owner}/${repo}/pulls?state=open&per_page=100`;
    let page = 0;
    while (url && page < MAX_PAGES) {
      const { data, headers: resHeaders } = await httpJson<RawGitHubPr[]>(url, { headers });
      results.push(...data.map(mapPr));
      url = parseNextLink(resHeaders.get('Link'));
      page++;
    }
    return results;
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
}
