import type { ForgeProvider } from './remoteUrlParser';

export type { ForgeProvider };

export interface PullRequestSummary {
  id: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  /** Set only when the source branch comes from a different repo (a fork) — e.g. "owner/repo". */
  sourceRepoFullName?: string;
  /** The base repo's "owner/repo" — always set, used to show a GitHub-style "owner/repo:branch" label for the target branch too. */
  targetRepoFullName?: string;
  authorName: string;
  authorAvatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  commentCount?: number;
  /** Undefined means the provider doesn't return this in the list response (or doesn't support the concept at all, e.g. assignees/labels on Bitbucket Cloud). */
  assignees?: PullRequestUser[];
  reviewers?: PullRequestUser[];
  labels?: PullRequestLabel[];
}

export type PullRequestStateFilter = 'open' | 'draft' | 'closed' | 'merged';
export type PullRequestAuthorFilter = 'all' | 'mine';

export interface ListPullRequestsOptions {
  /** Non-empty set of states to include — never "all" as a single value; pass every state to mean "all". */
  states: PullRequestStateFilter[];
  author: PullRequestAuthorFilter;
  page: number;
  /** Only PRs where the authenticated user is an assignee. Ignored by providers with no assignee concept (Bitbucket) — see `PullRequestCapabilities.canFilterAssignee`. */
  assignedToMe?: boolean;
  /** Only PRs where the authenticated user's review was requested. */
  reviewRequestedToMe?: boolean;
  /** Only PRs mentioning the authenticated user (title/body/comments). GitHub only — see `PullRequestCapabilities.canFilterMentions`. */
  mentioningMe?: boolean;
  /** Free-text search against the title (and body, where the provider's endpoint covers it), OR a bare PR number (e.g. "1234" or "#1234") to fetch that exact PR directly. */
  search?: string;
}

export interface ListPullRequestsResult {
  items: PullRequestSummary[];
  hasMore: boolean;
  /** Total PRs matching the current filters, when the provider can report it cheaply (i.e. without downloading every page). Undefined when the provider has no cheap way to know it (e.g. Bitbucket Cloud omits it for some query shapes). */
  totalCount?: number;
}

export interface CreatePullRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  draft?: boolean;
}

export interface CreatePullRequestResult {
  ok: boolean;
  pr?: PullRequestSummary;
  error?: string;
}

export interface PullRequestConnectionStatus {
  repoId: string;
  provider: ForgeProvider;
  host: string;
  connected: boolean;
  detectionFailed: boolean;
}

export type MergeStrategy = 'merge' | 'squash' | 'rebase' | 'fastForward';

export interface PullRequestCapabilities {
  canMerge: boolean;
  mergeStrategies: MergeStrategy[];
  canClose: boolean;
  canReopen: boolean;
  hasMergeableState: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canCommentReview: boolean;
  hasUnifiedDiffText: boolean;
  canManageReviewers: boolean;
  /** false for Bitbucket Cloud — it has no "assignee" concept on pull requests, only reviewers. */
  canManageAssignees: boolean;
  /** false for Bitbucket Cloud — it has no labels concept on pull requests. */
  canManageLabels: boolean;
  /** Whether the "Assigned to me" list filter is offered — false for Bitbucket Cloud (same reason as canManageAssignees). */
  canFilterAssignee: boolean;
  /** Whether the "Review requested" list filter is offered. True for all 4 providers. */
  canFilterReviewRequested: boolean;
  /** Whether the "Mentioning you" list filter is offered — true only for GitHub, the only provider with a full-text mentions search covering comments. */
  canFilterMentions: boolean;
}

/** A user reference normalized across forges — `id` is each provider's own write-identifier (GitHub/Gitea: login, GitLab: numeric user id as a string, Bitbucket: account uuid), opaque to callers. */
export interface PullRequestUser {
  id: string;
  username: string;
  avatarUrl?: string;
}

/** A label reference normalized across forges — `id` is each provider's own write-identifier (GitHub/GitLab: the label name itself, Gitea: numeric label id as a string), opaque to callers. `color` is a hex string without a leading '#'. */
export interface PullRequestLabel {
  id: string;
  name: string;
  color: string;
}

export interface CiStatus {
  state: 'pending' | 'success' | 'failure' | 'unknown';
  url?: string;
  label?: string;
}

