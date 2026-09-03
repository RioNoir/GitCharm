// Webview-side message type aliases (mirrors src/host/types/messages.ts)
// These are re-exported for convenience — Vite bundles them with type erasure.
export type { HostToCommitMsg, CommitToHostMsg, HostToLogMsg, LogToHostMsg, HostToMergeMsg, MergeToHostMsg, ShelveEntry, StashEntry, UnpushedCommit, RepoPullRequests, CreatePullRequestInput, ForgeProvider, PullRequestConnectionStatus, PullRequestSummary } from '../../host/types/messages';
export type { WorktreeEntry } from '../../host/git/WorkspaceGitManager';

