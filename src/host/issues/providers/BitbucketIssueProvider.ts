import * as vscode from 'vscode';
import type {
  ActionResult, PostCommentResult, PullRequestComment, PullRequestEvent, PullRequestLabel, PullRequestUser, UnsupportedResult,
} from '../../pullRequests/types';
import type { BitbucketCredentials } from '../../integrations/IntegrationAccountStore';
import { httpJson, HttpJsonError } from '../../pullRequests/httpJson';
import { formatApiError } from '../../pullRequests/formatApiError';
import { parseClosingReferences } from '../closingReferences';
import {
  IssueTrackerDisabledError,
  type CreateIssueInput, type CreateIssueResult, type IssueCapabilities, type IssueDetail, type IssueProvider, type IssueState,
  type IssueSummary, type LinkedIssue, type LinkedPullRequest, type ListIssuesOptions, type ListIssuesResult, type UpdateIssueInput,
} from '../types';

const PAGE_SIZE = 30;

const CAPABILITIES: IssueCapabilities = {
  canManageAssignees: true,
  singleAssignee: true,
  canManageLabels: false,
  canFilterMentions: false,
  canFilterAssignee: true,
};

/** Bitbucket's own workflow states, split into what the tab shows as open and as closed. */
const OPEN_STATES = ['new', 'open', 'on hold', 'submitted'];
const CLOSED_STATES = ['resolved', 'invalid', 'duplicate', 'wontfix', 'closed'];

/** Bitbucket's issue "kind" has no labels counterpart — shown as a read-only label so it's still visible. */
const KIND_COLORS: Record<string, string> = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  proposal: 'd876e3',
  task: '0e8a16',
};

interface RawBitbucketUserRef {
  uuid: string;
  account_id?: string;
  display_name: string;
  nickname?: string;
  links: { avatar: { href: string } };
}

interface RawBitbucketIssue {
  id: number;
  title: string;
  state: string;
  kind?: string;
  priority?: string;
  content?: { raw: string };
  reporter: RawBitbucketUserRef | null;
  assignee: RawBitbucketUserRef | null;
  created_on: string;
  updated_on: string;
  links: { html: { href: string } };
}

interface RawBitbucketIssuePage {
  values: RawBitbucketIssue[];
  next?: string;
  size?: number;
}

interface RawBitbucketComment {
  id: number;
  content: { raw: string | null };
  user: RawBitbucketUserRef | null;
  created_on: string;
  links: { html?: { href: string } };
}

interface RawBitbucketChange {
  id: number;
  created_on: string;
  user: RawBitbucketUserRef | null;
  changes: {
    state?: { old?: string; new?: string };
    title?: { old?: string; new?: string };
    assignee_account_id?: { old?: string; new?: string };
    assignee?: { old?: string; new?: string };
  };
}

function mapUserRef(u: RawBitbucketUserRef): PullRequestUser {
  return {
    id: u.uuid,
    username: u.display_name ?? u.nickname ?? u.uuid,
    avatarUrl: u.links?.avatar?.href,
    mention: u.account_id ? `@{${u.account_id}}` : undefined,
  };
}

function mapState(state: string): IssueState {
  return CLOSED_STATES.includes(state) ? 'closed' : 'open';
}

function kindLabel(kind: string | undefined): PullRequestLabel[] {
  return kind ? [{ id: kind, name: kind, color: KIND_COLORS[kind] ?? '808080' }] : [];
}

function mapIssue(issue: RawBitbucketIssue): IssueSummary {
  return {
    id: String(issue.id),
    number: issue.id,
    title: issue.title,
    url: issue.links.html.href,
    state: mapState(issue.state),
    authorName: issue.reporter?.display_name ?? issue.reporter?.nickname ?? 'unknown',
    authorAvatarUrl: issue.reporter?.links?.avatar?.href,
    createdAt: issue.created_on,
    updatedAt: issue.updated_on,
    assignees: issue.assignee ? [mapUserRef(issue.assignee)] : [],
    labels: kindLabel(issue.kind),
  };
}

