export interface RepoMeta {
  id: string;
  name: string;
  rootPath: string;
  color: string;
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
  detachedTag?: string;  // set when HEAD is detached on a tag
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
}

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted';

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
