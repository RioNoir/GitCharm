import type {
  BranchInfo,
  CommitNode,
  FileDiff,
  MergeConflictFile,
  RepoMeta,
  WorkspaceStatus,
} from './git';
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
  files: Array<{ path: string; status: string }>;
  patchFile: string;    // relative path inside .gitstorm/shelf/
}

// ─── Stash (native git stash) ────────────────────────────────────────────────

export interface StashEntry {
  ref: string;      // e.g. "stash@{0}"
  index: number;    // 0, 1, 2...
  message: string;  // description
  date: string;     // ISO date
  branch: string;   // branch name
  files: Array<{ path: string; status: string }>;
}

// ─── Push (unpushed commits) ─────────────────────────────────────────────────

export interface UnpushedCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

// ─── Commit Panel: Host → WebView ────────────────────────────────────────────

export type HostToCommitMsg =
  | { type: 'COMMIT_STATUS_UPDATE'; repos: RepoMeta[]; status: WorkspaceStatus; iconTheme?: IconThemeData }
  | { type: 'COMMIT_DIFF_RESULT'; requestId: string; diff: FileDiff | null; error?: string }
  | { type: 'COMMIT_OP_RESULT'; requestId: string; ok: boolean; output?: string; error?: string }
  | { type: 'COMMIT_BRANCHES_UPDATE'; repoId: string; branches: BranchInfo[] }
  | { type: 'COMMIT_REMOTES_RESULT'; requestId: string; remotes: string[]; error?: string }
  | { type: 'COMMIT_GENERATE_MESSAGE_RESULT'; requestId: string; message?: string; error?: string }
  | { type: 'SHELVE_LIST_RESULT'; requestId: string; repoId: string; shelves: ShelveEntry[]; error?: string }
  | { type: 'SHELVE_DIFF_RESULT'; requestId: string; repoId: string; shelveId: string; filePath: string; diff: string; error?: string }
  | { type: 'SHELVE_OP_RESULT'; requestId: string; repoId: string; op: 'push' | 'apply' | 'drop'; ok: boolean; error?: string; hasConflicts?: boolean; conflictFiles?: string[] }
  | { type: 'STASH_LIST_RESULT'; requestId: string; repoId: string; stashes: StashEntry[]; error?: string }
  | { type: 'STASH_SHOW_RESULT'; requestId: string; diff: string; error?: string }
  | { type: 'STASH_OP_RESULT'; requestId: string; repoId: string; op: 'apply' | 'pop' | 'drop' | 'push'; ok: boolean; error?: string }
  | { type: 'PUSH_UNPUSHED_RESULT'; requestId: string; repoId: string; commits: UnpushedCommit[]; error?: string }
  | { type: 'COMMIT_SET_MESSAGE'; message: string };

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
  | { type: 'COMMIT_PUSH_REPO'; requestId: string; repoId: string; remote: string }
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
  | { type: 'SHELVE_LIST'; requestId: string; repoId: string }
  | { type: 'SHELVE_PUSH'; requestId: string; repoId: string; name: string; paths?: string[] }
  | { type: 'SHELVE_APPLY'; requestId: string; repoId: string; shelveId: string; paths?: string[] }
  | { type: 'SHELVE_DROP'; requestId: string; repoId: string; shelveId: string }
  | { type: 'SHELVE_GET_FILE_DIFF'; requestId: string; repoId: string; shelveId: string; filePath: string }
  | { type: 'SHELVE_OPEN_FILE_DIFF'; repoId: string; shelveId: string; filePath: string }
  | { type: 'STASH_LIST'; requestId: string; repoId: string }
  | { type: 'STASH_PUSH'; requestId: string; repoId: string; message: string; paths?: string[] }
  | { type: 'STASH_SHOW'; requestId: string; repoId: string; stashRef: string; filePath: string }
  | { type: 'STASH_APPLY'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_POP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_DROP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_OPEN_FILE_DIFF'; repoId: string; stashRef: string; filePath: string }
  | { type: 'PUSH_GET_UNPUSHED'; requestId: string; repoId: string }
  | { type: 'COMMIT_OPEN_ALL_CHANGES'; repoId: string }
  | { type: 'COMMIT_OPEN_LOG'; hash: string; repoId: string }
  | { type: 'COMMIT_UNDO_COMMIT'; requestId: string; repoId: string };

// ─── Git Log: Host → WebView ─────────────────────────────────────────────────

export type { IconThemeData };

export type HostToLogMsg =
  | { type: 'LOG_INIT_DATA'; repos: RepoMeta[]; branches: BranchInfo[]; iconTheme?: IconThemeData }
  | { type: 'LOG_COMMITS_BATCH'; commits: CommitNode[]; isLast: boolean; batchIndex: number }
  | { type: 'LOG_DIFF_RESULT'; requestId: string; files: Array<{ path: string; status: string }>; diff: FileDiff | null; error?: string }
  | { type: 'LOG_COMMIT_FILES'; requestId: string; files: Array<{ path: string; status: string; added?: number; removed?: number }>; error?: string }
  | { type: 'LOG_BRANCH_OP_RESULT'; requestId: string; ok: boolean; output?: string; error?: string }
  | { type: 'LOG_REFS_UPDATE'; repoId: string; branches: BranchInfo[] }
  | { type: 'LOG_REMOTES_RESULT'; requestId: string; remotes: string[]; error?: string }
  | { type: 'LOG_REFRESH' }
  | { type: 'LOG_MERGE_COMMITS_RESULT'; requestId: string; commits: MergeParentCommit[]; error?: string }
  | { type: 'LOG_FILE_OP_RESULT'; requestId: string; ok: boolean; error?: string }
  | { type: 'LOG_COMMIT_BRANCHES_RESULT'; requestId: string; branches: string[] }
  | { type: 'LOG_SCROLL_TO_COMMIT'; hash: string; repoId: string }
  | { type: 'LOG_COMMIT_BODY_RESULT'; requestId: string; hasBody: boolean };

// ─── Git Log: WebView → Host ─────────────────────────────────────────────────

export type LogToHostMsg =
  | { type: 'LOG_REQUEST_COMMITS'; repoIds: string[]; limit: number; skip: number; filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string }
  | { type: 'LOG_REQUEST_COMMIT_FILES'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REQUEST_FILE_DIFF'; requestId: string; repoId: string; hash: string; filePath: string }
  | { type: 'LOG_OPEN_FILE_DIFF'; repoId: string; hash: string; filePath: string; fileStatus?: string }
  | { type: 'LOG_OPEN_FILE'; repoId: string; filePath: string }
  | { type: 'LOG_REVERT_FILE'; requestId: string; repoId: string; hash: string; filePath: string; fileStatus?: string }
  | { type: 'LOG_CHECKOUT'; requestId: string; repoId: string; branchName: string; createNew?: boolean; from?: string }
  | { type: 'LOG_PULL'; requestId: string; repoId: string }
  | { type: 'LOG_PUSH'; requestId: string; repoId: string; remote?: string; force?: boolean }
  | { type: 'LOG_MERGE'; requestId: string; repoId: string; from: string }
  | { type: 'LOG_REBASE'; requestId: string; repoId: string; onto: string }
  | { type: 'LOG_COMPARE'; requestId: string; repoId: string; refA: string; refB: string }
  | { type: 'LOG_DELETE_BRANCH'; requestId: string; repoId: string; branchName: string; force: boolean }
  | { type: 'LOG_FETCH_ALL' }
  | { type: 'LOG_FETCH_REPO'; requestId: string; repoId: string }
  | { type: 'LOG_GET_REMOTES'; requestId: string; repoId: string }
  | { type: 'LOG_CHERRY_PICK'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REVERT_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_RESET_TO'; requestId: string; repoId: string; hash: string; mode: 'soft' | 'mixed' | 'hard' }
  | { type: 'LOG_CREATE_PATCH'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REQUEST_MERGE_COMMITS'; requestId: string; repoId: string; hash: string; parents: string[] }
  | { type: 'LOG_DROP_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_SQUASH_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string; message: string }
  | { type: 'LOG_CHERRY_PICK_MULTI'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_REVERT_COMMITS'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_DROP_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string }
  | { type: 'LOG_CREATE_PATCH_MULTI'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_UNDO_COMMIT'; requestId: string; repoId: string }
  | { type: 'LOG_EDIT_COMMIT_MESSAGE'; requestId: string; repoId: string; hash: string; currentMessage: string }
  | { type: 'LOG_NEW_BRANCH_FROM_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_CREATE_TAG'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REQUEST_COMMIT_BRANCHES'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_OPEN_COMMIT_BODY'; requestId: string; repoId: string; hash: string };

// ─── Merge Editor: Host → WebView ────────────────────────────────────────────

export type HostToMergeMsg =
  | { type: 'MERGE_FILE_LOADED'; file: MergeConflictFile }
  | { type: 'MERGE_SAVE_RESULT'; requestId: string; ok: boolean; error?: string };

// ─── Merge Editor: WebView → Host ────────────────────────────────────────────

export type MergeToHostMsg =
  | { type: 'MERGE_SAVE_FILE'; requestId: string; resolvedContent: string }
  | { type: 'MERGE_OPEN_FILE'; filePath: string };
