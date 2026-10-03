import type {
  BranchInfo,
  ChangelistData,
  CommitNode,
  FileDiff,
  RepoMeta,
  WorkspaceStatus,
} from './git';
import type { WorktreeEntry } from '../git/WorkspaceGitManager';
import type { IconThemeData } from '../utils/IconThemeService';
import type { ViewAndSortSettings, ViewAndSortUserPrefs } from './settings';
import type { PullRequestFilters, RepoPullRequests } from '../pullRequests/PullRequestManager';
import type {
  ChangedFile, CiCheck, CreatePullRequestInput, FileDiffContent, FileDiffRefs, ForgeProvider, MergeStrategy, PullRequestAuthorFilter,
  PullRequestComment, PullRequestCommit, PullRequestConnectionStatus, PullRequestDetail, PullRequestEvent, PullRequestLabel,
  PullRequestStateFilter, PullRequestSummary, PullRequestUser, ReviewEvent, SubmitReviewInput,
} from '../pullRequests/types';

export type {
  RepoPullRequests, CreatePullRequestInput, ForgeProvider, PullRequestConnectionStatus, PullRequestSummary,
  PullRequestFilters, PullRequestStateFilter, PullRequestAuthorFilter, PullRequestDetail, ChangedFile,
  MergeStrategy, SubmitReviewInput, PullRequestComment, PullRequestCommit, PullRequestEvent, FileDiffContent, FileDiffRefs, ReviewEvent,
  PullRequestUser, PullRequestLabel, CiCheck, CommitNode,
};

/** A Git Log compare filter: commits reachable from `target` but not from `base`. Empty strings mean the defaults (HEAD / the repo's default branch). */
export interface CompareRange {
  base: string;
  target: string;
}

/**
 * A repo's uncommitted changes for the Git Log's working-tree row. Statuses are the
 * log's single letters (M/A/D/R/C), plus U for untracked and ! for conflicted; a file
 * both staged and unstaged is listed once.
 */
export interface LogWorkingTreeStatus {
  repoId: string;
  files: Array<{ path: string; status: string; oldPath?: string; staged: boolean; unstaged: boolean }>;
}

/** Commits of one repo picked together in the Git Log. */
export interface CommitSelectionGroup {
  repoId: string;
  hashes: string[];
}

/**
 * How a multi-commit selection is summed up: `combined` folds the changes each selected commit
 * introduced, `snapshot` diffs the oldest selected commit against the newest one.
 */
export type CommitSelectionMode = 'combined' | 'snapshot';

/** A changed file of a multi-commit selection. */
export interface RangeFileEntry {
  repoId: string;
  path: string;
  status: string;
  added?: number;
  removed?: number;
  oldPath?: string;
  /** Combined mode: the revision before the first selected commit touching the file. */
  baseRef?: string;
  /** Combined mode: the last selected commit touching the file. */
  headRef?: string;
}

