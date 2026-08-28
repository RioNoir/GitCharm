import * as vscode from 'vscode';
import {
  DEFAULT_REPO_SORT_MODE,
  DEFAULT_VIEW_AND_SORT_SETTINGS,
  REPO_SORT_MODES,
  type RepoSortMode,
  type ViewAndSortSettings,
  type ViewAndSortUserPrefs,
} from '../types/settings';

const GLOBAL_KEY = 'gitcharm.viewAndSort';
const WORKSPACE_HIDDEN_REPOS_KEY = 'gitcharm.hiddenRepoIds';

// Legacy (pre-refactor) keys — read once for migration, never written again.
const LEGACY_FILE_VIEW_MODE_KEY = 'fileViewMode';
const LEGACY_HIDE_REPOS_KEY = 'gitcharm.showOnlyChangedRepos';

function isRepoSortMode(value: unknown): value is RepoSortMode {
  return typeof value === 'string' && (REPO_SORT_MODES as readonly string[]).includes(value);
}

function isFileViewMode(value: unknown): value is 'flat' | 'tree' {
  return value === 'flat' || value === 'tree';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

export class ViewAndSortSettingsService {
  constructor(
    private readonly globalState?: vscode.Memento,
    private readonly workspaceState?: vscode.Memento
  ) {}

  /** One-shot migration from the old, scattered Memento keys. Idempotent. */
  async migrateIfNeeded(): Promise<void> {
    if (!this.globalState) return;
    if (this.globalState.get(GLOBAL_KEY) !== undefined) return;

    const legacyFileViewMode = this.globalState.get<'flat' | 'tree'>(LEGACY_FILE_VIEW_MODE_KEY, DEFAULT_VIEW_AND_SORT_SETTINGS.fileViewMode);
    const legacyHideReposWithoutChanges = this.globalState.get<boolean>(LEGACY_HIDE_REPOS_KEY, DEFAULT_VIEW_AND_SORT_SETTINGS.hideReposWithoutChanges);

    const migrated: ViewAndSortUserPrefs = {
      fileViewMode: isFileViewMode(legacyFileViewMode) ? legacyFileViewMode : DEFAULT_VIEW_AND_SORT_SETTINGS.fileViewMode,
      hideReposWithoutChanges: typeof legacyHideReposWithoutChanges === 'boolean' ? legacyHideReposWithoutChanges : DEFAULT_VIEW_AND_SORT_SETTINGS.hideReposWithoutChanges,
      repoSortMode: DEFAULT_REPO_SORT_MODE,
    };
    await this.globalState.update(GLOBAL_KEY, migrated);
  }

  getAll(): ViewAndSortSettings {
    const stored = this.globalState?.get<Partial<ViewAndSortUserPrefs>>(GLOBAL_KEY, {}) ?? {};
    const hiddenRepoIdsRaw = this.workspaceState?.get<string[]>(WORKSPACE_HIDDEN_REPOS_KEY, []) ?? [];

    return {
      fileViewMode: isFileViewMode(stored.fileViewMode) ? stored.fileViewMode : DEFAULT_VIEW_AND_SORT_SETTINGS.fileViewMode,
      hideReposWithoutChanges: typeof stored.hideReposWithoutChanges === 'boolean' ? stored.hideReposWithoutChanges : DEFAULT_VIEW_AND_SORT_SETTINGS.hideReposWithoutChanges,
      repoSortMode: isRepoSortMode(stored.repoSortMode) ? stored.repoSortMode : DEFAULT_REPO_SORT_MODE,
      hiddenRepoIds: isStringArray(hiddenRepoIdsRaw) ? hiddenRepoIdsRaw : [],
    };
  }

  async updatePrefs(partial: Partial<ViewAndSortUserPrefs>): Promise<ViewAndSortSettings> {
    const current = this.getAll();
    const next: ViewAndSortUserPrefs = {
      fileViewMode: partial.fileViewMode ?? current.fileViewMode,
      hideReposWithoutChanges: partial.hideReposWithoutChanges ?? current.hideReposWithoutChanges,
      repoSortMode: partial.repoSortMode ?? current.repoSortMode,
    };
    await this.globalState?.update(GLOBAL_KEY, next);
    return this.getAll();
  }

  async setHiddenRepoIds(ids: string[]): Promise<ViewAndSortSettings> {
    await this.workspaceState?.update(WORKSPACE_HIDDEN_REPOS_KEY, ids);
    return this.getAll();
  }
}