/** One individual check/job/pipeline-stage for a PR's head commit — the detail behind the aggregate `CiStatus` badge. */
export interface CiCheck {
  id: string;
  name: string;
  state: 'pending' | 'success' | 'failure' | 'unknown';
  url?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  description: string;
  merged: boolean;
  mergeableState?: 'mergeable' | 'conflicting' | 'unknown';
  headSha: string;
  baseSha: string;
  ciStatus?: CiStatus;
  capabilities: PullRequestCapabilities;
  /** Whether the currently authenticated user has write access to the base repo — gates merge/close/edit-title/edit-target-branch actions beyond what the provider generally supports. Approve/review is gated separately (read access is enough on every provider). */
  canWrite: boolean;
  reviewers: PullRequestUser[];
  assignees: PullRequestUser[];
  labels: PullRequestLabel[];
}

export interface PullRequestComment {
  id: string;
  authorName: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url?: string;
  /** Whether the authenticated user is allowed to edit/delete/hide THIS specific comment — computed by the
   * provider itself (not the caller), since the real policy differs per forge: GitHub/Gitea let anyone with
   * repo write access act on any comment, GitLab only lets the author edit (but a maintainer can still delete),
   * Bitbucket Cloud restricts both to the author (delete also allows a workspace/repo admin). Comparing display
   * names to determine "is this mine" is unreliable (Bitbucket's authorName is display_name, not the username
   * getCurrentUsername() returns), so the provider compares its own stable author id internally instead. */
  canEdit: boolean;
  canDelete: boolean;
  /** "Minimize"/hide a comment's content behind a collapsed placeholder — only GitHub exposes this (GraphQL-only,
   * no REST equivalent). Always false on GitLab/Bitbucket/Gitea, which have no comparable concept. */
  canHide: boolean;
  /** Whether this comment is currently minimized/hidden — GitHub only (read via a GraphQL follow-up query, since
   * REST doesn't expose it at all). Always false/undefined elsewhere. There's no unhide action yet, so this is
   * display-only for now. */
  isHidden?: boolean;
}

export interface PostCommentResult {
  ok: boolean;
  comment?: PullRequestComment;
  error?: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions?: number;
  deletions?: number;
}

export interface FileDiffContent {
  path: string;
  oldPath?: string;
  beforeContent: string;
  afterContent: string;
}

export interface FileDiffRefs {
  baseSha: string;
  headSha: string;
}

export interface PullRequestCommit {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorAvatarUrl?: string;
  authoredAt: string;
  parentSha?: string;
}

export type PullRequestEventKind =
  | 'renamed' | 'labeled' | 'unlabeled' | 'closed' | 'reopened' | 'merged'
  | 'baseChanged' | 'assigned' | 'unassigned' | 'reviewRequested' | 'reviewRequestRemoved';

/** A normalized non-comment, non-commit timeline entry (rename, label change, close/reopen/merge, target-branch
 * change, assign/unassign, review request). Real coverage differs sharply per forge — see each provider's
 * listEvents for exactly which kinds it can produce; a provider never fabricates an event kind its API can't
 * reliably report (e.g. no diffing two snapshots to "guess" a change). */
export interface PullRequestEvent {
  id: string;
  kind: PullRequestEventKind;
  actorName: string;
  actorAvatarUrl?: string;
  createdAt: string;
  /** kind === 'renamed' only. previousTitle is omitted where the provider's API doesn't expose it (Bitbucket). */
  previousTitle?: string;
  newTitle?: string;
  /** kind === 'labeled' | 'unlabeled' only. */
  label?: PullRequestLabel;
  /** kind === 'baseChanged' only — real branch names, only populated where the provider API exposes them (GitHub via GraphQL). */
  previousBranch?: string;
  newBranch?: string;
  /** kind === 'assigned' | 'unassigned' | 'reviewRequested' | 'reviewRequestRemoved' only. */
  user?: PullRequestUser;
}

export type ReviewEvent = 'approve' | 'requestChanges' | 'comment';