export interface MergeParentCommit {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  parentIndex: number; // which parent branch (1 = first non-main, 2 = second, ...)
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

// ─── Shelve (patch-based, PhpStorm-style) ────────────────────────────────────

export interface ShelveEntry {
  id: string;           // unique id = filename without extension
  name: string;         // user-provided description
  date: string;         // ISO date string
  files: Array<{ path: string; status: string; added?: number; removed?: number }>;
  patchFile: string;    // relative path inside .gitcharm/shelf/
  totalAdded?: number;
  totalRemoved?: number;
  changelistAssignments?: Array<{ path: string; changelistId: string; changelistName: string }>;
}

// ─── Stash (native git stash) ────────────────────────────────────────────────

export interface StashEntry {
  ref: string;         // e.g. "stash@{0}"
  hash: string;        // full hash of the stash commit
  index: number;       // 0, 1, 2...
  message: string;     // description
  date: string;        // ISO date
  branch: string;      // branch name
  parentHash: string;  // full hash of the commit the stash was created on (stash^1)
  files: Array<{ path: string; status: string; added?: number; removed?: number }>;
}

// ─── Push (unpushed commits) ─────────────────────────────────────────────────

export interface UnpushedCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

// ─── Commit Panel: Host → WebView ────────────────────────────────────────────

export type HostToCommitMsg =
  | { type: 'COMMIT_STATUS_UPDATE'; repos: RepoMeta[]; status: WorkspaceStatus; iconTheme?: IconThemeData; defaultCommitAction?: 'commit' | 'commitAndPush'; defaultSaveAction?: 'stash' | 'shelve'; hasWorkspaceFolder?: boolean; aiEnabled?: boolean; activeProfile?: { name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' } }
  | { type: 'COMMIT_PERSISTED_MESSAGE_RESULT'; message: string }
  | { type: 'COMMIT_DIFF_RESULT'; requestId: string; diff: FileDiff | null; error?: string }
  | { type: 'COMMIT_OP_RESULT'; requestId: string; ok: boolean; output?: string; error?: string; succeededRepoIds?: string[] }
  | { type: 'COMMIT_BRANCHES_UPDATE'; repoId: string; branches: BranchInfo[] }
  | { type: 'COMMIT_REMOTES_RESULT'; requestId: string; remotes: string[]; error?: string }
  | { type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT'; requestId: string; message: string; error?: string }
  | { type: 'COMMIT_GENERATE_MESSAGE_RESULT'; requestId: string; message?: string; error?: string }
  /** Text generated so far, while the AI is still writing — followed by exactly one COMMIT_GENERATE_MESSAGE_RESULT. */
  | { type: 'COMMIT_GENERATE_MESSAGE_PROGRESS'; requestId: string; message: string }
  | { type: 'SHELVE_LIST_RESULT'; requestId: string; repoId: string; shelves: ShelveEntry[]; error?: string }
  | { type: 'SHELVE_DIFF_RESULT'; requestId: string; repoId: string; shelveId: string; filePath: string; diff: string; error?: string }
  | { type: 'SHELVE_OP_RESULT'; requestId: string; repoId: string; op: 'push' | 'apply' | 'drop'; ok: boolean; error?: string; hasConflicts?: boolean; conflictFiles?: string[] }
  | { type: 'STASH_LIST_RESULT'; requestId: string; repoId: string; stashes: StashEntry[]; error?: string }
  | { type: 'STASH_SHOW_RESULT'; requestId: string; diff: string; error?: string }
  | { type: 'STASH_OP_RESULT'; requestId: string; repoId: string; op: 'apply' | 'pop' | 'drop' | 'push'; ok: boolean; error?: string }
  | { type: 'PUSH_UNPUSHED_RESULT'; requestId: string; repoId: string; commits: UnpushedCommit[]; error?: string }
  | { type: 'PUSH_SQUASH_RESULT'; requestId: string; ok: boolean; error?: string }
  | { type: 'PUSH_DROP_RESULT'; requestId: string; ok: boolean; error?: string }
  | { type: 'PUSH_REVERT_RESULT'; requestId: string; ok: boolean; error?: string }
  | { type: 'PUSH_EDIT_MSG_RESULT'; requestId: string; ok: boolean; error?: string }
  | { type: 'COMMIT_SET_MESSAGE'; message: string; ifEmpty?: boolean; ifEquals?: string }
  | { type: 'CHANGELISTS_UPDATE'; changelists: ChangelistData[]; viewMode: 'simplified' | 'changelists' | 'vscode' }
  | { type: 'SUBMODULE_OP_RESULT'; requestId: string; parentRepoId: string; submodulePath: string; op: 'init' | 'deinit' | 'update'; ok: boolean; error?: string }
  | { type: 'SUBMODULE_PUSH_RESULT'; requestId: string; repoId: string; ok: boolean; error?: string }
  | { type: 'SUBMODULE_PULL_RESULT'; requestId: string; repoId: string; ok: boolean; output?: string; error?: string }
  | { type: 'SUBMODULE_DETACHED_HEAD_WARNING'; repoId: string; headCommit: string }
  | { type: 'WORKTREE_LIST_RESULT'; repos: Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }> }
  | { type: 'WORKTREE_OP_RESULT'; requestId: string; repoId: string; op: 'create' | 'delete' | 'prune' | 'lock' | 'unlock'; ok: boolean; error?: string }
  | { type: 'PULLREQUEST_LIST_RESULT'; repos: RepoPullRequests[] }
  | { type: 'PULLREQUEST_LIST_START'; repoIds: string[] }
  | { type: 'PULLREQUEST_LIST_REPO_RESULT'; repo: RepoPullRequests }
  | { type: 'PULLREQUEST_LOAD_MORE_RESULT'; repoId: string; repo: RepoPullRequests | null }
  | { type: 'PULLREQUEST_INVALIDATED' }
  | { type: 'PULLREQUEST_CONNECTION_STATUS'; statuses: PullRequestConnectionStatus[] }
  | ({ type: 'COMMIT_VIEW_SORT_SETTINGS_UPDATE' } & ViewAndSortSettings)
  | { type: 'COMMIT_SWITCH_TAB'; tab: 'changes' | 'shelf' | 'stash' | 'worktree' | 'push' | 'pullrequests' }
  | { type: 'COMMIT_DESELECT_FILE'; filePath: string };

// ─── Commit Panel: WebView → Host ────────────────────────────────────────────

export type CommitToHostMsg =
  | { type: 'COMMIT_REQUEST_STATUS' }
  | { type: 'COMMIT_PERSIST_MESSAGE'; message: string }
  | { type: 'COMMIT_REQUEST_DIFF'; requestId: string; repoId: string; filePath: string; staged: boolean }
  | { type: 'COMMIT_STAGE_FILES'; requestId: string; repoId: string; paths: string[] }
  | { type: 'COMMIT_UNSTAGE_FILES'; requestId: string; repoId: string; paths: string[] }
  | { type: 'COMMIT_STAGE_ALL'; requestId: string; repoId: string }
  | { type: 'COMMIT_UNSTAGE_ALL'; requestId: string; repoId: string }
  | { type: 'COMMIT_DO_COMMIT'; requestId: string; repoId: string; message: string; amend: boolean }
  | { type: 'COMMIT_DO_COMMIT_PUSH'; requestId: string; repoId: string; message: string; amend: boolean }
  | { type: 'COMMIT_DO_COMMIT_MULTI'; requestId: string; repos: Array<{ repoId: string; message: string; amend: boolean; filesToStage: string[]; filesToUnstage: string[] }>; andPush: boolean }
  | { type: 'COMMIT_REBASE_ACTION'; requestId: string; repoId: string; action: 'continue' | 'abort' }
  | { type: 'COMMIT_PULL_ALL' }
  // rebase: omitted, the user picks merge or rebase, as in the branch menu's Pull…
  | { type: 'COMMIT_PULL_REPO'; requestId: string; repoId: string; rebase?: boolean }
  | { type: 'COMMIT_FETCH_REPO'; requestId: string; repoId: string }
  | { type: 'COMMIT_GET_REMOTES'; requestId: string; repoId: string }
  | { type: 'COMMIT_GET_LAST_COMMIT_MESSAGE'; requestId: string; repoId: string }
  | { type: 'OPEN_PROFILES_MENU' }
  | { type: 'COMMIT_PUSH_REPO'; requestId: string; repoId: string; remote: string; force?: boolean }
  | { type: 'COMMIT_SYNC_AND_PUSH_REPO'; requestId: string; repoId: string; rebase: boolean }
  | { type: 'COMMIT_SYNC_REPOS'; requestId: string; repoIds: string[] }
  | { type: 'COMMIT_DISCARD_FILE'; requestId: string; repoId: string; path: string }
  | { type: 'COMMIT_DISCARD_FILES'; requestId: string; files: Array<{ repoId: string; path: string }> }
  | { type: 'COMMIT_DISCARD_ALL'; requestId: string; repoId: string }
  | { type: 'COMMIT_OPEN_DIFF'; repoId: string; filePath: string; staged: boolean }
  | { type: 'COMMIT_SHOW_DIFF_TAB'; repoId: string; filePath: string }
  | { type: 'COMMIT_OPEN_FILE'; repoId: string; filePath: string }
  | { type: 'COMMIT_DELETE_FILE'; requestId: string; repoId: string; filePath: string }
  | { type: 'COMMIT_DELETE_FOLDER'; requestId: string; repoId: string; folderPath: string }
  | { type: 'COMMIT_ADD_TO_GITIGNORE'; repoId: string; entryPath: string }
  | { type: 'COMMIT_SHOW_BRANCH_MENU'; repoId?: string }
  | { type: 'COMMIT_OPEN_MERGE_EDITOR'; repoId: string; filePath: string }
  | { type: 'COMMIT_RESOLVE_CONFLICTS_AI'; repoId: string; filePath: string }
  | { type: 'COMMIT_GENERATE_MESSAGE'; requestId: string }
  | { type: 'COMMIT_SELECT_AI_MODEL' }
  | { type: 'COMMIT_OPEN_AI_SETTINGS' }
  | { type: 'SHELVE_LIST'; requestId: string; repoId: string }
  | { type: 'SHELVE_PUSH'; requestId: string; repoId: string; name: string; paths?: string[] }
  | { type: 'SHELVE_APPLY'; requestId: string; repoId: string; shelveId: string; paths?: string[] }
  | { type: 'SHELVE_DROP'; requestId: string; repoId: string; shelveId: string }
  | { type: 'SHELVE_RENAME'; requestId: string; repoId: string; shelveId: string; currentName: string }
  | { type: 'SHELVE_GET_FILE_DIFF'; requestId: string; repoId: string; shelveId: string; filePath: string }
  | { type: 'SHELVE_OPEN_FILE_DIFF'; repoId: string; shelveId: string; filePath: string }
  | { type: 'STASH_LIST'; requestId: string; repoId: string }
  | { type: 'STASH_PUSH'; requestId: string; repoId: string; message: string; paths?: string[] }
  | { type: 'STASH_SHOW'; requestId: string; repoId: string; stashRef: string; filePath: string }
  | { type: 'STASH_APPLY'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_POP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_DROP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_RENAME'; requestId: string; repoId: string; stashRef: string; currentMessage: string }
  | { type: 'STASH_OPEN_FILE_DIFF'; repoId: string; stashRef: string; filePath: string }
  | { type: 'PUSH_GET_UNPUSHED'; requestId: string; repoId: string }
  | { type: 'PUSH_SQUASH_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string; message: string; commits: { hash: string; shortHash: string; message: string }[] }
  | { type: 'PUSH_DROP_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string }
  | { type: 'PUSH_REVERT_COMMITS'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'PUSH_EDIT_COMMIT_MSG'; requestId: string; repoId: string; hash: string; currentMessage: string }
  | { type: 'PUSH_OPEN_DETAIL'; repoId: string; hash: string }
  | { type: 'PUSH_OPEN_COMMIT_CHANGES'; repoId: string; hash: string }
  | { type: 'PUSH_EXPLAIN_COMMIT'; repoId: string; hash: string }
  | { type: 'PUSH_VIEW_COMBINED_DIFF'; repoId: string; hashes: string[] }
  | { type: 'COMMIT_OPEN_ALL_CHANGES'; repoId: string; section?: 'staged' | 'unstaged' }
  | { type: 'COMMIT_OPEN_LOG'; hash: string; repoId: string }
  | { type: 'COMMIT_UNDO_COMMIT'; requestId: string; repoId: string }
  | { type: 'CHANGELISTS_CREATE'; name: string }
  | { type: 'CHANGELISTS_CREATE_PROMPT' }
  | { type: 'CHANGELISTS_RENAME'; id: string; name: string }
  | { type: 'CHANGELISTS_RENAME_PROMPT'; id: string; currentName: string }
  | { type: 'CHANGELISTS_DELETE'; id: string }
  | { type: 'CHANGELISTS_MOVE_FILES'; assignments: Array<{ repoId: string; path: string; changelistId: string }> }
  | { type: 'CHANGELISTS_MOVE_FILES_PROMPT'; files: Array<{ repoId: string; path: string }> }
  | { type: 'CHANGELISTS_SHELVE'; changelistId: string; requestId: string }
  | { type: 'CHANGELISTS_STASH'; changelistId: string; requestId: string }
  | ({ type: 'COMMIT_SET_VIEW_SORT_SETTINGS' } & Partial<ViewAndSortUserPrefs>)
  | { type: 'SUBMODULE_INIT'; requestId: string; parentRepoId: string; submodulePath: string }
  | { type: 'SUBMODULE_DEINIT'; requestId: string; parentRepoId: string; submodulePath: string; force?: boolean }
  | { type: 'SUBMODULE_UPDATE'; requestId: string; parentRepoId: string; submodulePath: string; recursive?: boolean }
  | { type: 'SUBMODULE_PUSH'; requestId: string; repoId: string }
  | { type: 'SUBMODULE_PULL'; requestId: string; repoId: string; rebase?: boolean }
  | { type: 'NOTIFY_ERROR'; message: string }
  | { type: 'NOTIFY_INFO'; message: string }
  | { type: 'COMMIT_REVEAL_IN_EXPLORER'; repoId: string; filePath: string }
  | { type: 'COMMIT_REVEAL_IN_OS'; repoId: string; filePath: string }
  | { type: 'COMMIT_SHOW_FILE_HISTORY'; repoId: string; filePath: string }
  | { type: 'COMMIT_COMPARE_FILE_WITH'; repoId: string; filePath: string }
  | { type: 'COMMIT_COMPARE_FOLDER_WITH'; repoId: string; folderPath: string }
  | { type: 'WORKTREE_REQUEST_LIST' }
  | { type: 'WORKTREE_CREATE_PROMPT'; repoId: string }
  | { type: 'WORKTREE_CREATE'; requestId: string; repoId: string; worktreePath: string; branch?: string; newBranch?: string; commitish?: string; noTrack?: boolean }
  | { type: 'WORKTREE_DELETE'; requestId: string; repoId: string; worktreePath: string; force?: boolean }
  | { type: 'WORKTREE_PRUNE'; requestId: string; repoId: string }
  | { type: 'WORKTREE_LOCK'; requestId: string; repoId: string; worktreePath: string; reason?: string }
  | { type: 'WORKTREE_UNLOCK'; requestId: string; repoId: string; worktreePath: string }
  | { type: 'WORKTREE_OPEN_IN_EXPLORER'; repoId: string; worktreePath: string }
  | { type: 'WORKTREE_OPEN_IN_NEW_WINDOW'; worktreePath: string }
  | { type: 'WORKTREE_OPEN_IN_OS'; worktreePath: string }
  | { type: 'WORKTREE_ADD_TO_WORKSPACE'; worktreePath: string }
  | { type: 'PULLREQUEST_REQUEST_LIST'; forceRefresh?: boolean }
  | { type: 'PULLREQUEST_REFRESH_REPO'; repoId: string }
  | { type: 'PULLREQUEST_LOAD_MORE'; repoId: string }
  | { type: 'PULLREQUEST_CREATE_PROMPT'; repoId: string }
  | { type: 'PULLREQUEST_CONNECT_PAT_PROMPT'; repoId: string }
  | { type: 'PULLREQUEST_OPEN_ACCOUNT_PICKER'; repoId: string }
  | { type: 'PULLREQUEST_DISCONNECT'; repoId: string }
  | { type: 'PULLREQUEST_SET_HOST_PROVIDER_OVERRIDE'; host: string; provider: ForgeProvider }
  | { type: 'PULLREQUEST_FILTERS_PROMPT'; repoId: string }
  | { type: 'PULLREQUEST_SEARCH_PROMPT'; repoId: string }
  | { type: 'PULLREQUEST_OPEN_IN_BROWSER'; url: string }
  | { type: 'PULLREQUEST_OPEN_DETAIL'; repoId: string; pr: PullRequestSummary }
  | { type: 'COMMIT_INIT_REPO' }
  | { type: 'COMMIT_OPEN_FOLDER' }
  | { type: 'COMMIT_CLONE_REPO' }
  | { type: 'COMMIT_HIDE_REPO'; repoId: string }
  | { type: 'COMMIT_UNHIDE_REPO'; repoId: string }
  | { type: 'COMMIT_MANAGE_HIDDEN_REPOS' }
  | { type: 'COMMIT_MANAGE_REPO'; repoId: string }
  | { type: 'COMMIT_VIEW_GIT_LOG'; repoId: string }
  | { type: 'COMMIT_REVEAL_REPO_IN_EXPLORER'; repoId: string }
  | { type: 'COMMIT_OPEN_REPO_IN_NEW_WINDOW'; repoId: string }
  | { type: 'COMMIT_REVEAL_REPO_IN_OS'; repoId: string };

// ─── Git Log: Host → WebView ─────────────────────────────────────────────────

export type { IconThemeData };

export interface TagInfo {
  name: string;
  hash: string;
  date: string;
  repoId: string;
}

/** Visibility of the Git Log filters bar and branch sidebar. */
export interface LogLayoutPrefs {
  filtersHidden: boolean;
  sidebarHidden: boolean;
}

/**
 * Where a Git Log is shown: a wide area (bottom panel, editor tab) or a tall, narrow
 * side bar. VS Code doesn't tell a view which container it is in, so the webview
 * infers it from its own shape.
 */
export type LogViewLocation = 'panel' | 'sideBar';

/** Global layout preferences, kept apart for each location. */
export type LogLayoutByLocation = Record<LogViewLocation, LogLayoutPrefs>;

export type HostToLogMsg =
  | { type: 'LOG_INIT_DATA'; repos: RepoMeta[]; branches: BranchInfo[]; iconTheme?: IconThemeData; hasWorkspaceFolder?: boolean; aiEnabled?: boolean; activeProfile?: { name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' }; layout?: LogLayoutByLocation }
  | { type: 'LOG_LAYOUT_PREFS'; layout: LogLayoutByLocation }
  | { type: 'LOG_CLEAR_FILTERS' }
  | { type: 'LOG_SET_COMPARE_MODE'; active: boolean }
  /** `limitReached`: the list stops at gitcharm.graphMaxCommits (`maxCommits`) though git has more. */
  | { type: 'LOG_COMMITS_BATCH'; commits: CommitNode[]; isLast: boolean; batchIndex: number; requestId?: string; limitReached?: boolean; maxCommits?: number }
  | { type: 'LOG_DIFF_RESULT'; requestId: string; files: Array<{ path: string; status: string }>; diff: FileDiff | null; error?: string }
  | { type: 'LOG_COMMIT_FILES'; requestId: string; files: Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }>; error?: string }
  /** `orderedHashes`: the selected hashes of each repo, oldest first. */
  | { type: 'LOG_RANGE_FILES_RESULT'; requestId: string; files: RangeFileEntry[]; orderedHashes: Record<string, string[]>; error?: string }
  | { type: 'LOG_BRANCH_OP_RESULT'; requestId: string; ok: boolean; output?: string; error?: string }
  | { type: 'LOG_REFS_UPDATE'; repoId: string; branches: BranchInfo[] }
  | { type: 'LOG_TAGS_UPDATE'; repoId: string; tags: TagInfo[] }
  | { type: 'LOG_COMMIT_TAGS_RESULT'; requestId: string; tags: string[] }
  | { type: 'LOG_REMOTES_RESULT'; requestId: string; remotes: string[]; error?: string }
  | { type: 'LOG_REFRESH' }
  | { type: 'LOG_MERGE_COMMITS_RESULT'; requestId: string; commits: MergeParentCommit[]; error?: string }
  | { type: 'LOG_FILE_OP_RESULT'; requestId: string; ok: boolean; error?: string }
  | { type: 'LOG_COMMIT_BRANCHES_RESULT'; requestId: string; branches: { local: string[]; remote: string[]; tags: string[] } }
  | { type: 'LOG_SCROLL_TO_COMMIT'; hash: string; repoId: string }
  | { type: 'LOG_COMMIT_BODY_RESULT'; requestId: string; hasBody: boolean }
  | { type: 'LOG_FILTER_BY_REPO'; repoId: string | null; branch?: string | null }
  | { type: 'LOG_STASHES_BATCH'; stashCommits: CommitNode[]; queriedRepoIds: string[] }
  /** Uncommitted changes of every repo in the log, replacing the previous report. Empty when the setting is off. */
  | { type: 'LOG_WORKING_TREE_STATUS'; repos: LogWorkingTreeStatus[] }
  | { type: 'LOG_UNDOCKED_CONFIG'; showCommit: boolean }
  | { type: 'LOG_DESELECT_FILE'; filePath: string };

// ─── Git Log: WebView → Host ─────────────────────────────────────────────────

export type LogToHostMsg =
  | { type: 'LOG_REQUEST_COMMITS'; repoIds: string[]; limit: number; skip: number; requestId?: string; filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; compare?: CompareRange }
  | { type: 'LOG_REQUEST_COMMIT_FILES'; requestId: string; repoId: string; hash: string; parents?: string[] }
  | { type: 'LOG_REQUEST_RANGE_FILES'; requestId: string; groups: CommitSelectionGroup[]; mode: CommitSelectionMode }
  | { type: 'LOG_REQUEST_FILE_DIFF'; requestId: string; repoId: string; hash: string; filePath: string }
  | { type: 'LOG_OPEN_FILE_DIFF'; repoId: string; hash: string; filePath: string; fileStatus?: string; oldPath?: string; parents?: string[]; combined?: boolean }
  /** With `baseRef`/`headRef` (combined mode) the diff spans exactly those; otherwise the oldest and newest of `hashes`. */
  | { type: 'LOG_OPEN_RANGE_FILE_DIFF'; repoId: string; hashes: string[]; filePath: string; fileStatus?: string; oldPath?: string; baseRef?: string; headRef?: string }
  | { type: 'LOG_OPEN_FILE'; repoId: string; filePath: string }
  | { type: 'LOG_REVERT_FILE'; requestId: string; repoId: string; hash: string; filePath: string; fileStatus?: string }
  | { type: 'LOG_CHERRY_PICK_FILE'; requestId: string; repoId: string; hash: string; filePath: string; oldPath?: string }
  | { type: 'LOG_CHECKOUT'; requestId: string; repoId: string; branchName: string; createNew?: boolean; from?: string }
  | { type: 'LOG_PULL'; requestId: string; repoId: string }
  | { type: 'LOG_PULL_BRANCH_PICK'; repoIds: string[]; branchName: string }
  | { type: 'LOG_PUSH'; requestId: string; repoId: string; remote?: string; force?: boolean }
  | { type: 'LOG_PUSH_BRANCH_PICK'; repoIds: string[]; branchName: string }
  | { type: 'LOG_MERGE'; requestId: string; repoId: string; from: string }
  | { type: 'LOG_REBASE'; requestId: string; repoId: string; onto: string }
  | { type: 'LOG_COMPARE'; requestId: string; repoId: string; refA: string; refB: string }
  | { type: 'LOG_DELETE_BRANCH'; requestId: string; repoId: string; branchName: string; force: boolean }
  | { type: 'LOG_DELETE_BRANCH_MULTI'; requestId: string; repoIds: string[]; branchName: string }
  | { type: 'LOG_RENAME_BRANCH_MULTI'; requestId: string; repoIds: string[]; oldName: string }
  | { type: 'LOG_NEW_BRANCH_FROM'; repoIds: string[]; fromBranch: string }
  | { type: 'LOG_FETCH_REPO'; requestId: string; repoId: string }
  | { type: 'LOG_GET_REMOTES'; requestId: string; repoId: string }
  | { type: 'LOG_CHERRY_PICK'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REVERT_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_RESET_TO'; requestId: string; repoId: string; hash: string; mode: 'soft' | 'mixed' | 'hard' }
  | { type: 'LOG_CREATE_PATCH'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REQUEST_MERGE_COMMITS'; requestId: string; repoId: string; hash: string; parents: string[] }
  | { type: 'LOG_DROP_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_SQUASH_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string; message: string; commits: { hash: string; shortHash: string; message: string }[] }
  | { type: 'LOG_CHERRY_PICK_MULTI'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_REVERT_COMMITS'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_DROP_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string }
  | { type: 'LOG_CREATE_PATCH_MULTI'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_UNDO_COMMIT'; requestId: string; repoId: string }
  | { type: 'LOG_EDIT_COMMIT_MESSAGE'; requestId: string; repoId: string; hash: string; currentMessage: string }
  | { type: 'LOG_NEW_BRANCH_FROM_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_CREATE_TAG'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_DELETE_TAG'; requestId: string; repoId: string; tagName: string }
  | { type: 'LOG_DELETE_TAG_MULTI'; requestId: string; repoIds: string[]; tagName: string }
  | { type: 'LOG_PUSH_TAG'; requestId: string; repoId: string; tagName: string; remote: string }
  | { type: 'LOG_CHECKOUT_TAG'; requestId: string; repoId: string; tagName: string }
  | { type: 'LOG_MERGE_TAG'; requestId: string; repoId: string; tagName: string }
  | { type: 'LOG_MERGE_TAG_MULTI'; requestId: string; repoIds: string[]; tagName: string }
  | { type: 'LOG_REQUEST_COMMIT_TAGS'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REQUEST_TAGS'; repoId: string }
  | { type: 'LOG_MANAGE_COMMIT_TAGS'; repoId: string; hash: string; currentBranch: string }
  | { type: 'LOG_RESET_TO_PICK'; repoId: string; hash: string }
  | { type: 'LOG_PUSH_PICK'; repoId: string }
  | { type: 'LOG_PUSH_TAG_PICK'; repoId: string; tagName: string }
  | { type: 'LOG_REQUEST_COMMIT_BRANCHES'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_OPEN_COMMIT_BODY'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_SHOW_BRANCH_OPTIONS'; repoId: string; branchName: string }
  | { type: 'LOG_CHECKOUT_COMMIT'; requestId: string; repoId: string; hash: string; branchName?: string }
  | { type: 'LOG_REVEAL_IN_EXPLORER'; repoId: string; filePath: string }
  | { type: 'LOG_REVEAL_IN_OS'; repoId: string; filePath: string }
  | { type: 'LOG_SHOW_FILE_HISTORY'; repoId: string; filePath: string }
  | { type: 'LOG_INIT_REPO' }
  | { type: 'LOG_OPEN_FOLDER' }
  | { type: 'LOG_CLONE_REPO' }
  | { type: 'LOG_OPEN_EXTENDED_DETAIL'; repoId: string; hash: string }
  | { type: 'LOG_OPEN_COMMIT_CHANGES'; repoId: string; hash: string }
  /** Diff of one uncommitted file, HEAD ↔ working tree. */
  | { type: 'LOG_OPEN_WORKING_TREE_FILE_DIFF'; repoId: string; filePath: string; fileStatus: string; oldPath?: string }
  /** Multi-file diff of every uncommitted change, HEAD ↔ working tree. */
  | { type: 'LOG_OPEN_WORKING_TREE_CHANGES'; repoId: string }
  | { type: 'LOG_SHOW_IN_COMMIT_PANEL' }
  | { type: 'LOG_OPEN_MAX_COMMITS_SETTING' }
  | { type: 'LOG_EXPLAIN_COMMIT'; repoId: string; hash: string }
  | { type: 'LOG_STASH_POP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'LOG_STASH_APPLY'; requestId: string; repoId: string; stashRef: string }
  | { type: 'LOG_STASH_DROP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'LOG_FILTERS_ACTIVE'; active: boolean }
  | { type: 'LOG_COMPARE_ACTIVE'; active: boolean }
  | { type: 'LOG_VIEW_LOCATION'; location: LogViewLocation }
  | { type: 'LOG_VIEW_COMBINED_DIFF'; groups: CommitSelectionGroup[] }
  | { type: 'LOG_COMPARE_COMMIT_WITH'; repoId: string; hash: string }
  | { type: 'LOG_COMPARE_FILE_WITH'; repoId: string; hash: string; filePath: string };

// ─── Create Pull Request: Host → WebView ─────────────────────────────────────

export type HostToPrCreateMsg =
  | { type: 'PRCREATE_INIT'; repoId: string; repoName: string; provider: ForgeProvider; aiEnabled: boolean; aiModelLabel: string }
  | { type: 'PRCREATE_BRANCHES_RESULT'; branches: BranchInfo[]; error?: string }
  | { type: 'PRCREATE_ICON_THEME'; iconTheme: IconThemeData }
  | { type: 'PRCREATE_BRANCH_PICKED'; requestId: string; role: 'source' | 'target'; branch?: string }
  | { type: 'PRCREATE_COMPARE_RESULT'; requestId: string; files: ChangedFile[]; commits: CommitNode[]; error?: string }
  | { type: 'PRCREATE_SUBMIT_RESULT'; ok: boolean; pr?: PullRequestSummary; error?: string }
  | { type: 'PRCREATE_MENTION_CANDIDATES'; users: PullRequestUser[] }
  | { type: 'PRCREATE_GENERATE_RESULT'; requestId: string; field: 'title' | 'description'; text?: string; error?: string }
  | { type: 'PRCREATE_GENERATE_PROGRESS'; requestId: string; field: 'title' | 'description'; text: string };

// ─── Create Pull Request: WebView → Host ─────────────────────────────────────

export type PrCreateToHostMsg =
  | { type: 'PRCREATE_REQUEST_BRANCHES' }
  | { type: 'PRCREATE_PICK_BRANCH'; requestId: string; role: 'source' | 'target'; current?: string }
  | { type: 'PRCREATE_REQUEST_COMPARE'; requestId: string; sourceBranch: string; targetBranch: string }
  | { type: 'PRCREATE_OPEN_FILE_DIFF'; sourceBranch: string; targetBranch: string; file: ChangedFile }
  | { type: 'PRCREATE_OPEN_NATIVE_COMPARE'; sourceBranch: string; targetBranch: string }
  | { type: 'PRCREATE_SUBMIT'; input: CreatePullRequestInput }
  | { type: 'PRCREATE_CANCEL' }
  | { type: 'PRCREATE_REQUEST_MENTION_CANDIDATES' }
  /** `field` is the one being generated; `title`/`description` carry what's currently typed, so the other one can steer it. */
  | { type: 'PRCREATE_GENERATE'; requestId: string; field: 'title' | 'description'; sourceBranch: string; targetBranch: string; title: string; description: string };

// ─── Pull Request Detail: Host → WebView ─────────────────────────────────────

export type HostToPrDetailMsg =
  | { type: 'PRDETAIL_INIT'; repoId: string; repoName: string; number: number; summary: PullRequestSummary; currentUsername?: string; aiEnabled: boolean; aiModelLabel: string; defaultMergeStrategy: MergeStrategy; defaultCheckoutAction: 'pr' | 'branch' }
  | { type: 'PRDETAIL_ICON_THEME'; iconTheme: IconThemeData }
  | { type: 'PRDETAIL_LOADED'; detail: PullRequestDetail }
  | { type: 'PRDETAIL_LOAD_ERROR'; error: string }
  | { type: 'PRDETAIL_COMMENTS_RESULT'; comments: PullRequestComment[]; error?: string }
  | { type: 'PRDETAIL_COMMENT_POSTED'; ok: boolean; comment?: PullRequestComment; error?: string }
  | { type: 'PRDETAIL_COMMENT_UPDATED'; ok: boolean; comment?: PullRequestComment; error?: string }
  | { type: 'PRDETAIL_COMMENT_DELETED'; ok: boolean; commentId?: string; error?: string }
  | { type: 'PRDETAIL_COMMENT_HIDDEN'; ok: boolean; commentId?: string; unsupported?: boolean; error?: string }
  | { type: 'PRDETAIL_COMMENT_UNHIDDEN'; ok: boolean; commentId?: string; unsupported?: boolean; error?: string }
  | { type: 'PRDETAIL_FILES_RESULT'; files: ChangedFile[]; error?: string }
  | { type: 'PRDETAIL_FILE_DIFF_ERROR'; path: string; error: string }
  | { type: 'PRDETAIL_COMMITS_RESULT'; commits: PullRequestCommit[]; error?: string }
  | { type: 'PRDETAIL_EVENTS_RESULT'; events: PullRequestEvent[]; error?: string }
  | { type: 'PRDETAIL_COMMIT_FILES_RESULT'; sha: string; files: ChangedFile[]; error?: string }
  | { type: 'PRDETAIL_MERGE_RESULT'; ok: boolean; error?: string }
  | { type: 'PRDETAIL_CLOSE_RESULT'; ok: boolean; error?: string }
  | { type: 'PRDETAIL_REOPEN_RESULT'; ok: boolean; unsupported?: boolean; error?: string }
  | { type: 'PRDETAIL_REVIEW_RESULT'; ok: boolean; unsupported?: boolean; error?: string }
  | { type: 'PRDETAIL_CHECKOUT_RESULT'; ok: boolean; branchName?: string; error?: string }
  | { type: 'PRDETAIL_UPDATE_RESULT'; ok: boolean; error?: string }
  | { type: 'PRDETAIL_UPDATE_REVIEWERS_RESULT'; ok: boolean; error?: string }
  | { type: 'PRDETAIL_UPDATE_ASSIGNEES_RESULT'; ok: boolean; unsupported?: boolean; error?: string }
  | { type: 'PRDETAIL_UPDATE_LABELS_RESULT'; ok: boolean; unsupported?: boolean; error?: string }
  | { type: 'PRDETAIL_CHECKS_RESULT'; checks: CiCheck[]; error?: string }
  | { type: 'PRDETAIL_MENTION_CANDIDATES'; users: PullRequestUser[] }
  | { type: 'PRDETAIL_DESCRIPTION_UPDATED'; ok: boolean; error?: string };

// ─── Pull Request Detail: WebView → Host ─────────────────────────────────────

export type PrDetailToHostMsg =
  | { type: 'PRDETAIL_REQUEST_DETAIL' }
  | { type: 'PRDETAIL_REQUEST_COMMENTS' }
  | { type: 'PRDETAIL_POST_COMMENT'; body: string }
  | { type: 'PRDETAIL_UPDATE_COMMENT'; commentId: string; body: string }
  | { type: 'PRDETAIL_DELETE_COMMENT'; commentId: string }
  | { type: 'PRDETAIL_HIDE_COMMENT'; commentId: string }
  | { type: 'PRDETAIL_UNHIDE_COMMENT'; commentId: string }
  | { type: 'PRDETAIL_REQUEST_FILES' }
  | { type: 'PRDETAIL_OPEN_FILE_DIFF'; file: ChangedFile }
  | { type: 'PRDETAIL_REQUEST_COMMITS' }
  | { type: 'PRDETAIL_REQUEST_EVENTS' }
  | { type: 'PRDETAIL_REQUEST_COMMIT_FILES'; sha: string }
  | { type: 'PRDETAIL_OPEN_COMMIT_FILE_DIFF'; file: ChangedFile; commitSha: string; parentSha?: string }
  | { type: 'PRDETAIL_OPEN_COMMIT_ALL_CHANGES'; commitSha: string; parentSha?: string }
  | { type: 'PRDETAIL_MERGE'; strategy: MergeStrategy }
  | { type: 'PRDETAIL_CLOSE' }
  | { type: 'PRDETAIL_REOPEN' }
  | { type: 'PRDETAIL_SUBMIT_REVIEW'; input: SubmitReviewInput }
  | { type: 'PRDETAIL_OPEN_IN_BROWSER' }
  | { type: 'PRDETAIL_VIEW_ALL_CHANGES' }
  | { type: 'PRDETAIL_CHECKOUT_PR' }
  | { type: 'PRDETAIL_CHECKOUT_BRANCH' }
  | { type: 'PRDETAIL_PICK_TITLE' }
  | { type: 'PRDETAIL_PICK_TARGET_BRANCH' }
  | { type: 'PRDETAIL_PICK_REVIEWERS' }
  | { type: 'PRDETAIL_PICK_ASSIGNEES' }
  | { type: 'PRDETAIL_PICK_LABELS' }
  | { type: 'PRDETAIL_REQUEST_CHECKS'; headSha: string }
  | { type: 'PRDETAIL_EXPLAIN' }
  | { type: 'PRDETAIL_REQUEST_MENTION_CANDIDATES' }
  | { type: 'PRDETAIL_UPDATE_DESCRIPTION'; description: string };

// ─── Commit Full Detail: Host → WebView ──────────────────────────────────────
// Reuses LogToHostMsg/HostToLogMsg for its file-tree/context-menu interactions
// (see src/webview/gitLog/components/CommitDetail.tsx) — this panel is a
// standalone single-commit view built around that same component, so only the
// init payload and the AI explain result/request are panel-specific.

export type HostToCommitFullDetailMsg =
  | {
      type: 'COMMITFULLDETAIL_INIT';
      repoId: string;
      repoName: string;
      commit: CommitNode;
      fullMessage: string;
      files: Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }>;
      iconTheme?: IconThemeData;
      aiEnabled: boolean;
      aiModelLabel: string;
      autoExplain: boolean;
      activeProfile?: { name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' };
    }
  | { type: 'COMMITFULLDETAIL_ICON_THEME'; iconTheme: IconThemeData };

// ─── AI Explain Detail: Host → WebView ───────────────────────────────────────
// A small standalone panel (opened beside the commit/PR detail panel it was triggered from) that just
// displays one AI-generated explanation — subject metadata + model label + markdown result/error. It never
// re-generates itself; the host re-posts AIEXPLAIN_RESULT into the same already-open panel when the user
// hits "Regenerate" on the originating panel's floating action button.

export type HostToAiExplainMsg =
  | { type: 'AIEXPLAIN_INIT'; subjectKind: 'commit' | 'pull-request'; subjectTitle: string; subjectSubtitle?: string; modelLabel: string }
  | { type: 'AIEXPLAIN_RESULT'; explanation?: string; error?: string }
  | { type: 'AIEXPLAIN_PROGRESS'; explanation: string };

// ─── Commit Full Detail: WebView → Host ──────────────────────────────────────

export type CommitFullDetailToHostMsg =
  | { type: 'COMMITFULLDETAIL_EXPLAIN'; repoId: string; hash: string };

// ─── Settings page ───────────────────────────────────────────────────────────
// GitCharm's own settings editor. The host reads the setting schema from package.json (descriptions already
// localized), the webview lays it out in categories. Edits go through vscode.workspace.getConfiguration, so
// the page and VS Code's Settings editor always show the same values.

export type SettingsTarget = 'user' | 'workspace';

/** One `gitcharm.*` setting as declared in package.json, key without the `gitcharm.` prefix. */
export interface SettingSchema {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'array' | 'object';
  /** Markdown (from markdownDescription) or plain text. */
  description: string;
  enum?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  /** `application` / `machine` settings can't be set per workspace. */
  scope?: string;
  multiline?: boolean;
}

export interface SettingValue {
  default: unknown;
  user?: unknown;
  workspace?: unknown;
}

export interface SettingsState {
  schema: SettingSchema[];
  values: Record<string, SettingValue>;
  hasWorkspace: boolean;
  /** Which AI providers have an API key in secure storage — never the keys themselves. */
  apiKeys: Record<'claude' | 'openai' | 'gemini', boolean>;
  repos: { name: string; color: string }[];
  defaultPrompts: Record<string, string>;
  aiModelLabel: string;
}

export interface AiModelOptionMsg { id: string; label: string; detail?: string }

/** A saved account of a cloud integration (GitHub: an account signed into VS Code). */
export interface IntegrationAccountMsg {
  /** For GitHub, `github:<VS Code account id>` — the same value a repository binding uses. */
  id: string;
  label: string;
  host: string;
  /** Workspace repositories assigned to this account. */
  repoNames: string[];
}

/** A workspace repository and the account it uses. */
export interface IntegrationRepoMsg {
  repoId: string;
  name: string;
  color: string;
  providerLabel: string;
  host: string;
  /** The integration (see types/integrations.ts) whose accounts this repository can use. */
  integrationId?: string;
  /** No forge recognized for the host: it needs an entry under Self-hosted forges. */
  detectionFailed: boolean;
  connected: boolean;
  /** Selected option value; '' when unassigned. */
  value?: string;
  options: { value: string; label: string }[];
}

export interface IntegrationsState {
  /** Accounts per integration id. */
  accounts: Record<string, IntegrationAccountMsg[]>;
  repos: IntegrationRepoMsg[];
}

export type HostToSettingsMsg =
  | { type: 'SETTINGS_STATE'; state: SettingsState }
  | { type: 'SETTINGS_NAVIGATE'; section: string }
  | { type: 'SETTINGS_MODELS'; requestId: string; models: AiModelOptionMsg[]; error?: string }
  | { type: 'SETTINGS_TEST_RESULT'; requestId: string; ok: boolean; message: string; elapsedMs: number }
  | { type: 'SETTINGS_INTEGRATIONS'; state: IntegrationsState }
  | { type: 'SETTINGS_INTEGRATION_ADDED'; requestId: string; ok: boolean; error?: string };

export type SettingsToHostMsg =
  | { type: 'SETTINGS_UPDATE'; key: string; value: unknown; target: SettingsTarget }
  | { type: 'SETTINGS_SET_API_KEY'; provider: 'claude' | 'openai' | 'gemini'; value: string }
  | { type: 'SETTINGS_LIST_MODELS'; requestId: string; provider: string }
  | { type: 'SETTINGS_TEST_AI'; requestId: string }
  | { type: 'SETTINGS_OPEN_NATIVE'; key?: string }
  | { type: 'SETTINGS_OPEN_JSON' }
  | { type: 'SETTINGS_COPY'; text: string }
  | { type: 'SETTINGS_OPEN_URL'; url: string }
  | { type: 'SETTINGS_INTEGRATIONS_GET' }
  | { type: 'SETTINGS_INTEGRATION_ADD'; requestId: string; integrationId: string; host?: string; label?: string; email?: string; token: string }
  | { type: 'SETTINGS_INTEGRATION_RENAME'; accountId: string; label: string }
  | { type: 'SETTINGS_INTEGRATION_REMOVE'; accountId: string }
  | { type: 'SETTINGS_INTEGRATION_GITHUB_ADD' }
  | { type: 'SETTINGS_INTEGRATION_ASSIGN'; repoId: string; value: string };

// ─── AI conflict resolution: live view ───────────────────────────────────────
// A side panel following an AI conflict resolution as it happens: each conflict with its two sides, the
// model's explanation and the resolved lines, streamed. `fileKey` identifies a file within one run.

export type HostToConflictAiMsg =
  | { type: 'CONFLICTAI_RESET'; modelLabel: string }
  | { type: 'CONFLICTAI_FILE'; fileKey: string; path: string }
  | {
      type: 'CONFLICTAI_HUNK_START'; fileKey: string; index: number; line: number;
      currentLabel: string; incomingLabel: string; current: string; incoming: string; base?: string;
    }
  | { type: 'CONFLICTAI_HUNK_PROGRESS'; fileKey: string; index: number; explanation: string; resolution: string }
  | { type: 'CONFLICTAI_HUNK_DONE'; fileKey: string; index: number; explanation: string; resolution: string }
  | { type: 'CONFLICTAI_HUNK_FAILED'; fileKey: string; index: number; error: string }
  | { type: 'CONFLICTAI_FILE_DONE'; fileKey: string; resolved: number; failed: number; staged: boolean; error?: string }
  | { type: 'CONFLICTAI_RUN_DONE'; cancelled: boolean };

export type ConflictAiToHostMsg =
  | { type: 'CONFLICTAI_OPEN_FILE'; path: string; line: number };
