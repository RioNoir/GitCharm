// Mirror of src/host/types/git.ts for use in webview (no Node.js imports)

export interface TagInfo {
  name: string;
  hash: string;
  date: string;
  repoId: string;
}

export interface MergeParentCommit {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorDate: string;
  parentIndex: number;
}

export interface RepoMeta {
  id: string;
  name: string;
  rootPath: string;
  color: string;
  isSubmodule?: boolean;
  parentRepoId?: string;
  submodulePath?: string;
  depth?: number;
}

export interface BranchInfo {
  repoId: string;
  name: string;
  fullName: string;
  isHead: boolean;
  isRemote: boolean;
  remoteName?: string;
  upstream?: string;
  aheadBehind?: { ahead: number; behind: number };
  lastCommitHash?: string;
  lastCommitDate?: string;
  detachedTag?: string;
  detachedHash?: string;
}

export interface CommitNode {
  hash: string;
  shortHash: string;
  repoId: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerDate: string;
  parents: string[];
  refs: string[];
  unpushed?: boolean;
  lane?: number;
  totalLanes?: number;
  graphLines?: GraphLine[];
}

export interface GraphLine {
  fromLane: number;
  toLane: number;
  type: 'straight' | 'merge-in' | 'fork-out' | 'pass-through';
  repoId: string;
  isStart?: boolean; // true when this lane opens here (no line arrives from above)
}

export type GitFileStatus =
  | 'modified' | 'added' | 'deleted' | 'renamed'
  | 'copied' | 'untracked' | 'conflicted' | 'submodule';

export interface FileStatus {
  repoId: string;
  path: string;
  absolutePath: string;
  oldPath?: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  repoId: string;
  oldPath: string;
  newPath: string;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
  originalContent?: string;
  modifiedContent?: string;
  language?: string;
}

export interface ConflictBlock {
  index: number;
  oursLabel: string;
  theirsLabel: string;
  oursLines: string[];
  baseLines: string[];
  theirsLines: string[];
  startLine: number;
  endLine: number;
}

export interface MergeConflictFile {
  absolutePath: string;
  relativePath: string;
  repoId: string;
  conflicts: ConflictBlock[];
  oursLabel: string;
  theirsLabel: string;
}

export interface WorkspaceStatus {
  repos: RepoStatus[];
}

export interface RepoStatus {
  repoId: string;
  branch: BranchInfo;
  stagedFiles: FileStatus[];
  unstagedFiles: FileStatus[];
  isDetachedHead: boolean;
  conflictCount: number;
}

// ─── Changelists ─────────────────────────────────────────────────────────────

export interface ChangelistData {
  id: string;
  name: string;
  color?: string;
  fileAssignments: Record<string, string[]>;
}

export const CHANGELIST_DEFAULT_ID = 'default';
export const CHANGELIST_UNVERSIONED_ID = 'unversioned';
