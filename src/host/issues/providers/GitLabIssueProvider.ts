import type { ActionResult, PostCommentResult, PullRequestComment, PullRequestEvent, PullRequestLabel, PullRequestSummary, TimelineReference } from '../../pullRequests/types';
import { httpJson, HttpJsonError } from '../../pullRequests/httpJson';
import { formatApiError } from '../../pullRequests/formatApiError';
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
  canFilterMentions: false,
  canFilterAssignee: true,
};

/** GitLab access levels: Reporter (20) can label, assign and close issues; Maintainer (40) can also delete other people's notes. */
const REPORTER_ACCESS = 20;
const MAINTAINER_ACCESS = 40;

interface RawGitLabUserRef {
  id: number;
  username: string;
  avatar_url: string;
}

interface RawGitLabIssue {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  state: 'opened' | 'closed';
  description?: string | null;
  author: RawGitLabUserRef | null;
  created_at: string;
  updated_at: string;
  user_notes_count?: number;
  assignees?: RawGitLabUserRef[];
  /** Label objects with `with_labels_details=true`, names otherwise. */
  labels?: ({ name: string; color: string } | string)[];
  references?: { full: string };
}

interface RawGitLabMr {
  iid: number;
  title: string;
  web_url: string;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft?: boolean;
  work_in_progress?: boolean;
  references?: { full: string };
}

interface RawGitLabNote {
  id: number;
  body: string;
  author: { username: string; avatar_url: string } | null;
  created_at: string;
  system?: boolean;
}

interface RawGitLabLabelEvent {
  id: number;
  user: { username: string; avatar_url: string } | null;
  created_at: string;
  action: 'add' | 'remove';
  label: { name: string; color: string } | null;
}

interface RawGitLabStateEvent {
  id: number;
  user: { username: string; avatar_url: string } | null;
  created_at: string;
  state: 'closed' | 'reopened';
}

interface RawGitLabProject {
  issues_enabled?: boolean;
  issues_access_level?: string;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}

function parseXTotal(headers: Headers): number | undefined {
  const raw = headers.get('x-total');
  if (!raw) return undefined;
  const total = Number(raw);
  return Number.isFinite(total) ? total : undefined;
}

