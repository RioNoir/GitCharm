import { create } from 'zustand';
import type { ChangelistData, FileDiff, FileStatus, RepoMeta, RepoStatus, WorkspaceStatus } from '../../shared/types';
import type { IconThemeData } from '../../../host/types/messages';

export type ViewMode = 'flat' | 'tree';

// fileSelections[repoId] = Set of file paths the user has checked
export type FileSelections = Record<string, Set<string>>;

export interface CommitState {
  status: WorkspaceStatus | null;
  repoMetas: RepoMeta[];
  iconTheme: IconThemeData | null;
  repoSelections: Record<string, boolean>;
  fileSelections: FileSelections;
  seenFiles: Record<string, Set<string>>;
  // collapsed state for repo headers and tree dirs (key = repoId or dirPath)
  collapsedKeys: Set<string>;
  selectedFile: { repoId: string; path: string } | null;
  currentDiff: FileDiff | null;
  loadingDiff: boolean;
  commitMessage: string;
  amendFlags: Record<string, boolean>;
  viewMode: ViewMode;
  shelveViewMode: ViewMode;
  shelveCollapsedKeys: Set<string>;
  loading: boolean;
  error: string | null;
  changelists: ChangelistData[];
  changesViewMode: 'simplified' | 'changelists' | 'vscode';
  defaultCommitAction: 'commit' | 'commitAndPush';
  hasWorkspaceFolder: boolean;

