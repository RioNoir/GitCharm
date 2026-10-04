import * as vscode from 'vscode';
import type {
  ActionResult, ChangedFile, CiCheck, CiStatus, CreatePullRequestInput, CreatePullRequestResult, FileDiffContent, FileDiffRefs,
  ListPullRequestsOptions, ListPullRequestsResult, MergeStrategy, PostCommentResult, PullRequestCapabilities, PullRequestChecksSummary,
  PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestEvent, PullRequestLabel, PullRequestProvider,
  PullRequestStateFilter, PullRequestSummary, PullRequestUser, SubmitReviewInput, UnsupportedResult, UpdatePullRequestInput,
} from '../types';
import { HttpJsonError } from '../httpJson';
import { summarizeChecksPerPr } from '../checksSummary';
import { formatApiError } from '../formatApiError';
import {
  API_VERSION_PREVIEW, mentionsFromAzure, mentionsToAzure, projectOf, type AzureDevOpsClient, type RawIdentityRef,
} from '../azureDevOpsClient';

const PAGE_SIZE = 30;
/** Azure DevOps tags have no color of their own. */
const TAG_COLOR = 'c8c8c8';

const CAPABILITIES: PullRequestCapabilities = {
  canMerge: true,
  // Azure DevOps' "semi-linear merge" (rebase, then a merge commit) has no counterpart in the shared list.
  mergeStrategies: ['merge', 'squash', 'rebase'],
  canClose: true,
  canReopen: true,
  hasMergeableState: true,
  canApprove: true,
  canRequestChanges: true,
  canCommentReview: true,
  hasUnifiedDiffText: false,
  canManageReviewers: true,
  canManageAssignees: false,
  canManageLabels: true,
  canFilterAssignee: false,
  canFilterReviewRequested: true,
  canFilterMentions: false,
};

const MERGE_STRATEGY: Record<MergeStrategy, string> = {
  merge: 'noFastForward',
  squash: 'squash',
  rebase: 'rebase',
  fastForward: 'rebase',
};

/** Votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for author, -10 rejected. */
const VOTE_APPROVE = 10;
const VOTE_WAIT_FOR_AUTHOR = -5;

interface RawRepositoryRef {
  id: string;
  name: string;
  remoteUrl?: string;
  project?: { id: string; name: string };
}

interface RawPullRequest {
  pullRequestId: number;
  status: 'active' | 'abandoned' | 'completed' | 'notSet';
  isDraft?: boolean;
  title: string;
  description?: string;
  createdBy: RawIdentityRef;
  creationDate: string;
  closedDate?: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: 'notSet' | 'queued' | 'conflicts' | 'succeeded' | 'rejectedByPolicy' | 'failure';
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  reviewers?: (RawIdentityRef & { vote?: number; isRequired?: boolean })[];
  labels?: { id: string; name: string; active?: boolean }[];
  repository: RawRepositoryRef;
  forkSource?: { repository: RawRepositoryRef };
}

interface RawComment {
  id: number;
  author: RawIdentityRef;
  content?: string;
  publishedDate: string;
  commentType?: 'text' | 'system' | 'codeChange' | 'unknown';
  isDeleted?: boolean;
}

interface RawThread {
  id: number;
  publishedDate: string;
  isDeleted?: boolean;
  comments: RawComment[];
  properties?: Record<string, { $value?: string } | undefined>;
  identities?: Record<string, RawIdentityRef>;
}

interface RawChangeEntry {
  item?: { path?: string; isFolder?: boolean; gitObjectType?: string };
  changeType: string;
  originalPath?: string;
  sourceServerItem?: string;
}

interface RawCommitRef {
  commitId: string;
  comment: string;
  author?: { name: string; email?: string; date: string };
  parents?: string[];
}

interface RawPolicyEvaluation {
  evaluationId: string;
  status: 'queued' | 'running' | 'approved' | 'rejected' | 'notApplicable' | 'broken';
  configuration?: { isEnabled?: boolean; type?: { displayName?: string }; settings?: { displayName?: string } };
  context?: { buildId?: number; buildDefinitionName?: string };
  startedDate?: string;
  completedDate?: string;
}

