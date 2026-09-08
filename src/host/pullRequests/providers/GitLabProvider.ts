import type {
  ActionResult, ChangedFile, CiCheck, CiStatus, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs,
  ListPullRequestsOptions, ListPullRequestsResult, MergeStrategy, PostCommentResult, PullRequestCapabilities,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestLabel, PullRequestProvider, PullRequestSummary, PullRequestUser,
  SubmitReviewInput, UnsupportedResult, UpdatePullRequestInput,
} from '../types';
import { httpJson, HttpJsonError } from '../httpJson';

const PAGE_SIZE = 30;

const CAPABILITIES: PullRequestCapabilities = {
  canMerge: true,
  mergeStrategies: ['merge', 'squash'],
  canClose: true,
  canReopen: true,
  hasMergeableState: true,
  canApprove: true,
  canRequestChanges: false,
  canCommentReview: false,
  hasUnifiedDiffText: false,
  canManageReviewers: true,
  canManageAssignees: true,
  canManageLabels: true,
};

interface RawGitLabUserRef {
  id: number;
  username: string;
  avatar_url: string;
}

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
  source_project_id: number;
  target_project_id: number;
  references?: { full: string };
  author: { username: string; avatar_url: string } | null;
  created_at: string;
  updated_at: string;
  user_notes_count?: number;
}

interface RawGitLabMrDetail extends RawGitLabMr {
  description: string | null;
  sha: string;
  merge_status?: 'can_be_merged' | 'cannot_be_merged' | 'checking' | 'unchecked' | string;
  diff_refs?: { base_sha: string; head_sha: string; start_sha: string } | null;
  user?: { can_merge: boolean };
  reviewers?: RawGitLabUserRef[];
  assignees?: RawGitLabUserRef[];
  labels?: string[];
  head_pipeline?: { status: string; web_url?: string } | null;
}

interface RawGitLabPipelineRef {
  id: number;
  sha: string;
}

interface RawGitLabJob {
  id: number;
  name: string;
  status: string;
  web_url?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

interface RawGitLabLabel {
  name: string;
  color: string;
}

interface RawGitLabUser {
  username: string;
}

interface RawGitLabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

interface RawGitLabChanges {
  changes: RawGitLabDiff[];
}

interface RawGitLabNote {
  id: number;
  body: string;
  author: { username: string; avatar_url: string } | null;
  created_at: string;
  system?: boolean;
}

interface RawGitLabCommit {
  id: string;
  short_id: string;
  message: string;
  author_name: string;
  authored_date: string;
  parent_ids?: string[];
}

function mapState(mr: RawGitLabMr): PullRequestSummary['state'] {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed' || mr.state === 'locked') return 'closed';
  if (mr.draft || mr.work_in_progress) return 'draft';
  return 'open';
}

/** GitLab's `references.full` is "namespace/project!123" — the target project's path, free on every MR response. */
function targetProjectPath(mr: RawGitLabMr): string | undefined {
  const full = mr.references?.full;
  return full ? full.replace(/!\d+$/, '') : undefined;
}

function mapMr(mr: RawGitLabMr, sourceProjectPath?: string): PullRequestSummary {
  const targetRepoFullName = targetProjectPath(mr);
  const isFork = mr.source_project_id !== mr.target_project_id;
  return {
    id: String(mr.id),
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    state: mapState(mr),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    sourceRepoFullName: isFork ? (sourceProjectPath ?? undefined) : undefined,
    targetRepoFullName,
    authorName: mr.author?.username ?? 'unknown',
    authorAvatarUrl: mr.author?.avatar_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    commentCount: mr.user_notes_count,
  };
}

function apiState(state: ListPullRequestsOptions['state']): 'opened' | 'closed' | 'merged' | 'all' {
  if (state === 'open') return 'opened';
  return state;
}

function mapMergeableState(mr: RawGitLabMrDetail): PullRequestDetail['mergeableState'] {
  if (mr.merge_status === 'can_be_merged') return 'mergeable';
  if (mr.merge_status === 'cannot_be_merged') return 'conflicting';
  return 'unknown';
}

const GITLAB_PENDING_PIPELINE_STATUSES = new Set([
  'created', 'waiting_for_resource', 'preparing', 'waiting_for_callback', 'pending', 'running', 'scheduled', 'canceling',
]);

/** GitLab's MR response carries the latest pipeline run for its head SHA inline (`head_pipeline`) — no separate API call needed. Absent if no pipeline has run yet, or the user can't view pipelines for this project. */
function mapCiStatus(mr: RawGitLabMrDetail): CiStatus | undefined {
  const pipeline = mr.head_pipeline;
  if (!pipeline) return undefined;
  const state: CiStatus['state'] =
    pipeline.status === 'success' ? 'success'
    : GITLAB_PENDING_PIPELINE_STATUSES.has(pipeline.status) ? 'pending'
    : pipeline.status === 'manual' || pipeline.status === 'skipped' ? 'success'
    : 'failure';
  return { state, url: pipeline.web_url };
}

function mapDiffStatus(d: RawGitLabDiff): ChangedFile['status'] {
  if (d.new_file) return 'added';
  if (d.deleted_file) return 'deleted';
  if (d.renamed_file) return 'renamed';
  return 'modified';
}

function mapDiff(d: RawGitLabDiff): ChangedFile {
  return {
    path: d.new_path,
    oldPath: d.old_path !== d.new_path ? d.old_path : undefined,
    status: mapDiffStatus(d),
  };
}

const LABELS_CACHE_TTL_MS = 5 * 60 * 1000;

export class GitLabProvider implements PullRequestProvider {
  readonly kind = 'gitlab' as const;
  private cachedUsername: string | undefined;
  /** Keyed by "owner/repo" — avoids re-paginating the whole project label list (just to resolve a few names to colors) on every PR-detail load. Short TTL since labels can be added/recolored/deleted. */
  private readonly labelsCache = new Map<string, { labels: PullRequestLabel[]; fetchedAt: number }>();

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

