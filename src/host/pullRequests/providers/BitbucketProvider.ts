import type {
  ActionResult, ChangedFile, CiCheck, CiStatus, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs,
  ListPullRequestsOptions, ListPullRequestsResult, MergeStrategy, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestLabel, PullRequestProvider, PullRequestSummary, PullRequestUser,
  SubmitReviewInput, UnsupportedResult, UpdatePullRequestInput,
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
  canManageReviewers: true,
  // Bitbucket Cloud has no "assignee" concept on pull requests, only reviewers.
  canManageAssignees: false,
  // Bitbucket Cloud has no labels concept on pull requests at all.
  canManageLabels: false,
};

interface RawBitbucketUserRef {
  uuid: string;
  display_name: string;
  nickname?: string;
  links: { avatar: { href: string } };
}

interface RawBitbucketPr {
  id: number;
  title: string;
  links: { html: { href: string } };
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft?: boolean;
  source: { branch: { name: string }; repository?: { full_name: string } };
  destination: { branch: { name: string }; repository?: { full_name: string } };
  author: { display_name: string; nickname?: string; uuid?: string; links: { avatar: { href: string } } } | null;
  created_on: string;
  updated_on: string;
  comment_count?: number;
  reviewers?: RawBitbucketUserRef[];
}

interface RawBitbucketPrDetail extends RawBitbucketPr {
  description?: string;
  source: { branch: { name: string }; commit: { hash: string } };
  destination: { branch: { name: string }; commit: { hash: string } };
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

interface RawBitbucketCommentUser {
  display_name: string;
  nickname?: string;
  links: { avatar: { href: string } };
}

interface RawBitbucketComment {
  id: number;
  content: { raw: string };
  user: RawBitbucketCommentUser | null;
  created_on: string;
  links: { html: { href: string } };
  deleted?: boolean;
}

interface RawBitbucketCommentPage {
  values: RawBitbucketComment[];
  next?: string;
}

interface RawBitbucketDiffstatEntry {
  status: 'added' | 'removed' | 'modified' | 'renamed';
  old?: { path: string };
  new?: { path: string };
  lines_added?: number;
  lines_removed?: number;
}

interface RawBitbucketDiffstatPage {
  values: RawBitbucketDiffstatEntry[];
  next?: string;
}

interface RawBitbucketCommit {
  hash: string;
  message: string;
  author: { user?: RawBitbucketCommentUser; raw: string };
  date: string;
  parents: { hash: string }[];
}

interface RawBitbucketCommitPage {
  values: RawBitbucketCommit[];
  next?: string;
}

interface RawBitbucketCommitStatus {
  key: string;
  name?: string;
  state: 'INPROGRESS' | 'SUCCESSFUL' | 'FAILED' | 'STOPPED' | string;
  url?: string;
  created_on?: string;
  updated_on?: string;
}

interface RawBitbucketCommitStatusPage {
  values: RawBitbucketCommitStatus[];
  next?: string;
}

function mapState(pr: RawBitbucketPr): PullRequestSummary['state'] {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'DECLINED' || pr.state === 'SUPERSEDED') return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

function mapPr(pr: RawBitbucketPr): PullRequestSummary {
  const sourceRepo = pr.source.repository?.full_name;
  const targetRepo = pr.destination.repository?.full_name;
  return {
    id: String(pr.id),
    number: pr.id,
    title: pr.title,
    url: pr.links.html.href,
    state: mapState(pr),
    sourceBranch: pr.source.branch.name,
    targetBranch: pr.destination.branch.name,
    sourceRepoFullName: sourceRepo && sourceRepo !== targetRepo ? sourceRepo : undefined,
    targetRepoFullName: targetRepo,
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

function mapDiffstatStatus(status: RawBitbucketDiffstatEntry['status']): ChangedFile['status'] {
  if (status === 'added') return 'added';
  if (status === 'removed') return 'deleted';
  if (status === 'renamed') return 'renamed';
  return 'modified';
}

function mapDiffstatEntry(entry: RawBitbucketDiffstatEntry): ChangedFile {
  const path = entry.new?.path ?? entry.old?.path ?? '';
  const oldPath = entry.old?.path;
  const file: ChangedFile = {
    path,
    status: mapDiffstatStatus(entry.status),
    additions: entry.lines_added,
    deletions: entry.lines_removed,
  };
  if (oldPath && oldPath !== path) file.oldPath = oldPath;
  return file;
}

function mapCommentUser(user: RawBitbucketCommentUser | null): { authorName: string; authorAvatarUrl?: string } {
  return {
    authorName: user?.display_name ?? user?.nickname ?? 'unknown',
    authorAvatarUrl: user?.links?.avatar?.href,
  };
}

/** Bitbucket omits `author.user` when the commit's author has no linked Bitbucket account — fall back to the raw "Name <email>" string. */
function mapCommitAuthorName(author: RawBitbucketCommit['author']): string {
  if (author.user) return author.user.display_name ?? author.user.nickname ?? 'unknown';
  const match = /^([^<]+)</.exec(author.raw);
  return match ? match[1].trim() : author.raw;
}

const MERGE_STRATEGY_MAP: Record<MergeStrategy, string> = {
  merge: 'merge_commit',
  squash: 'squash',
  fastForward: 'fast_forward',
  rebase: 'merge_commit',
};

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

  /**
   * Bitbucket Cloud exposes NO dedicated ref for a PR's head (unlike GitHub/GitLab/Gitea) — confirmed
   * against Atlassian's own tracker (BCLOUD-5814/22185, still open): `refs/pull-requests/*` only exists
   * on Bitbucket Server, not Cloud. Atlassian's own docs recommend fetching the PR's actual source branch
   * directly instead, from the source repo (which may be a fork) — so `remote` here is a literal, credential-
   * embedded HTTPS fetch URL rather than an existing git remote name, and `refspec` names the real branch.
   */
  async getCheckoutSource(pr: PullRequestSummary): Promise<{ remote: string; refspec: string }> {
    const credentials = await this.getCredentials();
    const auth = credentials ? `${encodeURIComponent(credentials.email)}:${encodeURIComponent(credentials.apiToken)}@` : '';
    const sourceRepoFullName = pr.sourceRepoFullName ?? pr.targetRepoFullName;
    return {
      remote: `https://${auth}bitbucket.org/${sourceRepoFullName}.git`,
      refspec: `refs/heads/${pr.sourceBranch}`,
    };
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const headers = await this.headers();
    const names: string[] = [];
    let url = `${this.apiBase()}/repositories/${owner}/${repo}/refs/branches?pagelen=${PAGE_SIZE}`;
    for (;;) {
      const { data } = await httpJson<{ values: { name: string }[]; next?: string }>(url, { headers });
      names.push(...data.values.map(b => b.name));
      if (!data.next) break;
      url = data.next;
    }
    return names;
  }

  async listCollaborators(owner: string): Promise<PullRequestUser[]> {
    const headers = await this.headers();
    const users: PullRequestUser[] = [];
    let url = `${this.apiBase()}/workspaces/${owner}/members?pagelen=${PAGE_SIZE}`;
    for (;;) {
      const { data } = await httpJson<{ values: { user: RawBitbucketUserRef }[]; next?: string }>(url, { headers });
      users.push(...data.values.map(m => ({
        id: m.user.uuid,
        username: m.user.display_name ?? m.user.nickname ?? m.user.uuid,
        avatarUrl: m.user.links?.avatar?.href,
      })));
      if (!data.next) break;
      url = data.next;
    }
    return users;
  }

  /** Bitbucket Cloud has no labels concept on pull requests — always empty. */
  async listAvailableLabels(): Promise<PullRequestLabel[]> {
    return [];
  }

  private async fetchCommitStatuses(owner: string, repo: string, sha: string): Promise<RawBitbucketCommitStatus[]> {
    const headers = await this.headers();
    const statuses: RawBitbucketCommitStatus[] = [];
    let url = `${this.apiBase()}/repositories/${owner}/${repo}/commit/${sha}/statuses?pagelen=100`;
    for (;;) {
      const { data } = await httpJson<RawBitbucketCommitStatusPage>(url, { headers });
      statuses.push(...data.values);
      if (!data.next) break;
      url = data.next;
    }
    return statuses;
  }

  /** Aggregates the (possibly multiple, one per CI system) build statuses posted to a commit — Bitbucket Pipelines and any external CI both post through this same generic endpoint. */
  private async getCiStatusForCommit(owner: string, repo: string, sha: string): Promise<CiStatus | undefined> {
    const statuses = await this.fetchCommitStatuses(owner, repo, sha);
    if (statuses.length === 0) return undefined;
    const hasFailure = statuses.some(s => s.state === 'FAILED' || s.state === 'STOPPED');
    const hasPending = statuses.some(s => s.state === 'INPROGRESS');
    return { state: hasFailure ? 'failure' : hasPending ? 'pending' : 'success', url: statuses[0]?.url };
  }

  /** No native duration field on Bitbucket's status entries — `updated_on` doubles as "last touched," so an in-progress entry's duration is only meaningful once it moves past `created_on`. */
  async listChecks(owner: string, repo: string, headSha: string): Promise<CiCheck[]> {
    const statuses = await this.fetchCommitStatuses(owner, repo, headSha);
    return statuses.map(s => ({
      id: s.key,
      name: s.name ?? s.key,
      state: s.state === 'SUCCESSFUL' ? 'success' : s.state === 'INPROGRESS' ? 'pending' : 'failure',
      url: s.url,
      startedAt: s.created_on,
      completedAt: s.updated_on,
    }));
  }

  async getPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail> {
    const headers = await this.headers();
    const { data } = await httpJson<RawBitbucketPrDetail>(
      `${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}`, { headers },
    );

    // Both lookups below are independent, best-effort extras on top of the PR itself — run them in parallel.
    const [canWrite, ciStatus] = await Promise.all([
      (async () => {
        try {
          const query = encodeURIComponent(`repository.full_name="${owner}/${repo}"`);
          const { data: permData } = await httpJson<{ values: { permission: 'admin' | 'write' | 'read' }[] }>(
            `${this.apiBase()}/user/permissions/repositories?q=${query}`, { headers },
          );
          return permData.values[0]?.permission === 'admin' || permData.values[0]?.permission === 'write';
        } catch {
          // Permission check is best-effort — default to no write access rather than fail the whole detail load.
          return false;
        }
      })(),
      this.getCiStatusForCommit(owner, repo, data.source.commit.hash).catch(() => undefined),
    ]);

    return {
      ...mapPr(data),
      description: data.description ?? '',
      merged: data.state === 'MERGED',
      mergeableState: undefined,
      headSha: data.source.commit.hash,
      baseSha: data.destination.commit.hash,
      ciStatus,
      capabilities: CAPABILITIES,
      canWrite,
      reviewers: (data.reviewers ?? []).map(u => ({ id: u.uuid, username: u.display_name ?? u.nickname ?? u.uuid, avatarUrl: u.links?.avatar?.href })),
      assignees: [],
      labels: [],
    };
  }

  async updatePullRequest(owner: string, repo: string, number: number, input: UpdatePullRequestInput): Promise<ActionResult> {
    const headers = await this.headers();
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.targetBranch !== undefined) body.destination = { branch: { name: input.targetBranch } };
    try {
      await httpJson(`${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Bitbucket's PUT pullrequest endpoint requires `title` even when only `reviewers` is changing — fetch the current title first. */
  async updateReviewers(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      const { data: current } = await httpJson<RawBitbucketPr>(`${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}`, { headers });
      await httpJson(`${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: current.title, reviewers: userIds.map(uuid => ({ uuid })) }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async updateAssignees(): Promise<ActionResult | UnsupportedResult> {
    return { ok: false, unsupported: true, error: 'Bitbucket does not support assignees on pull requests, only reviewers.' };
  }

  async updateLabels(): Promise<ActionResult | UnsupportedResult> {
    return { ok: false, unsupported: true, error: 'Bitbucket does not support labels on pull requests.' };
  }

  async listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]> {
    const headers = await this.headers();
    const comments: PullRequestComment[] = [];
    let url = `${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}/comments?pagelen=${PAGE_SIZE}`;
    for (;;) {
      const { data } = await httpJson<RawBitbucketCommentPage>(url, { headers });
      for (const c of data.values) {
        if (c.deleted) continue;
        comments.push({
          id: String(c.id),
          ...mapCommentUser(c.user),
          body: c.content.raw,
          createdAt: c.created_on,
          url: c.links.html.href,
        });
      }
      if (!data.next) break;
      url = data.next;
    }
    return comments;
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawBitbucketComment>(
        `${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}/comments`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { raw: body } }),
        },
      );
      return {
        ok: true,
        comment: {
          id: String(data.id),
          ...mapCommentUser(data.user),
          body: data.content.raw,
          createdAt: data.created_on,
          url: data.links.html.href,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listChangedFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]> {
    const headers = await this.headers();
    const files: ChangedFile[] = [];
    let url = `${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}/diffstat?pagelen=${PAGE_SIZE}`;
    for (;;) {
      const { data } = await httpJson<RawBitbucketDiffstatPage>(url, { headers });
      files.push(...data.values.map(mapDiffstatEntry));
      if (!data.next) break;
      url = data.next;
    }
    return files;
  }

  private async getBlobAtRef(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const headers = await this.headers();
    const url = `${this.apiBase()}/repositories/${owner}/${repo}/src/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) return '';
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
    }
    return res.text();
  }

  async getFileDiff(owner: string, repo: string, number: number, file: ChangedFile, refs: FileDiffRefs): Promise<FileDiffContent> {
    const [beforeContent, afterContent] = await Promise.all([
      file.status === 'added' ? Promise.resolve('') : this.getBlobAtRef(owner, repo, file.oldPath ?? file.path, refs.baseSha),
      file.status === 'deleted' ? Promise.resolve('') : this.getBlobAtRef(owner, repo, file.path, refs.headSha),
    ]);
    return { path: file.path, oldPath: file.oldPath, beforeContent, afterContent };
  }

  async listCommits(owner: string, repo: string, number: number): Promise<PullRequestCommit[]> {
    const headers = await this.headers();
    const commits: PullRequestCommit[] = [];
    let url = `${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}/commits?pagelen=${PAGE_SIZE}`;
    for (;;) {
      const { data } = await httpJson<RawBitbucketCommitPage>(url, { headers });
      commits.push(...data.values.map(c => ({
        sha: c.hash,
        shortSha: c.hash.slice(0, 8),
        message: c.message,
        authorName: mapCommitAuthorName(c.author),
        authorAvatarUrl: c.author.user?.links?.avatar?.href,
        authoredAt: c.date,
        parentSha: c.parents[0]?.hash,
      })));
      if (!data.next) break;
      url = data.next;
    }
    return commits;
  }

  async listCommitFiles(owner: string, repo: string, sha: string): Promise<ChangedFile[]> {
    const headers = await this.headers();
    const files: ChangedFile[] = [];
    let url = `${this.apiBase()}/repositories/${owner}/${repo}/diffstat/${sha}?pagelen=${PAGE_SIZE}`;
    for (;;) {
      const { data } = await httpJson<RawBitbucketDiffstatPage>(url, { headers });
      files.push(...data.values.map(mapDiffstatEntry));
      if (!data.next) break;
      url = data.next;
    }
    return files;
  }

  async mergePullRequest(owner: string, repo: string, number: number, strategy: MergeStrategy): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}/merge`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ merge_strategy: MERGE_STRATEGY_MAP[strategy] }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async closePullRequest(owner: string, repo: string, number: number): Promise<ActionResult> {
    const headers = await this.headers();
    try {
      await httpJson(`${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}/decline`, {
        method: 'POST',
        headers,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reopenPullRequest(): Promise<ActionResult | UnsupportedResult> {
    return { ok: false, unsupported: true, error: 'Bitbucket does not support reopening a declined pull request. This is a permanent platform limitation.' };
  }

  async submitReview(owner: string, repo: string, number: number, input: SubmitReviewInput): Promise<ActionResult | UnsupportedResult> {
    if (input.event === 'comment') {
      if (!input.body?.trim()) {
        return { ok: false, error: 'A comment body is required for this review type' };
      }
      const result = await this.postComment(owner, repo, number, input.body);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
    const headers = await this.headers();
    const endpoint = input.event === 'approve' ? 'approve' : 'request-changes';
    try {
      await httpJson(`${this.apiBase()}/repositories/${owner}/${repo}/pullrequests/${number}/${endpoint}`, {
        method: 'POST',
        headers,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
