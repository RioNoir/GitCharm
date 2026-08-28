export type RepoSortMode = 'discovery' | 'name' | 'path';

export const REPO_SORT_MODES: readonly RepoSortMode[] = ['discovery', 'name', 'path'];
export const DEFAULT_REPO_SORT_MODE: RepoSortMode = 'path';

// Preferences that follow the user across workspaces (globalState)
export interface ViewAndSortUserPrefs {
  fileViewMode: 'flat' | 'tree';
  hideReposWithoutChanges: boolean;
  repoSortMode: RepoSortMode;
}

// Project-specific state (workspaceState)
export interface ViewAndSortWorkspaceState {
  hiddenRepoIds: string[];
}

export type ViewAndSortSettings = ViewAndSortUserPrefs & ViewAndSortWorkspaceState;

export const DEFAULT_VIEW_AND_SORT_SETTINGS: ViewAndSortSettings = {
  fileViewMode: 'tree',
  hideReposWithoutChanges: false,
  repoSortMode: DEFAULT_REPO_SORT_MODE,
  hiddenRepoIds: [],
};