interface RawStatus {
  id: number;
  state: 'succeeded' | 'failed' | 'error' | 'pending' | 'notApplicable' | 'notSet';
  description?: string;
  context?: { name?: string; genre?: string };
  targetUrl?: string;
  creationDate?: string;
  updatedDate?: string;
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

function mapState(pr: RawPullRequest): PullRequestSummary['state'] {
  if (pr.status === 'completed') return 'merged';
  if (pr.status === 'abandoned') return 'closed';
  return pr.isDraft ? 'draft' : 'open';
}

/** The narrowest server-side status covering every requested state — the rest is filtered on each page. */
function apiStatus(states: PullRequestStateFilter[]): 'active' | 'completed' | 'abandoned' | 'all' {
  const wanted = new Set(states.map(s => (s === 'open' || s === 'draft' ? 'active' : s === 'merged' ? 'completed' : 'abandoned')));
  return wanted.size === 1 ? [...wanted][0] : 'all';
}

function mapChangeType(changeType: string): ChangedFile['status'] {
  // Flags joined by ", " — e.g. "edit, rename".
  const flags = changeType.toLowerCase().split(/,\s*/);
  if (flags.includes('delete')) return 'deleted';
  if (flags.includes('add')) return 'added';
  if (flags.includes('rename')) return 'renamed';
  return 'modified';
}

function mapChange(change: RawChangeEntry): ChangedFile | undefined {
  const path = change.item?.path;
  if (!path || change.item?.isFolder || change.item?.gitObjectType === 'tree') return undefined;
  const status = mapChangeType(change.changeType);
  const oldPath = status === 'renamed' ? (change.originalPath ?? change.sourceServerItem) : undefined;
  return { path: path.replace(/^\//, ''), oldPath: oldPath?.replace(/^\//, ''), status };
}

function mapCheckState(state: RawStatus['state'] | RawPolicyEvaluation['status']): CiCheck['state'] | undefined {
  switch (state) {
    case 'succeeded': case 'approved': return 'success';
    case 'failed': case 'error': case 'rejected': case 'broken': return 'failure';
    case 'pending': case 'queued': case 'running': return 'pending';
    default: return undefined; // not applicable / not set: not a check worth listing
  }
}

export class AzureDevOpsProvider implements PullRequestProvider {
  readonly kind = 'azure' as const;
  /** Checks are per pull request in Azure DevOps (policy evaluations, PR statuses), but listChecks only gets the
   * head commit — so the pull request behind each head commit seen is remembered. */
  private readonly prByHeadSha = new Map<string, { number: number; projectId?: string; owner: string; repo: string }>();
  /** Fork pull requests: where to fetch the source branch from. */
  private readonly forkRemoteByNumber = new Map<number, string>();
  private readonly parentBySha = new Map<string, Promise<string | undefined>>();

  constructor(private readonly client: AzureDevOpsClient) {}

  private repoUrl(owner: string, repo: string): string {
    return this.client.repoApiUrl(owner, repo);
  }

  private prUrl(owner: string, repo: string, number: number): string {
    return `${this.repoUrl(owner, repo)}/pullRequests/${number}`;
  }

  private webUrl(owner: string, repo: string, number: number): string {
    return `${this.client.projectUrl(owner)}/_git/${encodeURIComponent(repo)}/pullrequest/${number}`;
  }

  /** `{organization or collection path}/{project}/{repo}` — the owner/repo pair the rest of the extension passes back. */
  private fullName(owner: string, repository: RawRepositoryRef): string {
    const prefix = owner.slice(0, owner.lastIndexOf('/') + 1);
    return `${prefix}${repository.project?.name ?? projectOf(owner)}/${repository.name}`;
  }

  private async toUsers(identities: RawIdentityRef[] | undefined): Promise<PullRequestUser[]> {
    return Promise.all((identities ?? []).map(i => this.client.toUser(i)));
  }

  private async mapPr(owner: string, repo: string, pr: RawPullRequest): Promise<PullRequestSummary> {
    const headSha = pr.lastMergeSourceCommit?.commitId;
    if (headSha) this.prByHeadSha.set(headSha, { number: pr.pullRequestId, projectId: pr.repository.project?.id, owner, repo });
    const fork = pr.forkSource?.repository;
    if (fork?.remoteUrl) this.forkRemoteByNumber.set(pr.pullRequestId, fork.remoteUrl);
    const [authorAvatarUrl, reviewers] = await Promise.all([this.client.avatar(pr.createdBy), this.toUsers(pr.reviewers)]);
    return {
      id: String(pr.pullRequestId),
      number: pr.pullRequestId,
      title: pr.title,
      url: this.webUrl(owner, pr.repository.name ?? repo, pr.pullRequestId),
      state: mapState(pr),
      sourceBranch: branchName(pr.sourceRefName),
      targetBranch: branchName(pr.targetRefName),
      sourceRepoFullName: fork && fork.id !== pr.repository.id ? this.fullName(owner, fork) : undefined,
      targetRepoFullName: this.fullName(owner, pr.repository),
      authorName: pr.createdBy.displayName,
      authorAvatarUrl,
      createdAt: pr.creationDate,
      // No "last updated" on Azure DevOps pull requests — closing is the last change it records.
      updatedAt: pr.closedDate ?? pr.creationDate,
      reviewers,
      labels: (pr.labels ?? []).filter(l => l.active !== false).map(l => ({ id: l.name, name: l.name, color: TAG_COLOR })),
      headSha,
    };
  }

  async hasCredentials(): Promise<boolean> {
    return this.client.hasCredentials();
  }

  async getCurrentUsername(): Promise<string | undefined> {
    return (await this.client.getCurrentUser())?.displayName;
  }

  async listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const numberMatch = options.search?.trim().match(/^!?#?(\d+)$/);
    if (numberMatch) {
      try {
        const { data } = await this.client.request<RawPullRequest>(this.prUrl(owner, repo, Number(numberMatch[1])));
        const pr = await this.mapPr(owner, repo, data);
        return { items: options.states.includes(pr.state) ? [pr] : [], hasMore: false };
      } catch (err) {
        if (err instanceof HttpJsonError && err.status === 404) return { items: [], hasMore: false };
        throw err;
      }
    }

    const params = new URLSearchParams({
      'searchCriteria.status': apiStatus(options.states),
      $top: String(PAGE_SIZE),
      $skip: String((options.page - 1) * PAGE_SIZE),
    });
    if (options.author === 'mine' || options.reviewRequestedToMe) {
      const me = await this.client.getCurrentUser();
      if (me && options.author === 'mine') params.set('searchCriteria.creatorId', me.id);
      if (me && options.reviewRequestedToMe) params.set('searchCriteria.reviewerId', me.id);
    }
    const { data } = await this.client.request<{ value: RawPullRequest[] }>(`${this.repoUrl(owner, repo)}/pullrequests?${params.toString()}`);
    // No server-side text search on pull requests: titles are matched on each page.
    const search = options.search?.trim().toLowerCase();
    const matching = data.value.filter(pr => !search || pr.title.toLowerCase().includes(search));
    const items = (await Promise.all(matching.map(pr => this.mapPr(owner, repo, pr)))).filter(pr => options.states.includes(pr.state));
    return { items, hasMore: data.value.length === PAGE_SIZE };
  }

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    try {
      const { data } = await this.client.request<RawPullRequest>(`${this.repoUrl(owner, repo)}/pullrequests`, {
        method: 'POST',
        body: JSON.stringify({
          sourceRefName: `refs/heads/${input.sourceBranch}`,
          targetRefName: `refs/heads/${input.targetBranch}`,
          title: input.title,
          description: mentionsToAzure(input.description),
          isDraft: !!input.draft,
        }),
      });
      return { ok: true, pr: await this.mapPr(owner, repo, data) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  /** Commit authors are plain git identities on Azure DevOps — no account to take an avatar from. */
  async getCommitAuthorAvatar(): Promise<string | undefined> {
    return undefined;
  }

  getCapabilities(): PullRequestCapabilities {
    return CAPABILITIES;
  }

  /** Azure DevOps only publishes a pull request's merge preview (refs/pull/{id}/merge), not its head — the source
   * branch itself is fetched, from the fork when the pull request comes from one. */
  async getCheckoutSource(pr: PullRequestSummary): Promise<{ remote: string; refspec: string }> {
    const fork = pr.sourceRepoFullName ? this.forkRemoteByNumber.get(pr.number) : undefined;
    return { remote: fork ?? 'origin', refspec: `refs/heads/${pr.sourceBranch}` };
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const names: string[] = [];
    let continuationToken: string | null = null;
    do {
      const params = new URLSearchParams({ filter: 'heads/', $top: '1000' });
      if (continuationToken) params.set('continuationToken', continuationToken);
      const { data, headers } = await this.client.request<{ value: { name: string }[] }>(`${this.repoUrl(owner, repo)}/refs?${params.toString()}`);
      names.push(...data.value.map(r => branchName(r.name)));
      continuationToken = headers.get('x-ms-continuationtoken');
    } while (continuationToken);
    return names;
  }

  async listCollaborators(owner: string): Promise<PullRequestUser[]> {
    return this.client.listProjectMembers(owner);
  }

  /** Tags already used in the project — the same tag store work items use. */
  async listAvailableLabels(owner: string): Promise<PullRequestLabel[]> {
    try {
      const { data } = await this.client.request<{ value: { name: string }[] }>(`${this.client.projectUrl(owner)}/_apis/wit/tags`, { apiVersion: API_VERSION_PREVIEW });
      return data.value.map(t => ({ id: t.name, name: t.name, color: TAG_COLOR })).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  private async getChecksForPr(owner: string, repo: string, number: number, projectId: string | undefined): Promise<CiCheck[]> {
    const projectUrl = this.client.projectUrl(owner);
    const [evaluations, statuses] = await Promise.all([
      projectId
        ? this.client.request<{ value: RawPolicyEvaluation[] }>(
          `${projectUrl}/_apis/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${number}`)}`,
          { apiVersion: API_VERSION_PREVIEW },
        ).then(({ data }) => data.value).catch(() => [] as RawPolicyEvaluation[])
        : Promise.resolve([] as RawPolicyEvaluation[]),
      this.client.request<{ value: RawStatus[] }>(`${this.prUrl(owner, repo, number)}/statuses`, { apiVersion: API_VERSION_PREVIEW })
        .then(({ data }) => data.value).catch(() => [] as RawStatus[]),
    ]);
    const checks: CiCheck[] = [];
    for (const e of evaluations) {
      const state = mapCheckState(e.status);
      if (!state || e.configuration?.isEnabled === false) continue;
      checks.push({
        id: e.evaluationId,
        name: e.configuration?.settings?.displayName || e.context?.buildDefinitionName || e.configuration?.type?.displayName || vscode.l10n.t('Policy'),
        state,
        url: e.context?.buildId ? `${projectUrl}/_build/results?buildId=${e.context.buildId}` : undefined,
        startedAt: e.startedDate,
        completedAt: e.completedDate,
      });
    }
    for (const s of statuses) {
      const state = mapCheckState(s.state);
      if (!state) continue;
      checks.push({
        id: `status-${s.id}`,
        name: s.description || [s.context?.genre, s.context?.name].filter(Boolean).join('/') || vscode.l10n.t('Status'),
        state,
        url: s.targetUrl,
        startedAt: s.creationDate,
        completedAt: s.updatedDate,
      });
    }
    return checks;
  }

  async listChecks(owner: string, repo: string, headSha: string): Promise<CiCheck[]> {
    const pr = this.prByHeadSha.get(headSha);
    if (pr) return this.getChecksForPr(pr.owner, pr.repo, pr.number, pr.projectId);
    const { data } = await this.client.request<{ value: RawStatus[] }>(`${this.repoUrl(owner, repo)}/commits/${headSha}/statuses?latestOnly=true`);
    return data.value
      .map(s => ({ s, state: mapCheckState(s.state) }))
      .filter((x): x is { s: RawStatus; state: CiCheck['state'] } => !!x.state)
      .map(({ s, state }) => ({
        id: String(s.id), name: s.description || s.context?.name || vscode.l10n.t('Status'), state, url: s.targetUrl,
        startedAt: s.creationDate, completedAt: s.updatedDate,
      }));
  }

  async getChecksSummaries(owner: string, repo: string, prs: PullRequestSummary[]): Promise<Map<number, PullRequestChecksSummary>> {
    return summarizeChecksPerPr(prs, headSha => this.listChecks(owner, repo, headSha));
  }

  private aggregateStatus(checks: CiCheck[]): CiStatus | undefined {
    if (checks.length === 0) return undefined;
    const state: CiStatus['state'] = checks.some(c => c.state === 'failure' || c.state === 'unknown') ? 'failure'
      : checks.some(c => c.state === 'pending') ? 'pending' : 'success';
    // The check most worth opening: a failing one, else any with a page.
    const url = (checks.find(c => c.state !== 'success' && c.url) ?? checks.find(c => c.url))?.url;
    return { state, url };
  }

  /** The commit the pull request's changes are diffed against: the merge base of its latest iteration, as the web UI does. */
  private async getBaseSha(owner: string, repo: string, number: number, fallback: string | undefined): Promise<string> {
    try {
      const { data } = await this.client.request<{ value: { id: number; commonRefCommit?: { commitId: string } }[] }>(`${this.prUrl(owner, repo, number)}/iterations`);
      const last = data.value[data.value.length - 1];
      return last?.commonRefCommit?.commitId ?? fallback ?? '';
    } catch {
      return fallback ?? '';
    }
  }

  async getPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail> {
    const { data } = await this.client.request<RawPullRequest>(this.prUrl(owner, repo, number));
    const headSha = data.lastMergeSourceCommit?.commitId ?? '';
    const [summary, baseSha, checks] = await Promise.all([
      this.mapPr(owner, repo, data),
      this.getBaseSha(owner, repo, number, data.lastMergeTargetCommit?.commitId),
      this.getChecksForPr(owner, repo, number, data.repository.project?.id).catch(() => [] as CiCheck[]),
    ]);
    return {
      ...summary,
      description: mentionsFromAzure(data.description ?? ''),
      merged: data.status === 'completed',
      mergeableState: data.mergeStatus === 'succeeded' ? 'mergeable' : data.mergeStatus === 'conflicts' ? 'conflicting' : 'unknown',
      headSha,
      baseSha,
      ciStatus: this.aggregateStatus(checks),
      capabilities: CAPABILITIES,
      // Permissions aren't exposed per pull request; the server refuses what the account can't do.
      canWrite: true,
      reviewers: summary.reviewers ?? [],
      assignees: [],
      labels: summary.labels ?? [],
    };
  }

  private async patchPr(owner: string, repo: string, number: number, body: Record<string, unknown>): Promise<ActionResult> {
    try {
      await this.client.request(this.prUrl(owner, repo, number), { method: 'PATCH', body: JSON.stringify(body) });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updatePullRequest(owner: string, repo: string, number: number, input: UpdatePullRequestInput): Promise<ActionResult> {
    return this.patchPr(owner, repo, number, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: mentionsToAzure(input.description) } : {}),
      ...(input.targetBranch !== undefined ? { targetRefName: `refs/heads/${input.targetBranch}` } : {}),
    });
  }

  async updateReviewers(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    try {
      const { data } = await this.client.request<RawPullRequest>(this.prUrl(owner, repo, number));
      const current = (data.reviewers ?? []).map(r => r.id);
      const toAdd = userIds.filter(id => !current.includes(id));
      const toRemove = current.filter(id => !userIds.includes(id));
      await Promise.all([
        ...toAdd.map(id => this.client.request(`${this.prUrl(owner, repo, number)}/reviewers/${id}`, { method: 'PUT', body: JSON.stringify({ id, vote: 0 }) })),
        ...toRemove.map(id => this.client.request(`${this.prUrl(owner, repo, number)}/reviewers/${id}`, { method: 'DELETE' })),
      ]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateAssignees(): Promise<UnsupportedResult> {
    return { ok: false, unsupported: true, error: vscode.l10n.t('Azure DevOps pull requests have reviewers, not assignees.') };
  }

  async updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult> {
    const labelsUrl = `${this.prUrl(owner, repo, number)}/labels`;
    try {
      const { data } = await this.client.request<{ value: { name: string; active?: boolean }[] }>(labelsUrl, { apiVersion: API_VERSION_PREVIEW });
      const current = data.value.filter(l => l.active !== false).map(l => l.name);
      const toAdd = labelIds.filter(name => !current.includes(name));
      const toRemove = current.filter(name => !labelIds.includes(name));
      await Promise.all([
        ...toAdd.map(name => this.client.request(labelsUrl, { method: 'POST', apiVersion: API_VERSION_PREVIEW, body: JSON.stringify({ name }) })),
        ...toRemove.map(name => this.client.request(`${labelsUrl}/${encodeURIComponent(name)}`, { method: 'DELETE', apiVersion: API_VERSION_PREVIEW })),
      ]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  private async mapComment(owner: string, repo: string, number: number, threadId: number, c: RawComment, currentUserId: string | undefined): Promise<PullRequestComment> {
    const isOwn = !!currentUserId && c.author.id === currentUserId;
    return {
      // Comment ids are per thread — both are needed to edit or delete one.
      id: `${threadId}:${c.id}`,
      authorName: c.author.displayName,
      authorAvatarUrl: await this.client.avatar(c.author),
      body: mentionsFromAzure(c.content ?? ''),
      createdAt: c.publishedDate,
      url: `${this.webUrl(owner, repo, number)}?discussionId=${threadId}`,
      canEdit: isOwn,
      canDelete: isOwn,
      canHide: false,
    };
  }

  private async listThreads(owner: string, repo: string, number: number): Promise<RawThread[]> {
    const { data } = await this.client.request<{ value: RawThread[] }>(`${this.prUrl(owner, repo, number)}/threads`);
    return data.value.filter(t => !t.isDeleted);
  }

  /** Every human comment, from general and file threads alike — replies included, in posting order. */
  async listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]> {
    const [threads, me] = await Promise.all([this.listThreads(owner, repo, number), this.client.getCurrentUser()]);
    const comments = threads.flatMap(t => t.comments
      .filter(c => !c.isDeleted && c.commentType !== 'system' && c.content?.trim())
      .map(c => ({ thread: t, comment: c })));
    const mapped = await Promise.all(comments.map(({ thread, comment }) => this.mapComment(owner, repo, number, thread.id, comment, me?.id)));
    return mapped.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** System threads Azure DevOps writes for status and reviewer changes. */
  async listEvents(owner: string, repo: string, number: number): Promise<PullRequestEvent[]> {
    const threads = await this.listThreads(owner, repo, number);
    const events: PullRequestEvent[] = [];
    for (const t of threads) {
      const type = t.properties?.CodeReviewThreadType?.$value;
      const actor = t.comments[0]?.author;
      const base = { actorName: actor?.displayName ?? 'unknown', actorAvatarUrl: await this.client.avatar(actor), createdAt: t.publishedDate };
      if (type === 'StatusUpdate') {
        const status = t.properties?.CodeReviewStatus?.$value;
        const kind = status === 'Completed' ? 'merged' : status === 'Abandoned' ? 'closed' : status === 'Active' ? 'reopened' : undefined;
        if (kind) events.push({ ...base, id: `status-${t.id}`, kind });
      } else if (type === 'ReviewersUpdate') {
        for (const [property, kind] of [['CodeReviewReviewersUpdatedAddedIdentity', 'reviewRequested'], ['CodeReviewReviewersUpdatedRemovedIdentity', 'reviewRequestRemoved']] as const) {
          const key = t.properties?.[property]?.$value;
          const identity = key ? t.identities?.[key] : undefined;
          if (identity) events.push({ ...base, id: `${kind}-${t.id}`, kind, user: await this.client.toUser(identity) });
        }
      }
    }
    return events;
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult> {
    try {
      const [{ data }, me] = await Promise.all([
        this.client.request<RawThread>(`${this.prUrl(owner, repo, number)}/threads`, {
          method: 'POST',
          body: JSON.stringify({ comments: [{ parentCommentId: 0, content: mentionsToAzure(body), commentType: 1 }], status: 1 }),
        }),
        this.client.getCurrentUser(),
      ]);
      return { ok: true, comment: await this.mapComment(owner, repo, number, data.id, data.comments[0], me?.id) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  private commentUrl(owner: string, repo: string, number: number, commentId: string): string {
    const [threadId, id] = commentId.split(':');
    return `${this.prUrl(owner, repo, number)}/threads/${threadId}/comments/${id}`;
  }

  async updateComment(owner: string, repo: string, number: number, commentId: string, body: string): Promise<PostCommentResult> {
    try {
      const [{ data }, me] = await Promise.all([
        this.client.request<RawComment>(this.commentUrl(owner, repo, number, commentId), { method: 'PATCH', body: JSON.stringify({ content: mentionsToAzure(body) }) }),
        this.client.getCurrentUser(),
      ]);
      return { ok: true, comment: await this.mapComment(owner, repo, number, Number(commentId.split(':')[0]), data, me?.id) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async deleteComment(owner: string, repo: string, number: number, commentId: string): Promise<ActionResult> {
    try {
      await this.client.request(this.commentUrl(owner, repo, number, commentId), { method: 'DELETE' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async hideComment(): Promise<UnsupportedResult> {
    return { ok: false, unsupported: true, error: vscode.l10n.t('Azure DevOps has no concept of hiding a comment.') };
  }

  async unhideComment(): Promise<UnsupportedResult> {
    return { ok: false, unsupported: true, error: vscode.l10n.t('Azure DevOps has no concept of hiding a comment.') };
  }

  /** The changes of the latest iteration against the target branch — what the web UI's Files tab shows. */
  async listChangedFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]> {
    const { data: iterations } = await this.client.request<{ value: { id: number }[] }>(`${this.prUrl(owner, repo, number)}/iterations`);
    const last = iterations.value[iterations.value.length - 1];
    if (!last) return [];
    const files: ChangedFile[] = [];
    let skip = 0;
    for (;;) {
      const { data } = await this.client.request<{ changeEntries: RawChangeEntry[]; nextSkip?: number }>(
        `${this.prUrl(owner, repo, number)}/iterations/${last.id}/changes?$compareTo=0&$top=2000&$skip=${skip}`,
      );
      for (const change of data.changeEntries) {
        const file = mapChange(change);
        if (file) files.push(file);
      }
      if (!data.nextSkip) break;
      skip = data.nextSkip;
    }
    return files;
  }

  private async getBlobAtCommit(owner: string, repo: string, path: string, sha: string): Promise<string> {
    const params = new URLSearchParams({
      path: `/${path}`, 'versionDescriptor.versionType': 'commit', 'versionDescriptor.version': sha, includeContent: 'true', $format: 'json',
    });
    try {
      const { data } = await this.client.request<{ content?: string; contentMetadata?: { isBinary?: boolean } }>(`${this.repoUrl(owner, repo)}/items?${params.toString()}`);
      return data.contentMetadata?.isBinary ? '' : data.content ?? '';
    } catch (err) {
      if (err instanceof HttpJsonError && err.status === 404) return '';
      throw err;
    }
  }

  /** A commit's first parent — pull request commit lists don't carry parents, so it's looked up when a diff needs it. */
  private getParentSha(owner: string, repo: string, sha: string): Promise<string | undefined> {
    let parent = this.parentBySha.get(sha);
    if (!parent) {
      parent = this.client.request<RawCommitRef>(`${this.repoUrl(owner, repo)}/commits/${sha}`)
        .then(({ data }) => data.parents?.[0])
        .catch(() => undefined);
      this.parentBySha.set(sha, parent);
    }
    return parent;
  }

  async getFileDiff(owner: string, repo: string, _number: number, file: ChangedFile, refs: FileDiffRefs): Promise<FileDiffContent> {
    // A single commit's diff arrives with no parent (base === head) — see getParentSha.
    const baseSha = refs.baseSha === refs.headSha ? (await this.getParentSha(owner, repo, refs.headSha)) ?? refs.baseSha : refs.baseSha;
    const [beforeContent, afterContent] = await Promise.all([
      file.status === 'added' ? Promise.resolve('') : this.getBlobAtCommit(owner, repo, file.oldPath ?? file.path, baseSha),
      file.status === 'deleted' ? Promise.resolve('') : this.getBlobAtCommit(owner, repo, file.path, refs.headSha),
    ]);
    return { path: file.path, oldPath: file.oldPath, beforeContent, afterContent };
  }

  async listCommits(owner: string, repo: string, number: number): Promise<PullRequestCommit[]> {
    const commits: PullRequestCommit[] = [];
    let continuationToken: string | null = null;
    do {
      const params = new URLSearchParams({ $top: '100' });
      if (continuationToken) params.set('continuationToken', continuationToken);
      const { data, headers } = await this.client.request<{ value: RawCommitRef[] }>(`${this.prUrl(owner, repo, number)}/commits?${params.toString()}`);
      commits.push(...data.value.map(c => ({
        sha: c.commitId,
        shortSha: c.commitId.slice(0, 8),
        message: c.comment,
        authorName: c.author?.name ?? 'unknown',
        authoredAt: c.author?.date ?? '',
        parentSha: c.parents?.[0],
      })));
      continuationToken = headers.get('x-ms-continuationtoken');
    } while (continuationToken);
    return commits;
  }

  async listCommitFiles(owner: string, repo: string, sha: string): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    let skip = 0;
    for (;;) {
      const { data } = await this.client.request<{ changes: RawChangeEntry[] }>(`${this.repoUrl(owner, repo)}/commits/${sha}/changes?top=1000&skip=${skip}`);
      for (const change of data.changes) {
        const file = mapChange(change);
        if (file) files.push(file);
      }
      if (data.changes.length < 1000) break;
      skip += 1000;
    }
    return files;
  }

  async mergePullRequest(owner: string, repo: string, number: number, strategy: MergeStrategy): Promise<ActionResult> {
    try {
      const { data } = await this.client.request<RawPullRequest>(this.prUrl(owner, repo, number));
      return await this.patchPr(owner, repo, number, {
        status: 'completed',
        // Required: completes exactly what was reviewed, not something pushed meanwhile.
        lastMergeSourceCommit: data.lastMergeSourceCommit,
        completionOptions: { mergeStrategy: MERGE_STRATEGY[strategy] },
      });
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async closePullRequest(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.patchPr(owner, repo, number, { status: 'abandoned' });
  }

  async reopenPullRequest(owner: string, repo: string, number: number): Promise<ActionResult> {
    return this.patchPr(owner, repo, number, { status: 'active' });
  }

  /** Approve and request changes are votes ("Approved", "Waiting for author"); a comment review is a plain comment. */
  async submitReview(owner: string, repo: string, number: number, input: SubmitReviewInput): Promise<ActionResult | UnsupportedResult> {
    if ((input.event === 'requestChanges' || input.event === 'comment') && !input.body?.trim()) {
      return { ok: false, error: vscode.l10n.t('A comment body is required for this review type') };
    }
    if (input.event !== 'approve' && input.body?.trim()) {
      const posted = await this.postComment(owner, repo, number, input.body);
      if (!posted.ok) return { ok: false, error: posted.error };
    }
    if (input.event === 'comment') return { ok: true };
    try {
      const me = await this.client.getCurrentUser();
      if (!me) return { ok: false, error: vscode.l10n.t('Unable to identify the signed-in Azure DevOps user') };
      await this.client.request(`${this.prUrl(owner, repo, number)}/reviewers/${me.id}`, {
        method: 'PUT',
        body: JSON.stringify({ id: me.id, vote: input.event === 'approve' ? VOTE_APPROVE : VOTE_WAIT_FOR_AUTHOR }),
      });
      if (input.event === 'approve' && input.body?.trim()) await this.postComment(owner, repo, number, input.body);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }
}
