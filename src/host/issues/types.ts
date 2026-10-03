import type {
  ActionResult, ForgeProvider, PostCommentResult, PullRequestComment, PullRequestEvent, PullRequestLabel, PullRequestSummary,
  PullRequestUser, UnsupportedResult,
} from '../pullRequests/types';

export type IssueState = 'open' | 'closed';

/** Why a closed issue was closed, where the forge records it (GitHub only) — drives the closed icon's color. */
export type IssueStateReason = 'completed' | 'notPlanned' | 'duplicate';

export interface IssueSummary {
  id: string;
  number: number;
  title: string;
  url: string;
  state: IssueState;
  stateReason?: IssueStateReason;
  authorName: string;
  authorAvatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  commentCount?: number;
  /** Undefined when the list response doesn't carry them. */
  assignees?: PullRequestUser[];
  labels?: PullRequestLabel[];
}

export interface IssueCapabilities {
  canManageAssignees: boolean;
  /** Bitbucket Cloud issues have a single assignee — the picker then allows one choice only. */
  singleAssignee: boolean;
  /** false for Bitbucket Cloud: no labels (its "kind" is shown as a read-only label instead). */
  canManageLabels: boolean;
  /** Whether the "Mentioning you" list filter is offered. */
  canFilterMentions: boolean;
  /** Whether the "Assigned to me" list filter is offered. */
  canFilterAssignee: boolean;
}

export interface IssueDetail extends IssueSummary {
  description: string;
  capabilities: IssueCapabilities;
  /** Whether the authenticated user can edit the issue (title, description, assignees, labels, state) — the issue's
   * author can always close/reopen and edit it on every forge, so this is true for them too. */
  canWrite: boolean;
  assignees: PullRequestUser[];
  labels: PullRequestLabel[];
}

export type IssueStateFilter = IssueState;
export type IssueAuthorFilter = 'all' | 'mine';

export interface ListIssuesOptions {
  /** Non-empty set of states to include. */
  states: IssueStateFilter[];
  author: IssueAuthorFilter;
  assignedToMe?: boolean;
  /** Ignored by providers without a mentions search — see `IssueCapabilities.canFilterMentions`. */
  mentioningMe?: boolean;
  /** Free-text search against the title (and body, where the forge's search covers it), OR a bare issue number. */
  search?: string;
  /** Opaque, provider-defined: a page number for page-based APIs, a GraphQL cursor for GitHub. Undefined: first page. */
  cursor?: string;
}

export interface ListIssuesResult {
  items: IssueSummary[];
  /** Cursor of the next page; undefined when this was the last one. */
  nextCursor?: string;
  /** Total issues matching the filters, when the forge reports it cheaply. */
  totalCount?: number;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  /** `PullRequestUser.id` values. */
  assigneeIds?: string[];
  /** `PullRequestLabel.id` values. */
  labelIds?: string[];
}

export interface CreateIssueResult {
  ok: boolean;
  issue?: IssueSummary;
  error?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
}

/** A pull request linked to an issue: one that references it, or one that closes it once merged. */
export interface LinkedPullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequestSummary['state'];
  /** "owner/repo" of the repository the PR lives in. */
  repoFullName?: string;
  /** False when the PR lives in another repository — it then opens in the browser instead of the detail panel. */
  sameRepo: boolean;
  /** The PR closes the issue once merged. */
  willClose: boolean;
}

/** An issue a pull request closes once merged. */
export interface LinkedIssue {
  number: number;
  title: string;
  url: string;
  state: IssueState;
  stateReason?: IssueStateReason;
  repoFullName?: string;
  sameRepo: boolean;
}

/** The repository has its issue tracker turned off (or never had one, e.g. Bitbucket Cloud by default). */
export class IssueTrackerDisabledError extends Error {
  constructor() {
    super('Issue tracker disabled');
  }
}

export type IssueComment = PullRequestComment;
export type IssueEvent = PullRequestEvent;

export interface IssueProvider {
  readonly kind: ForgeProvider;
  /** Static per provider kind — no network call. */
  getCapabilities(): IssueCapabilities;
  hasCredentials(): Promise<boolean>;
  getCurrentUsername(): Promise<string | undefined>;
  /** Throws IssueTrackerDisabledError when the repository has no issue tracker. */
  listIssues(owner: string, repo: string, options: ListIssuesOptions): Promise<ListIssuesResult>;
  getIssueDetail(owner: string, repo: string, number: number): Promise<IssueDetail>;
  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<CreateIssueResult>;
  updateIssue(owner: string, repo: string, number: number, input: UpdateIssueInput): Promise<ActionResult>;
  closeIssue(owner: string, repo: string, number: number): Promise<ActionResult>;
  reopenIssue(owner: string, repo: string, number: number): Promise<ActionResult>;
  /** Replaces the full assignee list with `userIds` (each a `PullRequestUser.id`). */
  updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult | UnsupportedResult>;
  /** Replaces the full label list with `labelIds` (each a `PullRequestLabel.id`). */
  updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult | UnsupportedResult>;
  listComments(owner: string, repo: string, number: number): Promise<IssueComment[]>;
  postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult>;
  updateComment(owner: string, repo: string, number: number, commentId: string, body: string): Promise<PostCommentResult>;
  deleteComment(owner: string, repo: string, number: number, commentId: string): Promise<ActionResult>;
  /** Non-comment timeline entries (rename, label changes, close/reopen, assign/unassign) — coverage differs per forge. */
  listEvents(owner: string, repo: string, number: number): Promise<IssueEvent[]>;
  /** Pull requests referencing or closing the issue — empty where the forge exposes no such link. */
  listLinkedPullRequests(owner: string, repo: string, number: number): Promise<LinkedPullRequest[]>;
  /** Issues a pull request closes once merged. `prDescription` is for forges with no API for it, which
   * read the closing keywords ("Fixes #12") from the description instead. */
  listIssuesClosedByPullRequest(owner: string, repo: string, prNumber: number, prDescription: string): Promise<LinkedIssue[]>;
}