export interface SubmitReviewInput {
  event: ReviewEvent;
  body?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Returned when a provider structurally cannot perform an action (e.g. Bitbucket reopen) — no network call is made. */
export interface UnsupportedResult {
  ok: false;
  unsupported: true;
  error: string;
}

export interface UpdatePullRequestInput {
  title?: string;
  targetBranch?: string;
}

export interface PullRequestProvider {
  readonly kind: ForgeProvider;
  listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult>;
  createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult>;
  hasCredentials(): Promise<boolean>;
  /** Current authenticated username, used to implement the "mine" author filter. Cached by the caller. */
  getCurrentUsername(): Promise<string | undefined>;
  /** Branch names for a repo, used to populate the target-branch editor — always a remote API call, since the base repo may not be the local `origin` (e.g. a fork's upstream). */
  listBranches(owner: string, repo: string): Promise<string[]>;
  /** Candidate users for reviewer/assignee pickers — repo collaborators (GitHub/Gitea), project members (GitLab), or workspace members (Bitbucket). */
  listCollaborators(owner: string, repo: string): Promise<PullRequestUser[]>;
  /** Every label defined on the repo, for the label picker — not just the ones already applied to this PR. Empty for Bitbucket (no labels concept). */
  listAvailableLabels(owner: string, repo: string): Promise<PullRequestLabel[]>;

  /** Static per provider kind — no network call. */
  getCapabilities(): PullRequestCapabilities;
  /**
   * How to fetch this PR's head commit for a local checkout. Most forges (GitHub, GitLab, Gitea) expose a
   * dedicated PR ref fetchable from the existing `origin` remote (e.g. GitHub's "pull/{number}/head") — for
   * those, `remote` is the name of an existing git remote (typically "origin"). Bitbucket Cloud exposes no
   * such ref (confirmed: only Bitbucket Server has `refs/pull-requests/*`, not Cloud) — its `remote` is
   * instead a literal fetch URL for the PR's source repo (which may be a fork), and `refspec` names the
   * PR's actual source branch directly.
   */
  getCheckoutSource(pr: PullRequestSummary): Promise<{ remote: string; refspec: string }>;
  getPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail>;
  updatePullRequest(owner: string, repo: string, number: number, input: UpdatePullRequestInput): Promise<ActionResult>;
  /** Replaces the full reviewer/assignee list with `userIds` (each a `PullRequestUser.id`) — not an incremental add/remove, always the whole target set. */
  updateReviewers(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult>;
  updateAssignees(owner: string, repo: string, number: number, userIds: string[]): Promise<ActionResult | UnsupportedResult>;
  /** Replaces the full label list with `labelIds` (each a `PullRequestLabel.id`). */
  updateLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<ActionResult | UnsupportedResult>;
  listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]>;
  /** Non-comment/commit timeline entries (rename, label changes, close/reopen/merge, target-branch change,
   * assign/unassign, review request) — coverage differs sharply per provider based on real API capabilities. */
  listEvents(owner: string, repo: string, number: number): Promise<PullRequestEvent[]>;
  postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult>;
  /** `number` is the PR/MR number the comment belongs to — GitLab's note endpoints are nested under the merge
   * request iid, so every provider takes it uniformly even though GitHub/Bitbucket/Gitea's comment endpoints
   * are scoped by comment id alone. */
  updateComment(owner: string, repo: string, number: number, commentId: string, body: string): Promise<PostCommentResult>;
  deleteComment(owner: string, repo: string, number: number, commentId: string): Promise<ActionResult>;
  /** "Minimize" a comment behind a collapsed placeholder — GitHub only (GraphQL-only mutation, no REST
   * equivalent); every other provider returns UnsupportedResult unconditionally. */
  hideComment(owner: string, repo: string, number: number, commentId: string): Promise<ActionResult | UnsupportedResult>;
  /** Reverses hideComment — GitHub only, same GraphQL-only caveat. */
  unhideComment(owner: string, repo: string, number: number, commentId: string): Promise<ActionResult | UnsupportedResult>;
  listChangedFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]>;
  getFileDiff(owner: string, repo: string, number: number, file: ChangedFile, refs: FileDiffRefs): Promise<FileDiffContent>;
  listCommits(owner: string, repo: string, number: number): Promise<PullRequestCommit[]>;
  listCommitFiles(owner: string, repo: string, sha: string): Promise<ChangedFile[]>;
  mergePullRequest(owner: string, repo: string, number: number, strategy: MergeStrategy): Promise<ActionResult>;
  closePullRequest(owner: string, repo: string, number: number): Promise<ActionResult>;
  reopenPullRequest(owner: string, repo: string, number: number): Promise<ActionResult | UnsupportedResult>;
  submitReview(owner: string, repo: string, number: number, input: SubmitReviewInput): Promise<ActionResult | UnsupportedResult>;
  /** Every individual check/job for the PR's head commit — the detail behind the `ciStatus` aggregate badge. */
  listChecks(owner: string, repo: string, headSha: string): Promise<CiCheck[]>;
}
