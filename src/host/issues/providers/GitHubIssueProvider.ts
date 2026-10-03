import type { ActionResult, PostCommentResult, PullRequestComment, PullRequestEvent, PullRequestSummary, TimelineReference } from '../../pullRequests/types';
import { httpJson, HttpJsonError } from '../../pullRequests/httpJson';
import { formatApiError } from '../../pullRequests/formatApiError';
import { mapGithubTimelineNode, type RawGithubTimelineNode } from '../../pullRequests/providers/GitHubProvider';
import {
  IssueTrackerDisabledError,
  type CreateIssueInput, type CreateIssueResult, type IssueCapabilities, type IssueDetail, type IssueProvider, type IssueStateReason,
  type IssueSummary, type LinkedIssue, type LinkedPullRequest, type ListIssuesOptions, type ListIssuesResult, type UpdateIssueInput,
} from '../types';

const PAGE_SIZE = 30;

const CAPABILITIES: IssueCapabilities = {
  canManageAssignees: true,
  singleAssignee: false,
  canManageLabels: true,
  canFilterMentions: true,
  canFilterAssignee: true,
};

interface RawGitHubIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  state_reason?: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null;
  body?: string | null;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  updated_at: string;
  comments?: number;
  assignees?: { login: string; avatar_url: string }[];
  labels?: ({ name: string; color: string } | string)[];
  /** Present when the item is actually a pull request — the issues endpoints return both. */
  pull_request?: unknown;
}

interface RawGitHubIssueComment {
  id: number;
  body: string;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  html_url: string;
}

interface RawGraphqlIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  stateReason?: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | 'DUPLICATE' | null;
  createdAt: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  comments: { totalCount: number };
  assignees: { nodes: { login: string; avatarUrl: string }[] };
  labels: { nodes: { name: string; color: string }[] } | null;
}

interface RawGraphqlPrRef {
  number?: number;
  title?: string;
  url?: string;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft?: boolean;
  repository?: { nameWithOwner: string };
}

function mapStateReason(reason: string | null | undefined): IssueStateReason | undefined {
  switch (reason?.toLowerCase()) {
    case 'completed': return 'completed';
    case 'not_planned': return 'notPlanned';
    case 'duplicate': return 'duplicate';
    default: return undefined;
  }
}

function mapRestIssue(issue: RawGitHubIssue): IssueSummary {
  return {
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    stateReason: issue.state === 'closed' ? mapStateReason(issue.state_reason) : undefined,
    authorName: issue.user?.login ?? 'unknown',
    authorAvatarUrl: issue.user?.avatar_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    commentCount: issue.comments,
    assignees: (issue.assignees ?? []).map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatar_url })),
    labels: (issue.labels ?? []).map(l => typeof l === 'string'
      ? { id: l, name: l, color: '808080' }
      : { id: l.name, name: l.name, color: l.color }),
  };
}

function mapGraphqlIssue(issue: RawGraphqlIssue): IssueSummary {
  const state = issue.state === 'CLOSED' ? 'closed' : 'open';
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state,
    stateReason: state === 'closed' ? mapStateReason(issue.stateReason) : undefined,
    authorName: issue.author?.login ?? 'ghost',
    authorAvatarUrl: issue.author?.avatarUrl,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    commentCount: issue.comments.totalCount,
    assignees: issue.assignees.nodes.map(u => ({ id: u.login, username: u.login, avatarUrl: u.avatarUrl })),
    labels: (issue.labels?.nodes ?? []).map(l => ({ id: l.name, name: l.name, color: l.color })),
  };
}

function mapPrState(pr: RawGraphqlPrRef): PullRequestSummary['state'] {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  return pr.isDraft ? 'draft' : 'open';
}

const PR_REF_FIELDS = 'number title url state isDraft repository { nameWithOwner }';
const ISSUE_REF_FIELDS = 'number title url state stateReason repository { nameWithOwner }';

interface RawGraphqlRefSource extends RawGraphqlPrRef {
  __typename?: string;
  stateReason?: string | null;
}

