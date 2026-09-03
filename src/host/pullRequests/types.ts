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
  authorName: string;
  authorAvatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  commentCount?: number;
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

export interface PullRequestProvider {
  readonly kind: ForgeProvider;
  listPullRequests(owner: string, repo: string): Promise<PullRequestSummary[]>;
  createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult>;
  hasCredentials(): Promise<boolean>;
}
