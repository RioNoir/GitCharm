import type { ActionResult, PostCommentResult, PullRequestComment, PullRequestEvent, PullRequestSummary } from '../../pullRequests/types';
import { httpJson, HttpJsonError } from '../../pullRequests/httpJson';
import { formatApiError } from '../../pullRequests/formatApiError';
import { parseClosingReferences } from '../closingReferences';
import {
  IssueTrackerDisabledError,
  type CreateIssueInput, type CreateIssueResult, type IssueCapabilities, type IssueDetail, type IssueProvider, type IssueSummary,
  type LinkedIssue, type LinkedPullRequest, type ListIssuesOptions, type ListIssuesResult, type UpdateIssueInput,
} from '../types';

const PAGE_SIZE = 30;

const CAPABILITIES: IssueCapabilities = {
  canManageAssignees: true,
  singleAssignee: false,
  canManageLabels: true,
  canFilterMentions: true,
  canFilterAssignee: true,
};

interface RawGiteaIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  body?: string | null;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  updated_at: string;
  comments?: number;
  assignees?: { login: string; avatar_url: string }[] | null;
  labels?: { name: string; color: string }[];
  /** Set when the item is a pull request — the issues endpoints also return those. */
  pull_request?: unknown;
}

interface RawGiteaIssueComment {
  id: number;
  body: string;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  html_url: string;
}

interface RawGiteaRefIssue {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  pull_request?: { merged?: boolean; draft?: boolean } | null;
  repository?: { full_name: string };
}

interface RawGiteaTimelineEntry {
  id: number;
  type: string;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  old_title?: string;
  new_title?: string;
  label?: { name: string; color: string };
  assignee?: { login: string; avatar_url: string } | null;
  removed_assignee?: boolean;
  body?: string;
  ref_issue?: RawGiteaRefIssue | null;
}

function parseXTotalCount(headers: Headers): number | undefined {
  const raw = headers.get('x-total-count');
  if (!raw) return undefined;
  const total = Number(raw);
  return Number.isFinite(total) ? total : undefined;
}

