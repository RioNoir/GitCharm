import type { CreatePullRequestInput, CreatePullRequestResult, PullRequestProvider, PullRequestSummary } from '../types';
import { httpJson } from '../httpJson';

const MAX_PAGES = 20;

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

export class GitLabProvider implements PullRequestProvider {
  readonly kind = 'gitlab' as const;

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

  async listPullRequests(owner: string, repo: string): Promise<PullRequestSummary[]> {
    const headers = await this.headers();
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const results: PullRequestSummary[] = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      const url = `${this.apiBase()}/projects/${projectId}/merge_requests?state=opened&per_page=100&page=${page}`;
      const { data, headers: resHeaders } = await httpJson<RawGitLabMr[]>(url, { headers });
      results.push(...data.map(mapMr));
      const nextPage = resHeaders.get('X-Next-Page');
      if (!nextPage) break;
      page = Number(nextPage);
    }
    return results;
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
}