  setStatus: (repos: RepoMeta[], status: WorkspaceStatus, iconTheme?: IconThemeData | null, fileViewMode?: 'flat' | 'tree', defaultCommitAction?: 'commit' | 'commitAndPush', hasWorkspaceFolder?: boolean) => void;
  setRepoSelection: (repoId: string, selected: boolean) => void;
  toggleFileSelection: (repoId: string, path: string) => void;
  setFileSelections: (repoId: string, paths: string[], selected: boolean) => void;
  isFileSelected: (repoId: string, path: string) => boolean;
  getSelectedFilesForRepo: (repoId: string) => string[];
  selectFile: (repoId: string, path: string) => void;
  setDiff: (diff: FileDiff | null) => void;
  setLoadingDiff: (v: boolean) => void;
  setCommitMessage: (msg: string) => void;
  setAmend: (repoId: string, v: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  setShelveViewMode: (mode: ViewMode) => void;
  isShelveCollapsed: (key: string) => boolean;
  toggleShelveCollapsed: (key: string) => void;
  shelveExpandAll: (shelveIds: string[], allDirPaths: string[]) => void;
  shelveCollapseAll: (shelveIds: string[], allDirPaths: string[]) => void;
  setLoading: (v: boolean) => void;
  setError: (err: string | null) => void;
  setChangelists: (changelists: ChangelistData[], viewMode: 'simplified' | 'changelists' | 'vscode') => void;
  getRepoStatus: (repoId: string) => RepoStatus | undefined;
  getSelectedRepos: () => string[];
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
}

function allFilePaths(repoStatus: RepoStatus): string[] {
  const paths = new Set<string>();
  for (const f of repoStatus.stagedFiles) paths.add(f.path);
  for (const f of repoStatus.unstagedFiles) paths.add(f.path);
  return Array.from(paths);
}

export const useCommitStore = create<CommitState>((set, get) => ({
  status: null,
  repoMetas: [],
  iconTheme: null,
  repoSelections: {},
  fileSelections: {},
  seenFiles: {},
  collapsedKeys: new Set(),
  selectedFile: null,
  currentDiff: null,
  loadingDiff: false,
  commitMessage: '',
  amendFlags: {},
  viewMode: 'tree',
  shelveViewMode: 'tree',
  shelveCollapsedKeys: new Set(),
  loading: false,
  error: null,
  changelists: [],
  changesViewMode: 'simplified',
  defaultCommitAction: 'commit',
  hasWorkspaceFolder: true,

  setStatus: (repoMetas, status, iconTheme, fileViewMode, defaultCommitAction, hasWorkspaceFolder) => {
    const prev = get().repoSelections;
    const prevFiles = get().fileSelections;
    const prevSeen = get().seenFiles;
    const prevCollapsed = get().collapsedKeys;
    const { changelists, changesViewMode } = get();
    const repoSelections: Record<string, boolean> = {};
    const fileSelections: FileSelections = {};
    const seenFiles: Record<string, Set<string>> = {};
    const collapsedKeys = new Set(prevCollapsed);

    // Build a lookup of which changelist each file belongs to (only in changelists mode)
    const fileChangelistId = new Map<string, string>(); // `${repoId}::${path}` → changelistId
    if (changesViewMode === 'changelists') {
      for (const cl of changelists) {
        for (const [repoId, paths] of Object.entries(cl.fileAssignments)) {
          for (const p of paths) fileChangelistId.set(`${repoId}::${p}`, cl.id);
        }
      }
    }

    for (const r of status.repos) {
      repoSelections[r.repoId] = prev[r.repoId] ?? true;
      const currentPaths = allFilePaths(r);
      const untrackedPaths = new Set(r.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path));
      const prevSelectedSet = prevFiles[r.repoId];
      const prevSeenSet = prevSeen[r.repoId];
      const next = new Set<string>();
      for (const p of currentPaths) {
        const isFirstLoad = !prevSeenSet;
        const isNew = !isFirstLoad && !prevSeenSet.has(p);
        if (isFirstLoad) {
          // Initial load: select everything except untracked in changelists mode
          if (changesViewMode === 'changelists' && untrackedPaths.has(p)) continue;
          next.add(p);
        } else if (isNew) {
          // File appeared after initial load — never auto-select
        } else if (prevSelectedSet?.has(p)) {
          next.add(p);
        }
      }
      fileSelections[r.repoId] = next;
      seenFiles[r.repoId] = new Set(currentPaths);

      // Auto-collapse repos with no changes; auto-expand when changes appear
      if (!(r.repoId in prev)) {
        if (currentPaths.length === 0) collapsedKeys.add(r.repoId);
      } else {
        const hadFiles = (prevFiles[r.repoId]?.size ?? 0) > 0 || prevCollapsed.has(r.repoId) === false;
        const wasCollapsed = prevCollapsed.has(r.repoId);
        if (wasCollapsed && currentPaths.length > 0 && (prevFiles[r.repoId]?.size ?? 0) === 0) {
          collapsedKeys.delete(r.repoId);
        }
      }
    }
    set({ repoMetas, status, repoSelections, fileSelections, seenFiles, collapsedKeys, ...(iconTheme !== undefined ? { iconTheme } : {}), ...(fileViewMode !== undefined ? { viewMode: fileViewMode } : {}), ...(defaultCommitAction !== undefined ? { defaultCommitAction } : {}), ...(hasWorkspaceFolder !== undefined ? { hasWorkspaceFolder } : {}) });
  },

  setRepoSelection: (repoId, selected) =>
    set(s => ({ repoSelections: { ...s.repoSelections, [repoId]: selected } })),

  toggleFileSelection: (repoId, path) =>
    set(s => {
      const prev = new Set(s.fileSelections[repoId] ?? []);
      if (prev.has(path)) prev.delete(path);
      else prev.add(path);
      return { fileSelections: { ...s.fileSelections, [repoId]: prev } };
    }),

  setFileSelections: (repoId, paths, selected) =>
    set(s => {
      const next = new Set(s.fileSelections[repoId] ?? []);
      for (const p of paths) {
        if (selected) next.add(p);
        else next.delete(p);
      }
      return { fileSelections: { ...s.fileSelections, [repoId]: next } };
    }),

  isFileSelected: (repoId, path) =>
    get().fileSelections[repoId]?.has(path) ?? false,

  getSelectedFilesForRepo: (repoId) =>
    Array.from(get().fileSelections[repoId] ?? []),

  selectFile: (repoId, path) =>
    set({ selectedFile: { repoId, path }, currentDiff: null }),

  setDiff: (diff) => set({ currentDiff: diff, loadingDiff: false }),
  setLoadingDiff: (v) => set({ loadingDiff: v }),
  setCommitMessage: (msg) => set({ commitMessage: msg }),
  setAmend: (repoId, v) => set(s => ({ amendFlags: { ...s.amendFlags, [repoId]: v } })),
  setViewMode: (mode) => set({ viewMode: mode }),
  setShelveViewMode: (mode) => set({ shelveViewMode: mode }),
  // shelveCollapsedKeys tracks *expanded* items — absence means collapsed (default)
  isShelveCollapsed: (key) => !get().shelveCollapsedKeys.has(key),
  toggleShelveCollapsed: (key) => set(s => {
    const next = new Set(s.shelveCollapsedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    return { shelveCollapsedKeys: next };
  }),
  shelveExpandAll: (shelveIds: string[], allDirPaths: string[]) => {
    const keys = new Set<string>();
    for (const id of shelveIds) {
      keys.add(id);
      for (const p of allDirPaths) keys.add(`${id}:${p}`);
    }
    set({ shelveCollapsedKeys: keys });
  },
  shelveCollapseAll: (_shelveIds: string[], _allDirPaths: string[]) => {
    // Collapsing = removing from the expanded set = empty set
    set({ shelveCollapsedKeys: new Set() });
  },
  setLoading: (v) => set({ loading: v }),
  setError: (err) => set({ error: err }),
  setChangelists: (changelists, viewMode) => {
    set({ changelists, changesViewMode: viewMode });
    if (viewMode !== 'changelists' && viewMode !== 'vscode') return;
    if (viewMode !== 'changelists') return;

    // Build lookup: repoId::path → changelistId
    const fileClId = new Map<string, string>();
    for (const cl of changelists) {
      for (const [repoId, paths] of Object.entries(cl.fileAssignments)) {
        for (const p of paths) fileClId.set(`${repoId}::${p}`, cl.id);
      }
    }

    const { fileSelections, status } = get();
    const nextSelections: FileSelections = {};
    let changed = false;
    for (const r of status?.repos ?? []) {
      const cur = fileSelections[r.repoId];
      if (!cur) continue;
      const next = new Set(cur);
      for (const p of cur) {
        const isUntracked = r.unstagedFiles.some(f => f.path === p && f.status === 'untracked');
        const clId = fileClId.get(`${r.repoId}::${p}`) ?? 'default';
        if (isUntracked || clId !== 'default') {
          next.delete(p);
          changed = true;
        }
      }
      nextSelections[r.repoId] = next;
    }
    if (changed) set({ fileSelections: { ...fileSelections, ...nextSelections } });
  },

  getRepoStatus: (repoId) => get().status?.repos.find(r => r.repoId === repoId),

  getSelectedRepos: () => {
    const { repoSelections, status } = get();
    return (status?.repos ?? [])
      .filter(r => repoSelections[r.repoId] !== false)
      .map(r => r.repoId);
  },

  isCollapsed: (key) => get().collapsedKeys.has(key),
  toggleCollapsed: (key) => set(s => {
    const next = new Set(s.collapsedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    return { collapsedKeys: next };
  }),
  expandAll: () => set({ collapsedKeys: new Set() }),
  collapseAll: () => {
    const { status } = get();
    const keys = new Set<string>();
    for (const r of status?.repos ?? []) {
      keys.add(r.repoId);
      // Add all dir paths from staged + unstaged files
      const allPaths = [...r.stagedFiles, ...r.unstagedFiles].map(f => f.path);
      for (const p of allPaths) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) {
          keys.add(`${r.repoId}:${parts.slice(0, i).join('/')}`);
        }
      }
    }
    set({ collapsedKeys: keys });
  },
}));
