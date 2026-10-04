import * as vscode from 'vscode';
import { marked } from 'marked';
import type {
  ActionResult, PostCommentResult, PullRequestComment, PullRequestEvent, PullRequestLabel, PullRequestUser,
} from '../../pullRequests/types';
import { HttpJsonError } from '../../pullRequests/httpJson';
import { formatApiError } from '../../pullRequests/formatApiError';
import { projectOf, type AzureDevOpsClient, type RawIdentityRef } from '../../pullRequests/azureDevOpsClient';
import type {
  CreateIssueInput, CreateIssueResult, IssueCapabilities, IssueDetail, IssueProvider, IssueState, IssueStateReason, IssueSummary,
  LinkedIssue, LinkedPullRequest, ListIssuesOptions, ListIssuesResult, UpdateIssueInput,
} from '../types';

// Issues are Azure Boards work items. Their states depend on the project's process (New/Active/Closed, To Do/Doing/
// Done…), so open and closed are told apart by each state's category; their rich text fields are HTML.

const PAGE_SIZE = 30;
const COMMENTS_API_VERSION = '6.0-preview.3';
const IDS_TTL_MS = 60_000;

const CAPABILITIES: IssueCapabilities = {
  canManageAssignees: true,
  singleAssignee: true,
  canManageLabels: true,
  canFilterMentions: false,
  canFilterAssignee: true,
};

/** Work item types that aren't tracked work: test artifacts, and the types Azure DevOps hides itself. */
const EXCLUDED_CATEGORIES = new Set([
  'Microsoft.HiddenCategory', 'Microsoft.TestPlanCategory', 'Microsoft.TestSuiteCategory', 'Microsoft.TestCaseCategory',
  'Microsoft.SharedStepCategory', 'Microsoft.SharedParameterCategory',
]);
/** The type a new issue is created as: the first one the process has. */
const CREATE_TYPE_PREFERENCE = ['Bug', 'Issue', 'Task'];
/** The work item type is shown as a read-only label; its id is kept apart from tag names. */
const TYPE_LABEL_PREFIX = 'ado-type:';
const TAG_COLOR = 'c8c8c8';

const FIELDS = [
  'System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.TeamProject', 'System.CreatedBy', 'System.CreatedDate',
  'System.ChangedDate', 'System.AssignedTo', 'System.Tags', 'System.CommentCount',
];

interface RawWorkItem {
  id: number;
  fields: Record<string, unknown>;
  relations?: { rel: string; url: string; attributes?: { name?: string } }[];
}

interface RawWorkItemType {
  name: string;
  color?: string;
  isDisabled?: boolean;
  states?: { name: string; category: string }[];
}

interface RawWorkItemComment {
  id: number;
  text: string;
  createdBy: RawIdentityRef;
  createdDate: string;
  isDeleted?: boolean;
}

interface RawWorkItemUpdate {
  id: number;
  rev: number;
  revisedBy?: RawIdentityRef;
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown } | undefined>;
}

interface ProcessInfo {
  types: Map<string, RawWorkItemType>;
  visibleTypes: string[];
  /** States in the Completed or Removed category — what the tab shows as closed. */
  closedStates: Set<string>;
  removedStates: Set<string>;
}

function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true, breaks: true });
}

function splitTags(tags: unknown): string[] {
  return typeof tags === 'string' ? tags.split(';').map(t => t.trim()).filter(Boolean) : [];
}

function identityField(value: unknown): RawIdentityRef | undefined {
  return value && typeof value === 'object' && 'displayName' in value ? value as RawIdentityRef : undefined;
}

export class AzureDevOpsIssueProvider implements IssueProvider {
  readonly kind = 'azure' as const;
  private readonly process = new Map<string, Promise<ProcessInfo>>();
  private readonly queryIds = new Map<string, { ids: number[]; fetchedAt: number }>();
  /** Which field holds a work item's description: Bugs keep theirs in Repro Steps. */
  private readonly descriptionField = new Map<number, string>();
  private repoId: Promise<string | undefined> | undefined;

  constructor(private readonly client: AzureDevOpsClient) {}

  getCapabilities(): IssueCapabilities {
    return CAPABILITIES;
  }

  async hasCredentials(): Promise<boolean> {
    return this.client.hasCredentials();
  }