/** API tokens created for pull requests usually lack the issue scopes — say so instead of a bare 401/403. */
function formatIssueApiError(err: unknown): string {
  const message = formatApiError(err);
  if (err instanceof HttpJsonError && (err.status === 401 || err.status === 403)) {
    return vscode.l10n.t('{0} — the API token may be missing the read:issue:bitbucket / write:issue:bitbucket scopes.', message);
  }
  return message;
}

export class BitbucketIssueProvider implements IssueProvider {
  readonly kind = 'bitbucket' as const;
  private cachedUsername: string | undefined;
  private cachedUserUuid: string | undefined;

  constructor(
    private readonly getCredentials: () => Promise<BitbucketCredentials | undefined>,
  ) {}

  private apiBase(): string {
    return 'https://api.bitbucket.org/2.0';
  }

  private async headers(): Promise<Record<string, string>> {
    const credentials = await this.getCredentials();
    const headers: Record<string, string> = {};
    if (credentials) headers.Authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`;
    return headers;
  }

  getCapabilities(): IssueCapabilities {
    return CAPABILITIES;
  }

  async hasCredentials(): Promise<boolean> {
    return (await this.getCredentials()) !== undefined;
  }

  async getCurrentUsername(): Promise<string | undefined> {
    if (this.cachedUsername) return this.cachedUsername;
    const headers = await this.headers();
    try {
      const { data } = await httpJson<{ username?: string; nickname?: string; display_name?: string; uuid: string }>(`${this.apiBase()}/user`, { headers });
      // Issues identify people by display name (the reporter field has no username) — the same value is used for "is mine".
      this.cachedUsername = data.display_name ?? data.username ?? data.nickname ?? data.uuid;
      this.cachedUserUuid = data.uuid;
      return this.cachedUsername;
    } catch {
      return undefined;
    }
  }

  private async getCurrentUserUuid(): Promise<string | undefined> {
    if (this.cachedUserUuid) return this.cachedUserUuid;
    await this.getCurrentUsername();
    return this.cachedUserUuid;
  }

  private async getPermission(owner: string, repo: string, headers: Record<string, string>): Promise<'admin' | 'write' | 'read' | undefined> {
    try {
      const query = encodeURIComponent(`repository.full_name="${owner}/${repo}"`);
      const { data } = await httpJson<{ values: { permission: 'admin' | 'write' | 'read' }[] }>(
        `${this.apiBase()}/user/permissions/repositories?q=${query}`, { headers },
      );
      return data.values[0]?.permission;
    } catch {
      return undefined;
    }
  }

  async listIssues(owner: string, repo: string, options: ListIssuesOptions): Promise<ListIssuesResult> {
    const headers = await this.headers();
    const page = Number(options.cursor ?? '1');
    const clauses: string[] = [];
    const states = [
      ...(options.states.includes('open') ? OPEN_STATES : []),
      ...(options.states.includes('closed') ? CLOSED_STATES : []),
    ];
    if (options.states.length === 1) clauses.push(`(${states.map(s => `state="${s}"`).join(' OR ')})`);
    if (options.author === 'mine' || options.assignedToMe) {
      const uuid = await this.getCurrentUserUuid();
      if (uuid && options.author === 'mine') clauses.push(`reporter.uuid="${uuid}"`);
      if (uuid && options.assignedToMe) clauses.push(`assignee.uuid="${uuid}"`);
    }
    const numberMatch = options.search?.trim().match(/^#?(\d+)$/);
    if (numberMatch) clauses.push(`id=${numberMatch[1]}`);
    else if (options.search) clauses.push(`title~"${options.search.replace(/"/g, '\\"')}"`);

    const params = new URLSearchParams({ pagelen: String(PAGE_SIZE), page: String(page), sort: '-updated_on' });
    if (clauses.length > 0) params.set('q', clauses.join(' AND '));
    let result: { data: RawBitbucketIssuePage };
    try {
      result = await httpJson<RawBitbucketIssuePage>(`${this.apiBase()}/repositories/${owner}/${repo}/issues?${params.toString()}`, { headers });
    } catch (err) {
      // Issue trackers are off by default on Bitbucket Cloud: 404 "Repository has no issue tracker."
      if (err instanceof HttpJsonError && err.status === 404 && /issue tracker/i.test(err.message)) throw new IssueTrackerDisabledError();
      if (err instanceof HttpJsonError && (err.status === 401 || err.status === 403)) throw new Error(formatIssueApiError(err));
      throw err;
    }
    return {
      items: result.data.values.map(mapIssue),
      nextCursor: result.data.next ? String(page + 1) : undefined,
      totalCount: result.data.size,
    };
  }

  async getIssueDetail(owner: string, repo: string, number: number): Promise<IssueDetail> {
    const headers = await this.headers();
    const [{ data }, permission, uuid] = await Promise.all([
      httpJson<RawBitbucketIssue>(`${this.apiBase()}/repositories/${owner}/${repo}/issues/${number}`, { headers }),
      this.getPermission(owner, repo, headers),
      this.getCurrentUserUuid(),
    ]);
    const summary = mapIssue(data);
    return {
      ...summary,
      description: data.content?.raw ?? '',
      capabilities: CAPABILITIES,
      canWrite: permission === 'admin' || permission === 'write' || (!!uuid && data.reporter?.uuid === uuid),
      assignees: summary.assignees ?? [],
      labels: summary.labels ?? [],
    };
  }

  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<CreateIssueResult> {
    const headers = await this.headers();
    try {
      const assignee = input.assigneeIds?.[0];
      const { data } = await httpJson<RawBitbucketIssue>(`${this.apiBase()}/repositories/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.title, content: { raw: input.description }, ...(assignee ? { assignee: { uuid: assignee } } : {}) }),
      });
      return { ok: true, issue: mapIssue(data) };
    } catch (err) {
      return { ok: false, error: formatIssueApiError(err) };
    }
  }

  private async putIssue(owner: string, repo: string, number: number, body: Record<string, unknown>): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repositories/${owner}/${repo}/issues/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatIssueApiError(err) };
    }
  }

  async updateIssue(owner: string, repo: string, number: number, input: UpdateIssueInput): Promise<ActionResult> {
    return this.putIssue(owner, repo, number, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { content: { raw: input.description } } : {}),
    });
  }

  /** State changes go through the issue's change log, the way Bitbucket's own UI makes them. */
  private async changeState(owner: string, repo: string, number: number, state: string): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repositories/${owner}/${repo}/issues/${number}/changes`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { state: { new: state } } }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatIssueApiError(err) };
    }
  }

  async closeIssue(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.changeState(owner, repo, number, 'resolved');
  }

  async reopenIssue(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.changeState(owner, repo, number, 'open');
  }

  /** One assignee at most — the first id wins, none unassigns. */
  async updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    return this.putIssue(owner, repo, number, { assignee: userIds[0] ? { uuid: userIds[0] } : null });
  }

  async updateLabels(): Promise<UnsupportedResult> {
    return { ok: false, unsupported: true, error: vscode.l10n.t('Bitbucket Cloud issues have no labels.') };
  }

  private mapComment(c: RawBitbucketComment, currentUserUuid: string | undefined, isAdmin: boolean): PullRequestComment {
    const isOwn = !!currentUserUuid && c.user?.uuid === currentUserUuid;
    return {
      id: String(c.id),
      authorName: c.user?.display_name ?? c.user?.nickname ?? 'unknown',
      authorAvatarUrl: c.user?.links?.avatar?.href,
      body: c.content.raw ?? '',
      createdAt: c.created_on,
      url: c.links.html?.href,
      canEdit: isOwn,
      canDelete: isOwn || isAdmin,
      canHide: false,
    };
  }

  async listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]> {
    const headers = await this.headers();
    const [uuid, permission] = await Promise.all([this.getCurrentUserUuid(), this.getPermission(owner, repo, headers)]);
    const comments: PullRequestComment[] = [];
    let url = `${this.apiBase()}/repositories/${owner}/${repo}/issues/${number}/comments?pagelen=${PAGE_SIZE}`;
    for (;;) {
      const { data } = await httpJson<{ values: RawBitbucketComment[]; next?: string }>(url, { headers });
      // A state change made with a message leaves a comment with no text of its own — nothing to show.
      for (const c of data.values) if (c.content.raw) comments.push(this.mapComment(c, uuid, permission === 'admin'));
      if (!data.next) break;
      url = data.next;
    }
    return comments;
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, uuid, permission] = await Promise.all([
        httpJson<RawBitbucketComment>(`${this.apiBase()}/repositories/${owner}/${repo}/issues/${number}/comments`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: { raw: body } }),
        }),
        this.getCurrentUserUuid(),
        this.getPermission(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapComment(data, uuid, permission === 'admin') };
    } catch (err) {
      return { ok: false, error: formatIssueApiError(err) };
    }
  }

  async updateComment(owner: string, repo: string, number: number, commentId: string, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, uuid, permission] = await Promise.all([
        httpJson<RawBitbucketComment>(`${this.apiBase()}/repositories/${owner}/${repo}/issues/${number}/comments/${commentId}`, {
          method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: { raw: body } }),
        }),
        this.getCurrentUserUuid(),
        this.getPermission(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapComment(data, uuid, permission === 'admin') };
    } catch (err) {
      return { ok: false, error: formatIssueApiError(err) };
    }
  }

  async deleteComment(owner: string, repo: string, number: number, commentId: string): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repositories/${owner}/${repo}/issues/${number}/comments/${commentId}`, { method: 'DELETE', headers });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatIssueApiError(err) };
    }
  }

  /** The issue's change log: renames and state changes (an assignee change only carries an account id, no name). */
  async listEvents(owner: string, repo: string, number: number): Promise<PullRequestEvent[]> {
    const headers = await this.headers();
    const events: PullRequestEvent[] = [];
    let url = `${this.apiBase()}/repositories/${owner}/${repo}/issues/${number}/changes?pagelen=${PAGE_SIZE}`;
    for (;;) {
      const { data } = await httpJson<{ values: RawBitbucketChange[]; next?: string }>(url, { headers });
      for (const c of data.values) {
        const base = { actorName: c.user?.display_name ?? 'unknown', actorAvatarUrl: c.user?.links?.avatar?.href, createdAt: c.created_on };
        const title = c.changes.title;
        if (title?.new && title.new !== title.old) events.push({ ...base, id: `title-${c.id}`, kind: 'renamed', previousTitle: title.old, newTitle: title.new });
        const state = c.changes.state;
        if (state?.new && state.old && mapState(state.new) !== mapState(state.old)) {
          events.push({ ...base, id: `state-${c.id}`, kind: mapState(state.new) === 'closed' ? 'closed' : 'reopened' });
        }
      }
      if (!data.next) break;
      url = data.next;
    }
    return events;
  }

  /** Bitbucket exposes no link from an issue to the pull requests mentioning it. */
  async listLinkedPullRequests(): Promise<LinkedPullRequest[]> {
    return [];
  }

  /** No API for it either — the PR description's closing keywords ("Fixes #12") are read instead. */
  async listIssuesClosedByPullRequest(owner: string, repo: string, _prNumber: number, prDescription: string): Promise<LinkedIssue[]> {
    const headers = await this.headers();
    const issues = await Promise.all(parseClosingReferences(prDescription).map(n =>
      httpJson<RawBitbucketIssue>(`${this.apiBase()}/repositories/${owner}/${repo}/issues/${n}`, { headers }).then(({ data }) => data).catch(() => undefined),
    ));
    return issues
      .filter((i): i is RawBitbucketIssue => !!i)
      .map(i => ({ number: i.id, title: i.title, url: i.links.html.href, state: mapState(i.state), repoFullName: `${owner}/${repo}`, sameRepo: true }));
  }
}
