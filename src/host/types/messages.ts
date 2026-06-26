import type {
  BranchInfo,
  ChangelistData,
  CommitNode,
  FileDiff,
  MergeConflictFile,
  RepoMeta,
  WorkspaceStatus,
} from './git';
import type { WorktreeEntry } from '../git/WorkspaceGitManager';
import type { IconThemeData } from '../utils/IconThemeService';

export interface MergeParentCommit {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorDate: string;
  parentIndex: number; // which parent branch (1 = first non-main, 2 = second, ...)
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
  date: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

// ─── Commit Panel: Host → WebView ────────────────────────────────────────────

export type HostToCommitMsg =
  | { type: 'COMMIT_STATUS_UPDATE'; repos: RepoMeta[]; status: WorkspaceStatus; iconTheme?: IconThemeData; fileViewMode?: 'flat' | 'tree'; defaultCommitAction?: 'commit' | 'commitAndPush'; defaultSaveAction?: 'stash' | 'shelve'; hasWorkspaceFolder?: boolean; aiEnabled?: boolean; activeProfile?: { name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' } }
  | { type: 'COMMIT_DIFF_RESULT'; requestId: string; diff: FileDiff | null; error?: string }
  | { type: 'COMMIT_OP_RESULT'; requestId: string; ok: boolean; output?: string; error?: string }
  | { type: 'COMMIT_BRANCHES_UPDATE'; repoId: string; branches: BranchInfo[] }
  | { type: 'COMMIT_REMOTES_RESULT'; requestId: string; remotes: string[]; error?: string }
  | { type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT'; requestId: string; message: string; error?: string }
  | { type: 'COMMIT_GENERATE_MESSAGE_RESULT'; requestId: string; message?: string; error?: string }
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
  | { type: 'COMMIT_SET_MESSAGE'; message: string }
  | { type: 'CHANGELISTS_UPDATE'; changelists: ChangelistData[]; viewMode: 'simplified' | 'changelists' | 'vscode' }
  | { type: 'SUBMODULE_OP_RESULT'; requestId: string; parentRepoId: string; submodulePath: string; op: 'init' | 'deinit' | 'update'; ok: boolean; error?: string }
  | { type: 'SUBMODULE_PUSH_RESULT'; requestId: string; repoId: string; ok: boolean; error?: string }
  | { type: 'SUBMODULE_PULL_RESULT'; requestId: string; repoId: string; ok: boolean; output?: string; error?: string }
  | { type: 'SUBMODULE_DETACHED_HEAD_WARNING'; repoId: string; headCommit: string }
  | { type: 'WORKTREE_LIST_RESULT'; repos: Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }> }
  | { type: 'WORKTREE_OP_RESULT'; requestId: string; repoId: string; op: 'create' | 'delete' | 'prune' | 'lock' | 'unlock'; ok: boolean; error?: string }
  | { type: 'COMMIT_HIDDEN_REPOS_UPDATE'; hiddenRepoIds: string[] }
  | { type: 'COMMIT_SWITCH_TAB'; tab: 'changes' | 'shelf' | 'stash' | 'worktree' | 'push' }
  | { type: 'COMMIT_DESELECT_FILE'; filePath: string };

// ─── Commit Panel: WebView → Host ────────────────────────────────────────────

export type CommitToHostMsg =
  | { type: 'COMMIT_REQUEST_STATUS' }
  | { type: 'COMMIT_REQUEST_DIFF'; requestId: string; repoId: string; filePath: string; staged: boolean }
  | { type: 'COMMIT_STAGE_FILES'; requestId: string; repoId: string; paths: string[] }
  | { type: 'COMMIT_UNSTAGE_FILES'; requestId: string; repoId: string; paths: string[] }
  | { type: 'COMMIT_STAGE_ALL'; requestId: string; repoId: string }
  | { type: 'COMMIT_UNSTAGE_ALL'; requestId: string; repoId: string }
  | { type: 'COMMIT_DO_COMMIT'; requestId: string; repoId: string; message: string; amend: boolean }
  | { type: 'COMMIT_DO_COMMIT_PUSH'; requestId: string; repoId: string; message: string; amend: boolean }
  | { type: 'COMMIT_DO_COMMIT_MULTI'; requestId: string; repos: Array<{ repoId: string; message: string; amend: boolean; filesToStage: string[]; filesToUnstage: string[] }>; andPush: boolean }
  | { type: 'COMMIT_PULL_ALL' }
  | { type: 'COMMIT_PULL_REPO'; requestId: string; repoId: string }
  | { type: 'COMMIT_GET_REMOTES'; requestId: string; repoId: string }
  | { type: 'COMMIT_GET_LAST_COMMIT_MESSAGE'; requestId: string; repoId: string }
  | { type: 'OPEN_PROFILES_MENU' }
  | { type: 'COMMIT_PUSH_REPO'; requestId: string; repoId: string; remote: string; force?: boolean }
  | { type: 'COMMIT_SYNC_AND_PUSH_REPO'; requestId: string; repoId: string; rebase: boolean }
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
  | { type: 'COMMIT_SET_FILE_VIEW_MODE'; mode: 'flat' | 'tree' }
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

export type HostToLogMsg =
  | { type: 'LOG_INIT_DATA'; repos: RepoMeta[]; branches: BranchInfo[]; iconTheme?: IconThemeData; hasWorkspaceFolder?: boolean; aiEnabled?: boolean }
  | { type: 'LOG_COMMITS_BATCH'; commits: CommitNode[]; isLast: boolean; batchIndex: number; requestId?: string }
  | { type: 'LOG_DIFF_RESULT'; requestId: string; files: Array<{ path: string; status: string }>; diff: FileDiff | null; error?: string }
  | { type: 'LOG_COMMIT_FILES'; requestId: string; files: Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }>; error?: string }
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
  | { type: 'LOG_STASHES_BATCH'; stashCommits: CommitNode[] }
  | { type: 'LOG_UNDOCKED_CONFIG'; showCommit: boolean }
  | { type: 'LOG_DESELECT_FILE'; filePath: string };

// ─── Git Log: WebView → Host ─────────────────────────────────────────────────

export type LogToHostMsg =
  | { type: 'LOG_REQUEST_COMMITS'; repoIds: string[]; limit: number; skip: number; requestId?: string; filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string }
  | { type: 'LOG_REQUEST_COMMIT_FILES'; requestId: string; repoId: string; hash: string; parents?: string[] }
  | { type: 'LOG_REQUEST_FILE_DIFF'; requestId: string; repoId: string; hash: string; filePath: string }
  | { type: 'LOG_OPEN_FILE_DIFF'; repoId: string; hash: string; filePath: string; fileStatus?: string; oldPath?: string; parents?: string[]; combined?: boolean }
  | { type: 'LOG_OPEN_FILE'; repoId: string; filePath: string }
  | { type: 'LOG_REVERT_FILE'; requestId: string; repoId: string; hash: string; filePath: string; fileStatus?: string }
  | { type: 'LOG_CHECKOUT'; requestId: string; repoId: string; branchName: string; createNew?: boolean; from?: string }
  | { type: 'LOG_PULL'; requestId: string; repoId: string }
  | { type: 'LOG_PUSH'; requestId: string; repoId: string; remote?: string; force?: boolean }
  | { type: 'LOG_MERGE'; requestId: string; repoId: string; from: string }
  | { type: 'LOG_REBASE'; requestId: string; repoId: string; onto: string }
  | { type: 'LOG_COMPARE'; requestId: string; repoId: string; refA: string; refB: string }
  | { type: 'LOG_DELETE_BRANCH'; requestId: string; repoId: string; branchName: string; force: boolean }
  | { type: 'LOG_DELETE_BRANCH_MULTI'; requestId: string; repoIds: string[]; branchName: string }
  | { type: 'LOG_FETCH_ALL' }
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
  | { type: 'LOG_EXPLAIN_COMMIT'; repoId: string; hash: string }
  | { type: 'LOG_STASH_POP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'LOG_STASH_APPLY'; requestId: string; repoId: string; stashRef: string }
  | { type: 'LOG_STASH_DROP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'LOG_UNDOCK'; target: 'editorTab' | 'newWindow' | 'pick' }
  | { type: 'LOG_VIEW_COMBINED_DIFF'; repoId: string; hashes: string[] }
  | { type: 'LOG_COMPARE_COMMIT_WITH'; repoId: string; hash: string };

// ─── Merge Editor: Host → WebView ────────────────────────────────────────────

export type HostToMergeMsg =
  | { type: 'MERGE_FILE_LOADED'; file: MergeConflictFile }
  | { type: 'MERGE_SAVE_RESULT'; requestId: string; ok: boolean; error?: string };

// ─── Merge Editor: WebView → Host ────────────────────────────────────────────

export type MergeToHostMsg =
  | { type: 'MERGE_SAVE_FILE'; requestId: string; resolvedContent: string }
  | { type: 'MERGE_OPEN_FILE'; filePath: string };
