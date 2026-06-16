import { create } from 'zustand';
import type { BranchInfo, CommitNode, FileDiff, RepoMeta, TagInfo } from '../../shared/types';
import type { IconThemeData } from '../../../host/types/messages';

export interface CommitFilters {
  text: string;
  author: string;
  branch: string;
  dateFrom: string;
  dateTo: string;
  repoId: string | null;
}

interface LogState {
  repos: RepoMeta[];
  initialized: boolean;
  branches: BranchInfo[];
  tags: TagInfo[];
  iconTheme: IconThemeData | null;
  commits: CommitNode[];
  hasMore: boolean;
  selectedCommit: CommitNode | null;
  selectedFile: { path: string; status: string } | null;
  commitFiles: Array<{ path: string; status: string; added?: number; removed?: number }>;
  currentDiff: FileDiff | null;
  loadingCommits: boolean;
  backgroundLoading: boolean;
  loadingFiles: boolean;
  loadingDiff: boolean;
  totalLanes: number;
  filterRepoId: string | null;
  branchFilter: string;
  commitFilters: CommitFilters;
  error: string | null;
  pendingScrollHash: string | null;
  fileLoadSeq: number;

  hasWorkspaceFolder: boolean;
  aiEnabled: boolean;
  setRepos: (repos: RepoMeta[], hasWorkspaceFolder?: boolean, aiEnabled?: boolean) => void;
  setBranches: (branches: BranchInfo[]) => void;
  updateTags: (repoId: string, tags: TagInfo[]) => void;
  setIconTheme: (theme: IconThemeData | null) => void;
  appendCommits: (commits: CommitNode[], isLast: boolean) => void;
  setCommits: (commits: CommitNode[], hasMore: boolean) => void;
  resetCommits: () => void;
  selectCommit: (commit: CommitNode | null) => void;
  setCommitFiles: (files: Array<{ path: string; status: string; added?: number; removed?: number }>) => void;
  selectFile: (file: { path: string; status: string } | null) => void;
  setDiff: (diff: FileDiff | null) => void;
  setLoadingCommits: (v: boolean) => void;
  setBackgroundLoading: (v: boolean) => void;
  setLoadingFiles: (v: boolean) => void;
  setLoadingDiff: (v: boolean) => void;
  setFilterRepoId: (id: string | null) => void;
  setBranchFilter: (filter: string) => void;
  setCommitFilters: (filters: Partial<CommitFilters>) => void;
  updateBranches: (repoId: string, branches: BranchInfo[]) => void;
  setError: (err: string | null) => void;
  setPendingScrollHash: (hash: string | null) => void;
}

const defaultCommitFilters: CommitFilters = {
  text: '',
  author: '',
  branch: '',
  dateFrom: '',
  dateTo: '',
  repoId: null,
};

export const useLogStore = create<LogState>((set, get) => ({
  repos: [],
  initialized: false,
  hasWorkspaceFolder: true,
  aiEnabled: true,
  branches: [],
  tags: [],
  iconTheme: null,
  commits: [],
  hasMore: true,
  selectedCommit: null,
  selectedFile: null,
  commitFiles: [],
  currentDiff: null,
  loadingCommits: false,
  backgroundLoading: false,
  loadingFiles: false,
  loadingDiff: false,
  totalLanes: 1,
  filterRepoId: null,
  branchFilter: '',
  commitFilters: { ...defaultCommitFilters },
  error: null,
  pendingScrollHash: null,
  fileLoadSeq: 0,

  setRepos: (repos, hasWorkspaceFolder, aiEnabled) => set({ repos, initialized: true, ...(hasWorkspaceFolder !== undefined ? { hasWorkspaceFolder } : {}), ...(aiEnabled !== undefined ? { aiEnabled } : {}) }),
  setBranches: (branches) => set({ branches }),
  updateTags: (repoId, tags) => set(s => ({
    tags: [...s.tags.filter(t => t.repoId !== repoId), ...tags],
  })),
  setIconTheme: (iconTheme) => set({ iconTheme }),
  appendCommits: (commits, isLast) => set(s => ({
    commits: [...s.commits, ...commits],
    loadingCommits: false,
    backgroundLoading: false,
    hasMore: !isLast,
  })),
  setCommits: (commits, hasMore) => set({ commits, hasMore, loadingCommits: false, backgroundLoading: false }),
  resetCommits: () => set({ commits: [], hasMore: true, backgroundLoading: false, loadingCommits: true, selectedCommit: null, commitFiles: [], currentDiff: null }),
  selectCommit: (commit) => set(s => ({ selectedCommit: commit, commitFiles: [], currentDiff: null, selectedFile: null, fileLoadSeq: s.fileLoadSeq + 1 })),
  setCommitFiles: (files) => set({ commitFiles: files, loadingFiles: false }),
  selectFile: (file) => set({ selectedFile: file }),
  setDiff: (diff) => set({ currentDiff: diff, loadingDiff: false }),
  setLoadingCommits: (v) => set({ loadingCommits: v }),
  setBackgroundLoading: (v) => set({ backgroundLoading: v }),
  setLoadingFiles: (v) => set({ loadingFiles: v }),
  setLoadingDiff: (v) => set({ loadingDiff: v }),
  setFilterRepoId: (id) => set({ filterRepoId: id }),
  setBranchFilter: (filter) => set({ branchFilter: filter }),
  setCommitFilters: (filters) => set(s => ({ commitFilters: { ...s.commitFilters, ...filters } })),
  updateBranches: (repoId, branches) => set(s => ({
    branches: [...s.branches.filter(b => b.repoId !== repoId), ...branches],
  })),
  setError: (err) => set({ error: err }),
  setPendingScrollHash: (hash) => set({ pendingScrollHash: hash }),
}));