  async hasCredentials(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  async getCurrentUsername(): Promise<string | undefined> {
    if (this.cachedUsername) return this.cachedUsername;
    const headers = await this.headers();
    try {
      const { data } = await httpJson<RawGitLabUser>(`${this.apiBase()}/user`, { headers });
      this.cachedUsername = data.username;
      return data.username;
    } catch {
      return undefined;
    }
  }

  async listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const headers = await this.headers();
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const params = new URLSearchParams({
      state: apiState(options.state),
      per_page: String(PAGE_SIZE),
      page: String(options.page),
    });
    if (options.author === 'mine') {
      const username = await this.getCurrentUsername();
      if (username) params.set('author_username', username);
    }
    const url = `${this.apiBase()}/projects/${projectId}/merge_requests?${params.toString()}`;
    const { data } = await httpJson<RawGitLabMr[]>(url, { headers });
    return { items: data.map(mr => mapMr(mr)), hasMore: data.length === PAGE_SIZE };
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

  getCapabilities(): PullRequestCapabilities {
    return CAPABILITIES;
  }

  async getCheckoutSource(pr: PullRequestSummary): Promise<{ remote: string; refspec: string }> {
    return { remote: 'origin', refspec: `merge-requests/${pr.number}/head` };
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    const names: string[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<{ name: string }[]>(
        `${this.apiBase()}/projects/${projectId}/repository/branches?per_page=100&page=${page}`, { headers },
      );
      names.push(...data.map(b => b.name));
      if (data.length < 100) break;
      page++;
    }
    return names;
  }

  async listCollaborators(owner: string, repo: string): Promise<PullRequestUser[]> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    const users: PullRequestUser[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGitLabUserRef[]>(
        `${this.apiBase()}/projects/${projectId}/members/all?per_page=100&page=${page}`, { headers },
      );
      users.push(...data.map(u => ({ id: String(u.id), username: u.username, avatarUrl: u.avatar_url })));
      if (data.length < 100) break;
      page++;
    }
    return users;
  }

  /** GitLab's MR response only carries label names — colors come from the project's own label definitions. Always fetches fresh (used by the "Edit labels" picker, where stale data would hide a just-created label). */
  async listAvailableLabels(owner: string, repo: string): Promise<PullRequestLabel[]> {
    const labels = await this.fetchProjectLabels(owner, repo);
    this.labelsCache.set(this.projectId(owner, repo), { labels, fetchedAt: Date.now() });
    return labels;
  }