function mapIssue(issue: RawGiteaIssue): IssueSummary {
  return {
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    authorName: issue.user?.login ?? 'unknown',
    authorAvatarUrl: issue.user?.avatar_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    commentCount: issue.comments,
    assignees: (issue.assignees ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
    // Label names as ids — the same convention as the label picker (the PR provider's listAvailableLabels).
    labels: (issue.labels ?? []).map(l => ({ id: l.name, name: l.name, color: l.color.replace(/^#/, '') })),
  };
}

function mapRefPrState(pr: RawGiteaRefIssue): PullRequestSummary['state'] {
  if (pr.pull_request?.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.pull_request?.draft ? 'draft' : 'open';
}

function mapTimelineEntry(entry: RawGiteaTimelineEntry): PullRequestEvent | null {
  const base = { id: String(entry.id), actorName: entry.user?.login ?? 'unknown', actorAvatarUrl: entry.user?.avatar_url, createdAt: entry.created_at };
  switch (entry.type) {
    case 'change_title':
      return { ...base, kind: 'renamed', previousTitle: entry.old_title, newTitle: entry.new_title };
    case 'label':
      if (!entry.label) return null;
      // Gitea records a removal as a "label" entry whose body is empty — "1" marks an addition.
      return { ...base, kind: entry.body === '' ? 'unlabeled' : 'labeled', label: { id: entry.label.name, name: entry.label.name, color: entry.label.color.replace(/^#/, '') } };
    case 'close':
      return { ...base, kind: 'closed' };
    case 'reopen':
      return { ...base, kind: 'reopened' };
    case 'assignees':
      return entry.assignee
        ? { ...base, kind: entry.removed_assignee ? 'unassigned' : 'assigned', user: { id: entry.assignee.login, username: entry.assignee.login, avatarUrl: entry.assignee.avatar_url } }
        : null;
    default:
      return null;
  }
}

export class GiteaIssueProvider implements IssueProvider {
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

  getCapabilities(): IssueCapabilities {
    return CAPABILITIES;
  }

  async hasCredentials(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  async getCurrentUsername(): Promise<string | undefined> {
    if (this.cachedUsername) return this.cachedUsername;
    const headers = await this.headers();
    try {
      const { data } = await httpJson<{ login: string }>(`${this.apiBase()}/user`, { headers });
      this.cachedUsername = data.login;
      return data.login;
    } catch {
      return undefined;
    }
  }

  private async getRepo(owner: string, repo: string, headers: Record<string, string>): Promise<{ has_issues?: boolean; permissions?: { push?: boolean } } | undefined> {
    try {
      const { data } = await httpJson<{ has_issues?: boolean; permissions?: { push?: boolean } }>(`${this.apiBase()}/repos/${owner}/${repo}`, { headers });
      return data;
    } catch {
      return undefined;
    }
  }

  async listIssues(owner: string, repo: string, options: ListIssuesOptions): Promise<ListIssuesResult> {
    const headers = await this.headers();

    const numberMatch = options.search?.trim().match(/^#?(\d+)$/);
    if (numberMatch) {
      try {
        const { data } = await httpJson<RawGiteaIssue>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${numberMatch[1]}`, { headers });
        if (data.pull_request) return { items: [] };
        const issue = mapIssue(data);
        return { items: options.states.includes(issue.state) ? [issue] : [] };
      } catch (err) {
        if (err instanceof HttpJsonError && err.status === 404) return { items: [] };
        throw err;
      }
    }

    const page = Number(options.cursor ?? '1');
    const params = new URLSearchParams({
      type: 'issues',
      state: options.states.length === 1 ? options.states[0] : 'all',
      limit: String(PAGE_SIZE),
      page: String(page),
    });
    if (options.search) params.set('q', options.search);
    if (options.author === 'mine' || options.assignedToMe || options.mentioningMe) {
      const username = await this.getCurrentUsername();
      if (username && options.author === 'mine') params.set('created_by', username);
      if (username && options.assignedToMe) params.set('assigned_by', username);
      if (username && options.mentioningMe) params.set('mentioned_by', username);
    }

    let result: { data: RawGiteaIssue[]; headers: Headers };
    try {
      result = await httpJson<RawGiteaIssue[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues?${params.toString()}`, { headers });
    } catch (err) {
      if (err instanceof HttpJsonError && err.status === 404 && (await this.getRepo(owner, repo, headers))?.has_issues === false) {
        throw new IssueTrackerDisabledError();
      }
      throw err;
    }
    return {
      items: result.data.filter(i => !i.pull_request).map(mapIssue),
      nextCursor: result.data.length === PAGE_SIZE ? String(page + 1) : undefined,
      totalCount: parseXTotalCount(result.headers),
    };
  }

  async getIssueDetail(owner: string, repo: string, number: number): Promise<IssueDetail> {
    const headers = await this.headers();
    const [{ data }, repoInfo, username] = await Promise.all([
      httpJson<RawGiteaIssue>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}`, { headers }),
      this.getRepo(owner, repo, headers),
      this.getCurrentUsername(),
    ]);
    if (data.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
    const summary = mapIssue(data);
    return {
      ...summary,
      description: data.body ?? '',
      capabilities: CAPABILITIES,
      canWrite: !!repoInfo?.permissions?.push || (!!username && username === summary.authorName),
      assignees: summary.assignees ?? [],
      labels: summary.labels ?? [],
    };
  }

  /** The create endpoint only takes numeric label ids, the labels endpoint also takes names — so labels are set
   * right after creating the issue, through the same call the label picker uses. */
  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<CreateIssueResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGiteaIssue>(`${this.apiBase()}/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.title, body: input.description, assignees: input.assigneeIds }),
      });
      if (input.labelIds?.length) {
        const labelled = await this.updateLabels(owner, repo, data.number, input.labelIds);
        if (!labelled.ok) return { ok: true, issue: mapIssue(data), error: labelled.error };
      }
      return { ok: true, issue: mapIssue(data) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  private async patchIssue(owner: string, repo: string, number: number, body: Record<string, unknown>): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateIssue(owner: string, repo: string, number: number, input: UpdateIssueInput): Promise<ActionResult> {
    return this.patchIssue(owner, repo, number, { title: input.title, body: input.description });
  }

  async closeIssue(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.patchIssue(owner, repo, number, { state: 'closed' });
  }

  async reopenIssue(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.patchIssue(owner, repo, number, { state: 'open' });
  }

  /** The issue PATCH's `assignees` replaces the whole list. */
  async updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    return this.patchIssue(owner, repo, number, { assignees: userIds });
  }

  async updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/labels`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: labelIds }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
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
    const [{ data }, currentUsername, repoInfo] = await Promise.all([
      httpJson<RawGiteaIssueComment[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, { headers }),
      this.getCurrentUsername(),
      this.getRepo(owner, repo, headers),
    ]);
    return data.map(c => this.mapComment(c, currentUsername, !!repoInfo?.permissions?.push));
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, currentUsername, repoInfo] = await Promise.all([
        httpJson<RawGiteaIssueComment>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        }),
        this.getCurrentUsername(),
        this.getRepo(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapComment(data, currentUsername, !!repoInfo?.permissions?.push) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateComment(owner: string, repo: string, _number: number, commentId: string, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, currentUsername, repoInfo] = await Promise.all([
        httpJson<RawGiteaIssueComment>(`${this.apiBase()}/repos/${owner}/${repo}/issues/comments/${commentId}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        }),
        this.getCurrentUsername(),
        this.getRepo(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapComment(data, currentUsername, !!repoInfo?.permissions?.push) };
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

  private async listTimeline(owner: string, repo: string, number: number): Promise<RawGiteaTimelineEntry[]> {
    const headers = await this.headers();
    const { data } = await httpJson<RawGiteaTimelineEntry[]>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/timeline`, { headers });
    return data;
  }

  async listEvents(owner: string, repo: string, number: number): Promise<PullRequestEvent[]> {
    return (await this.listTimeline(owner, repo, number)).map(mapTimelineEntry).filter((e): e is PullRequestEvent => e !== null);
  }

  /** Gitea records a PR that mentions an issue as a "pull_ref" timeline entry carrying the PR itself. */
  async listLinkedPullRequests(owner: string, repo: string, number: number): Promise<LinkedPullRequest[]> {
    const ownFullName = `${owner}/${repo}`.toLowerCase();
    const byKey = new Map<string, LinkedPullRequest>();
    for (const entry of await this.listTimeline(owner, repo, number)) {
      const pr = entry.ref_issue;
      if (entry.type !== 'pull_ref' || !pr?.pull_request) continue;
      const repoFullName = pr.repository?.full_name;
      byKey.set(`${repoFullName ?? ''}#${pr.number}`, {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        state: mapRefPrState(pr),
        repoFullName,
        sameRepo: !repoFullName || repoFullName.toLowerCase() === ownFullName,
        willClose: false,
      });
    }
    return [...byKey.values()];
  }

  /** Gitea has no API for the issues a PR closes — its closing keywords are read from the PR description instead. */
  async listIssuesClosedByPullRequest(owner: string, repo: string, _prNumber: number, prDescription: string): Promise<LinkedIssue[]> {
    const headers = await this.headers();
    const issues = await Promise.all(parseClosingReferences(prDescription).map(n =>
      httpJson<RawGiteaIssue>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${n}`, { headers }).then(({ data }) => data).catch(() => undefined),
    ));
    return issues
      .filter((i): i is RawGiteaIssue => !!i && !i.pull_request)
      .map(i => ({ number: i.number, title: i.title, url: i.html_url, state: i.state, repoFullName: `${owner}/${repo}`, sameRepo: true }));
  }
}