/** A timeline node about another pull request/issue or a commit — the PR provider's mapper doesn't know them. */
interface RawReferenceNode {
  __typename: string;
  id: string;
  createdAt: string;
  actor?: { login: string; avatarUrl?: string } | null;
  willCloseTarget?: boolean;
  source?: RawGraphqlRefSource;
  subject?: RawGraphqlRefSource;
  commit?: { oid: string; abbreviatedOid: string; messageHeadline: string; url: string } | null;
  commitRepository?: { nameWithOwner: string } | null;
}

function mapReference(ref: RawGraphqlRefSource, ownFullName: string, willClose?: boolean): TimelineReference | undefined {
  if (!ref.number || !ref.url) return undefined;
  const repoFullName = ref.repository?.nameWithOwner;
  const isIssue = ref.__typename === 'Issue';
  return {
    kind: isIssue ? 'issue' : 'pullRequest',
    number: ref.number,
    title: ref.title ?? '',
    url: ref.url,
    state: isIssue ? (ref.state === 'CLOSED' ? 'closed' : 'open') : mapPrState(ref),
    stateReason: isIssue && ref.state === 'CLOSED' ? mapStateReason(ref.stateReason) : undefined,
    repoFullName,
    sameRepo: !repoFullName || repoFullName.toLowerCase() === ownFullName,
    willClose,
  };
}

/** Maps the reference/commit/link nodes of an issue timeline; anything else goes through the PR provider's mapper. */
function mapIssueTimelineNode(node: RawGithubTimelineNode & RawReferenceNode, ownFullName: string): PullRequestEvent | null {
  const base = { id: node.id, actorName: node.actor?.login ?? 'ghost', actorAvatarUrl: node.actor?.avatarUrl, createdAt: node.createdAt };
  switch (node.__typename) {
    case 'CrossReferencedEvent': {
      const reference = node.source && mapReference(node.source, ownFullName, node.willCloseTarget);
      return reference ? { ...base, kind: 'crossReferenced', reference } : null;
    }
    case 'ConnectedEvent':
    case 'DisconnectedEvent': {
      // Both ends are named — this issue and the PR; only the PR end matches the fragment.
      const end = node.subject?.number ? node.subject : node.source;
      const reference = end && mapReference({ ...end, __typename: 'PullRequest' }, ownFullName, node.__typename === 'ConnectedEvent');
      return reference ? { ...base, kind: node.__typename === 'ConnectedEvent' ? 'connected' : 'disconnected', reference } : null;
    }
    case 'ReferencedEvent': {
      if (!node.commit) return null;
      const repoFullName = node.commitRepository?.nameWithOwner;
      return {
        ...base,
        kind: 'commitReferenced',
        commit: {
          sha: node.commit.oid, shortSha: node.commit.abbreviatedOid, message: node.commit.messageHeadline, url: node.commit.url,
          repoFullName, sameRepo: !repoFullName || repoFullName.toLowerCase() === ownFullName,
        },
      };
    }
    default:
      return mapGithubTimelineNode(node);
  }
}

export class GitHubIssueProvider implements IssueProvider {
  readonly kind = 'github' as const;
  private cachedUsername: string | undefined;

  constructor(
    private readonly host: string,
    private readonly getToken: () => Promise<string | undefined>,
  ) {}

  private apiBase(): string {
    return this.host === 'github.com' ? 'https://api.github.com' : `https://${this.host}/api/v3`;
  }