  /** Same data as `listAvailableLabels`, but cached briefly — for resolving a PR's label colors on detail-load, where a short-lived stale color is harmless but re-paginating the whole project label list on every load is not. */
  private async getCachedProjectLabels(owner: string, repo: string): Promise<PullRequestLabel[]> {
    const key = this.projectId(owner, repo);
    const cached = this.labelsCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < LABELS_CACHE_TTL_MS) return cached.labels;
    const labels = await this.fetchProjectLabels(owner, repo);
    this.labelsCache.set(key, { labels, fetchedAt: Date.now() });
    return labels;
  }

  private async fetchProjectLabels(owner: string, repo: string): Promise<PullRequestLabel[]> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    const labels: PullRequestLabel[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGitLabLabel[]>(
        `${this.apiBase()}/projects/${projectId}/labels?per_page=100&page=${page}`, { headers },
      );
      labels.push(...data.map(l => ({ id: l.name, name: l.name, color: l.color.replace(/^#/, '') })));
      if (data.length < 100) break;
      page++;
    }
    return labels;
  }

  async getPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    const { data } = await httpJson<RawGitLabMrDetail>(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}`, { headers });

    // The two lookups below are both optional/best-effort and independent of each other — run them in parallel rather than one-after-another.
    const [sourceProjectPath, labels] = await Promise.all([
      data.source_project_id !== data.target_project_id
        ? httpJson<{ path_with_namespace: string }>(`${this.apiBase()}/projects/${data.source_project_id}`, { headers })
          .then(({ data: sourceProject }) => sourceProject.path_with_namespace)
          // Best-effort — the fork's readable path is a display nicety, not required for the diff/merge to work.
          .catch(() => undefined)
        : Promise.resolve(undefined),
      // The MR response only carries label names, not colors — look those up from the project's own label definitions.
      data.labels && data.labels.length > 0
        ? this.getCachedProjectLabels(owner, repo)
          .then(availableLabels => {
            const colorByName = new Map(availableLabels.map(l => [l.name, l.color]));
            return data.labels!.map(name => ({ id: name, name, color: colorByName.get(name) ?? '808080' }));
          })
          // Best-effort — fall back to uncolored labels rather than failing the whole detail load.
          .catch(() => data.labels!.map(name => ({ id: name, name, color: '808080' })))
        : Promise.resolve<PullRequestLabel[]>([]),
    ]);

    return {
      ...mapMr(data, sourceProjectPath),
      description: data.description ?? '',
      merged: data.state === 'merged',
      mergeableState: mapMergeableState(data),
      headSha: data.diff_refs?.head_sha ?? data.sha,
      baseSha: data.diff_refs?.base_sha ?? data.sha,
      ciStatus: mapCiStatus(data),
      capabilities: CAPABILITIES,
      canWrite: data.user?.can_merge ?? false,
      reviewers: (data.reviewers ?? []).map(u => ({ id: String(u.id), username: u.username, avatarUrl: u.avatar_url })),
      assignees: (data.assignees ?? []).map(u => ({ id: String(u.id), username: u.username, avatarUrl: u.avatar_url })),
      labels,
    };
  }

  /** GitLab jobs live under a pipeline id, not a commit sha directly — resolves the latest pipeline for `headSha` first, then lists its jobs. */
  async listChecks(owner: string, repo: string, headSha: string): Promise<CiCheck[]> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    const { data: pipelines } = await httpJson<RawGitLabPipelineRef[]>(
      `${this.apiBase()}/projects/${projectId}/pipelines?sha=${encodeURIComponent(headSha)}&per_page=1&order_by=id&sort=desc`, { headers },
    );
    const pipeline = pipelines[0];
    if (!pipeline) return [];

    const jobs: RawGitLabJob[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGitLabJob[]>(
        `${this.apiBase()}/projects/${projectId}/pipelines/${pipeline.id}/jobs?per_page=100&page=${page}`, { headers },
      );
      jobs.push(...data);
      if (data.length < 100) break;
      page++;
    }

    return jobs.map(j => ({
      id: String(j.id),
      name: j.name,
      state: j.status === 'success' || j.status === 'manual' || j.status === 'skipped' ? 'success'
        : GITLAB_PENDING_PIPELINE_STATUSES.has(j.status) ? 'pending'
        : 'failure',
      url: j.web_url,
      startedAt: j.started_at ?? undefined,
      completedAt: j.finished_at ?? undefined,
    }));
  }

  async updatePullRequest(owner: string, repo: string, number: number, input: UpdatePullRequestInput): Promise<ActionResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      await httpJson(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.title, target_branch: input.targetBranch }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GitLab's MR update endpoint takes reviewer_ids/assignee_ids directly — a true replace, no add/remove diffing needed. */
  async updateReviewers(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      await httpJson(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewer_ids: userIds.map(Number) }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      await httpJson(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee_ids: userIds.map(Number) }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GitLab's `labels` param on the MR update endpoint takes a comma-separated string and always replaces the full set (unlike its incremental `add_labels`/`remove_labels` siblings, not used here). */
  async updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      await httpJson(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: labelIds.join(',') }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    const notes: PullRequestComment[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGitLabNote[]>(
        `${this.apiBase()}/projects/${projectId}/merge_requests/${number}/notes?per_page=100&page=${page}`, { headers },
      );
      notes.push(...data.filter(n => !n.system).map(n => ({
        id: String(n.id),
        authorName: n.author?.username ?? 'unknown',
        authorAvatarUrl: n.author?.avatar_url,
        body: n.body,
        createdAt: n.created_at,
      })));
      if (data.length < 100) break;
      page++;
    }
    return notes;
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      const { data } = await httpJson<RawGitLabNote>(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}/notes`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      return {
        ok: true,
        comment: {
          id: String(data.id),
          authorName: data.author?.username ?? 'unknown',
          authorAvatarUrl: data.author?.avatar_url,
          body: data.body,
          createdAt: data.created_at,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listChangedFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    const { data } = await httpJson<RawGitLabChanges>(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}/changes`, { headers });
    return data.changes.map(mapDiff);
  }

  private async getBlobAtRef(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      const res = await fetch(
        `${this.apiBase()}/projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
        { headers },
      );
      if (!res.ok) {
        if (res.status === 404) return '';
        const bodyText = await res.text().catch(() => '');
        throw new HttpJsonError(res.status, `HTTP ${res.status} ${res.statusText}${bodyText ? `: ${bodyText}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      if (err instanceof HttpJsonError && err.status === 404) return '';
      throw err;
    }
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
    const projectId = this.projectId(owner, repo);
    const commits: PullRequestCommit[] = [];
    let page = 1;
    for (;;) {
      const { data } = await httpJson<RawGitLabCommit[]>(
        `${this.apiBase()}/projects/${projectId}/merge_requests/${number}/commits?per_page=100&page=${page}`, { headers },
      );
      commits.push(...data.map(c => ({
        sha: c.id,
        shortSha: c.short_id,
        message: c.message,
        authorName: c.author_name,
        authoredAt: c.authored_date,
        parentSha: c.parent_ids?.[0],
      })));
      if (data.length < 100) break;
      page++;
    }
    return commits;
  }

  async listCommitFiles(owner: string, repo: string, sha: string): Promise<ChangedFile[]> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    const { data } = await httpJson<RawGitLabDiff[]>(`${this.apiBase()}/projects/${projectId}/repository/commits/${sha}/diff`, { headers });
    return data.map(mapDiff);
  }

  async mergePullRequest(owner: string, repo: string, number: number, strategy: MergeStrategy): Promise<ActionResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      await httpJson(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}/merge`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ squash: strategy === 'squash' }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async closePullRequest(owner: string, repo: string, number: number): Promise<ActionResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      await httpJson(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state_event: 'close' }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reopenPullRequest(owner: string, repo: string, number: number): Promise<ActionResult | UnsupportedResult> {
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      await httpJson(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state_event: 'reopen' }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async submitReview(owner: string, repo: string, number: number, input: SubmitReviewInput): Promise<ActionResult | UnsupportedResult> {
    if (input.event === 'comment') {
      if (!input.body?.trim()) return { ok: false, error: 'A comment body is required for this review type' };
      const result = await this.postComment(owner, repo, number, input.body);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
    if (input.event !== 'approve') {
      return { ok: false, unsupported: true, error: 'GitLab does not support requesting changes on a merge request' };
    }
    const headers = await this.headers();
    const projectId = this.projectId(owner, repo);
    try {
      await httpJson(`${this.apiBase()}/projects/${projectId}/merge_requests/${number}/approve`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
