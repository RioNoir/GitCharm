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
  loadingFiles: boolean;
  loadingDiff: boolean;
  totalLanes: number;
  filterRepoId: string | null;
  branchFilter: string;
  commitFilters: CommitFilters;
  error: string | null;
  pendingScrollHash: string | null;
  fileLoadSeq: number;

  setRepos: (repos: RepoMeta[]) => void;
  setBranches: (branches: BranchInfo[]) => void;
  updateTags: (repoId: string, tags: TagInfo[]) => void;
  setIconTheme: (theme: IconThemeData | null) => void;
  appendCommits: (commits: CommitNode[], isLast: boolean) => void;
  resetCommits: () => void;
  selectCommit: (commit: CommitNode | null) => void;
  setCommitFiles: (files: Array<{ path: string; status: string; added?: number; removed?: number }>) => void;
  selectFile: (file: { path: string; status: string } | null) => void;
  setDiff: (diff: FileDiff | null) => void;
  setLoadingCommits: (v: boolean) => void;
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
  loadingFiles: false,
  loadingDiff: false,
  totalLanes: 1,
  filterRepoId: null,
  branchFilter: '',
  commitFilters: { ...defaultCommitFilters },
  error: null,
  pendingScrollHash: null,
  fileLoadSeq: 0,

  setRepos: (repos) => set({ repos }),
  setBranches: (branches) => set({ branches }),
  updateTags: (repoId, tags) => set(s => ({
    tags: [...s.tags.filter(t => t.repoId !== repoId), ...tags],
  })),
  setIconTheme: (iconTheme) => set({ iconTheme }),
  appendCommits: (commits, isLast) => set(s => ({
    commits: [...s.commits, ...commits],
    loadingCommits: false,
    hasMore: !isLast,
  })),
  resetCommits: () => set({ commits: [], hasMore: true, selectedCommit: null, commitFiles: [], currentDiff: null }),
  selectCommit: (commit) => set(s => ({ selectedCommit: commit, commitFiles: [], currentDiff: null, selectedFile: null, fileLoadSeq: s.fileLoadSeq + 1 })),
  setCommitFiles: (files) => set({ commitFiles: files, loadingFiles: false }),
  selectFile: (file) => set({ selectedFile: file }),
  setDiff: (diff) => set({ currentDiff: diff, loadingDiff: false }),
  setLoadingCommits: (v) => set({ loadingCommits: v }),
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
