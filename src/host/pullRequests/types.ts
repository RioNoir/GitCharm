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
}

export type PullRequestStateFilter = 'open' | 'closed' | 'merged' | 'all';
export type PullRequestAuthorFilter = 'all' | 'mine';

export interface ListPullRequestsOptions {
  state: PullRequestStateFilter;
  author: PullRequestAuthorFilter;
  page: number;
}

export interface ListPullRequestsResult {
  items: PullRequestSummary[];
  hasMore: boolean;
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
}

export interface CiStatus {
  state: 'pending' | 'success' | 'failure' | 'unknown';
  url?: string;
  label?: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  description: string;
  merged: boolean;
  mergeableState?: 'mergeable' | 'conflicting' | 'unknown';
  headSha: string;
  baseSha: string;
  ciStatus?: CiStatus;
  capabilities: PullRequestCapabilities;
}

export interface PullRequestComment {
  id: string;
  authorName: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url?: string;
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

export interface PullRequestProvider {
  readonly kind: ForgeProvider;
  listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions): Promise<ListPullRequestsResult>;
  createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult>;
  hasCredentials(): Promise<boolean>;
  /** Current authenticated username, used to implement the "mine" author filter. Cached by the caller. */
  getCurrentUsername(): Promise<string | undefined>;

  /** Static per provider kind — no network call. */
  getCapabilities(): PullRequestCapabilities;
  /** The remote refspec that fetches this PR's head commit into a local ref, e.g. GitHub's "pull/{number}/head". */
  getCheckoutRefspec(number: number): string;
  getPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail>;
  listComments(owner: string, repo: string, number: number): Promise<PullRequestComment[]>;
  postComment(owner: string, repo: string, number: number, body: string): Promise<PostCommentResult>;
  listChangedFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]>;
  getFileDiff(owner: string, repo: string, number: number, file: ChangedFile, refs: FileDiffRefs): Promise<FileDiffContent>;
  listCommits(owner: string, repo: string, number: number): Promise<PullRequestCommit[]>;
  listCommitFiles(owner: string, repo: string, sha: string): Promise<ChangedFile[]>;
  mergePullRequest(owner: string, repo: string, number: number, strategy: MergeStrategy): Promise<ActionResult>;
  closePullRequest(owner: string, repo: string, number: number): Promise<ActionResult>;
  reopenPullRequest(owner: string, repo: string, number: number): Promise<ActionResult | UnsupportedResult>;
  submitReview(owner: string, repo: string, number: number, input: SubmitReviewInput): Promise<ActionResult | UnsupportedResult>;
}