  private graphqlUrl(): string {
    return this.host === 'github.com' ? 'https://api.github.com/graphql' : `https://${this.host}/api/graphql`;
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

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const headers = await this.headers();
    const { data } = await httpJson<{ data?: T; errors?: Array<{ message: string }> }>(this.graphqlUrl(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join('; '));
    return data.data as T;
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

  async listIssues(owner: string, repo: string, options: ListIssuesOptions): Promise<ListIssuesResult> {
    const headers = await this.headers();

    // A bare number goes straight to a single get-by-number call — the issues endpoint also answers for PRs, so those are dropped.
    const numberMatch = options.search?.trim().match(/^#?(\d+)$/);
    if (numberMatch) {
      try {
        const { data } = await httpJson<RawGitHubIssue>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${numberMatch[1]}`, { headers });
        if (data.pull_request) return { items: [] };
        const issue = mapRestIssue(data);
        return { items: options.states.includes(issue.state) ? [issue] : [] };
      } catch (err) {
        if (err instanceof HttpJsonError && err.status === 404) return { items: [] };
        if (err instanceof HttpJsonError && err.status === 410) throw new IssueTrackerDisabledError();
        throw err;
      }
    }

    const needsUser = options.author === 'mine' || options.assignedToMe || options.mentioningMe;
    const username = needsUser ? await this.getCurrentUsername() : undefined;

    if (options.search) {
      // Free text needs the Search API — GraphQL's issues connection has no text filter.
      const qParts = [`repo:${owner}/${repo}`, 'is:issue'];
      if (options.states.length === 1) qParts.push(`is:${options.states[0]}`);
      if (options.author === 'mine' && username) qParts.push(`author:${username}`);
      if (options.assignedToMe && username) qParts.push(`assignee:${username}`);
      if (options.mentioningMe && username) qParts.push(`mentions:${username}`);
      qParts.push(options.search);
      const page = Number(options.cursor ?? '1');
      const params = new URLSearchParams({ q: qParts.join(' '), per_page: String(PAGE_SIZE), page: String(page), sort: 'updated' });
      const { data } = await httpJson<{ items: RawGitHubIssue[]; total_count: number }>(`${this.apiBase()}/search/issues?${params.toString()}`, { headers });
      return {
        items: data.items.map(mapRestIssue),
        nextCursor: data.items.length === PAGE_SIZE ? String(page + 1) : undefined,
        totalCount: data.total_count,
      };
    }

    // The REST issues list mixes pull requests in (and counts them in every page), so GraphQL's issues connection
    // is used instead: issues only, with an exact, filter-aware totalCount for the tab badge.
    const filterBy: Record<string, string> = {};
    if (options.author === 'mine' && username) filterBy.createdBy = username;
    if (options.assignedToMe && username) filterBy.assignee = username;
    if (options.mentioningMe && username) filterBy.mentioned = username;
    const buildQuery = (withStateReason: boolean) => `query($owner: String!, $repo: String!, $first: Int!, $after: String, $states: [IssueState!], $filterBy: IssueFilters) {
      repository(owner: $owner, name: $repo) {
        hasIssuesEnabled
        issues(first: $first, after: $after, states: $states, filterBy: $filterBy, orderBy: { field: UPDATED_AT, direction: DESC }) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id number title url state ${withStateReason ? 'stateReason' : ''} createdAt updatedAt
            author { login avatarUrl }
            comments { totalCount }
            assignees(first: 10) { nodes { login avatarUrl } }
            labels(first: 20) { nodes { name color } }
          }
        }
      }
    }`;
    type Result = {
      repository: { hasIssuesEnabled: boolean; issues: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawGraphqlIssue[] } } | null;
    };
    const variables = {
      owner, repo, first: PAGE_SIZE, after: options.cursor ?? null,
      states: options.states.map(s => s.toUpperCase()),
      filterBy,
    };
    let data: Result;
    try {
      data = await this.graphql<Result>(buildQuery(true), variables);
    } catch (err) {
      // Older GitHub Enterprise versions predate `stateReason` — list without it rather than not at all.
      if (!(err instanceof Error) || !err.message.includes('stateReason')) throw err;
      data = await this.graphql<Result>(buildQuery(false), variables);
    }
    if (!data.repository) throw new Error(`Repository ${owner}/${repo} not found`);
    if (!data.repository.hasIssuesEnabled) throw new IssueTrackerDisabledError();
    const { issues } = data.repository;
    return {
      items: issues.nodes.map(mapGraphqlIssue),
      nextCursor: issues.pageInfo.hasNextPage && issues.pageInfo.endCursor ? issues.pageInfo.endCursor : undefined,
      totalCount: issues.totalCount,
    };
  }

  /** Push access lets anyone edit/close/label any issue; without it, only the issue's own author can edit it. */
  private async getRepoCanWrite(owner: string, repo: string, headers: Record<string, string>): Promise<boolean> {
    try {
      const { data } = await httpJson<{ permissions?: { push?: boolean; triage?: boolean } }>(`${this.apiBase()}/repos/${owner}/${repo}`, { headers });
      return data.permissions?.push ?? data.permissions?.triage ?? false;
    } catch {
      return false;
    }
  }

  async getIssueDetail(owner: string, repo: string, number: number): Promise<IssueDetail> {
    const headers = await this.headers();
    const [{ data }, canWriteRepo, username] = await Promise.all([
      httpJson<RawGitHubIssue>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}`, { headers }),
      this.getRepoCanWrite(owner, repo, headers),
      this.getCurrentUsername(),
    ]);
    if (data.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
    const summary = mapRestIssue(data);
    return {
      ...summary,
      description: data.body ?? '',
      capabilities: CAPABILITIES,
      canWrite: canWriteRepo || (!!username && username === summary.authorName),
      assignees: summary.assignees ?? [],
      labels: summary.labels ?? [],
    };
  }

  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<CreateIssueResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitHubIssue>(`${this.apiBase()}/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.title, body: input.description, assignees: input.assigneeIds, labels: input.labelIds }),
      });
      return { ok: true, issue: mapRestIssue(data) };
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
    return this.patchIssue(owner, repo, number, { state: 'closed', state_reason: 'completed' });
  }

  async reopenIssue(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.patchIssue(owner, repo, number, { state: 'open' });
  }

  /** Unlike the PR reviewers endpoint, an issue PATCH takes the whole assignee list — a true replace. */
  async updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    return this.patchIssue(owner, repo, number, { assignees: userIds });
  }

  async updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/labels`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: labelIds }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  private mapComment(c: RawGitHubIssueComment, currentUsername: string | undefined, canWrite: boolean): PullRequestComment {
    const isOwn = !!currentUsername && c.user?.login === currentUsername;
    return {
      id: String(c.id),
      authorName: c.user?.login ?? 'ghost',
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
    const [currentUsername, canWrite] = await Promise.all([this.getCurrentUsername(), this.getRepoCanWrite(owner, repo, headers)]);
    const comments: PullRequestComment[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGitHubIssueComment[]>(
        `${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`, { headers },
      );
      comments.push(...data.map(c => this.mapComment(c, currentUsername, canWrite)));
      if (data.length < 100) break;
      page++;
    }
    return comments;
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, currentUsername, canWrite] = await Promise.all([
        httpJson<RawGitHubIssueComment>(`${this.apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        }),
        this.getCurrentUsername(),
        this.getRepoCanWrite(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapComment(data, currentUsername, canWrite) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateComment(owner: string, repo: string, _number: number, commentId: string, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const [{ data }, currentUsername, canWrite] = await Promise.all([
        httpJson<RawGitHubIssueComment>(`${this.apiBase()}/repos/${owner}/${repo}/issues/comments/${commentId}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        }),
        this.getCurrentUsername(),
        this.getRepoCanWrite(owner, repo, headers),
      ]);
      return { ok: true, comment: this.mapComment(data, currentUsername, canWrite) };
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

  /** Same GraphQL timeline the PR provider reads, scoped to the event types an issue can have. */
  async listEvents(owner: string, repo: string, number: number): Promise<PullRequestEvent[]> {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          timelineItems(first: 100, itemTypes: [
            RENAMED_TITLE_EVENT, LABELED_EVENT, UNLABELED_EVENT, CLOSED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT,
            CROSS_REFERENCED_EVENT, REFERENCED_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT
          ]) {
            nodes {
              __typename
              ... on RenamedTitleEvent { id previousTitle currentTitle createdAt actor { login avatarUrl } }
              ... on LabeledEvent { id createdAt actor { login avatarUrl } label { name color } }
              ... on UnlabeledEvent { id createdAt actor { login avatarUrl } label { name color } }
              ... on ClosedEvent { id createdAt actor { login avatarUrl } }
              ... on ReopenedEvent { id createdAt actor { login avatarUrl } }
              ... on AssignedEvent { id createdAt actor { login avatarUrl } assignee { ... on User { login avatarUrl } } }
              ... on UnassignedEvent { id createdAt actor { login avatarUrl } assignee { ... on User { login avatarUrl } } }
              ... on CrossReferencedEvent { id createdAt willCloseTarget actor { login avatarUrl } source { __typename ... on PullRequest { ${PR_REF_FIELDS} } ... on Issue { ${ISSUE_REF_FIELDS} } } }
              ... on ReferencedEvent { id createdAt actor { login avatarUrl } commit { oid abbreviatedOid messageHeadline url } commitRepository { nameWithOwner } }
              ... on ConnectedEvent { id createdAt actor { login avatarUrl } source { ... on PullRequest { ${PR_REF_FIELDS} } } subject { ... on PullRequest { ${PR_REF_FIELDS} } } }
              ... on DisconnectedEvent { id createdAt actor { login avatarUrl } source { ... on PullRequest { ${PR_REF_FIELDS} } } subject { ... on PullRequest { ${PR_REF_FIELDS} } } }
            }
          }
        }
      }
    }`;
    const data = await this.graphql<{ repository?: { issue?: { timelineItems?: { nodes: (RawGithubTimelineNode & RawReferenceNode)[] } } } }>(query, { owner, repo, number });
    const nodes = data.repository?.issue?.timelineItems?.nodes ?? [];
    const ownFullName = `${owner}/${repo}`.toLowerCase();
    return nodes.map(n => mapIssueTimelineNode(n, ownFullName)).filter((e): e is PullRequestEvent => e !== null);
  }

  /** Cross-references from pull requests (a PR mentioning the issue, with `willCloseTarget` when it closes it on
   * merge) and manual "linked pull request" connections, read from the issue's timeline. */
  async listLinkedPullRequests(owner: string, repo: string, number: number): Promise<LinkedPullRequest[]> {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT]) {
            nodes {
              __typename
              ... on CrossReferencedEvent { willCloseTarget source { ... on PullRequest { ${PR_REF_FIELDS} } } }
              ... on ConnectedEvent { source { ... on PullRequest { ${PR_REF_FIELDS} } } subject { ... on PullRequest { ${PR_REF_FIELDS} } } }
              ... on DisconnectedEvent { source { ... on PullRequest { ${PR_REF_FIELDS} } } subject { ... on PullRequest { ${PR_REF_FIELDS} } } }
            }
          }
        }
      }
    }`;
    type Node = { __typename: string; willCloseTarget?: boolean; source?: RawGraphqlPrRef; subject?: RawGraphqlPrRef };
    const data = await this.graphql<{ repository?: { issue?: { timelineItems?: { nodes: Node[] } } } }>(query, { owner, repo, number });
    const ownFullName = `${owner}/${repo}`.toLowerCase();
    const byKey = new Map<string, LinkedPullRequest>();
    for (const node of data.repository?.issue?.timelineItems?.nodes ?? []) {
      // A (dis)connection names both ends — the issue itself and the PR; only the PR end matches the fragment.
      const pr = node.__typename === 'CrossReferencedEvent' ? node.source : (node.subject?.number ? node.subject : node.source);
      if (!pr?.number || !pr.url) continue;
      const repoFullName = pr.repository?.nameWithOwner;
      const key = `${repoFullName ?? ''}#${pr.number}`;
      if (node.__typename === 'DisconnectedEvent') {
        byKey.delete(key);
        continue;
      }
      const existing = byKey.get(key);
      byKey.set(key, {
        number: pr.number,
        title: pr.title ?? '',
        url: pr.url,
        state: mapPrState(pr),
        repoFullName,
        sameRepo: !repoFullName || repoFullName.toLowerCase() === ownFullName,
        willClose: !!existing?.willClose || node.__typename === 'ConnectedEvent' || !!node.willCloseTarget,
      });
    }
    return [...byKey.values()];
  }

  async listIssuesClosedByPullRequest(owner: string, repo: string, prNumber: number): Promise<LinkedIssue[]> {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 25) {
            nodes { number title url state stateReason repository { nameWithOwner } }
          }
        }
      }
    }`;
    type Node = { number: number; title: string; url: string; state: 'OPEN' | 'CLOSED'; stateReason?: string | null; repository?: { nameWithOwner: string } };
    const data = await this.graphql<{ repository?: { pullRequest?: { closingIssuesReferences?: { nodes: Node[] } } } }>(query, { owner, repo, number: prNumber });
    const ownFullName = `${owner}/${repo}`.toLowerCase();
    return (data.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []).map(n => {
      const state = n.state === 'CLOSED' ? 'closed' : 'open';
      const repoFullName = n.repository?.nameWithOwner;
      return {
        number: n.number,
        title: n.title,
        url: n.url,
        state,
        stateReason: state === 'closed' ? mapStateReason(n.stateReason) : undefined,
        repoFullName,
        sameRepo: !repoFullName || repoFullName.toLowerCase() === ownFullName,
      };
    });
  }
}