  async getCurrentUsername(): Promise<string | undefined> {
    return (await this.client.getCurrentUser())?.displayName;
  }

  private witUrl(owner: string): string {
    return `${this.client.projectUrl(owner)}/_apis/wit`;
  }

  private webUrl(project: string, id: number): string {
    return `${this.client.apiBase}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
  }

  private getProcess(owner: string): Promise<ProcessInfo> {
    const project = projectOf(owner);
    let info = this.process.get(project);
    if (!info) {
      info = (async () => {
        const [{ data: types }, { data: categories }] = await Promise.all([
          this.client.request<{ value: RawWorkItemType[] }>(`${this.witUrl(owner)}/workitemtypes`),
          this.client.request<{ value: { referenceName: string; workItemTypes: { name: string }[] }[] }>(`${this.witUrl(owner)}/workitemtypecategories`),
        ]);
        const excluded = new Set(categories.value.filter(c => EXCLUDED_CATEGORIES.has(c.referenceName)).flatMap(c => c.workItemTypes.map(t => t.name)));
        const visible = types.value.filter(t => !t.isDisabled && !excluded.has(t.name));
        const states = visible.flatMap(t => t.states ?? []);
        return {
          types: new Map(types.value.map(t => [t.name, t])),
          visibleTypes: visible.map(t => t.name),
          closedStates: new Set(states.filter(s => s.category === 'Completed' || s.category === 'Removed').map(s => s.name)),
          removedStates: new Set(states.filter(s => s.category === 'Removed').map(s => s.name)),
        };
      })();
      info.catch(() => this.process.delete(project));
      this.process.set(project, info);
    }
    return info;
  }

  private mapState(state: unknown, process: ProcessInfo): { state: IssueState; stateReason?: IssueStateReason } {
    const name = String(state ?? '');
    if (!process.closedStates.has(name)) return { state: 'open' };
    return { state: 'closed', stateReason: process.removedStates.has(name) ? 'notPlanned' : 'completed' };
  }

  private labelsOf(fields: Record<string, unknown>, process: ProcessInfo): PullRequestLabel[] {
    const type = String(fields['System.WorkItemType'] ?? '');
    const typeColor = process.types.get(type)?.color;
    return [
      ...(type ? [{ id: `${TYPE_LABEL_PREFIX}${type}`, name: type, color: typeColor?.replace(/^#/, '').slice(-6) || '808080' }] : []),
      ...splitTags(fields['System.Tags']).map(t => ({ id: t, name: t, color: TAG_COLOR })),
    ];
  }

  private async mapWorkItem(owner: string, item: RawWorkItem, process: ProcessInfo): Promise<IssueSummary> {
    const f = item.fields;
    const createdBy = identityField(f['System.CreatedBy']);
    const assignedTo = identityField(f['System.AssignedTo']);
    const [authorAvatarUrl, assignees] = await Promise.all([
      this.client.avatar(createdBy),
      assignedTo ? this.client.toUser(assignedTo).then(u => [u]) : Promise.resolve([] as PullRequestUser[]),
    ]);
    return {
      id: String(item.id),
      number: item.id,
      title: String(f['System.Title'] ?? ''),
      url: this.webUrl(String(f['System.TeamProject'] ?? projectOf(owner)), item.id),
      ...this.mapState(f['System.State'], process),
      authorName: createdBy?.displayName ?? 'unknown',
      authorAvatarUrl,
      createdAt: String(f['System.CreatedDate'] ?? ''),
      updatedAt: String(f['System.ChangedDate'] ?? ''),
      commentCount: typeof f['System.CommentCount'] === 'number' ? f['System.CommentCount'] : undefined,
      assignees,
      labels: this.labelsOf(f, process),
    };
  }

  /** Work items by id, in the given order (the batch endpoint takes 200 at most). */
  private async getWorkItems(ids: number[], fields = FIELDS): Promise<RawWorkItem[]> {
    const items: RawWorkItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await this.client.request<{ value: RawWorkItem[] }>(`${this.client.apiBase}/_apis/wit/workitemsbatch`, {
        method: 'POST', body: JSON.stringify({ ids: ids.slice(i, i + 200), fields, errorPolicy: 'omit' }),
      });
      items.push(...data.value.filter(Boolean));
    }
    const byId = new Map(items.map(item => [item.id, item]));
    return ids.map(id => byId.get(id)).filter((item): item is RawWorkItem => !!item);
  }

  /** WIQL returns every matching id at once — kept briefly so the following pages don't run the query again. */
  private async queryIdsFor(owner: string, query: string, fresh: boolean): Promise<number[]> {
    const key = `${projectOf(owner)}|${query}`;
    const cached = this.queryIds.get(key);
    if (!fresh && cached && Date.now() - cached.fetchedAt < IDS_TTL_MS) return cached.ids;
    const { data } = await this.client.request<{ workItems: { id: number }[] }>(`${this.witUrl(owner)}/wiql?$top=20000`, {
      method: 'POST', body: JSON.stringify({ query }),
    });
    const ids = data.workItems.map(w => w.id);
    this.queryIds.set(key, { ids, fetchedAt: Date.now() });
    return ids;
  }

  async listIssues(owner: string, _repo: string, options: ListIssuesOptions): Promise<ListIssuesResult> {
    const process = await this.getProcess(owner);
    const clauses = ['[System.TeamProject] = @project'];
    if (process.visibleTypes.length > 0) clauses.push(`[System.WorkItemType] IN (${process.visibleTypes.map(wiqlString).join(', ')})`);
    const closed = [...process.closedStates].map(wiqlString).join(', ');
    if (options.states.length === 1 && closed) clauses.push(`[System.State] ${options.states[0] === 'closed' ? 'IN' : 'NOT IN'} (${closed})`);
    if (options.author === 'mine') clauses.push('[System.CreatedBy] = @Me');
    if (options.assignedToMe) clauses.push('[System.AssignedTo] = @Me');
    const search = options.search?.trim();
    const numberMatch = search?.match(/^(?:AB)?#?(\d+)$/i);
    if (numberMatch) clauses.push(`[System.Id] = ${numberMatch[1]}`);
    else if (search) clauses.push(`[System.Title] CONTAINS ${wiqlString(search)}`);
    const query = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;

    const offset = Number(options.cursor ?? '0');
    const ids = await this.queryIdsFor(owner, query, offset === 0);
    const pageIds = ids.slice(offset, offset + PAGE_SIZE);
    const items = await this.getWorkItems(pageIds);
    return {
      items: await Promise.all(items.map(item => this.mapWorkItem(owner, item, process))),
      nextCursor: offset + PAGE_SIZE < ids.length ? String(offset + PAGE_SIZE) : undefined,
      totalCount: ids.length,
    };
  }

  async getIssueDetail(owner: string, _repo: string, number: number): Promise<IssueDetail> {
    const [process, [item]] = await Promise.all([
      this.getProcess(owner),
      this.getWorkItems([number], [...FIELDS, 'System.Description', 'Microsoft.VSTS.TCM.ReproSteps']),
    ]);
    if (!item) throw new Error(vscode.l10n.t('Work item {0} not found', number));
    const summary = await this.mapWorkItem(owner, item, process);
    const description = item.fields['System.Description'];
    const reproSteps = item.fields['Microsoft.VSTS.TCM.ReproSteps'];
    const useReproSteps = !description && typeof reproSteps === 'string';
    this.descriptionField.set(number, useReproSteps ? 'Microsoft.VSTS.TCM.ReproSteps' : 'System.Description');
    return {
      ...summary,
      description: String((useReproSteps ? reproSteps : description) ?? ''),
      capabilities: CAPABILITIES,
      // Permissions are per area path and not exposed — the server refuses what the account can't do.
      canWrite: true,
      assignees: summary.assignees ?? [],
      labels: summary.labels ?? [],
    };
  }

  private async patchWorkItem(number: number, operations: { op: string; path: string; value?: unknown }[]): Promise<ActionResult> {
    try {
      await this.client.request(`${this.client.apiBase}/_apis/wit/workitems/${number}`, {
        method: 'PATCH', contentType: 'application/json-patch+json', body: JSON.stringify(operations),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  /** The value a person field takes: the unique name (an id isn't accepted there). */
  private identityValue(userId: string): string {
    return this.client.getIdentity(userId)?.uniqueName ?? userId;
  }

  async createIssue(owner: string, _repo: string, input: CreateIssueInput): Promise<CreateIssueResult> {
    try {
      const process = await this.getProcess(owner);
      const type = CREATE_TYPE_PREFERENCE.find(t => process.visibleTypes.includes(t)) ?? process.visibleTypes[0];
      if (!type) return { ok: false, error: vscode.l10n.t('No work item type available in this project') };
      const descriptionField = type === 'Bug' ? 'Microsoft.VSTS.TCM.ReproSteps' : 'System.Description';
      const operations = [
        { op: 'add', path: '/fields/System.Title', value: input.title },
        ...(input.description.trim() ? [{ op: 'add', path: `/fields/${descriptionField}`, value: markdownToHtml(input.description) }] : []),
        ...(input.assigneeIds?.[0] ? [{ op: 'add', path: '/fields/System.AssignedTo', value: this.identityValue(input.assigneeIds[0]) }] : []),
        ...(input.labelIds?.length ? [{ op: 'add', path: '/fields/System.Tags', value: input.labelIds.filter(id => !id.startsWith(TYPE_LABEL_PREFIX)).join('; ') }] : []),
      ];
      const { data } = await this.client.request<RawWorkItem>(`${this.witUrl(owner)}/workitems/$${encodeURIComponent(type)}`, {
        method: 'POST', contentType: 'application/json-patch+json', body: JSON.stringify(operations),
      });
      return { ok: true, issue: await this.mapWorkItem(owner, data, process) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateIssue(_owner: string, _repo: string, number: number, input: UpdateIssueInput): Promise<ActionResult> {
    return this.patchWorkItem(number, [
      ...(input.title !== undefined ? [{ op: 'add', path: '/fields/System.Title', value: input.title }] : []),
      ...(input.description !== undefined
        ? [{ op: 'add', path: `/fields/${this.descriptionField.get(number) ?? 'System.Description'}`, value: markdownToHtml(input.description) }]
        : []),
    ]);
  }

  /** Moves the work item to the first state of `category` its type defines (Closed, Done…; New, To Do…). */
  private async changeState(owner: string, number: number, category: 'Completed' | 'Proposed'): Promise<ActionResult> {
    try {
      const [process, [item]] = await Promise.all([this.getProcess(owner), this.getWorkItems([number], ['System.WorkItemType'])]);
      const type = process.types.get(String(item?.fields['System.WorkItemType'] ?? ''));
      const state = type?.states?.find(s => s.category === category)?.name;
      if (!state) return { ok: false, error: vscode.l10n.t('No suitable state found for this work item type') };
      return await this.patchWorkItem(number, [{ op: 'add', path: '/fields/System.State', value: state }]);
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  closeIssue(owner: string, _repo: string, number: number): Promise<ActionResult> {
    return this.changeState(owner, number, 'Completed');
  }

  reopenIssue(owner: string, _repo: string, number: number): Promise<ActionResult> {
    return this.changeState(owner, number, 'Proposed');
  }

  /** One assignee at most — the first id wins, none unassigns. */
  async updateAssignees(_owner: string, _repo: string, number: number, userIds: string[]): Promise<ActionResult> {
    return this.patchWorkItem(number, [
      userIds[0]
        ? { op: 'add', path: '/fields/System.AssignedTo', value: this.identityValue(userIds[0]) }
        : { op: 'add', path: '/fields/System.AssignedTo', value: '' },
    ]);
  }

  async updateLabels(_owner: string, _repo: string, number: number, labelIds: string[]): Promise<ActionResult> {
    const tags = labelIds.filter(id => !id.startsWith(TYPE_LABEL_PREFIX));
    return this.patchWorkItem(number, [{ op: 'add', path: '/fields/System.Tags', value: tags.join('; ') }]);
  }

  private async mapComment(owner: string, number: number, c: RawWorkItemComment, currentUserId: string | undefined, project: string): Promise<PullRequestComment> {
    const isOwn = !!currentUserId && c.createdBy.id === currentUserId;
    return {
      id: String(c.id),
      authorName: c.createdBy.displayName,
      authorAvatarUrl: await this.client.avatar(c.createdBy),
      body: c.text,
      createdAt: c.createdDate,
      url: `${this.webUrl(project, number)}#${c.id}`,
      canEdit: isOwn,
      canDelete: isOwn,
      canHide: false,
    };
  }

  private commentsUrl(owner: string, number: number): string {
    return `${this.witUrl(owner)}/workItems/${number}/comments`;
  }

  async listComments(owner: string, _repo: string, number: number): Promise<PullRequestComment[]> {
    const me = await this.client.getCurrentUser();
    const raw: RawWorkItemComment[] = [];
    let continuationToken: string | undefined;
    do {
      const params = new URLSearchParams({ $top: '200', order: 'asc' });
      if (continuationToken) params.set('continuationToken', continuationToken);
      const { data } = await this.client.request<{ comments: RawWorkItemComment[]; continuationToken?: string }>(
        `${this.commentsUrl(owner, number)}?${params.toString()}`, { apiVersion: COMMENTS_API_VERSION },
      );
      raw.push(...data.comments.filter(c => !c.isDeleted));
      continuationToken = data.continuationToken;
    } while (continuationToken);
    const project = projectOf(owner);
    return Promise.all(raw.map(c => this.mapComment(owner, number, c, me?.id, project)));
  }

  async postComment(owner: string, _repo: string, number: number, body: string): Promise<PostCommentResult> {
    try {
      const [{ data }, me] = await Promise.all([
        this.client.request<RawWorkItemComment>(this.commentsUrl(owner, number), {
          method: 'POST', apiVersion: COMMENTS_API_VERSION, body: JSON.stringify({ text: markdownToHtml(body) }),
        }),
        this.client.getCurrentUser(),
      ]);
      return { ok: true, comment: await this.mapComment(owner, number, data, me?.id, projectOf(owner)) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async updateComment(owner: string, _repo: string, number: number, commentId: string, body: string): Promise<PostCommentResult> {
    try {
      const [{ data }, me] = await Promise.all([
        this.client.request<RawWorkItemComment>(`${this.commentsUrl(owner, number)}/${commentId}`, {
          method: 'PATCH', apiVersion: COMMENTS_API_VERSION, body: JSON.stringify({ text: markdownToHtml(body) }),
        }),
        this.client.getCurrentUser(),
      ]);
      return { ok: true, comment: await this.mapComment(owner, number, data, me?.id, projectOf(owner)) };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  async deleteComment(owner: string, _repo: string, number: number, commentId: string): Promise<ActionResult> {
    try {
      await this.client.request(`${this.commentsUrl(owner, number)}/${commentId}`, { method: 'DELETE', apiVersion: COMMENTS_API_VERSION });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatApiError(err) };
    }
  }

  /** The work item's revision history: renames, state changes across open/closed, tag and assignee changes. */
  async listEvents(owner: string, _repo: string, number: number): Promise<PullRequestEvent[]> {
    const process = await this.getProcess(owner);
    const updates: RawWorkItemUpdate[] = [];
    for (let skip = 0; ; skip += 200) {
      const { data } = await this.client.request<{ value: RawWorkItemUpdate[] }>(`${this.client.apiBase}/_apis/wit/workItems/${number}/updates?$top=200&$skip=${skip}`);
      updates.push(...data.value);
      if (data.value.length < 200) break;
    }
    const events: PullRequestEvent[] = [];
    for (const u of updates) {
      const fields = u.fields;
      if (!fields || u.rev <= 1) continue; // revision 1 is the creation itself
      const createdAt = String(fields['System.ChangedDate']?.newValue ?? '');
      const base = { actorName: u.revisedBy?.displayName ?? 'unknown', actorAvatarUrl: await this.client.avatar(u.revisedBy), createdAt };
      const title = fields['System.Title'];
      if (title?.oldValue !== undefined && title.newValue !== undefined) {
        events.push({ ...base, id: `title-${u.id}`, kind: 'renamed', previousTitle: String(title.oldValue), newTitle: String(title.newValue) });
      }
      const state = fields['System.State'];
      if (state?.oldValue !== undefined && state.newValue !== undefined) {
        const from = this.mapState(state.oldValue, process).state;
        const to = this.mapState(state.newValue, process).state;
        if (from !== to) events.push({ ...base, id: `state-${u.id}`, kind: to === 'closed' ? 'closed' : 'reopened' });
      }
      const tags = fields['System.Tags'];
      if (tags) {
        const before = splitTags(tags.oldValue);
        const after = splitTags(tags.newValue);
        for (const t of after.filter(t => !before.includes(t))) events.push({ ...base, id: `tag+${t}-${u.id}`, kind: 'labeled', label: { id: t, name: t, color: TAG_COLOR } });
        for (const t of before.filter(t => !after.includes(t))) events.push({ ...base, id: `tag-${t}-${u.id}`, kind: 'unlabeled', label: { id: t, name: t, color: TAG_COLOR } });
      }
      const assignee = fields['System.AssignedTo'];
      if (assignee) {
        const added = identityField(assignee.newValue);
        const removed = identityField(assignee.oldValue);
        if (removed) events.push({ ...base, id: `unassign-${u.id}`, kind: 'unassigned', user: await this.client.toUser(removed) });
        if (added) events.push({ ...base, id: `assign-${u.id}`, kind: 'assigned', user: await this.client.toUser(added) });
      }
    }
    return events;
  }

  private getRepoId(owner: string, repo: string): Promise<string | undefined> {
    this.repoId ??= this.client.request<{ id: string }>(this.client.repoApiUrl(owner, repo))
      .then(({ data }) => data.id)
      .catch(() => { this.repoId = undefined; return undefined; });
    return this.repoId;
  }

  /** Pull requests linked from the work item's Development section (artifact links). */
  async listLinkedPullRequests(owner: string, repo: string, number: number): Promise<LinkedPullRequest[]> {
    const [{ data }, repoId] = await Promise.all([
      this.client.request<RawWorkItem>(`${this.client.apiBase}/_apis/wit/workitems/${number}?$expand=relations`),
      this.getRepoId(owner, repo),
    ]);
    // vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{pullRequestId}
    const prIds = (data.relations ?? [])
      .filter(r => r.rel === 'ArtifactLink' && /^vstfs:\/\/\/Git\/PullRequestId\//i.test(r.url))
      .map(r => Number(decodeURIComponent(r.url.slice(r.url.lastIndexOf('/') + 1)).split('/').pop()))
      .filter(id => Number.isFinite(id));
    const prs = await Promise.all(prIds.map(id =>
      this.client.request<{
        pullRequestId: number; title: string; status: string; isDraft?: boolean;
        repository: { id: string; name: string; project?: { name: string } }; completionOptions?: { transitionWorkItems?: boolean };
      }>(`${this.client.apiBase}/_apis/git/pullrequests/${id}`).then(r => r.data).catch(() => undefined),
    ));
    const prefix = owner.slice(0, owner.lastIndexOf('/') + 1);
    return prs.filter((pr): pr is NonNullable<typeof pr> => !!pr).map(pr => {
      const project = pr.repository.project?.name ?? projectOf(owner);
      return {
        number: pr.pullRequestId,
        title: pr.title,
        url: `${this.client.apiBase}/${encodeURIComponent(project)}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`,
        state: pr.status === 'completed' ? 'merged' : pr.status === 'abandoned' ? 'closed' : pr.isDraft ? 'draft' : 'open',
        repoFullName: `${prefix}${project}/${pr.repository.name}`,
        sameRepo: !!repoId && pr.repository.id === repoId,
        willClose: pr.completionOptions?.transitionWorkItems === true,
      };
    });
  }

  /** The work items linked to the pull request — completing it can transition them, Azure DevOps' "closes". */
  async listIssuesClosedByPullRequest(owner: string, repo: string, prNumber: number): Promise<LinkedIssue[]> {
    let ids: number[];
    try {
      const { data } = await this.client.request<{ value: { id: string }[] }>(`${this.client.repoApiUrl(owner, repo)}/pullRequests/${prNumber}/workitems`);
      ids = data.value.map(w => Number(w.id)).filter(id => Number.isFinite(id));
    } catch (err) {
      if (err instanceof HttpJsonError && err.status === 404) return [];
      throw err;
    }
    if (ids.length === 0) return [];
    const [process, items] = await Promise.all([this.getProcess(owner), this.getWorkItems(ids)]);
    return items.map(item => ({
      number: item.id,
      title: String(item.fields['System.Title'] ?? ''),
      url: this.webUrl(String(item.fields['System.TeamProject'] ?? projectOf(owner)), item.id),
      ...this.mapState(item.fields['System.State'], process),
      repoFullName: `${owner}/${repo}`,
      sameRepo: true,
    }));
  }
}
