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
  /** True between beginReload() and the first batch of the reload arriving. */
  reloading: boolean;
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
  pendingScrollTarget: { hash: string; repoId: string } | null;
  fileLoadSeq: number;
  stashes: CommitNode[];

  hasWorkspaceFolder: boolean;
  aiEnabled: boolean;
  setRepos: (repos: RepoMeta[], hasWorkspaceFolder?: boolean, aiEnabled?: boolean) => void;
  setBranches: (branches: BranchInfo[]) => void;
  updateTags: (repoId: string, tags: TagInfo[]) => void;
  setIconTheme: (theme: IconThemeData | null) => void;
  appendCommits: (commits: CommitNode[], isLast: boolean) => void;
  setCommits: (commits: CommitNode[], hasMore: boolean) => void;
  resetCommits: () => void;
  beginReload: () => void;
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
  setPendingScrollTarget: (target: { hash: string; repoId: string } | null) => void;
  setStashes: (stashes: CommitNode[]) => void;
}

const defaultCommitFilters: CommitFilters = {
  text: '',
  author: '',
  branch: '',
  dateFrom: '',
  dateTo: '',
  repoId: null,
};

/**
 * Structural equality for two commit lists — everything a row renders from.
 * Bails on the first difference, so an unchanged refresh costs O(n) cheap
 * comparisons, and a changed one usually costs far less.
 */
function commitListsEqual(a: CommitNode[], b: CommitNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (
      x.hash !== y.hash ||
      x.repoId !== y.repoId ||
      x.message !== y.message ||
      x.committerDate !== y.committerDate ||
      x.authorName !== y.authorName ||
      x.authorEmail !== y.authorEmail ||
      !!x.unpushed !== !!y.unpushed ||
      !!x.incoming !== !!y.incoming ||
      !stringsEqual(x.parents, y.parents) ||
      !stringsEqual(x.refs, y.refs)
    ) return false;
  }
  return true;
}

function stringsEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const useLogStore = create<LogState>((set, get) => ({
  repos: [],
  initialized: false,
  hasWorkspaceFolder: true,
  aiEnabled: true,
  branches: [],
  tags: [],
  iconTheme: null,
  commits: [],
  stashes: [],
  hasMore: true,
  reloading: false,
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
  pendingScrollTarget: null,
  fileLoadSeq: 0,

  setRepos: (repos, hasWorkspaceFolder, aiEnabled) => set({ repos, initialized: true, ...(hasWorkspaceFolder !== undefined ? { hasWorkspaceFolder } : {}), ...(aiEnabled !== undefined ? { aiEnabled } : {}) }),
  setBranches: (branches) => set({ branches }),
  updateTags: (repoId, tags) => set(s => ({
    tags: [...s.tags.filter(t => t.repoId !== repoId), ...tags],
  })),
  setIconTheme: (iconTheme) => set({ iconTheme }),
  appendCommits: (commits, isLast) => set(s => {
    if (s.reloading) {
      // First batch of a reload replaces the list rather than appending, so the
      // view never blanks out (no skeleton) while fresh data is in flight.
      //
      // Fast path: most refreshes are triggered by repo events that didn't change
      // the graph at all (a fetch with nothing new, an index change, a file save).
      // Keeping the *same array reference* when nothing changed means the
      // commitsWithStashes memo, assignLanes, and the whole row tree all bail out
      // of re-rendering — the refresh costs one comparison and zero DOM work.
      const unchanged = commitListsEqual(s.commits, commits);
      const sel = s.selectedCommit;
      const selectionSurvives = unchanged || !sel || sel.isStash
        || commits.some(c => c.hash === sel.hash && c.repoId === sel.repoId);
      return {
        commits: unchanged ? s.commits : commits,
        reloading: false,
        loadingCommits: false,
        backgroundLoading: false,
        hasMore: !isLast,
        ...(selectionSurvives ? {} : { selectedCommit: null, selectedFile: null, commitFiles: [], currentDiff: null }),
      };
    }
    return {
      commits: [...s.commits, ...commits],
      loadingCommits: false,
      backgroundLoading: false,
      hasMore: !isLast,
    };
  }),
  setCommits: (commits, hasMore) => set({ commits, hasMore, loadingCommits: false, backgroundLoading: false }),
  resetCommits: () => set({ commits: [], stashes: [], hasMore: true, reloading: false, backgroundLoading: false, loadingCommits: true, selectedCommit: null, commitFiles: [], currentDiff: null }),
  // Warm refresh: keep the current commits (and selection) on screen until the
  // replacement batch lands. Only the thin progress bar indicates the reload.
  beginReload: () => set({ reloading: true, loadingCommits: true }),
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
  setPendingScrollTarget: (target) => set({ pendingScrollTarget: target }),
  setStashes: (stashes) => set(s => (
    // Same reasoning as the commit bail-out: stashes are merged into the row list,
    // so handing back a new array reference for an unchanged set of stashes would
    // re-trigger assignLanes on every refresh and undo that fast path.
    commitListsEqual(s.stashes, stashes) ? {} : { stashes }
  )),
}));