function mapLabels(labels: RawGitLabIssue['labels']): PullRequestLabel[] {
  return (labels ?? []).map(l => typeof l === 'string'
    ? { id: l, name: l, color: '808080' }
    : { id: l.name, name: l.name, color: l.color.replace(/^#/, '') });
}

function mapIssue(issue: RawGitLabIssue): IssueSummary {
  return {
    id: String(issue.id),
    number: issue.iid,
    title: issue.title,
    url: issue.web_url,
    state: issue.state === 'closed' ? 'closed' : 'open',
    authorName: issue.author?.username ?? 'unknown',
    authorAvatarUrl: issue.author?.avatar_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    commentCount: issue.user_notes_count,
    assignees: (issue.assignees ?? []).map(u => ({ id: String(u.id), username: u.username, avatarUrl: u.avatar_url })),
    labels: mapLabels(issue.labels),
  };
}

function mapMrState(mr: RawGitLabMr): PullRequestSummary['state'] {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed' || mr.state === 'locked') return 'closed';
  return mr.draft || mr.work_in_progress ? 'draft' : 'open';
}

/** GitLab's system notes for references: "mentioned in merge request !12", "mentioned in commit group/project@1a2b3c4d",
 * "mentioned in issue other/project#3" — the only place GitLab records who referenced an issue, and when. */
const MENTION_NOTE = /^mentioned in (merge request|issue|commit) (?:([\w./-]+)([!#@]))?[!#]?([0-9a-f]{7,40}|\d+)\s*$/i;

/** `references.full` is "group/project#12" for an issue, "group/project!12" for an MR. */
function projectPathOf(full: string | undefined): string | undefined {
  return full?.replace(/[#!]\d+$/, '');
}

export class GitLabIssueProvider implements IssueProvider {
  readonly kind = 'gitlab' as const;
  private cachedUsername: string | undefined;
  private readonly accessLevelCache = new Map<string, number>();

  constructor(
    private readonly host: string,
    private readonly getToken: () => Promise<string | undefined>,
  ) {}

  private apiBase(): string {
    return `https://${this.host}/api/v4`;
  }

  private projectId(owner: string, repo: string): string {
    return encodeURIComponent(`${owner}/${repo}`);
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['PRIVATE-TOKEN'] = token;
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
      const { data } = await httpJson<{ username: string }>(`${this.apiBase()}/user`, { headers });
      this.cachedUsername = data.username;
      return data.username;
    } catch {
      return undefined;
    }
  }

  /** The authenticated user's access level on the project (direct or inherited from its group), cached per project. */
  private async getAccessLevel(owner: string, repo: string, headers: Record<string, string>): Promise<number> {
    const key = `${owner}/${repo}`;
    const cached = this.accessLevelCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const { data } = await httpJson<RawGitLabProject>(`${this.apiBase()}/projects/${this.projectId(owner, repo)}`, { headers });
      const level = Math.max(data.permissions?.project_access?.access_level ?? 0, data.permissions?.group_access?.access_level ?? 0);
      this.accessLevelCache.set(key, level);
      return level;
    } catch {
      return 0;
    }
  }

  /** A 403/404 from the issues endpoint may just mean the project turned its issues off — tell the two apart. */
  private async throwIfTrackerDisabled(owner: string, repo: string, headers: Record<string, string>, err: unknown): Promise<never> {
    if (err instanceof HttpJsonError && (err.status === 403 || err.status === 404)) {
      const project = await httpJson<RawGitLabProject>(`${this.apiBase()}/projects/${this.projectId(owner, repo)}`, { headers })
        .then(({ data }) => data).catch(() => undefined);
      if (project && (project.issues_enabled === false || project.issues_access_level === 'disabled')) throw new IssueTrackerDisabledError();
    }
    throw err;
  }

  async listIssues(owner: string, repo: string, options: ListIssuesOptions): Promise<ListIssuesResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);

    const numberMatch = options.search?.trim().match(/^#?(\d+)$/);
    const page = Number(options.cursor ?? '1');
    const params = new URLSearchParams({
      state: options.states.length === 1 ? (options.states[0] === 'open' ? 'opened' : 'closed') : 'all',
      with_labels_details: 'true',
      order_by: 'updated_at',
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    if (numberMatch) params.append('iids[]', numberMatch[1]);
    else if (options.search) params.set('search', options.search);
    if (options.author === 'mine' || options.assignedToMe) {
      const username = await this.getCurrentUsername();
      if (username && options.author === 'mine') params.set('author_username', username);
      if (username && options.assignedToMe) params.set('assignee_username', username);
    }

    let result: { data: RawGitLabIssue[]; headers: Headers };
    try {
      result = await httpJson<RawGitLabIssue[]>(`${this.apiBase()}/projects/${projectId}/issues?${params.toString()}`, { headers });
    } catch (err) {
      return this.throwIfTrackerDisabled(owner, repo, headers, err);
    }
    return {
      items: result.data.map(mapIssue),
      nextCursor: result.data.length === PAGE_SIZE ? String(page + 1) : undefined,
      totalCount: parseXTotal(result.headers),
    };
  }

  async getIssueDetail(owner: string, repo: string, number: number): Promise<IssueDetail> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    // The single-issue endpoint returns label names only — the list endpoint, filtered to this one iid, returns
    // the label colors too, in the same single call.
    const [{ data }, accessLevel, username] = await Promise.all([
      httpJson<RawGitLabIssue[]>(`${this.apiBase()}/projects/${projectId}/issues?iids[]=${number}&with_labels_details=true&state=all`, { headers }),
      this.getAccessLevel(owner, repo, headers),
      this.getCurrentUsername(),
    ]);
    const raw = data[0];
    if (!raw) throw new Error(`Issue #${number} not found`);
    const summary = mapIssue(raw);
    return {
      ...summary,
      description: raw.description ?? '',
      capabilities: CAPABILITIES,
      canWrite: accessLevel >= REPORTER_ACCESS || (!!username && username === summary.authorName),
      assignees: summary.assignees ?? [],
      labels: summary.labels ?? [],
    };
  }

  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<CreateIssueResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitLabIssue>(`${this.apiBase()}/projects/${this.projectId(owner, repo)}/issues`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          assignee_ids: input.assigneeIds?.map(Number),
          labels: input.labelIds?.join(','),
        }),
      });
      return { ok: true, issue: mapIssue(data) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  private async putIssue(owner: string, repo: string, number: number, body: Record<string, unknown>): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/projects/${this.projectId(owner, repo)}/issues/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateIssue(owner: string, repo: string, number: number, input: UpdateIssueInput): Promise<ActionResult> {
    return this.putIssue(owner, repo, number, { title: input.title, description: input.description });
  }

  async closeIssue(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.putIssue(owner, repo, number, { state_event: 'close' });
  }

  async reopenIssue(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.putIssue(owner, repo, number, { state_event: 'reopen' });
  }

  /** `assignee_ids` replaces the whole set; an empty array unassigns everyone. GitLab Free keeps only the first. */
  async updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    return this.putIssue(owner, repo, number, { assignee_ids: userIds.length > 0 ? userIds.map(Number) : [0] });
  }

  async updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult> {
    return this.putIssue(owner, repo, number, { labels: labelIds.join(',') });
  }

  private mapNote(n: RawGitLabNote, currentUsername: string | undefined, accessLevel: number): PullRequestComment {
    const isOwn = !!currentUsername && n.author?.username === currentUsername;
    return {
      id: String(n.id),
      authorName: n.author?.username ?? 'unknown',
      authorAvatarUrl: n.author?.avatar_url,
      body: n.body,
      createdAt: n.created_at,
      canEdit: isOwn,
      canDelete: isOwn || accessLevel >= MAINTAINER_ACCESS,
      canHide: false,
    };
  }

  private async paginate<T>(url: string, headers: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<T[]>(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { headers });
      items.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return items;
  }

  async listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]> {
    const headers = await this.headers();
    const [notes, currentUsername, accessLevel] = await Promise.all([
      this.paginate<RawGitLabNote>(`${this.apiBase()}/projects/${this.projectId(owner, repo)}/issues/${number}/notes?sort=asc`, headers),
      this.getCurrentUsername(),
      this.getAccessLevel(owner, repo, headers),
    ]);
    return notes.filter(n => !n.system).map(n => this.mapNote(n, currentUsername, accessLevel));
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, currentUsername, accessLevel] = await Promise.all([
        httpJson<RawGitLabNote>(`${this.apiBase()}/projects/${this.projectId(owner, repo)}/issues/${number}/notes`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        }),
        this.getCurrentUsername(),
        this.getAccessLevel(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapNote(data, currentUsername, accessLevel) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateComment(owner: string, repo: string, number: number, commentId: string, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, currentUsername, accessLevel] = await Promise.all([
        httpJson<RawGitLabNote>(`${this.apiBase()}/projects/${this.projectId(owner, repo)}/issues/${number}/notes/${commentId}`, {
          method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        }),
        this.getCurrentUsername(),
        this.getAccessLevel(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapNote(data, currentUsername, accessLevel) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async deleteComment(owner: string, repo: string, number: number, commentId: string): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/projects/${this.projectId(owner, repo)}/issues/${number}/notes/${commentId}`, { method: 'DELETE', headers });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  /** Same two resource-event endpoints the MR provider reads — label add/remove and close/reopen. */
  async listEvents(owner: string, repo: string, number: number): Promise<PullRequestEvent[]> {
    const headers = await this.headers();
    const base = `${this.apiBase()}/projects/${this.projectId(owner, repo)}/issues/${number}`;
    const [labelEvents, stateEvents, notes] = await Promise.all([
      this.paginate<RawGitLabLabelEvent>(`${base}/resource_label_events`, headers),
      this.paginate<RawGitLabStateEvent>(`${base}/resource_state_events`, headers),
      this.paginate<RawGitLabNote>(`${base}/notes?sort=asc`, headers).catch(() => [] as RawGitLabNote[]),
    ]);
    const events: PullRequestEvent[] = await this.mentionEvents(owner, repo, notes.filter(n => n.system), headers);
    for (const e of labelEvents) {
      if (!e.label) continue;
      events.push({
        id: `label-${e.id}`,
        kind: e.action === 'add' ? 'labeled' : 'unlabeled',
        actorName: e.user?.username ?? 'unknown',
        actorAvatarUrl: e.user?.avatar_url,
        createdAt: e.created_at,
        label: { id: e.label.name, name: e.label.name, color: e.label.color.replace(/^#/, '') },
      });
    }
    for (const e of stateEvents) {
      if (e.state !== 'closed' && e.state !== 'reopened') continue;
      events.push({
        id: `state-${e.id}`,
        kind: e.state,
        actorName: e.user?.username ?? 'unknown',
        actorAvatarUrl: e.user?.avatar_url,
        createdAt: e.created_at,
      });
    }
    return events;
  }

  /** Turns "mentioned in …" system notes into reference events, looking up titles (and commit messages) in the
   * same project — at most a few lookups, best-effort: a reference whose details can't be read keeps its number. */
  private async mentionEvents(owner: string, repo: string, systemNotes: RawGitLabNote[], headers: Record<string, string>): Promise<PullRequestEvent[]> {
    const ownPath = `${owner}/${repo}`;
    const events: PullRequestEvent[] = [];
    const lookups: Promise<void>[] = [];
    const MAX_LOOKUPS = 25;
    for (const note of systemNotes) {
      const m = MENTION_NOTE.exec(note.body.trim());
      if (!m) continue;
      const [, what, project, , id] = m;
      const projectPath = project || ownPath;
      const sameRepo = projectPath.toLowerCase() === ownPath.toLowerCase();
      const projectApi = `${this.apiBase()}/projects/${encodeURIComponent(projectPath)}`;
      const webBase = `https://${this.host}/${projectPath}/-`;
      const base = { id: `note-${note.id}`, actorName: note.author?.username ?? 'unknown', actorAvatarUrl: note.author?.avatar_url, createdAt: note.created_at };
      if (what.toLowerCase() === 'commit') {
        const event: PullRequestEvent = {
          ...base, kind: 'commitReferenced',
          commit: { sha: id, shortSha: id.slice(0, 8), url: `${webBase}/commit/${id}`, repoFullName: projectPath, sameRepo },
        };
        events.push(event);
        if (lookups.length < MAX_LOOKUPS) {
          lookups.push(httpJson<{ id: string; short_id: string; title: string; web_url: string }>(`${projectApi}/repository/commits/${id}`, { headers })
            .then(({ data }) => { event.commit = { ...event.commit!, sha: data.id, shortSha: data.short_id, message: data.title, url: data.web_url }; })
            .catch(() => undefined));
        }
      } else {
        const isMr = what.toLowerCase() === 'merge request';
        const reference: TimelineReference = {
          kind: isMr ? 'pullRequest' : 'issue', number: Number(id), title: '', state: 'open',
          url: `${webBase}/${isMr ? 'merge_requests' : 'issues'}/${id}`, repoFullName: projectPath, sameRepo,
        };
        events.push({ ...base, kind: 'crossReferenced', reference });
        if (lookups.length < MAX_LOOKUPS) {
          lookups.push(httpJson<RawGitLabMr & RawGitLabIssue>(`${projectApi}/${isMr ? 'merge_requests' : 'issues'}/${id}`, { headers })
            .then(({ data }) => {
              reference.title = data.title;
              reference.url = data.web_url;
              reference.state = isMr ? mapMrState(data) : data.state === 'closed' ? 'closed' : 'open';
            })
            .catch(() => undefined));
        }
      }
    }
    await Promise.all(lookups);
    return events;
  }

  /** MRs mentioning the issue (`related_merge_requests`) plus the ones that close it (`closed_by`). */
  async listLinkedPullRequests(owner: string, repo: string, number: number): Promise<LinkedPullRequest[]> {
    const headers = await this.headers();
    const base = `${this.apiBase()}/projects/${this.projectId(owner, repo)}/issues/${number}`;
    const [related, closedBy] = await Promise.all([
      this.paginate<RawGitLabMr>(`${base}/related_merge_requests`, headers).catch(() => [] as RawGitLabMr[]),
      this.paginate<RawGitLabMr>(`${base}/closed_by`, headers).catch(() => [] as RawGitLabMr[]),
    ]);
    const ownPath = `${owner}/${repo}`.toLowerCase();
    const byKey = new Map<string, LinkedPullRequest>();
    const add = (mr: RawGitLabMr, willClose: boolean) => {
      const repoFullName = projectPathOf(mr.references?.full);
      const key = `${repoFullName ?? ''}!${mr.iid}`;
      byKey.set(key, {
        number: mr.iid,
        title: mr.title,
        url: mr.web_url,
        state: mapMrState(mr),
        repoFullName,
        sameRepo: !repoFullName || repoFullName.toLowerCase() === ownPath,
        willClose: willClose || !!byKey.get(key)?.willClose,
      });
    };
    related.forEach(mr => add(mr, false));
    closedBy.forEach(mr => add(mr, true));
    return [...byKey.values()];
  }

  async listIssuesClosedByPullRequest(owner: string, repo: string, prNumber: number): Promise<LinkedIssue[]> {
    const headers = await this.headers();
    const issues = await this.paginate<RawGitLabIssue>(
      `${this.apiBase()}/projects/${this.projectId(owner, repo)}/merge_requests/${prNumber}/closes_issues`, headers,
    );
    const ownPath = `${owner}/${repo}`.toLowerCase();
    return issues.map(issue => {
      const repoFullName = projectPathOf(issue.references?.full);
      return {
        number: issue.iid,
        title: issue.title,
        url: issue.web_url,
        state: issue.state === 'closed' ? 'closed' : 'open',
        repoFullName,
        sameRepo: !repoFullName || repoFullName.toLowerCase() === ownPath,
      };
    });
  }
}
