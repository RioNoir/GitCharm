import { plural } from '../shared/l10n';
import * as l10n from '@vscode/l10n';
import { isImeComposing } from '../shared/ime';
import React, { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isEmbedded } from '../shared/embedded';
import { useCommitStore } from './store/commitStore';
import { ProjectGroup } from './components/ProjectGroup';
import { ChangelistView } from './components/ChangelistView';
import { VscodeView } from './components/VscodeView';
import { UnifiedCommitForm } from './components/UnifiedCommitForm';
import type { SyncAction } from './syncState';
import { ContextMenu, type ContextMenuEntry } from './components/ContextMenu';
import { ShelvePanel } from './components/ShelvePanel';
import { EmptyTabState } from './components/EmptyTabState';
import { StashTab } from './components/StashTab';
import { PushTab } from './components/PushTab';
import { WorktreePanel } from './components/WorktreePanel';
import { PullRequestPanel, NoRemoteState, noRepoHasRemote } from './components/PullRequestPanel';
import { IssuePanel, IssuesNoRemoteState, noIssueRepoHasRemote } from './components/IssuePanel';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import { ScrollArea } from '../shared/ScrollArea';
import { handleTreeNavKeyDown } from '../shared/keyboardNav';
import type { CommitToHostMsg, HostToCommitMsg, ShelveEntry, StashEntry, UnpushedCommit, WorktreeEntry, RepoPullRequests, ForgeProvider, PullRequestSummary, RepoIssues, IssueSummary } from '../shared/msgTypes';
import type { CommitPanelConfig } from '../../host/types/messages';
import type { FileStatus, RepoStatus } from '../shared/types';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../shared/types';
import type { ViewAndSortUserPrefs } from '../../host/types/settings';
import { sortRepos } from './repoSort';
import { displayWidth } from '../../host/utils/displayWidth';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Caps tab badge counts at "99+" so a large number never stretches the tab bar. */
function formatBadgeCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

// ── Dynamic context menu label helper ─────────────────────────────────────

function dynItems(items: ContextMenuEntry[], n: number): ContextMenuEntry[] {
  const label = (id: string) => {
    if (id === 'rollback'    || id === 'cl-rollback') return plural(n, l10n.t('Rollback this file'), l10n.t('Rollback {0} files', n));
    if (id === 'shelve'      || id === 'cl-shelve')   return plural(n, l10n.t('Silently Shelve this file'), l10n.t('Silently Shelve {0} files', n));
    if (id === 'stash'       || id === 'cl-stash')    return plural(n, l10n.t('Silently Stash this file'), l10n.t('Silently Stash {0} files', n));
    return null;
  };
  return items.map(i => {
    if (!('id' in i)) return i;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l = label((i as any).id);
    return l ? { ...i, label: l } : i;
  });
}

// ── Context menu items ────────────────────────────────────────────────────────

const revealOsLabel = () => l10n.t('Reveal in File Manager');

const FILE_CONTEXT_ITEMS = (): ContextMenuEntry[] => [
  { id: 'rollback',        label: l10n.t('Rollback'),            icon: 'discard' },
  { id: 'shelve',          label: l10n.t('Shelve'),              icon: 'archive' },
  { id: 'stash',           label: l10n.t('Stash'),               icon: 'git-stash' },
  { id: 'diff',            label: l10n.t('Show Diff'),           icon: 'diff' },
  { id: 'compare-with',    label: l10n.t('Compare with…'),       icon: 'git-compare' },
  { id: 'file-history',    label: l10n.t('Show File History'),   icon: 'history' },
  { id: 'jump',            label: l10n.t('Jump to Source'),      icon: 'go-to-file' },
  { id: 'reveal-explorer', label: l10n.t('Reveal in Explorer'),  icon: 'list-tree' },
  { id: 'reveal-os',       label: revealOsLabel(),       icon: 'folder-opened' },
  { separator: true },
  { id: 'gitignore',       label: l10n.t('Add to .gitignore'),   icon: 'exclude' },
  { separator: true },
  { id: 'delete',          label: l10n.t('Delete'),              icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',         label: l10n.t('Refresh'),             icon: 'refresh' },
];

const FILE_CONTEXT_ITEMS_CONFLICT = (aiEnabled: boolean): ContextMenuEntry[] => [
  { id: 'resolve',   label: l10n.t('Resolve Conflicts'),  icon: 'git-merge' },
  ...(aiEnabled ? [{ id: 'resolveAi', label: l10n.t('Resolve Conflicts with AI'), icon: 'sparkle' }] : []),
  { separator: true },
  ...FILE_CONTEXT_ITEMS(),
];

const FOLDER_CONTEXT_ITEMS = (): ContextMenuEntry[] => [
  { id: 'rollback',  label: l10n.t('Rollback'),           icon: 'discard' },
  { id: 'shelve',    label: l10n.t('Shelve Changes'),      icon: 'archive' },
  { id: 'stash',     label: l10n.t('Stash Changes'),       icon: 'git-stash' },
  { id: 'compare-with', label: l10n.t('Compare with…'),    icon: 'git-compare' },
  { separator: true },
  { id: 'gitignore', label: l10n.t('Add to .gitignore'),  icon: 'exclude' },
  { separator: true },
  { id: 'delete',    label: l10n.t('Delete'),              icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',   label: l10n.t('Refresh'),             icon: 'refresh' },
];

const REPO_CONTEXT_ITEMS = (): ContextMenuEntry[] => [
  { id: 'rollback',          label: l10n.t('Rollback'),              icon: 'discard' },
  { id: 'shelve',            label: l10n.t('Shelve Changes'),         icon: 'archive' },
  { id: 'stash',             label: l10n.t('Stash Changes'),          icon: 'git-stash' },
  { separator: true },
  { id: 'manage-repo',       label: l10n.t('Manage Repository'),      icon: 'git-branch' },
  { id: 'view-git-log',      label: l10n.t('View Log Panel'),           icon: 'git-commit' },
  { separator: true },
  { id: 'reveal-explorer',   label: l10n.t('Reveal in Explorer'),     icon: 'list-tree' },
  { id: 'open-new-window',   label: l10n.t('Open in New Window'),     icon: 'multiple-windows' },
  { id: 'reveal-os',         label: revealOsLabel(),          icon: 'folder-opened' },
  { separator: true },
  { id: 'hide-repo',         label: l10n.t('Hide Repository'),        icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',           label: l10n.t('Refresh'),                icon: 'refresh' },
];

const VSCODE_FILE_STAGED_ITEMS = (): ContextMenuEntry[] => [
  { id: 'unstage',         label: l10n.t('Unstage'),              icon: 'remove' },
  { separator: true },
  { id: 'diff',            label: l10n.t('Show Diff'),            icon: 'diff' },
  { id: 'compare-with',    label: l10n.t('Compare with…'),        icon: 'git-compare' },
  { id: 'file-history',    label: l10n.t('Show File History'),    icon: 'history' },
  { id: 'jump',            label: l10n.t('Jump to Source'),       icon: 'go-to-file' },
  { id: 'reveal-explorer', label: l10n.t('Reveal in Explorer'),   icon: 'list-tree' },
  { id: 'reveal-os',       label: revealOsLabel(),        icon: 'folder-opened' },
  { separator: true },
  { id: 'refresh',         label: l10n.t('Refresh'),              icon: 'refresh' },
];

const VSCODE_FILE_UNSTAGED_ITEMS = (): ContextMenuEntry[] => [
  { id: 'stage',           label: l10n.t('Stage'),                icon: 'add' },
  { id: 'rollback',        label: l10n.t('Rollback'),             icon: 'discard' },
  { id: 'shelve',          label: l10n.t('Shelve'),               icon: 'archive' },
  { id: 'stash',           label: l10n.t('Stash'),                icon: 'git-stash' },
  { separator: true },
  { id: 'diff',            label: l10n.t('Show Diff'),            icon: 'diff' },
  { id: 'compare-with',    label: l10n.t('Compare with…'),        icon: 'git-compare' },
  { id: 'file-history',    label: l10n.t('Show File History'),    icon: 'history' },
  { id: 'jump',            label: l10n.t('Jump to Source'),       icon: 'go-to-file' },
  { id: 'reveal-explorer', label: l10n.t('Reveal in Explorer'),   icon: 'list-tree' },
  { id: 'reveal-os',       label: revealOsLabel(),        icon: 'folder-opened' },
  { separator: true },
  { id: 'gitignore',       label: l10n.t('Add to .gitignore'),    icon: 'exclude' },
  { separator: true },
  { id: 'delete',          label: l10n.t('Delete'),               icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',         label: l10n.t('Refresh'),              icon: 'refresh' },
];

const VSCODE_FOLDER_STAGED_ITEMS = (): ContextMenuEntry[] => [
  { id: 'unstage',  label: l10n.t('Unstage Folder'),       icon: 'remove' },
  { separator: true },
  { id: 'compare-with', label: l10n.t('Compare with…'),    icon: 'git-compare' },
  { separator: true },
  { id: 'refresh',  label: l10n.t('Refresh'),              icon: 'refresh' },
];

const VSCODE_FOLDER_UNSTAGED_ITEMS = (): ContextMenuEntry[] => [
  { id: 'stage',    label: l10n.t('Stage Folder'),         icon: 'add' },
  { id: 'rollback', label: l10n.t('Rollback'),             icon: 'discard' },
  { id: 'shelve',   label: l10n.t('Shelve Changes'),        icon: 'archive' },
  { id: 'stash',    label: l10n.t('Stash Changes'),         icon: 'git-stash' },
  { id: 'compare-with', label: l10n.t('Compare with…'),    icon: 'git-compare' },
  { separator: true },
  { id: 'gitignore',label: l10n.t('Add to .gitignore'),    icon: 'exclude' },
  { separator: true },
  { id: 'delete',   label: l10n.t('Delete'),               icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',  label: l10n.t('Refresh'),              icon: 'refresh' },
];

const VSCODE_REPO_STAGED_ITEMS = (): ContextMenuEntry[] => [
  { id: 'unstage-all',       label: l10n.t('Unstage All'),           icon: 'remove' },
  { separator: true },
  { id: 'manage-repo',       label: l10n.t('Manage Repository'),      icon: 'git-branch' },
  { id: 'view-git-log',      label: l10n.t('View Log Panel'),           icon: 'git-commit' },
  { separator: true },
  { id: 'reveal-explorer',   label: l10n.t('Reveal in Explorer'),     icon: 'list-tree' },
  { id: 'open-new-window',   label: l10n.t('Open in New Window'),     icon: 'multiple-windows' },
  { id: 'reveal-os',         label: revealOsLabel(),          icon: 'folder-opened' },
  { separator: true },
  { id: 'hide-repo',         label: l10n.t('Hide Repository'),        icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',           label: l10n.t('Refresh'),                icon: 'refresh' },
];

const VSCODE_REPO_UNSTAGED_ITEMS = (): ContextMenuEntry[] => [
  { id: 'stage-all',         label: l10n.t('Stage All'),             icon: 'add' },
  { id: 'rollback',          label: l10n.t('Rollback'),               icon: 'discard' },
  { id: 'shelve',            label: l10n.t('Shelve Changes'),          icon: 'archive' },
  { id: 'stash',             label: l10n.t('Stash Changes'),           icon: 'git-stash' },
  { separator: true },
  { id: 'manage-repo',       label: l10n.t('Manage Repository'),       icon: 'git-branch' },
  { id: 'view-git-log',      label: l10n.t('View Log Panel'),            icon: 'git-commit' },
  { separator: true },
  { id: 'reveal-explorer',   label: l10n.t('Reveal in Explorer'),      icon: 'list-tree' },
  { id: 'open-new-window',   label: l10n.t('Open in New Window'),      icon: 'multiple-windows' },
  { id: 'reveal-os',         label: revealOsLabel(),           icon: 'folder-opened' },
  { separator: true },
  { id: 'hide-repo',         label: l10n.t('Hide Repository'),         icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',           label: l10n.t('Refresh'),                 icon: 'refresh' },
];

const SUBMODULE_FILE_STAGED_ITEMS = (): ContextMenuEntry[] => [
  { id: 'unstage',  label: l10n.t('Unstage'),   icon: 'remove' },
  { separator: true },
  { id: 'refresh',  label: l10n.t('Refresh'),   icon: 'refresh' },
];

const SUBMODULE_FILE_UNSTAGED_ITEMS = (): ContextMenuEntry[] => [
  { id: 'stage',    label: l10n.t('Stage'),     icon: 'add' },
  { separator: true },
  { id: 'refresh',  label: l10n.t('Refresh'),   icon: 'refresh' },
];

const CHANGELIST_EMPTY_AREA_ITEMS = (): ContextMenuEntry[] => [
  { id: 'cl-new',   label: l10n.t('New Changelist…'), icon: 'add' },
  { separator: true },
  { id: 'refresh',  label: l10n.t('Refresh'),         icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_FIXED = (): ContextMenuEntry[] => [
  { id: 'cl-rollback', label: l10n.t('Rollback'),          icon: 'discard' },
  { id: 'cl-shelve',   label: l10n.t('Shelve Changes'),    icon: 'archive' },
  { id: 'cl-stash',    label: l10n.t('Stash Changes'),     icon: 'git-stash' },
  { separator: true },
  { id: 'cl-new',      label: l10n.t('New Changelist…'),   icon: 'add' },
  { separator: true },
  { id: 'refresh',     label: l10n.t('Refresh'),           icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_UNVERSIONED = (): ContextMenuEntry[] => [
  { id: 'cl-rollback',   label: l10n.t('Rollback'),         icon: 'discard' },
  { id: 'cl-shelve',     label: l10n.t('Shelve Changes'),   icon: 'archive' },
  { id: 'cl-stash',      label: l10n.t('Stash Changes'),    icon: 'git-stash' },
  { separator: true },
  { id: 'cl-add-to-git', label: l10n.t('Add to Git'),       icon: 'add' },
  { separator: true },
  { id: 'cl-new',        label: l10n.t('New Changelist…'),  icon: 'add' },
  { separator: true },
  { id: 'refresh',       label: l10n.t('Refresh'),          icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_CUSTOM = (): ContextMenuEntry[] => [
  { id: 'cl-rollback', label: l10n.t('Rollback'),          icon: 'discard' },
  { id: 'cl-shelve',   label: l10n.t('Shelve Changes'),    icon: 'archive' },
  { id: 'cl-stash',    label: l10n.t('Stash Changes'),     icon: 'git-stash' },
  { separator: true },
  { id: 'cl-new',      label: l10n.t('New Changelist…'),   icon: 'add' },
  { id: 'cl-rename',   label: l10n.t('Rename Changelist…'), icon: 'edit' },
  { separator: true },
  { id: 'cl-delete',   label: l10n.t('Delete Changelist'),  icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',     label: l10n.t('Refresh'),           icon: 'refresh' },
];

type TabId = 'changes' | 'shelf' | 'stash' | 'push' | 'worktree' | 'pullrequests' | 'issues';

function App() {
  const store = useCommitStore();
  const pendingRef = useRef<Map<string, (msg: HostToCommitMsg) => void>>(new Map());

  // ── Tab ───────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('changes');
  // The gitcharm.commitPanel.* settings: which tabs, in which order, labels and badges. Null until the host sends them.
  const [panelConfig, setPanelConfig] = useState<CommitPanelConfig | null>(null);
  const shownTabs: TabId[] = panelConfig?.tabs ?? ['changes', 'shelf', 'stash', 'worktree', 'issues', 'pullrequests', 'push'];
  // A tab turned off while open hands over to Changes.
  useEffect(() => {
    if (!shownTabs.includes(activeTab)) setActiveTab('changes');
  }, [activeTab, panelConfig]);
  const [tabBarCollapsed, setTabBarCollapsed] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; width: number } | null>(null);
  const tabDropdownBtnRef = useRef<HTMLButtonElement>(null);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const tabBarContentRef = useRef<HTMLDivElement | null>(null);

  // ── Shelve state ──────────────────────────────────────────────────────────
  const [shelveMap, setShelveMap]       = useState<Record<string, ShelveEntry[]>>({});
  const [shelveLoading, setShelveLoading] = useState<Record<string, boolean>>({});
  const [shelveError, setShelveError]   = useState<Record<string, string | null>>({});

  // ── Stash state ───────────────────────────────────────────────────────────
  const [stashMap, setStashMap]       = useState<Record<string, StashEntry[]>>({});
  const [stashLoading, setStashLoading] = useState<Record<string, boolean>>({});
  const [stashError, setStashError]   = useState<Record<string, string | null>>({});

  // ── Worktree state ────────────────────────────────────────────────────────
  const [worktreeRepos, setWorktreeRepos] = useState<Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }>>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

  // ── Pull Request state ────────────────────────────────────────────────────
  const [pullRequestRepos, setPullRequestRepos] = useState<RepoPullRequests[]>([]);
  const [pullRequestLoading, setPullRequestLoading] = useState(false);
  const [pullRequestLoadingMore, setPullRequestLoadingMore] = useState<Record<string, boolean>>({});
  const [expandedPrRepoIds, setExpandedPrRepoIds] = useState<Set<string>>(new Set());
  /** repoIds still awaited from the current streaming load — cleared as each PULLREQUEST_LIST_REPO_RESULT arrives; loading flips off once empty. */
  const pullRequestPendingRef = useRef<Set<string>>(new Set());

  // ── Issue state ───────────────────────────────────────────────────────────
  const [issueRepos, setIssueRepos] = useState<RepoIssues[]>([]);
  const [issueLoading, setIssueLoading] = useState(false);
  const [issueLoadingMore, setIssueLoadingMore] = useState<Record<string, boolean>>({});
  const [expandedIssueRepoIds, setExpandedIssueRepoIds] = useState<Set<string>>(new Set());
  const issuePendingRef = useRef<Set<string>>(new Set());
  /** Text the host asked to insert into the commit message (an issue reference); `id` makes repeats distinct. */
  const [commitInsert, setCommitInsert] = useState<{ id: number; text: string } | null>(null);

  // ── Submodule detached HEAD warnings ─────────────────────────────────────
  // repoId → headCommit — shown as dismissable banner above the file tree
  const [detachedWarnings, setDetachedWarnings] = useState<Record<string, string>>({});

  // Track unstaged file counts per repo to detect new changes for auto-expand in vscode mode
  const prevUnstagedCountsRef = useRef<Map<string, number>>(new Map());
  // The in-flight commit, so its message is only cleared once the commit succeeded.
  const pendingCommitRef = useRef<{ requestId: string; repoIds: string[] } | null>(null);

  // Persist the commit message draft to workspaceState (host-side), debounced so typing
  // doesn't post a message per keystroke. Scoped per-workspace by the host, unlike the
  // webview's shared-origin localStorage.
  const commitMessage = useCommitStore(s => s.commitMessage);
  useEffect(() => {
    const timer = setTimeout(() => {
      getVsCodeApi().postMessage({ type: 'COMMIT_PERSIST_MESSAGE', message: commitMessage } satisfies CommitToHostMsg);
    }, 400);
    return () => clearTimeout(timer);
  }, [commitMessage]);

  // ── Vscode mode: repo selection for commit ───────────────────────────────
  const [vscodeSelectedRepos, setVscodeSelectedRepos] = useState<Set<string>>(new Set());

  // Sync: when repos change, add any new repo as selected by default
  useEffect(() => {
    const currentRepoIds = (store.status?.repos ?? []).map(r => r.repoId);
    setVscodeSelectedRepos(prev => {
      const next = new Set(prev);
      for (const id of currentRepoIds) if (!next.has(id)) next.add(id);
      return next;
    });
  }, [(store.status?.repos ?? []).map(r => r.repoId).join(',')]);

  // Prune per-repo caches when a repo disappears from the workspace (removed folder,
  // repo no longer detected, etc.) so stale entries don't linger in the UI forever.
  useEffect(() => {
    const currentRepoIds = new Set((store.status?.repos ?? []).map(r => r.repoId));
    const pruneRecord = <T,>(prev: Record<string, T>): Record<string, T> => {
      let changed = false;
      const next: Record<string, T> = {};
      for (const [repoId, value] of Object.entries(prev)) {
        if (currentRepoIds.has(repoId)) next[repoId] = value;
        else changed = true;
      }
      return changed ? next : prev;
    };
    setShelveMap(pruneRecord);
    setShelveLoading(pruneRecord);
    setShelveError(pruneRecord);
    setStashMap(pruneRecord);
    setStashLoading(pruneRecord);
    setStashError(pruneRecord);
    setUnpushedMap(pruneRecord);
    setDetachedWarnings(pruneRecord);
    setWorktreeRepos(prev => prev.filter(r => currentRepoIds.has(r.repoId)));
    setPullRequestRepos(prev => prev.filter(r => currentRepoIds.has(r.repoId)));
    setIssueRepos(prev => prev.filter(r => currentRepoIds.has(r.repoId)));
  }, [(store.status?.repos ?? []).map(r => r.repoId).join(',')]);

  const toggleVscodeRepoSelection = (repoId: string) => {
    setVscodeSelectedRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId); else next.add(repoId);
      return next;
    });
  };

  // ── Push / unpushed state ─────────────────────────────────────────────────
  const [unpushedMap, setUnpushedMap] = useState<Record<string, { loading: boolean; commits: UnpushedCommit[]; error?: string }>>({});

  // ── Shelve name prompt (triggered by context menu or commit bar button) ────
  const [shelvePrompt, setShelvePrompt] = useState<{
    repoId: string;
    paths?: string[];
    defaultName: string;
  } | null>(null);
  const [shelvePromptName, setShelvePromptName] = useState('');
  const shelvePromptRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (shelvePrompt) {
      setShelvePromptName(shelvePrompt.defaultName);
      setTimeout(() => shelvePromptRef.current?.focus(), 30);
    }
  }, [shelvePrompt]);

  // ── Inject tab label animation keyframes once ─────────────────────────────
  useEffect(() => {
    const id = 'gitcharm-tab-kf';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      @keyframes gs-tab-label-in {
        from { opacity: 0; transform: translateX(-6px); max-width: 0; }
        to   { opacity: 1; transform: translateX(0);    max-width: 80px; }
      }
    `;
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    const id = 'gitcharm-action-btn-hover';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `[data-action-btn]:hover { background: var(--vscode-toolbar-hoverBackground) !important; opacity: 1 !important; }`;
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    const id = 'gitcharm-tab-dropdown-hover';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `[data-tab-dropdown-btn]:hover { background: var(--vscode-toolbar-hoverBackground) !important; }`;
    document.head.appendChild(s);
  }, []);

  // Collapse the tab bar into a single dropdown button once it no longer fits in the
  // available width. The width check is driven by a hidden probe strip with every tab's
  // label expanded at once (see tabBarContentRefCb usage below), not by the real strip —
  // that keeps the collapse threshold constant regardless of which tab is active. The tab
  // bar only mounts once the loading/empty-state early returns below have passed, so the
  // observer is (re)installed via callback refs rather than a mount-only useEffect —
  // otherwise it would run once against null refs (during the loading state) and never again.
  const tabBarObserverRef = useRef<ResizeObserver | null>(null);
  const setTabBarRefs = useCallback(() => {
    const bar = tabBarRef.current;
    const content = tabBarContentRef.current;
    tabBarObserverRef.current?.disconnect();
    tabBarObserverRef.current = null;
    if (!bar || !content) return;
    const check = () => setTabBarCollapsed(content.scrollWidth > bar.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    observer.observe(content);
    tabBarObserverRef.current = observer;
  }, []);
  const tabBarRefCb = useCallback((el: HTMLDivElement | null) => {
    tabBarRef.current = el;
    setTabBarRefs();
  }, [setTabBarRefs]);
  const tabBarContentRefCb = useCallback((el: HTMLDivElement | null) => {
    tabBarContentRef.current = el;
    setTabBarRefs();
  }, [setTabBarRefs]);

  // ── Autopilot ─────────────────────────────────────────────────────────────
  const [generatingMessage, setGeneratingMessage]   = useState(false);
  // What the message was before AI generation started streaming into it — put back if generation fails midway.
  const messageBeforeGenerate = useRef<string | null>(null);

  // ── Selected file (highlighted when diff is open or on right-click) ──────
  const [selectedFile, setSelectedFile] = useState<FileStatus | null>(null);

  // ── Context menus ─────────────────────────────────────────────────────────
  const [ctxFile, setCtxFile] = useState<{ repoId: string; path: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: FileStatus } | null>(null);
  const [multiSelectedFiles, setMultiSelectedFiles] = useState<FileStatus[]>([]);
  const [multiCtxMenu, setMultiCtxMenu] = useState<{ x: number; y: number; files: FileStatus[] } | null>(null);
  const [activeFolderPath, setActiveFolderPath] = useState<string | null>(null);
  const [folderCtxMenu, setFolderCtxMenu] = useState<{
    x: number; y: number; repoId: string; folderPath: string; files: FileStatus[];
  } | null>(null);
  const [repoCtxMenu, setRepoCtxMenu] = useState<{ x: number; y: number; repoId: string; changelistId?: string; stagedSection?: boolean } | null>(null);
  // vscode-mode: staged flag attached to file/folder ctx menus
  const [ctxMenuStaged, setCtxMenuStaged] = useState<boolean>(false);
  const [folderCtxMenuStaged, setFolderCtxMenuStaged] = useState<boolean>(false);
  const [clHeaderCtxMenu, setClHeaderCtxMenu] = useState<{ x: number; y: number; changelistId: string } | null>(null);

  const send = useCallback((msg: CommitToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  const updateViewAndSort = useCallback((partial: Partial<ViewAndSortUserPrefs>) => {
    store.setViewAndSort(partial);
    send({ type: 'COMMIT_SET_VIEW_SORT_SETTINGS', ...partial });
  }, [send]);

  const notifyError = useCallback((message: string) => {
    send({ type: 'NOTIFY_ERROR', message } satisfies CommitToHostMsg);
  }, []);

  const notifyInfo = useCallback((message: string) => {
    send({ type: 'NOTIFY_INFO', message } satisfies CommitToHostMsg);
  }, []);

  // ── Message handler ───────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent<HostToCommitMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;

      if ('requestId' in msg && msg.requestId && pendingRef.current.has(msg.requestId as string)) {
        const resolve = pendingRef.current.get(msg.requestId as string)!;
        pendingRef.current.delete(msg.requestId as string);
        resolve(msg);
      }

      switch (msg.type) {
        case 'COMMIT_VIEW_SORT_SETTINGS_UPDATE':
          store.setViewAndSort({
            fileViewMode: msg.fileViewMode,
            hideReposWithoutChanges: msg.hideReposWithoutChanges,
            repoSortMode: msg.repoSortMode,
            changeSortMode: msg.changeSortMode,
            hiddenRepoIds: msg.hiddenRepoIds,
          });
          break;
        case 'COMMIT_STATUS_UPDATE':
          store.setStatus(msg.repos, msg.status, msg.iconTheme, msg.defaultCommitAction, msg.defaultSaveAction, msg.hasWorkspaceFolder, msg.aiEnabled, msg.activeProfile);
          if (msg.panelConfig) setPanelConfig(msg.panelConfig);
          if (Array.isArray(msg.status.repos) && useCommitStore.getState().changesViewMode === 'vscode') {
            const prevCounts = prevUnstagedCountsRef.current;
            let hasNewChanges = false;
            for (const repo of msg.status.repos) {
              const prev = prevCounts.get(repo.repoId) ?? 0;
              const curr = (repo.unstagedFiles ?? []).length;
              if (prev === 0 && curr > 0) hasNewChanges = true;
              prevCounts.set(repo.repoId, curr);
            }
            if (hasNewChanges && useCommitStore.getState().isCollapsed('vscode-section:unstaged')) {
              useCommitStore.getState().toggleCollapsed('vscode-section:unstaged');
            }
          } else if (Array.isArray(msg.status.repos)) {
            const prevCounts = prevUnstagedCountsRef.current;
            for (const repo of msg.status.repos) {
              prevCounts.set(repo.repoId, (repo.unstagedFiles ?? []).length);
            }
          }
          break;
        case 'CHANGELISTS_UPDATE':
          store.setChangelists(msg.changelists, msg.viewMode);
          break;
        case 'COMMIT_OP_RESULT':
          store.setLoading(false);
          if (pendingCommitRef.current?.requestId === msg.requestId) {
            const { repoIds } = pendingCommitRef.current;
            pendingCommitRef.current = null;
            // Only repos that actually committed consume the message/amend flag — a
            // rejecting hook or missing identity in one repo of a multi-repo commit
            // must not cost the user what they typed for the repos that did succeed.
            if (msg.ok) {
              store.setCommitMessage('');
              repoIds.forEach(id => store.clearAmend(id));
            } else if (msg.succeededRepoIds?.length) {
              msg.succeededRepoIds.forEach(id => store.clearAmend(id));
            }
          }
          if (msg.ok) {
            // Refresh push tab after any successful operation (commit, undo, push, etc.)
            const currentRepos = useCommitStore.getState().status?.repos ?? [];
            currentRepos.forEach(r => requestUnpushedCommits(r.repoId));
          } else if (msg.error && msg.error !== 'Cancelled') {
            notifyError(msg.error);
          }
          break;
        case 'COMMIT_GENERATE_MESSAGE_PROGRESS':
          if (msg.message) store.setCommitMessage(msg.message);
          break;
        case 'COMMIT_GENERATE_MESSAGE_RESULT':
          setGeneratingMessage(false);
          if (msg.message) {
            store.setCommitMessage(msg.message);
          } else {
            if (messageBeforeGenerate.current !== null) store.setCommitMessage(messageBeforeGenerate.current);
            if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          }
          messageBeforeGenerate.current = null;
          break;
        case 'COMMIT_LAST_COMMIT_MESSAGE_RESULT':
          if (msg.message && !useCommitStore.getState().commitMessage.trim()) {
            store.setCommitMessage(msg.message);
          }
          break;
        case 'COMMIT_SET_MESSAGE':
          if (msg.ifEmpty && useCommitStore.getState().commitMessage.trim()) break;
          if (msg.ifEquals !== undefined && useCommitStore.getState().commitMessage.trim() !== msg.ifEquals.trim()) break;
          store.setCommitMessage(msg.message);
          break;
        case 'COMMIT_PERSISTED_MESSAGE_RESULT':
          if (!useCommitStore.getState().commitMessage.trim()) store.setCommitMessage(msg.message);
          break;
        case 'SHELVE_LIST_RESULT':
          setShelveLoading(prev => ({ ...prev, [msg.repoId]: false }));
          if (msg.error) {
            setShelveError(prev => ({ ...prev, [msg.repoId]: msg.error ?? null }));
          } else {
            setShelveMap(prev => ({ ...prev, [msg.repoId]: msg.shelves }));
            setShelveError(prev => ({ ...prev, [msg.repoId]: null }));
          }
          break;
        case 'SHELVE_OP_RESULT':
          if (!msg.ok) {
            if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          } else {
            if (msg.hasConflicts && msg.conflictFiles?.length) {
              const n = msg.conflictFiles.length;
              notifyInfo(plural(n, l10n.t('Conflicts in 1 file — merge editor opened'), l10n.t('Conflicts in {0} files — merge editor opened', n)));
            }
            // Refresh the shelf list for the affected repo after any successful op
            setShelveLoading(prev => ({ ...prev, [msg.repoId]: true }));
            getVsCodeApi().postMessage({ type: 'SHELVE_LIST', requestId: generateId(), repoId: msg.repoId } satisfies CommitToHostMsg);
          }
          break;

        case 'STASH_LIST_RESULT':
          setStashLoading(prev => ({ ...prev, [msg.repoId]: false }));
          if (msg.error) {
            setStashError(prev => ({ ...prev, [msg.repoId]: msg.error ?? null }));
          } else {
            setStashMap(prev => ({ ...prev, [msg.repoId]: msg.stashes }));
            setStashError(prev => ({ ...prev, [msg.repoId]: null }));
          }
          break;

        case 'STASH_OP_RESULT':
          if (!msg.ok) {
            if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          } else {
            // Refresh stash list for affected repo
            setStashLoading(prev => ({ ...prev, [msg.repoId]: true }));
            getVsCodeApi().postMessage({ type: 'STASH_LIST', requestId: generateId(), repoId: msg.repoId } satisfies CommitToHostMsg);
          }
          break;

        case 'PUSH_UNPUSHED_RESULT':
          setUnpushedMap(prev => ({
            ...prev,
            [msg.repoId]: { loading: false, commits: msg.commits, error: msg.error },
          }));
          break;

        case 'PUSH_SQUASH_RESULT':
        case 'PUSH_DROP_RESULT':
        case 'PUSH_REVERT_RESULT':
        case 'PUSH_EDIT_MSG_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;

        case 'SUBMODULE_OP_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;

        case 'SUBMODULE_DETACHED_HEAD_WARNING':
          setDetachedWarnings(prev => ({ ...prev, [msg.repoId]: msg.headCommit }));
          break;

        case 'SUBMODULE_PUSH_RESULT':
        case 'SUBMODULE_PULL_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;

        case 'WORKTREE_LIST_RESULT':
          setWorktreeLoading(false);
          setWorktreeRepos(msg.repos);
          break;

        case 'WORKTREE_OP_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;

        case 'PULLREQUEST_LIST_RESULT':
          setPullRequestLoading(false);
          setPullRequestRepos(msg.repos);
          break;

        case 'PULLREQUEST_LIST_START': {
          pullRequestPendingRef.current = new Set(msg.repoIds);
          setPullRequestLoading(true);
          const metas = useCommitStore.getState().repoMetas;
          setPullRequestRepos(msg.repoIds.map(repoId => {
            const meta = metas.find(m => m.id === repoId);
            return {
              repoId, repoName: meta?.name ?? repoId, repoColor: meta?.color ?? '#888',
              connection: { repoId, provider: 'unknown', host: '', connected: false, detectionFailed: false },
              pullRequests: [], page: 1, hasMore: false, pending: true,
            };
          }));
          break;
        }

        case 'PULLREQUEST_LIST_REPO_RESULT':
          setPullRequestRepos(prev => {
            const idx = prev.findIndex(r => r.repoId === msg.repo.repoId);
            if (idx === -1) return [...prev, msg.repo];
            const next = [...prev];
            next[idx] = msg.repo;
            return next;
          });
          pullRequestPendingRef.current.delete(msg.repo.repoId);
          if (pullRequestPendingRef.current.size === 0) setPullRequestLoading(false);
          break;

        case 'PULLREQUEST_LOAD_MORE_RESULT':
          setPullRequestLoadingMore(prev => ({ ...prev, [msg.repoId]: false }));
          if (msg.repo) {
            setPullRequestRepos(prev => prev.map(r => r.repoId === msg.repoId ? msg.repo! : r));
          }
          break;

        case 'PULLREQUEST_INVALIDATED':
          requestPullRequestList(true);
          break;

        case 'ISSUE_LIST_RESULT':
          setIssueLoading(false);
          setIssueRepos(msg.repos);
          break;

        case 'ISSUE_LIST_START': {
          issuePendingRef.current = new Set(msg.repoIds);
          setIssueLoading(true);
          const metas = useCommitStore.getState().repoMetas;
          setIssueRepos(msg.repoIds.map(repoId => {
            const meta = metas.find(m => m.id === repoId);
            return {
              repoId, repoName: meta?.name ?? repoId, repoColor: meta?.color ?? '#888',
              connection: { repoId, provider: 'unknown', host: '', connected: false, detectionFailed: false },
              issues: [], hasMore: false, pending: true,
            };
          }));
          break;
        }

        case 'ISSUE_LIST_REPO_RESULT':
          setIssueRepos(prev => {
            const idx = prev.findIndex(r => r.repoId === msg.repo.repoId);
            if (idx === -1) return [...prev, msg.repo];
            const next = [...prev];
            next[idx] = msg.repo;
            return next;
          });
          issuePendingRef.current.delete(msg.repo.repoId);
          if (issuePendingRef.current.size === 0) setIssueLoading(false);
          break;

        case 'ISSUE_LOAD_MORE_RESULT':
          setIssueLoadingMore(prev => ({ ...prev, [msg.repoId]: false }));
          if (msg.repo) setIssueRepos(prev => prev.map(r => r.repoId === msg.repoId ? msg.repo! : r));
          break;

        case 'ISSUE_INVALIDATED':
          // Only re-fetch a list that was loaded already — an unopened tab loads its own when first shown.
          if (issueListRequestedRef.current) requestIssueList(true);
          break;

        case 'COMMIT_INSERT_TEXT':
          setCommitInsert({ id: Date.now(), text: msg.text });
          break;

        case 'COMMIT_PANEL_CONFIG':
          setPanelConfig(msg.config);
          break;

        case 'COMMIT_SWITCH_TAB':
          setActiveTab(msg.tab);
          if (msg.tab === 'push') repos.forEach(r => requestUnpushedCommits(r.repoId));
          if (msg.tab === 'pullrequests') requestPullRequestList();
          if (msg.tab === 'issues') requestIssueList();
          break;

        case 'COMMIT_DESELECT_FILE':
          setSelectedFile(prev => {
            if (!prev) return null;
            const repo = useCommitStore.getState().status?.repos.find(r => r.repoId === prev.repoId);
            if (!repo) return null;
            const absPath = msg.filePath;
            const matches = absPath.endsWith('/' + prev.path) || absPath.endsWith('\\' + prev.path) || absPath === prev.path;
            return matches ? null : prev;
          });
          break;
      }
    };
    window.addEventListener('message', handler);
    send({ type: 'COMMIT_REQUEST_STATUS' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Shelve callbacks ──────────────────────────────────────────────────────

  const requestShelveList = useCallback((repoId: string) => {
    setShelveLoading(prev => ({ ...prev, [repoId]: true }));
    send({ type: 'SHELVE_LIST', requestId: generateId(), repoId });
  }, [send]);

  const confirmShelve = useCallback((repoId: string, name: string, paths?: string[]) => {
    if (!name.trim()) return;
    send({ type: 'SHELVE_PUSH', requestId: generateId(), repoId, name: name.trim(), paths });
    setShelvePrompt(null);
  }, [send]);

  const handleUnshelve = useCallback((repoId: string, shelveId: string) => {
    send({ type: 'SHELVE_APPLY', requestId: generateId(), repoId, shelveId });
  }, [send]);

  const handleUnshelveFile = useCallback((repoId: string, shelveId: string, filePath: string) => {
    send({ type: 'SHELVE_APPLY', requestId: generateId(), repoId, shelveId, paths: [filePath] });
  }, [send]);

  const handleDropShelve = useCallback((repoId: string, shelveId: string) => {
    send({ type: 'SHELVE_DROP', requestId: generateId(), repoId, shelveId });
  }, [send]);

  const handleRenameShelve = useCallback((repoId: string, shelveId: string, currentName: string) => {
    send({ type: 'SHELVE_RENAME', requestId: generateId(), repoId, shelveId, currentName });
  }, [send]);

  const handleOpenFileDiff = useCallback((repoId: string, shelveId: string, filePath: string) => {
    send({ type: 'SHELVE_OPEN_FILE_DIFF', repoId, shelveId, filePath });
  }, [send]);

  // ── Stash callbacks ───────────────────────────────────────────────────────

  const requestStashList = useCallback((repoId: string) => {
    setStashLoading(prev => ({ ...prev, [repoId]: true }));
    send({ type: 'STASH_LIST', requestId: generateId(), repoId });
  }, [send]);

  const handleStashApply = useCallback((repoId: string, stashRef: string) => {
    send({ type: 'STASH_APPLY', requestId: generateId(), repoId, stashRef });
  }, [send]);

  const handleStashPop = useCallback((repoId: string, stashRef: string) => {
    send({ type: 'STASH_POP', requestId: generateId(), repoId, stashRef });
  }, [send]);

  const handleStashDrop = useCallback((repoId: string, stashRef: string) => {
    send({ type: 'STASH_DROP', requestId: generateId(), repoId, stashRef });
  }, [send]);

  const handleRenameStash = useCallback((repoId: string, stashRef: string, currentMessage: string) => {
    send({ type: 'STASH_RENAME', requestId: generateId(), repoId, stashRef, currentMessage });
  }, [send]);

  const handleStashShowFileDiff = useCallback((repoId: string, stashRef: string, filePath: string) => {
    send({ type: 'STASH_OPEN_FILE_DIFF', repoId, stashRef, filePath });
  }, [send]);

  // ── Worktree callbacks ────────────────────────────────────────────────────

  const requestWorktreeList = useCallback(() => {
    setWorktreeLoading(true);
    setWorktreeError(null);
    send({ type: 'WORKTREE_REQUEST_LIST' });
  }, [send]);

  const handleWorktreeDelete = useCallback((repoId: string, worktreePath: string, force: boolean) => {
    send({ type: 'WORKTREE_DELETE', requestId: generateId(), repoId, worktreePath, force });
  }, [send]);

  const handleWorktreeLock = useCallback((repoId: string, worktreePath: string) => {
    send({ type: 'WORKTREE_LOCK', requestId: generateId(), repoId, worktreePath });
  }, [send]);

  const handleWorktreeUnlock = useCallback((repoId: string, worktreePath: string) => {
    send({ type: 'WORKTREE_UNLOCK', requestId: generateId(), repoId, worktreePath });
  }, [send]);

  const handleWorktreePrune = useCallback((repoId: string) => {
    send({ type: 'WORKTREE_PRUNE', requestId: generateId(), repoId });
  }, [send]);

  const handleWorktreeOpenInExplorer = useCallback((repoId: string, worktreePath: string) => {
    send({ type: 'WORKTREE_OPEN_IN_EXPLORER', repoId, worktreePath });
  }, [send]);

  const handleWorktreeOpenInNewWindow = useCallback((worktreePath: string) => {
    send({ type: 'WORKTREE_OPEN_IN_NEW_WINDOW', worktreePath });
  }, [send]);

  const handleWorktreeOpenInOS = useCallback((worktreePath: string) => {
    send({ type: 'WORKTREE_OPEN_IN_OS', worktreePath });
  }, [send]);

  const handleWorktreeAddToWorkspace = useCallback((worktreePath: string) => {
    send({ type: 'WORKTREE_ADD_TO_WORKSPACE', worktreePath });
  }, [send]);

  const handleWorktreeRequestCreate = useCallback((repoId: string) => {
    send({ type: 'WORKTREE_CREATE_PROMPT', repoId } as CommitToHostMsg);
  }, [send]);

  // ── Pull Request callbacks ────────────────────────────────────────────────

  const requestPullRequestList = useCallback((forceRefresh?: boolean) => {
    send({ type: 'PULLREQUEST_REQUEST_LIST', forceRefresh });
  }, [send]);

  // Loads PRs in the background on mount (regardless of the active tab) so the tab badge count is populated right away.
  useEffect(() => {
    requestPullRequestList();
  }, [requestPullRequestList]);

  const handlePrOpenFilters = useCallback((repoId: string) => {
    send({ type: 'PULLREQUEST_FILTERS_PROMPT', repoId });
  }, [send]);

  const handlePrOpenSearch = useCallback((repoId: string) => {
    send({ type: 'PULLREQUEST_SEARCH_PROMPT', repoId });
  }, [send]);

  const handlePrRefreshRepo = useCallback((repoId: string) => {
    send({ type: 'PULLREQUEST_REFRESH_REPO', repoId });
  }, [send]);

  const handlePrLoadMore = useCallback((repoId: string) => {
    setPullRequestLoadingMore(prev => ({ ...prev, [repoId]: true }));
    send({ type: 'PULLREQUEST_LOAD_MORE', repoId });
  }, [send]);

  // Accordion — only one repo section can be expanded at a time.
  const handlePrToggleExpanded = useCallback((repoId: string) => {
    setExpandedPrRepoIds(prev => (prev.has(repoId) ? new Set() : new Set([repoId])));
  }, []);

  const handlePrOpenInBrowser = useCallback((url: string) => {
    send({ type: 'PULLREQUEST_OPEN_IN_BROWSER', url });
  }, [send]);

  const handlePrOpenDetail = useCallback((repoId: string, pr: PullRequestSummary) => {
    send({ type: 'PULLREQUEST_OPEN_DETAIL', repoId, pr });
  }, [send]);

  const handlePrOpenAccountPicker = useCallback((repoId: string) => {
    send({ type: 'PULLREQUEST_OPEN_ACCOUNT_PICKER', repoId });
  }, [send]);

  const handlePrRequestCreate = useCallback((repoId: string) => {
    send({ type: 'PULLREQUEST_CREATE_PROMPT', repoId });
  }, [send]);

  const handlePrSetHostOverride = useCallback((host: string, provider: ForgeProvider) => {
    send({ type: 'PULLREQUEST_SET_HOST_PROVIDER_OVERRIDE', host, provider });
  }, [send]);

  // ── Issue callbacks ───────────────────────────────────────────────────────

  /** Whether the issue list was ever asked for — issues load on demand, unlike pull requests. */
  const issueListRequestedRef = useRef(false);
  const requestIssueList = useCallback((forceRefresh?: boolean) => {
    issueListRequestedRef.current = true;
    send({ type: 'ISSUE_REQUEST_LIST', forceRefresh });
  }, [send]);

  const handleIssueLoadMore = useCallback((repoId: string) => {
    setIssueLoadingMore(prev => ({ ...prev, [repoId]: true }));
    send({ type: 'ISSUE_LOAD_MORE', repoId });
  }, [send]);

  // Accordion — only one repo section can be expanded at a time.
  const handleIssueToggleExpanded = useCallback((repoId: string) => {
    setExpandedIssueRepoIds(prev => (prev.has(repoId) ? new Set() : new Set([repoId])));
  }, []);

  const issueHandlers = useMemo(() => ({
    onToggleExpanded: handleIssueToggleExpanded,
    onOpenInBrowser: (url: string) => send({ type: 'ISSUE_OPEN_IN_BROWSER', url }),
    onOpenDetail: (repoId: string, issue: IssueSummary) => send({ type: 'ISSUE_OPEN_DETAIL', repoId, issue }),
    onCreateBranch: (repoId: string, issue: IssueSummary) => send({ type: 'ISSUE_CREATE_BRANCH', repoId, issue }),
    onInsertReference: (issue: IssueSummary) => send({ type: 'ISSUE_INSERT_REFERENCE', issue }),
    // One connection per repository serves both tabs, so connecting goes through the Pull Requests account picker.
    onOpenAccountPicker: (repoId: string) => send({ type: 'PULLREQUEST_OPEN_ACCOUNT_PICKER', repoId }),
    onRequestCreate: (repoId: string) => send({ type: 'ISSUE_CREATE_PROMPT', repoId }),
    onRefresh: (repoId: string) => send({ type: 'ISSUE_REFRESH_REPO', repoId }),
    onSetHostOverride: (host: string, provider: ForgeProvider) => send({ type: 'PULLREQUEST_SET_HOST_PROVIDER_OVERRIDE', host, provider }),
    onOpenFilters: (repoId: string) => send({ type: 'ISSUE_FILTERS_PROMPT', repoId }),
    onOpenSearch: (repoId: string) => send({ type: 'ISSUE_SEARCH_PROMPT', repoId }),
  }), [send, handleIssueToggleExpanded]);

  // ── Push / unpushed callbacks ─────────────────────────────────────────────

  const requestUnpushedCommits = useCallback((repoId: string) => {
    setUnpushedMap(prev => ({
      ...prev,
      // Keep existing commits visible while refreshing; only clear on first load
      [repoId]: prev[repoId]
        ? { ...prev[repoId], loading: true }
        : { loading: true, commits: [] },
    }));
    send({ type: 'PUSH_GET_UNPUSHED', requestId: generateId(), repoId });
  }, [send]);

  // ── Diff open ─────────────────────────────────────────────────────────────
  const openDiff = useCallback((repoId: string, filePath: string) => {
    const repoStatus = store.status?.repos.find(r => r.repoId === repoId);
    const isStaged = repoStatus?.stagedFiles.some(f => f.path === filePath) ?? false;
    send({ type: 'COMMIT_OPEN_DIFF', repoId, filePath, staged: isStaged });
  }, [store.status, send]);

  const { hiddenRepoIds, hideReposWithoutChanges, repoSortMode } = store.viewAndSort;
  const allRepos = store.status?.repos ?? [];
  const visibleRepos = hiddenRepoIds.length > 0 ? allRepos.filter(r => !hiddenRepoIds.includes(r.repoId)) : allRepos;
  const repos = sortRepos(visibleRepos, repoSortMode, store.repoMetas);
  const changedRepos = repos.filter(r => r.stagedFiles.length > 0 || r.unstagedFiles.length > 0);
  const changesRepos = hideReposWithoutChanges ? changedRepos : repos;
  const metaMap = new Map(store.repoMetas.map(m => [m.id, m]));
  const multiRepo = repos.length >= 1;
  const changesMultiRepo = changesRepos.length >= 1;
  // The neutral repo-header look (repo icon, no color) is for a workspace with one repo; a
  // single repo left after a filter (no changes, nothing shelved…) keeps its color and dot.
  const workspaceSingleRepo = allRepos.length === 1;

  // Shelf and Stash list only the repos that have entries (or an error to show), so each tab
  // needs every repo's list — not only those of the panels on screen, which used to load
  // their own on mount. Repos that turn out empty are left out, and the tab says so when none
  // remain. The only repo listed is shown as the single one: open, with the repo icon.
  const repoIdsKey = repos.map(r => r.repoId).join('\n');
  useEffect(() => {
    if (activeTab === 'shelf') repos.forEach(r => { if (!(r.repoId in shelveMap) && !shelveLoading[r.repoId]) requestShelveList(r.repoId); });
    if (activeTab === 'stash') repos.forEach(r => { if (!(r.repoId in stashMap) && !stashLoading[r.repoId]) requestStashList(r.repoId); });
  }, [activeTab, repoIdsKey]);

  // The first configuration from the host picks the tab to open on (gitcharm.commitPanel.defaultTab); from then
  // on, every tab change is reported back, for the "last used" default.
  const initialTabAppliedRef = useRef(false);
  useEffect(() => {
    if (!panelConfig || initialTabAppliedRef.current) return;
    initialTabAppliedRef.current = true;
    const tab = panelConfig.initialTab;
    if (tab === 'changes') return;
    setActiveTab(tab);
    if (tab === 'push') repos.forEach(r => requestUnpushedCommits(r.repoId));
    if (tab === 'worktree') requestWorktreeList();
    if (tab === 'pullrequests') requestPullRequestList();
    if (tab === 'issues') requestIssueList();
  }, [panelConfig]);
  // The Issues badge (off by default) needs the lists even with the tab closed.
  useEffect(() => {
    if (panelConfig?.badges.issues && panelConfig.tabs.includes('issues') && !issueListRequestedRef.current) requestIssueList();
  }, [panelConfig]);
  useEffect(() => {
    if (initialTabAppliedRef.current) send({ type: 'COMMIT_ACTIVE_TAB', tab: activeTab });
  }, [activeTab]);

  // The Shelf and Stash badges (off by default) need every repo's list even with the tab closed. Shelves and stashes
  // can change outside the panel (a terminal, another window), so the lists are asked for again, quietly and at most
  // every few seconds, as the status changes. Worktrees come with every status change already.
  const shelfBadge = !!panelConfig?.badges.shelf;
  const stashBadge = !!panelConfig?.badges.stash;
  const worktreeBadge = !!panelConfig?.badges.worktree;
  useEffect(() => {
    if (!shelfBadge && !stashBadge) return;
    const timer = setTimeout(() => {
      for (const r of repos) {
        if (shelfBadge) send({ type: 'SHELVE_LIST', requestId: generateId(), repoId: r.repoId });
        if (stashBadge) send({ type: 'STASH_LIST', requestId: generateId(), repoId: r.repoId });
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [shelfBadge, stashBadge, store.status]);
  useEffect(() => {
    if (worktreeBadge && worktreeRepos.length === 0) send({ type: 'WORKTREE_REQUEST_LIST' });
  }, [worktreeBadge]);
  const worktreeBranchOf = (repoStatus: RepoStatus) => metaMap.get(repoStatus.repoId)?.isWorktree
    ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
    : undefined;
  const stashesOf = (repoStatus: RepoStatus) => {
    const worktreeBranch = worktreeBranchOf(repoStatus);
    return (stashMap[repoStatus.repoId] ?? []).filter(s => !worktreeBranch || s.branch === worktreeBranch);
  };
  // The name the first tab goes by in the current view mode, for the Shelf/Stash hints that point to it.
  const changesTabName = (store.changesViewMode === 'changelists' || store.changesViewMode === 'vscode')
    ? l10n.t({ message: 'Commit', comment: ['Tab title: the tab with the commit form and changed files'] })
    : l10n.t({ message: 'Changes', comment: ['Tab title: list of changed files'] });
  const shelfRepos = repos.filter(r => (shelveMap[r.repoId]?.length ?? 0) > 0 || !!shelveError[r.repoId]);
  const stashRepos = repos.filter(r => stashesOf(r).length > 0 || !!stashError[r.repoId]);

  // Keep unpushed-commit counts fresh for repos without upstream so the Push tab badge
  // shows the correct number even before the tab is opened. Upstream repos are live via aheadBehind.ahead.
  // Full refresh on every status update is intentionally avoided to prevent visual noise.
  const noUpstreamKey = repos.filter(r => !r.branch.upstream).map(r => r.repoId).join(',');
  useEffect(() => {
    if (!noUpstreamKey) return;
    noUpstreamKey.split(',').forEach(id => requestUnpushedCommits(id));
  }, [noUpstreamKey]);

  // ── Context menu handlers ─────────────────────────────────────────────────

  const doStash = useCallback((repoId: string, message: string, paths?: string[]) => {
    send({ type: 'STASH_PUSH', requestId: generateId(), repoId, message, paths } satisfies CommitToHostMsg);
  }, [send]);

  const handleMultiSelect = useCallback((file: FileStatus) => {
    setMultiSelectedFiles(prev =>
      prev.some(f => f.repoId === file.repoId && f.path === file.path)
        ? prev.filter(f => !(f.repoId === file.repoId && f.path === file.path))
        : [...prev, file]
    );
  }, []);

  const handleContextMenuSelect = useCallback((id: string) => {
    const file = ctxMenu?.file;
    if (!file) return;
    switch (id) {
      case 'stage':
        send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: file.repoId, paths: [file.path] });
        break;
      case 'unstage':
        send({ type: 'COMMIT_UNSTAGE_FILES', requestId: generateId(), repoId: file.repoId, paths: [file.path] });
        break;
      case 'resolve':
        send({ type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: file.repoId, filePath: file.path });
        break;
      case 'resolveAi':
        send({ type: 'COMMIT_RESOLVE_CONFLICTS_AI', repoId: file.repoId, filePath: file.path });
        break;
      case 'rollback':
        send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: file.repoId, path: file.path });
        break;
      case 'shelve':
        send({ type: 'SHELVE_PUSH', requestId: generateId(), repoId: file.repoId, name: 'Changes', paths: [file.path] });
        break;
      case 'stash':
        doStash(file.repoId, 'Changes', [file.path]);
        break;
      case 'diff':
        openDiff(file.repoId, file.path);
        break;
      case 'compare-with':
        send({ type: 'COMMIT_COMPARE_FILE_WITH', repoId: file.repoId, filePath: file.path });
        break;
      case 'file-history':
        send({ type: 'COMMIT_SHOW_FILE_HISTORY', repoId: file.repoId, filePath: file.path });
        break;
      case 'jump':
        send({ type: 'COMMIT_OPEN_FILE', repoId: file.repoId, filePath: file.path });
        break;
      case 'reveal-explorer':
        send({ type: 'COMMIT_REVEAL_IN_EXPLORER', repoId: file.repoId, filePath: file.path });
        break;
      case 'reveal-os':
        send({ type: 'COMMIT_REVEAL_IN_OS', repoId: file.repoId, filePath: file.path });
        break;
      case 'gitignore':
        send({ type: 'COMMIT_ADD_TO_GITIGNORE', repoId: file.repoId, entryPath: file.path });
        break;
      case 'delete':
        send({ type: 'COMMIT_DELETE_FILE', requestId: generateId(), repoId: file.repoId, filePath: file.path });
        break;
      case 'refresh':
        send({ type: 'COMMIT_REQUEST_STATUS' });
        break;
    }
  }, [ctxMenu, openDiff, doStash, send]);

  const handleFolderContextMenuSelect = useCallback((id: string) => {
    const ctx = folderCtxMenu;
    if (!ctx) return;
    switch (id) {
      case 'stage':
        send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: ctx.repoId, paths: ctx.files.map(f => f.path) });
        break;
      case 'unstage':
        send({ type: 'COMMIT_UNSTAGE_FILES', requestId: generateId(), repoId: ctx.repoId, paths: ctx.files.map(f => f.path) });
        break;
      case 'rollback':
        send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: ctx.files.map(f => ({ repoId: f.repoId, path: f.path })) });
        break;
      case 'shelve':
        send({ type: 'SHELVE_PUSH', requestId: generateId(), repoId: ctx.repoId, name: 'Changes', paths: ctx.files.map(f => f.path) });
        break;
      case 'stash':
        doStash(ctx.repoId, 'Changes', ctx.files.map(f => f.path));
        break;
      case 'compare-with':
        send({ type: 'COMMIT_COMPARE_FOLDER_WITH', repoId: ctx.repoId, folderPath: ctx.folderPath });
        break;
      case 'gitignore':
        send({ type: 'COMMIT_ADD_TO_GITIGNORE', repoId: ctx.repoId, entryPath: ctx.folderPath });
        break;
      case 'delete':
        send({ type: 'COMMIT_DELETE_FOLDER', requestId: generateId(), repoId: ctx.repoId, folderPath: ctx.folderPath });
        break;
      case 'refresh':
        send({ type: 'COMMIT_REQUEST_STATUS' });
        break;
    }
  }, [folderCtxMenu, doStash, send]);

  const handleRepoContextMenuSelect = useCallback((id: string) => {
    const ctx = repoCtxMenu;
    if (!ctx) return;
    const repoStatus = repos.find(r => r.repoId === ctx.repoId);
    switch (id) {
      case 'stage-all':
        send({ type: 'COMMIT_STAGE_ALL', requestId: generateId(), repoId: ctx.repoId });
        break;
      case 'unstage-all':
        send({ type: 'COMMIT_UNSTAGE_ALL', requestId: generateId(), repoId: ctx.repoId });
        break;
      case 'rollback': {
        const fileMap = new Map<string, FileStatus>();
        for (const f of repoStatus?.unstagedFiles ?? []) fileMap.set(f.path, f);
        for (const f of repoStatus?.stagedFiles ?? []) fileMap.set(f.path, f);
        const allFiles = Array.from(fileMap.values());
        if (allFiles.length > 0) {
          send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: allFiles.map(f => ({ repoId: f.repoId, path: f.path })) });
        }
        break;
      }
      case 'shelve':
        confirmShelve(ctx.repoId, 'Changes');
        break;
      case 'stash':
        doStash(ctx.repoId, 'WIP stash');
        break;
      case 'manage-repo':
        send({ type: 'COMMIT_MANAGE_REPO', repoId: ctx.repoId });
        break;
      case 'view-git-log':
        send({ type: 'COMMIT_VIEW_GIT_LOG', repoId: ctx.repoId });
        break;
      case 'reveal-explorer':
        send({ type: 'COMMIT_REVEAL_REPO_IN_EXPLORER', repoId: ctx.repoId });
        break;
      case 'open-new-window':
        send({ type: 'COMMIT_OPEN_REPO_IN_NEW_WINDOW', repoId: ctx.repoId });
        break;
      case 'reveal-os':
        send({ type: 'COMMIT_REVEAL_REPO_IN_OS', repoId: ctx.repoId });
        break;
      case 'hide-repo':
        send({ type: 'COMMIT_HIDE_REPO', repoId: ctx.repoId });
        break;
      case 'refresh':
        send({ type: 'COMMIT_REQUEST_STATUS' });
        break;
    }
  }, [repoCtxMenu, repos, doStash, confirmShelve, send]);

  // ── Changelist actions ────────────────────────────────────────────────────

  const handleClHeaderContextMenuSelect = useCallback((id: string) => {
    const ctx = clHeaderCtxMenu;
    if (!ctx) return;
    switch (id) {
      case 'cl-rollback': {
        const cl = store.changelists.find(c => c.id === ctx.changelistId);
        if (!cl) break;
        const files = Object.entries(cl.fileAssignments).flatMap(([repoId, paths]) =>
          paths.map(path => ({ repoId, path }))
        );
        if (files.length > 0) send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files } satisfies CommitToHostMsg);
        break;
      }
      case 'cl-shelve':
        send({ type: 'CHANGELISTS_SHELVE', changelistId: ctx.changelistId, requestId: generateId() } satisfies CommitToHostMsg);
        break;
      case 'cl-stash':
        send({ type: 'CHANGELISTS_STASH', changelistId: ctx.changelistId, requestId: generateId() } satisfies CommitToHostMsg);
        break;
      case 'cl-add-to-git': {
        const untrackedByRepo = new Map<string, string[]>();
        for (const r of repos) {
          const paths = r.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path);
          if (paths.length > 0) untrackedByRepo.set(r.repoId, paths);
        }
        for (const [repoId, paths] of untrackedByRepo) {
          send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId, paths } satisfies CommitToHostMsg);
        }
        break;
      }
      case 'cl-new':
        send({ type: 'CHANGELISTS_CREATE_PROMPT' } satisfies CommitToHostMsg);
        break;
      case 'cl-rename': {
        const cl = store.changelists.find(c => c.id === ctx.changelistId);
        if (cl) send({ type: 'CHANGELISTS_RENAME_PROMPT', id: cl.id, currentName: cl.name } satisfies CommitToHostMsg);
        break;
      }
      case 'cl-delete':
        send({ type: 'CHANGELISTS_DELETE', id: ctx.changelistId } satisfies CommitToHostMsg);
        break;
      case 'refresh':
        send({ type: 'COMMIT_REQUEST_STATUS' });
        break;
    }
  }, [clHeaderCtxMenu, store.changelists, changesRepos, send]);

  // ── Push actions ──────────────────────────────────────────────────────────

  const doPush = (repoId: string) => {
    const remote = useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName ?? 'origin';
    send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId, remote });
  };

  const doForcePush = (repoId: string) => {
    const remote = useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName ?? 'origin';
    send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId, remote, force: true });
  };

  const doSquash = (repoId: string, hashes: string[], oldestHash: string, combinedMessage: string, commits: { hash: string; shortHash: string; message: string }[]) => {
    send({ type: 'PUSH_SQUASH_COMMITS', requestId: generateId(), repoId, hashes, oldestHash, message: combinedMessage, commits } satisfies CommitToHostMsg);
  };

  const doDropCommits = (repoId: string, hashes: string[], oldestHash: string) => {
    send({ type: 'PUSH_DROP_COMMITS', requestId: generateId(), repoId, hashes, oldestHash } satisfies CommitToHostMsg);
  };

  const doRevertCommits = (repoId: string, hashes: string[]) => {
    send({ type: 'PUSH_REVERT_COMMITS', requestId: generateId(), repoId, hashes } satisfies CommitToHostMsg);
  };

  const doEditCommitMsg = (repoId: string, hash: string, currentMessage: string) => {
    send({ type: 'PUSH_EDIT_COMMIT_MSG', requestId: generateId(), repoId, hash, currentMessage } satisfies CommitToHostMsg);
  };

  const doOpenInLog = (hash: string, repoId: string) => {
    send({ type: 'COMMIT_OPEN_LOG', hash, repoId });
  };

  const doPushOpenDetail = (repoId: string, hash: string) => {
    send({ type: 'PUSH_OPEN_DETAIL', repoId, hash } satisfies CommitToHostMsg);
  };

  const doPushOpenChanges = (repoId: string, hash: string) => {
    send({ type: 'PUSH_OPEN_COMMIT_CHANGES', repoId, hash } satisfies CommitToHostMsg);
  };

  const doPushExplainCommit = (repoId: string, hash: string) => {
    send({ type: 'PUSH_EXPLAIN_COMMIT', repoId, hash } satisfies CommitToHostMsg);
  };

  const doPushViewCombinedDiff = (repoId: string, hashes: string[]) => {
    send({ type: 'PUSH_VIEW_COMBINED_DIFF', repoId, hashes } satisfies CommitToHostMsg);
  };

  const doUndoCommit = (repoId: string) => {
    send({ type: 'COMMIT_UNDO_COMMIT', requestId: generateId(), repoId });
  };

  const doPushAll = () => {
    const allRepos = useCommitStore.getState().status?.repos ?? [];
    for (const r of allRepos) {
      if ((r.branch.aheadBehind?.ahead ?? 0) > 0) {
        const remote = r.branch.remoteName ?? 'origin';
        send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId: r.repoId, remote });
      }
    }
  };

  // rebase omitted: the host asks merge or rebase.
  const doPull = (repoId: string, rebase?: boolean) => {
    send({ type: 'COMMIT_PULL_REPO', requestId: generateId(), repoId, rebase });
  };

  const doFetch = (repoId: string) => {
    send({ type: 'COMMIT_FETCH_REPO', requestId: generateId(), repoId } satisfies CommitToHostMsg);
  };

  // Push, pull or both as each repo needs; the host asks how to reconcile a diverged branch.
  const doSyncRepos = (repoIds: string[]) => {
    send({ type: 'COMMIT_SYNC_REPOS', requestId: generateId(), repoIds } satisfies CommitToHostMsg);
  };

  // Commit-tab publish/sync button. Publish and the explicit dropdown entries map straight
  // onto push/pull; 'sync' goes to the host, which works out whether a plain pull is enough
  // or the divergence needs a rebase/force decision from the user.
  const doSyncAction = (action: SyncAction, repoIds: string[]) => {
    switch (action) {
      case 'publish':
      case 'push':
        repoIds.forEach(doPush);
        break;
      case 'pull':
        repoIds.forEach(id => doPull(id, false));
        break;
      case 'sync':
        send({ type: 'COMMIT_SYNC_REPOS', requestId: generateId(), repoIds } satisfies CommitToHostMsg);
        break;
      case 'none':
        break;
    }
  };

  // ── Autopilot ─────────────────────────────────────────────────────────────

  const doAutopilot = useCallback(() => {
    if (generatingMessage) return;
    setGeneratingMessage(true);
    messageBeforeGenerate.current = useCommitStore.getState().commitMessage;
    send({ type: 'COMMIT_GENERATE_MESSAGE', requestId: generateId() });
  }, [generatingMessage, send]);

  const doAutopilotContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    send({ type: 'COMMIT_SELECT_AI_MODEL' });
  }, [send]);

  // ── Loading / empty states ────────────────────────────────────────────────

  if (repos.length === 0 && !store.status) {
    return (
      <div style={css.fullCenter}>
        <span style={{ opacity: 0.5, fontSize: '13px' }}>{l10n.t('Loading repositories…')}</span>
      </div>
    );
  }

  if (repos.length === 0 && store.status) {
    if (!store.hasWorkspaceFolder) {
      return (
        <div style={{ ...css.fullCenter, flexDirection: 'column', gap: '12px', padding: '24px' }}>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
            {l10n.t('You have not yet opened a folder.')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '200px' }}>
            <button style={css.initRepoBtn} onClick={() => send({ type: 'COMMIT_OPEN_FOLDER' } as CommitToHostMsg)}>{l10n.t('Open Folder')}</button>
            <button style={css.initRepoBtn} onClick={() => send({ type: 'COMMIT_CLONE_REPO' } as CommitToHostMsg)}>{l10n.t('Clone Repository')}</button>
          </div>
        </div>
      );
    }
    if (store.repoMetas.length === 0) {
      return (
        <div style={{ ...css.fullCenter, flexDirection: 'column', gap: '12px', padding: '24px' }}>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
            {l10n.t("The folder currently open doesn't have a Git repository. You can initialize a repository which will enable source control features powered by Git.")}
          </div>
          <button
            style={css.initRepoBtn}
            onClick={() => send({ type: 'COMMIT_INIT_REPO' } as CommitToHostMsg)}
          >
            {l10n.t('Initialize Repository')}
          </button>
        </div>
      );
    }
    return (
      <div style={css.fullCenter}>
        <div style={{ textAlign: 'center', opacity: 0.45 }}>
          <div style={{ fontSize: '22px' }}>✓</div>
          <div style={{ fontSize: '13px', marginTop: '6px' }}>{l10n.t('No changes in workspace')}</div>
        </div>
      </div>
    );
  }

  // ── Commit action ─────────────────────────────────────────────────────────

  const doCommit = (andPush: boolean) => {
    if (!store.commitMessage.trim()) return;
    // Read fresh state at commit time to avoid stale closure values
    const freshState = useCommitStore.getState();
    const currentRepos = freshState.status?.repos ?? [];

    // Amend is only ever valid when exactly one repo is the commit target and that repo
    // is ahead of its upstream — the same condition that shows the Amend checkbox in
    // UnifiedCommitForm. amendFlags can stay "armed" after the checkbox is hidden (e.g.
    // after a push drops `ahead` to 0, or after switching to a multi-repo selection), so
    // re-check the condition here rather than trusting the stored flag as-is.
    const resolveAmend = (repoId: string, targetCount: number): boolean => {
      if (targetCount !== 1) return false;
      if (!(freshState.amendFlags[repoId] ?? false)) return false;
      const repoStatus = currentRepos.find(rs => rs.repoId === repoId);
      return (repoStatus?.branch.aheadBehind?.ahead ?? 0) > 0;
    };

    // In vscode mode, commit only what's already staged — no stage/unstage manipulation
    if (freshState.changesViewMode === 'vscode') {
      const selectedSet = vscodeSelectedRepos;
      const candidates = currentRepos.filter(r => r.stagedFiles.length > 0 && selectedSet.has(r.repoId));
      const targets = candidates.map(r => ({
        repoId: r.repoId,
        message: freshState.commitMessage,
        amend: resolveAmend(r.repoId, candidates.length),
        filesToStage: [],
        filesToUnstage: [],
      }));
      if (targets.length === 0) return;
      store.setLoading(true);

      const requestId = generateId();
      pendingCommitRef.current = { requestId, repoIds: targets.map(t => t.repoId) };
      getVsCodeApi().postMessage({ type: 'COMMIT_DO_COMMIT_MULTI', requestId, repos: targets, andPush } satisfies CommitToHostMsg);
      return;
    }

    const candidates = currentRepos
      .filter(r => freshState.repoSelections[r.repoId] !== false)
      .map(r => {
        const repoId = r.repoId;
        const selectedPaths = new Set(freshState.getSelectedFilesForRepo(repoId));
        const stagedPaths = new Set(r.stagedFiles.map(f => f.path));
        const unstagedPaths = new Set(r.unstagedFiles.map(f => f.path));
        // Include partially-staged files so their unstaged changes are also committed.
        const filesToStage = Array.from(selectedPaths).filter(p => !stagedPaths.has(p) || unstagedPaths.has(p));
        const filesToUnstage = r.stagedFiles.map(f => f.path).filter(p => !selectedPaths.has(p));
        return { repoId, filesToStage, filesToUnstage };
      })
      .filter(r => {
        const repoStatus = currentRepos.find(rs => rs.repoId === r.repoId)!;
        const stagedAfter = new Set(repoStatus.stagedFiles.map(f => f.path));
        for (const p of r.filesToUnstage) stagedAfter.delete(p);
        for (const p of r.filesToStage) stagedAfter.add(p);
        return stagedAfter.size > 0;
      });
    const targets = candidates.map(r => ({
      repoId: r.repoId,
      message: freshState.commitMessage,
      amend: resolveAmend(r.repoId, candidates.length),
      filesToStage: r.filesToStage,
      filesToUnstage: r.filesToUnstage,
    }));
    if (targets.length === 0) return;
    store.setLoading(true);
    store.setError(null);
    const requestId = generateId();
    pendingCommitRef.current = { requestId, repoIds: targets.map(t => t.repoId) };
    getVsCodeApi().postMessage({ type: 'COMMIT_DO_COMMIT_MULTI', requestId, repos: targets, andPush } satisfies CommitToHostMsg);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={css.app} onContextMenu={e => e.preventDefault()}>
      {/* ── Tab bar ── */}
      {(() => {
        // Commits out of sync: to push (or the branch to publish, counted as at least one) plus
        // to pull. A detached HEAD has no upstream but nothing to publish either.
        const totalOutOfSync = repos.reduce((sum, r) => {
          const behind = r.branch.aheadBehind?.behind ?? 0;
          if (r.branch.upstream) return sum + (r.branch.aheadBehind?.ahead ?? 0) + behind;
          if (r.isDetachedHead || r.branch.detachedHash || r.branch.detachedTag) return sum;
          return sum + Math.max(1, unpushedMap[r.repoId]?.commits?.length ?? 0);
        }, 0);
        const totalChanges = repos.reduce((sum, r) => {
          const paths = new Set([...r.stagedFiles.map(f => f.path), ...r.unstagedFiles.map(f => f.path)]);
          return sum + paths.size;
        }, 0);
        // Prefer each repo's provider-reported totalCount (exact, filter-aware, no extra pages fetched) over the
        // number of PRs actually downloaded so far — falls back to the downloaded count for providers/queries
        // where no cheap total is available (see ListPullRequestsResult.totalCount).
        const totalShelves = repos.reduce((sum, r) => sum + (shelveMap[r.repoId]?.length ?? 0), 0);
        const totalStashes = repos.reduce((sum, r) => sum + (stashMap[r.repoId]?.length ?? 0), 0);
        // The linked worktrees: every repo has its main one.
        const totalWorktrees = worktreeRepos.reduce((sum, r) => sum + r.worktrees.filter(w => !w.isMain).length, 0);
        const totalPullRequests = pullRequestRepos.reduce((sum, r) => sum + (r.totalCount ?? r.pullRequests.length), 0);
        const totalIssues = issueRepos.reduce((sum, r) => sum + (r.totalCount ?? r.issues.length), 0);
        const changesLabel = (store.changesViewMode === 'changelists' || store.changesViewMode === 'vscode')
          ? l10n.t({ message: 'Commit', comment: ['Tab title: the tab with the commit form and changed files'] })
          : l10n.t({ message: 'Changes', comment: ['Tab title: list of changed files'] });
        const tabMeta = (tab: TabId) => ({
          label: tab === 'changes' ? changesLabel : tab === 'shelf' ? l10n.t('Shelf') : tab === 'stash' ? l10n.t({ message: 'Stash', comment: ['Tab title: list of git stashes'] }) : tab === 'worktree' ? l10n.t('Worktrees') : tab === 'pullrequests' ? l10n.t('Pull Requests') : tab === 'issues' ? l10n.t('Issues') : l10n.t({ message: 'Sync', comment: ['Tab title: remote operations — commits to push and to pull'] }),
          iconName: tab === 'changes' ? 'git-branch-changes' : tab === 'shelf' ? 'archive' : tab === 'stash' ? 'git-stash' : tab === 'worktree' ? 'worktree' : tab === 'pullrequests' ? 'git-pull-request' : tab === 'issues' ? 'issues' : 'cloud',
          badge: !(panelConfig ? panelConfig.badges[tab] : tab === 'changes' || tab === 'push' || tab === 'pullrequests' || tab === 'issues') ? 0
            : tab === 'changes' ? totalChanges : tab === 'push' ? totalOutOfSync : tab === 'pullrequests' ? totalPullRequests : tab === 'issues' ? totalIssues
            : tab === 'shelf' ? totalShelves : tab === 'stash' ? totalStashes : tab === 'worktree' ? totalWorktrees : 0,
        });
        const selectTab = (tab: TabId) => {
          setActiveTab(tab);
          // Skip refetching data that's already loaded — avoids a jarring loading flash every time the
          // tab is reopened; an explicit refresh (per-tab or per-repo) stays available for real refetches.
          if (tab === 'shelf') repos.forEach(r => { if (!(r.repoId in shelveMap)) requestShelveList(r.repoId); });
          if (tab === 'stash') repos.forEach(r => { if (!(r.repoId in stashMap)) requestStashList(r.repoId); });
          if (tab === 'push') repos.forEach(r => requestUnpushedCommits(r.repoId));
          if (tab === 'worktree' && worktreeRepos.length === 0) requestWorktreeList();
          if (tab === 'pullrequests' && pullRequestRepos.length === 0) requestPullRequestList();
          if (tab === 'issues' && !issueListRequestedRef.current) requestIssueList();
        };
        const allTabs = shownTabs;
        const activeMeta = tabMeta(activeTab);
        const labels = panelConfig?.labels ?? 'active';
        const showsLabel = (tab: TabId) => labels === 'always' || (labels === 'active' && tab === activeTab);
        // Longest label among all tabs — used by the width probe below as the one tab whose label
        // gets expanded, since only one tab (the active one) is ever expanded at a time.
        const widestTab = allTabs.reduce((a, b) => displayWidth(tabMeta(b).label) > displayWidth(tabMeta(a).label) ? b : a);
        // Which labels the probe expands: the worst case of the label setting.
        const probeShowsLabel = (tab: TabId) => labels === 'always' || (labels === 'active' && tab === widestTab);
        return (
          <div ref={tabBarRefCb} style={css.tabBar}>
            {/* Real tab strip — hidden (not unmounted) when collapsed, so it keeps its state and re-appears instantly once space is available again. */}
            <div style={tabBarCollapsed ? { display: 'none' } : { display: 'flex', minWidth: 0 }}>
              {allTabs.map(tab => {
                const { label, iconName, badge } = tabMeta(tab);
                return (
                  <button
                    key={tab}
                    style={css.tab(activeTab === tab)}
                    title={label}
                    onClick={() => selectTab(tab)}
                  >
                    <Codicon
                      name={iconName}
                      style={{ marginRight: showsLabel(tab) ? '5px' : '0', fontSize: '13px', transition: 'margin 0.15s' }}
                    />
                    {showsLabel(tab) && (
                      <span style={{ animation: 'gs-tab-label-in 0.18s ease-out both', overflow: 'hidden', display: 'inline-block' }}>
                        {label}
                      </span>
                    )}
                    {badge > 0 && (
                      <span style={css.pushBadge}>{formatBadgeCount(badge)}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Width probe — always mounted off-screen. Only ever one tab has its label expanded at a
                time (the active one), so the worst case is the widest label among all tabs expanded
                alongside the rest icon-only — not every label expanded at once, which would reserve far
                more space than any real state ever needs. This keeps the collapse threshold constant
                regardless of which tab is active (activating "Pull Requests", the longest label, no
                longer collapses the bar at a width where a shorter-labeled tab like "Changes" still fit). */}
            <div
              ref={tabBarContentRefCb}
              aria-hidden="true"
              style={{ display: 'flex', position: 'fixed', left: '-9999px', top: '-9999px', visibility: 'hidden' }}
            >
              {allTabs.map(tab => {
                const { label, iconName, badge } = tabMeta(tab);
                const expanded = probeShowsLabel(tab);
                return (
                  <div key={tab} style={css.tab(expanded)}>
                    <Codicon name={iconName} style={{ marginRight: expanded ? '5px' : '0', fontSize: '13px' }} />
                    {expanded && <span style={{ overflow: 'hidden', display: 'inline-block' }}>{label}</span>}
                    {badge > 0 && (
                      <span style={css.pushBadge}>{formatBadgeCount(badge)}</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Collapsed fallback — single dropdown button showing the active tab. */}
            {tabBarCollapsed && (
              <button
                ref={tabDropdownBtnRef}
                data-tab-dropdown-btn
                style={css.tabDropdownBtn}
                title={activeMeta.label}
                onClick={e => {
                  if (tabMenu) { setTabMenu(null); return; }
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTabMenu({ x: rect.left, y: rect.bottom, width: rect.width });
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
                  <Codicon name={activeMeta.iconName} style={{ marginRight: '5px', fontSize: '13px', flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{activeMeta.label}</span>
                </span>
                {activeMeta.badge > 0 && <span style={{ ...css.pushBadge, flexShrink: 0 }}>{formatBadgeCount(activeMeta.badge)}</span>}
                <Codicon name="chevron-down" style={{ marginLeft: 'auto', paddingLeft: '5px', fontSize: '13px', flexShrink: 0 }} />
              </button>
            )}

            {tabMenu && (
              <ContextMenu
                x={tabMenu.x}
                y={tabMenu.y}
                width={tabMenu.width}
                anchor={tabDropdownBtnRef.current}
                menuStyle={css.tabDropdownMenu}
                // The active tab is already shown on the button itself, so the menu only lists the others.
                items={allTabs.filter(tab => tab !== activeTab).map(tab => {
                  const { label, iconName, badge } = tabMeta(tab);
                  return { id: tab, label, icon: iconName, badge: badge > 0 ? formatBadgeCount(badge) : undefined };
                })}
                onSelect={id => selectTab(id as TabId)}
                onClose={() => setTabMenu(null)}
              />
            )}
          </div>
        );
      })()}

      {/* ── Tab content ── */}
      <div style={css.main}>

        {activeTab === 'changes' && (<>

          {/* File list */}
          <ScrollArea style={css.repoList} onKeyDown={(e) => handleTreeNavKeyDown(e, e.currentTarget)}>
            {hideReposWithoutChanges && changesRepos.length === 0 ? (
              <div style={css.filteredEmptyState}>
                <Codicon name="filter" style={{ fontSize: '18px', opacity: 0.55 }} />
                <div>{l10n.t('No repositories with changes')}</div>
                <button className="gc-btn-secondary" style={css.clearFilterBtn} onClick={() => updateViewAndSort({ hideReposWithoutChanges: false })}>
                  {l10n.t('Show all repositories')}
                </button>
              </div>
            ) : store.changesViewMode === 'vscode' ? (
              <VscodeView
                repos={changesRepos}
                workspaceSingleRepo={workspaceSingleRepo}
                repoMetas={store.repoMetas}
                selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                ctxFile={ctxFile}
                viewMode={store.viewAndSort.fileViewMode}
                isCollapsed={store.isCollapsed}
                toggleCollapsed={store.toggleCollapsed}
                hasExpandedDirs={store.hasExpandedDirs}
                setDirsCollapsed={store.setDirsCollapsed}
                onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                onContextMenu={(e, file, staged) => {
                  if (e.metaKey || e.ctrlKey) {
                    setMultiSelectedFiles(prev =>
                      prev.some(f => f.repoId === file.repoId && f.path === file.path)
                        ? prev.filter(f => !(f.repoId === file.repoId && f.path === file.path))
                        : [...prev, file]
                    );
                    return;
                  }
                  if (multiSelectedFiles.length > 1 && multiSelectedFiles.some(f => f.repoId === file.repoId && f.path === file.path)) {
                    setMultiCtxMenu({ x: e.clientX, y: e.clientY, files: multiSelectedFiles });
                    return;
                  }
                  setMultiSelectedFiles([]);
                  setCtxFile({ repoId: file.repoId, path: file.path });
                  setCtxMenuStaged(staged);
                  setCtxMenu({ x: e.clientX, y: e.clientY, file });
                }}
                onFolderContextMenu={(e, rid, folderPath, files, staged) => {
                  setActiveFolderPath(folderPath);
                  setFolderCtxMenuStaged(staged);
                  setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files });
                }}
                onOpenFile={f => send({ type: 'COMMIT_OPEN_FILE', repoId: f.repoId, filePath: f.path })}
                onRollback={files => {
                  if (files.length === 1) {
                    send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: files[0].repoId, path: files[0].path });
                  } else {
                    send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                  }
                }}
                onResolveMerge={(f, withAi) => send(withAi ? { type: 'COMMIT_RESOLVE_CONFLICTS_AI', repoId: f.repoId, filePath: f.path } : { type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                onStageFiles={(rid, paths) => send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: rid, paths })}
                onUnstageFiles={(rid, paths) => send({ type: 'COMMIT_UNSTAGE_FILES', requestId: generateId(), repoId: rid, paths })}
                onStageAll={rid => send({ type: 'COMMIT_STAGE_ALL', requestId: generateId(), repoId: rid })}
                onUnstageAll={rid => send({ type: 'COMMIT_UNSTAGE_ALL', requestId: generateId(), repoId: rid })}
                onRepoContextMenu={(e, rid, staged) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, stagedSection: staged })}
                onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                onOpenStagedChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid, section: 'staged' })}
                onOpenUnstagedChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid, section: 'unstaged' })}
                iconTheme={store.iconTheme}
                activeFolderPath={activeFolderPath}
                selectedRepos={vscodeSelectedRepos}
                onToggleRepoSelection={toggleVscodeRepoSelection}
                onOpenAllChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
                onMultiSelect={handleMultiSelect}
                multiSelectedFiles={multiSelectedFiles}
              />
            ) : store.changesViewMode === 'changelists' ? (
              <ChangelistView
                changelists={store.changelists}
                repos={changesRepos}
                workspaceSingleRepo={workspaceSingleRepo}
                repoMetas={store.repoMetas}
                selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                viewMode={store.viewAndSort.fileViewMode}
                isFileSelected={store.isFileSelected}
                isCollapsed={store.isCollapsed}
                toggleCollapsed={store.toggleCollapsed}
                hasExpandedDirs={store.hasExpandedDirs}
                setDirsCollapsed={store.setDirsCollapsed}
                onToggleFile={store.toggleFileSelection}
                onSetFiles={store.setFileSelections}
                onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                onContextMenu={(e, file) => {
                  if (e.metaKey || e.ctrlKey) {
                    setMultiSelectedFiles(prev =>
                      prev.some(f => f.repoId === file.repoId && f.path === file.path)
                        ? prev.filter(f => !(f.repoId === file.repoId && f.path === file.path))
                        : [...prev, file]
                    );
                    return;
                  }
                  if (multiSelectedFiles.length > 1 && multiSelectedFiles.some(f => f.repoId === file.repoId && f.path === file.path)) {
                    setMultiCtxMenu({ x: e.clientX, y: e.clientY, files: multiSelectedFiles });
                    return;
                  }
                  setMultiSelectedFiles([]);
                  setCtxFile({ repoId: file.repoId, path: file.path });
                  setCtxMenu({ x: e.clientX, y: e.clientY, file });
                }}
                onFolderContextMenu={(e, rid, folderPath, files) => { setActiveFolderPath(folderPath); setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files }); }}
                onOpenFile={f => send({ type: 'COMMIT_OPEN_FILE', repoId: f.repoId, filePath: f.path })}
                onRollback={files => {
                  if (files.length === 1) {
                    send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: files[0].repoId, path: files[0].path });
                  } else {
                    send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                  }
                }}
                onResolveMerge={(f, withAi) => send(withAi ? { type: 'COMMIT_RESOLVE_CONFLICTS_AI', repoId: f.repoId, filePath: f.path } : { type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                onHeaderContextMenu={(e, clId) => setClHeaderCtxMenu({ x: e.clientX, y: e.clientY, changelistId: clId })}
                onRepoContextMenu={(e, rid, clId) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, changelistId: clId })}
                onOpenChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
                onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                iconTheme={store.iconTheme}
                activeFolderPath={activeFolderPath}
                ctxFile={ctxFile}
                onMultiSelect={handleMultiSelect}
                multiSelectedFiles={multiSelectedFiles}
              />
            ) : (
              changesRepos.map((repoStatus, idx) => {
                const repoId = repoStatus.repoId;
                const meta = metaMap.get(repoId);
                const repoName = meta?.name ?? repoId.split('/').pop() ?? repoId;
                const repoColor = meta?.color ?? '#4ec9b0';
                const detachedCommit = meta?.isSubmodule ? detachedWarnings[repoId] : undefined;
                return (
                  <React.Fragment key={repoId}>
                    {detachedCommit && (
                      <div style={css.detachedBanner}>
                        <Codicon name="git-commit" style={{ flexShrink: 0, opacity: 0.8 }} />
                        <span style={{ flex: 1 }}>
                          {l10n.t('{0} is in detached HEAD ({1}). Checkout a branch to commit.', repoName, detachedCommit)}
                        </span>
                        <button
                          className="gc-btn-secondary"
                          style={css.detachedBannerBtn}
                          onClick={() => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId })}
                          title={l10n.t('Checkout or create a branch')}
                        >
                          {l10n.t('Checkout branch')}
                        </button>
                        <button
                          style={css.detachedBannerDismissBtn}
                          onClick={() => setDetachedWarnings(prev => { const n = { ...prev }; delete n[repoId]; return n; })}
                          title={l10n.t('Dismiss')}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    <ProjectGroup
                      isFirst={idx === 0}
                      isLast={idx === changesRepos.length - 1}
                      repoStatus={repoStatus}
                      repoName={repoName}
                      repoColor={repoColor}
                      multiRepo={changesMultiRepo}
                      singleRepo={workspaceSingleRepo}
                      isSubmodule={meta?.isSubmodule}
                      submodulePath={meta?.submodulePath}
                      isWorktree={meta?.isWorktree}
                      mainWorktreePath={meta?.mainWorktreePath}
                      selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                      viewMode={store.viewAndSort.fileViewMode}
                      isFileSelected={store.isFileSelected}
                      isCollapsed={store.isCollapsed}
                      toggleCollapsed={store.toggleCollapsed}
                      hasExpandedDirs={store.hasExpandedDirs}
                      setDirsCollapsed={store.setDirsCollapsed}
                      onToggleFile={store.toggleFileSelection}
                      onSetFiles={store.setFileSelections}
                      onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                      onContextMenu={(e, file) => {
                        if (e.metaKey || e.ctrlKey) {
                          setMultiSelectedFiles(prev =>
                            prev.some(f => f.repoId === file.repoId && f.path === file.path)
                              ? prev.filter(f => !(f.repoId === file.repoId && f.path === file.path))
                              : [...prev, file]
                          );
                          return;
                        }
                        if (multiSelectedFiles.length > 1 && multiSelectedFiles.some(f => f.repoId === file.repoId && f.path === file.path)) {
                          setMultiCtxMenu({ x: e.clientX, y: e.clientY, files: multiSelectedFiles });
                          return;
                        }
                        setMultiSelectedFiles([]);
                        setCtxFile({ repoId: file.repoId, path: file.path });
                        setCtxMenu({ x: e.clientX, y: e.clientY, file });
                      }}
                      onFolderContextMenu={(e, rid, folderPath, files) => { setActiveFolderPath(folderPath); setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files }); }}
                      onOpenFile={f => send({ type: 'COMMIT_OPEN_FILE', repoId: f.repoId, filePath: f.path })}
                      onRollback={files => {
                        if (files.length === 1) {
                          send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: files[0].repoId, path: files[0].path });
                        } else {
                          send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                        }
                      }}
                      onResolveMerge={(f, withAi) => send(withAi ? { type: 'COMMIT_RESOLVE_CONFLICTS_AI', repoId: f.repoId, filePath: f.path } : { type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                      onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                      onRepoContextMenu={(e, rid) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid })}
                      onOpenAllChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
                      iconTheme={store.iconTheme}
                      activeFolderPath={activeFolderPath}
                      ctxFile={ctxFile}
                      onMultiSelect={handleMultiSelect}
                      multiSelectedFiles={multiSelectedFiles}
                    />
                  </React.Fragment>
                );
              })
            )}
          </ScrollArea>

          {/* Shelve name prompt — appears above commit form */}
          {shelvePrompt && (
            <div style={css.shelvePromptBar}>
              <Codicon name="archive" style={{ flexShrink: 0, opacity: 0.65, fontSize: '14px' }} />
              <input
                ref={shelvePromptRef}
                style={css.shelvePromptInput}
                value={shelvePromptName}
                onChange={e => setShelvePromptName(e.target.value)}
                placeholder={l10n.t('Shelve name…')}
                onKeyDown={e => {
                  if (isImeComposing(e)) return;
                  if (e.key === 'Enter') confirmShelve(shelvePrompt.repoId, shelvePromptName, shelvePrompt.paths);
                  if (e.key === 'Escape') setShelvePrompt(null);
                }}
              />
              <button
                style={css.shelvePromptOk}
                onClick={() => confirmShelve(shelvePrompt.repoId, shelvePromptName, shelvePrompt.paths)}
                disabled={!shelvePromptName.trim()}
                title={l10n.t('Confirm shelve')}
              >
                <Codicon name="check" />
              </button>
              <button style={css.shelvePromptCancel} onClick={() => setShelvePrompt(null)} title={l10n.t('Cancel')}>
                <Codicon name="close" />
              </button>
            </div>
          )}

          {/* Commit form */}
          <UnifiedCommitForm
            message={store.commitMessage}
            repoStatuses={changesRepos}
            repoMetas={store.repoMetas}
            amendFlags={store.amendFlags}
            loading={store.loading}
            changesViewMode={store.changesViewMode}
            defaultCommitAction={store.defaultCommitAction}
            defaultSaveAction={store.defaultSaveAction}
            subjectMaxLength={panelConfig?.subjectMaxLength ?? 0}
            insertRequest={commitInsert}
            onInsertHandled={() => setCommitInsert(null)}
            vscodeSelectedRepos={store.changesViewMode === 'vscode' ? vscodeSelectedRepos : undefined}
            getSelectedFilesForRepo={store.getSelectedFilesForRepo}
            onDeselectRepo={repoId => {
              if (store.changesViewMode === 'vscode') {
                toggleVscodeRepoSelection(repoId);
              } else {
                const r = changesRepos.find(r => r.repoId === repoId);
                if (!r) return;
                const allPaths = [...r.stagedFiles, ...r.unstagedFiles].map(f => f.path);
                store.setFileSelections(repoId, allPaths, false);
              }
            }}
            onMessageChange={msg => store.setCommitMessage(msg)}
            onAmendToggle={repoId => {
              const newValue = !(store.amendFlags[repoId] ?? false);
              store.setAmend(repoId, newValue);
              if (newValue) {
                send({ type: 'COMMIT_GET_LAST_COMMIT_MESSAGE', requestId: generateId(), repoId } satisfies CommitToHostMsg);
              }
            }}
            onCommit={() => doCommit(false)}
            onCommitAndPush={() => doCommit(true)}
            onPush={doPush}
            onPushAll={doPushAll}
            syncRepoStatuses={repos}
            onSyncAction={doSyncAction}
            onPullRepos={ids => ids.forEach(id => doPull(id, false))}
            onPushRepos={ids => ids.forEach(doPush)}
            onForcePushRepos={ids => ids.forEach(doForcePush)}
            aiEnabled={store.aiEnabled}
            onAutopilot={doAutopilot}
            onAutopilotContextMenu={doAutopilotContextMenu}
            generatingMessage={generatingMessage}
            activeProfile={store.activeProfile}
            onOpenProfiles={() => send({ type: 'OPEN_PROFILES_MENU' } satisfies CommitToHostMsg)}
            onRebaseAction={(repoId, action) => {
              store.setLoading(true);
              send({ type: 'COMMIT_REBASE_ACTION', requestId: generateId(), repoId, action } satisfies CommitToHostMsg);
            }}
            onShelve={() => {
              const name = store.commitMessage.trim();
              if (!name) return;
              for (const repoStatus of changesRepos) {
                const selectedPaths = store.getSelectedFilesForRepo(repoStatus.repoId);
                if (selectedPaths.length === 0) continue;
                confirmShelve(repoStatus.repoId, name, selectedPaths);
              }
              store.setCommitMessage('');
            }}
            onStash={() => {
              const message = store.commitMessage.trim() || 'WIP stash';
              for (const repoStatus of changesRepos) {
                const selectedPaths = store.getSelectedFilesForRepo(repoStatus.repoId);
                if (selectedPaths.length === 0) continue;
                doStash(repoStatus.repoId, message, selectedPaths);
              }
            }}
          />

        </>)}

        {activeTab === 'shelf' && (
          /* Shelf tab */
          shelfRepos.length === 0 ? (
            repos.some(r => shelveLoading[r.repoId])
              ? <EmptyTabState icon="archive" message={l10n.t('Loading…')} loading />
              : <EmptyTabState icon="archive" message={l10n.t('No shelved changes')} hint={l10n.t('Shelving sets changes aside as a patch kept by GitCharm, outside the repository, to apply again later. In the {0} tab, select the files, write a message and choose Shelve Changes from the button next to Commit.', changesTabName)} />
          ) : (
          <ScrollArea style={css.repoList}>
            {shelfRepos.map((repoStatus, i) => {
              const repoId = repoStatus.repoId;
              const meta = metaMap.get(repoId);
              const repoName = meta?.name ?? repoId.split('/').pop() ?? repoId;
              const repoColor = meta?.color ?? '#4ec9b0';
              const worktreeBranch = worktreeBranchOf(repoStatus);
              const mainRepoName = meta?.mainWorktreePath?.split('/').pop();
              return (
                <ShelvePanel
                  key={repoId}
                  repoId={repoId}
                  repoName={repoName}
                  repoColor={repoColor}
                  worktreeBranch={worktreeBranch}
                  mainRepoName={mainRepoName}
                  multiRepo={multiRepo}
                  singleRepo={shelfRepos.length === 1}
                  plainHeader={workspaceSingleRepo}
                  shelves={shelveMap[repoId] ?? []}
                  loading={shelveLoading[repoId] ?? false}
                  error={shelveError[repoId] ?? null}
                  viewMode={store.viewAndSort.fileViewMode}
                  onUnshelve={handleUnshelve}
                  onUnshelveFile={handleUnshelveFile}
                  onDrop={handleDropShelve}
                  onRename={handleRenameShelve}
                  onRequestList={requestShelveList}
                  onOpenFileDiff={handleOpenFileDiff}
                  isLast={i === shelfRepos.length - 1}
                />
              );
            })}
          </ScrollArea>
          )
        )}

        {activeTab === 'stash' && (
          /* Stash tab */
          stashRepos.length === 0 ? (
            repos.some(r => stashLoading[r.repoId])
              ? <EmptyTabState icon="git-stash" message={l10n.t('Loading…')} loading />
              : <EmptyTabState icon="git-stash" message={l10n.t('No stashes')} hint={l10n.t('A stash saves uncommitted changes in Git and clears them from the working tree. In the {0} tab, select the files, write a message and choose Stash Changes from the button next to Commit.', changesTabName)} />
          ) : (
          <ScrollArea style={css.repoList}>
            {stashRepos.map((repoStatus, i) => {
              const repoId = repoStatus.repoId;
              const meta = metaMap.get(repoId);
              const repoName = meta?.name ?? repoId.split('/').pop() ?? repoId;
              const repoColor = meta?.color ?? '#4ec9b0';
              const worktreeBranch = worktreeBranchOf(repoStatus);
              const mainRepoName = meta?.mainWorktreePath?.split('/').pop();
              return (
                <StashTab
                  key={repoId}
                  repoId={repoId}
                  repoName={repoName}
                  repoColor={repoColor}
                  worktreeBranch={worktreeBranch}
                  mainRepoName={mainRepoName}
                  multiRepo={multiRepo}
                  singleRepo={stashRepos.length === 1}
                  plainHeader={workspaceSingleRepo}
                  stashes={stashesOf(repoStatus)}
                  loading={stashLoading[repoId] ?? false}
                  error={stashError[repoId] ?? null}
                  viewMode={store.viewAndSort.fileViewMode}
                  onApply={handleStashApply}
                  onPop={handleStashPop}
                  onDrop={handleStashDrop}
                  onRename={handleRenameStash}
                  onRequestList={requestStashList}
                  onOpenFileDiff={handleStashShowFileDiff}
                  isLast={i === stashRepos.length - 1}
                />
              );
            })}
          </ScrollArea>
          )
        )}

        {activeTab === 'push' && (
          /* Push tab — manages its own scroll, footer anchored at bottom */
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <PushTab
              repos={repos}
              plainHeaders={workspaceSingleRepo}
              repoMetas={store.repoMetas}
              unpushedMap={unpushedMap}
              onPush={doPush}
              onForcePush={doForcePush}
              onPushAll={doPushAll}
              onPull={doPull}
              onFetch={doFetch}
              onSync={doSyncRepos}
              onOpenInLog={doOpenInLog}
              onUndoCommit={doUndoCommit}
              onSquash={doSquash}
              onDropCommits={doDropCommits}
              onRevertCommits={doRevertCommits}
              onEditCommitMsg={doEditCommitMsg}
              onOpenDetail={doPushOpenDetail}
              onOpenChanges={doPushOpenChanges}
              onExplainCommit={doPushExplainCommit}
              onViewCombinedDiff={doPushViewCombinedDiff}
              onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
              aiEnabled={store.aiEnabled}
            />
          </div>
        )}

        {activeTab === 'worktree' && (
          /* Worktree tab */
          <ScrollArea style={css.repoList}>
            <WorktreePanel
              repos={worktreeRepos}
              plainHeaders={workspaceSingleRepo}
              loading={worktreeLoading}
              error={worktreeError}
              multiRepo={multiRepo}
              onDelete={handleWorktreeDelete}
              onLock={handleWorktreeLock}
              onUnlock={handleWorktreeUnlock}
              onPrune={handleWorktreePrune}
              onOpenInExplorer={handleWorktreeOpenInExplorer}
              onOpenInNewWindow={handleWorktreeOpenInNewWindow}
              onOpenInOS={handleWorktreeOpenInOS}
              onAddToWorkspace={handleWorktreeAddToWorkspace}
              onRequestCreate={handleWorktreeRequestCreate}
            />
          </ScrollArea>
        )}

        {activeTab === 'pullrequests' && (noRepoHasRemote(pullRequestRepos) ? (
          <NoRemoteState repoCount={pullRequestRepos.length} />
        ) : (
          /* Pull Requests tab */
          <ScrollArea
            style={css.repoList}
            onScroll={e => {
              const el = e.currentTarget;
              const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
              if (!nearBottom) return;
              const singleRepo = pullRequestRepos.length === 1;
              for (const repo of pullRequestRepos) {
                const isExpanded = singleRepo || expandedPrRepoIds.has(repo.repoId);
                if (isExpanded && repo.hasMore && !pullRequestLoadingMore[repo.repoId]) handlePrLoadMore(repo.repoId);
              }
            }}
          >
            <PullRequestPanel
              repos={pullRequestRepos}
              plainHeaders={workspaceSingleRepo}
              loading={pullRequestLoading}
              loadingMore={pullRequestLoadingMore}
              multiRepo={multiRepo}
              expandedRepoIds={expandedPrRepoIds}
              onToggleExpanded={handlePrToggleExpanded}
              onOpenInBrowser={handlePrOpenInBrowser}
              onOpenDetail={handlePrOpenDetail}
              onOpenAccountPicker={handlePrOpenAccountPicker}
              onRequestCreate={handlePrRequestCreate}
              onRefresh={handlePrRefreshRepo}
              onSetHostOverride={handlePrSetHostOverride}
              onOpenFilters={handlePrOpenFilters}
              onOpenSearch={handlePrOpenSearch}
            />
          </ScrollArea>
        ))}

        {activeTab === 'issues' && (noIssueRepoHasRemote(issueRepos) ? (
          <IssuesNoRemoteState repoCount={issueRepos.length} />
        ) : (
          /* Issues tab */
          <ScrollArea
            style={css.repoList}
            onScroll={e => {
              const el = e.currentTarget;
              if (el.scrollTop + el.clientHeight < el.scrollHeight - 200) return;
              const singleRepo = issueRepos.length === 1;
              for (const repo of issueRepos) {
                const isExpanded = singleRepo || expandedIssueRepoIds.has(repo.repoId);
                if (isExpanded && repo.hasMore && !issueLoadingMore[repo.repoId]) handleIssueLoadMore(repo.repoId);
              }
            }}
          >
            <IssuePanel
              repos={issueRepos}
              plainHeaders={workspaceSingleRepo}
              loading={issueLoading}
              loadingMore={issueLoadingMore}
              multiRepo={multiRepo}
              expandedRepoIds={expandedIssueRepoIds}
              {...issueHandlers}
            />
          </ScrollArea>
        ))}

      </div>

      {/* File context menu */}
      {ctxMenu && (() => {
        const file = ctxMenu.file;
        const isUntracked = file.status === 'untracked';
        const isSubmodule = file.status === 'submodule';
        const hasCustomCls = store.changelists.some(cl => cl.id !== CHANGELIST_DEFAULT_ID && cl.id !== CHANGELIST_UNVERSIONED_ID);
        const baseItems = file.status === 'conflicted' ? FILE_CONTEXT_ITEMS_CONFLICT(store.aiEnabled) : FILE_CONTEXT_ITEMS();
        let items: ContextMenuEntry[] = baseItems;
        if (isSubmodule) {
          items = ctxMenuStaged ? SUBMODULE_FILE_STAGED_ITEMS() : SUBMODULE_FILE_UNSTAGED_ITEMS();
        } else if (store.changesViewMode === 'vscode') {
          items = ctxMenuStaged ? VSCODE_FILE_STAGED_ITEMS() : VSCODE_FILE_UNSTAGED_ITEMS();
        } else if (store.changesViewMode === 'simplified' && isUntracked) {
          items = [
            { id: 'add-to-git',    label: l10n.t('Add to Git'),          icon: 'add' },
            { id: 'rollback',      label: l10n.t('Rollback'),             icon: 'discard' },
            { id: 'shelve',        label: l10n.t('Shelve'),               icon: 'archive' },
            { id: 'stash',         label: l10n.t('Stash'),                icon: 'git-stash' },
            { id: 'diff',          label: l10n.t('Show Diff'),            icon: 'diff' },
            { id: 'file-history',  label: l10n.t('Show File History'),    icon: 'history' },
            { id: 'jump',          label: l10n.t('Jump to Source'),       icon: 'go-to-file' },
            { separator: true },
            { id: 'gitignore',     label: l10n.t('Add to .gitignore'),    icon: 'exclude' },
            { separator: true },
            { id: 'delete',        label: l10n.t('Delete'),               icon: 'trash', danger: true },
            { separator: true },
            { id: 'refresh',       label: l10n.t('Refresh'),              icon: 'refresh' },
          ];
        } else if (store.changesViewMode === 'changelists') {
          if (isUntracked) {
            items = [
              { id: 'add-to-git',   label: l10n.t('Add to Git'),         icon: 'add' },
              { id: 'rollback',     label: l10n.t('Rollback'),            icon: 'discard' },
              { id: 'shelve',       label: l10n.t('Shelve'),              icon: 'archive' },
              { id: 'stash',        label: l10n.t('Stash'),               icon: 'git-stash' },
              { id: 'diff',         label: l10n.t('Show Diff'),           icon: 'diff' },
              { id: 'file-history', label: l10n.t('Show File History'),   icon: 'history' },
              { id: 'jump',         label: l10n.t('Jump to Source'),      icon: 'go-to-file' },
              { separator: true },
              { id: 'gitignore',    label: l10n.t('Add to .gitignore'),   icon: 'exclude' },
              { separator: true },
              { id: 'delete',       label: l10n.t('Delete'),              icon: 'trash', danger: true },
              { separator: true },
              { id: 'refresh',      label: l10n.t('Refresh'),             icon: 'refresh' },
            ];
          } else {
            items = hasCustomCls
              ? [...baseItems, { separator: true }, { id: 'move-to-cl', label: l10n.t('Move to Changelist…'), icon: 'list-unordered' }]
              : baseItems;
          }
        }
        return (
          <ContextMenu
            x={ctxMenu.x} y={ctxMenu.y}
            items={dynItems(items, 1)}
            onSelect={id => {
              if (id === 'add-to-git') {
                send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: file.repoId, paths: [file.path] } satisfies CommitToHostMsg);
                setCtxMenu(null); setCtxFile(null);
              } else if (id === 'move-to-cl') {
                send({ type: 'CHANGELISTS_MOVE_FILES_PROMPT', files: [{ repoId: file.repoId, path: file.path }] } satisfies CommitToHostMsg);
                setCtxMenu(null); setCtxFile(null);
              } else {
                handleContextMenuSelect(id);
              }
            }}
            onClose={() => { setCtxMenu(null); setCtxFile(null); }}
          />
        );
      })()}

      {/* Folder context menu */}
      {folderCtxMenu && (() => {
        const files = folderCtxMenu.files;
        const allUntracked = files.length > 0 && files.every(f => f.status === 'untracked');
        const hasCustomCls = store.changelists.some(cl => cl.id !== CHANGELIST_DEFAULT_ID && cl.id !== CHANGELIST_UNVERSIONED_ID);
        let items: ContextMenuEntry[] = FOLDER_CONTEXT_ITEMS();
        if (store.changesViewMode === 'vscode') {
          items = folderCtxMenuStaged ? VSCODE_FOLDER_STAGED_ITEMS() : VSCODE_FOLDER_UNSTAGED_ITEMS();
        } else if (store.changesViewMode === 'changelists') {
          if (allUntracked) {
            items = [
              { id: 'add-to-git', label: l10n.t('Add to Git'),        icon: 'add' },
              { id: 'rollback',   label: l10n.t('Rollback'),           icon: 'discard' },
              { id: 'shelve',     label: l10n.t('Shelve Changes'),     icon: 'archive' },
              { id: 'stash',      label: l10n.t('Stash Changes'),      icon: 'git-stash' },
              { id: 'compare-with', label: l10n.t('Compare with…'),   icon: 'git-compare' },
              { separator: true },
              { id: 'gitignore',  label: l10n.t('Add to .gitignore'), icon: 'exclude' },
              { separator: true },
              { id: 'delete',     label: l10n.t('Delete'),             icon: 'trash', danger: true },
              { separator: true },
              { id: 'refresh',    label: l10n.t('Refresh'),            icon: 'refresh' },
            ];
          } else {
            items = hasCustomCls
              ? [...FOLDER_CONTEXT_ITEMS(), { separator: true }, { id: 'move-to-cl', label: l10n.t('Move to Changelist…'), icon: 'list-unordered' }]
              : FOLDER_CONTEXT_ITEMS();
          }
        }
        return (
          <ContextMenu
            x={folderCtxMenu.x} y={folderCtxMenu.y}
            items={dynItems(items, folderCtxMenu.files.length)}
            onSelect={id => {
              if (id === 'add-to-git') {
                send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: folderCtxMenu.repoId, paths: files.map(f => f.path) } satisfies CommitToHostMsg);
                setFolderCtxMenu(null); setActiveFolderPath(null);
              } else if (id === 'move-to-cl') {
                send({ type: 'CHANGELISTS_MOVE_FILES_PROMPT', files: files.map(f => ({ repoId: f.repoId, path: f.path })) } satisfies CommitToHostMsg);
                setFolderCtxMenu(null); setActiveFolderPath(null);
              } else {
                handleFolderContextMenuSelect(id);
              }
            }}
            onClose={() => { setFolderCtxMenu(null); setActiveFolderPath(null); }}
          />
        );
      })()}

      {repoCtxMenu && (() => {
        const hasCustomCls = store.changelists.some(cl => cl.id !== CHANGELIST_DEFAULT_ID && cl.id !== CHANGELIST_UNVERSIONED_ID);
        const isInDefaultCl = !repoCtxMenu.changelistId || repoCtxMenu.changelistId === CHANGELIST_DEFAULT_ID;
        let repoItems = REPO_CONTEXT_ITEMS();
        if (store.changesViewMode === 'vscode') {
          repoItems = repoCtxMenu.stagedSection ? VSCODE_REPO_STAGED_ITEMS() : VSCODE_REPO_UNSTAGED_ITEMS();
        } else if (store.changesViewMode === 'changelists') {
          const baseItems: ContextMenuEntry[] = [
            { id: 'rollback',     label: l10n.t('Rollback'),              icon: 'discard' },
            { id: 'shelve',       label: l10n.t('Shelve Changes'),         icon: 'archive' },
            { id: 'stash',        label: l10n.t('Stash Changes'),          icon: 'git-stash' },
            ...( (!isInDefaultCl || hasCustomCls) ? [{ separator: true } as ContextMenuEntry] : []),
            ...(!isInDefaultCl ? [{ id: 'add-to-git', label: l10n.t('Add to Git'), icon: 'add' } as ContextMenuEntry] : []),
            ...(hasCustomCls ? [{ id: 'move-to-cl', label: l10n.t('Move to Changelist…'), icon: 'list-unordered' } as ContextMenuEntry] : []),
            { separator: true },
            { id: 'manage-repo',      label: l10n.t('Manage Repository'),   icon: 'git-branch' },
            { id: 'view-git-log',     label: l10n.t('View Log Panel'),        icon: 'git-commit' },
            { separator: true },
            { id: 'reveal-explorer',  label: l10n.t('Reveal in Explorer'),  icon: 'list-tree' },
            { id: 'open-new-window',  label: l10n.t('Open in New Window'),  icon: 'multiple-windows' },
            { id: 'reveal-os',        label: revealOsLabel(),       icon: 'folder-opened' },
            { separator: true },
            { id: 'hide-repo',        label: l10n.t('Hide Repository'),     icon: 'eye-closed' },
            { separator: true },
            { id: 'refresh',          label: l10n.t('Refresh'),             icon: 'refresh' },
          ];
          repoItems = baseItems;
        }
        return (
          <ContextMenu
            x={repoCtxMenu.x} y={repoCtxMenu.y}
            items={(() => {
              const rs = repos.find(r => r.repoId === repoCtxMenu.repoId);
              const totalFiles = new Set([...(rs?.unstagedFiles ?? []).map(f => f.path), ...(rs?.stagedFiles ?? []).map(f => f.path)]).size;
              const noChanges = totalFiles === 0;
              let items = noChanges
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ? repoItems.filter(i => !('id' in i) || !['rollback', 'shelve', 'stash'].includes((i as any).id))
                : repoItems;
              if (noChanges) items = items.filter((item, i, arr) =>
                !('separator' in item) || (i > 0 && !('separator' in arr[i - 1]))
              );
              return dynItems(items, totalFiles);
            })()}
            onSelect={id => {
              if (id === 'move-to-cl') {
                const ctx = repoCtxMenu;
                const repoStatus = repos.find(r => r.repoId === ctx.repoId);
                const allRepoFiles: Array<{ repoId: string; path: string }> = [];
                if (repoStatus) {
                  const seen = new Set<string>();
                  for (const f of [...repoStatus.unstagedFiles, ...repoStatus.stagedFiles]) {
                    if (!seen.has(f.path)) { seen.add(f.path); allRepoFiles.push({ repoId: f.repoId, path: f.path }); }
                  }
                }
                if (allRepoFiles.length > 0) {
                  send({ type: 'CHANGELISTS_MOVE_FILES_PROMPT', files: allRepoFiles } satisfies CommitToHostMsg);
                }
                setRepoCtxMenu(null);
              } else if (id === 'add-to-git') {
                const repoStatus = repos.find(r => r.repoId === repoCtxMenu.repoId);
                const untrackedPaths = repoStatus?.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path) ?? [];
                if (untrackedPaths.length > 0) {
                  send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: repoCtxMenu.repoId, paths: untrackedPaths } satisfies CommitToHostMsg);
                }
                setRepoCtxMenu(null);
              } else {
                handleRepoContextMenuSelect(id);
              }
            }}
            onClose={() => setRepoCtxMenu(null)}
          />
        );
      })()}

      {/* Multi-file context menu */}
      {multiCtxMenu && (() => {
        const files = multiCtxMenu.files;
        const n = files.length;
        const allSameRepo = files.every(f => f.repoId === files[0].repoId);
        const noneSubmodule = files.every(f => f.status !== 'submodule');
        const items: ContextMenuEntry[] = [
          ...(noneSubmodule && allSameRepo ? [
            { id: 'multi-rollback', label: l10n.t('Rollback {0} files', n), icon: 'discard' } as ContextMenuEntry,
            { id: 'multi-shelve',   label: l10n.t('Silently Shelve {0} files', n), icon: 'archive' } as ContextMenuEntry,
            { id: 'multi-stash',    label: l10n.t('Silently Stash {0} files', n), icon: 'git-stash' } as ContextMenuEntry,
            { separator: true } as ContextMenuEntry,
          ] : []),
          ...(noneSubmodule ? [
            { id: 'multi-gitignore', label: l10n.t('Add to .gitignore'), icon: 'exclude' } as ContextMenuEntry,
            { separator: true } as ContextMenuEntry,
          ] : []),
          { id: 'multi-refresh', label: l10n.t('Refresh'), icon: 'refresh' } as ContextMenuEntry,
        ];
        return (
          <ContextMenu
            x={multiCtxMenu.x} y={multiCtxMenu.y}
            items={items}
            onSelect={id => {
              const repoId = files[0].repoId;
              const paths = files.map(f => f.path);
              switch (id) {
                case 'multi-rollback':
                  send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                  break;
                case 'multi-shelve':
                  send({ type: 'SHELVE_PUSH', requestId: generateId(), repoId, name: 'Changes', paths });
                  break;
                case 'multi-stash':
                  send({ type: 'STASH_PUSH', requestId: generateId(), repoId, message: 'Changes', paths });
                  break;
                case 'multi-gitignore':
                  files.forEach(f => send({ type: 'COMMIT_ADD_TO_GITIGNORE', repoId: f.repoId, entryPath: f.path }));
                  break;
                case 'multi-refresh':
                  send({ type: 'COMMIT_REQUEST_STATUS' });
                  break;
              }
              setMultiCtxMenu(null);
              setMultiSelectedFiles([]);
            }}
            onClose={() => setMultiCtxMenu(null)}
          />
        );
      })()}

      {/* Changelist header context menu (also used for empty-space click) */}
      {clHeaderCtxMenu && (() => {
        const isEmpty = clHeaderCtxMenu.changelistId === 'empty';
        const isUnversioned = clHeaderCtxMenu.changelistId === CHANGELIST_UNVERSIONED_ID;
        const isFixed = clHeaderCtxMenu.changelistId === CHANGELIST_DEFAULT_ID || isUnversioned;
        const baseItems = isEmpty
          ? CHANGELIST_EMPTY_AREA_ITEMS()
          : isUnversioned
            ? CHANGELIST_HEADER_ITEMS_UNVERSIONED()
            : isFixed
              ? CHANGELIST_HEADER_ITEMS_FIXED()
              : CHANGELIST_HEADER_ITEMS_CUSTOM();
        const clFileCount = (() => {
          if (isEmpty) return 0;
          if (isUnversioned) return changesRepos.reduce((sum, r) => sum + r.unstagedFiles.filter(f => f.status === 'untracked').length, 0);
          const cl = store.changelists.find(c => c.id === clHeaderCtxMenu.changelistId);
          if (!cl) return 0;
          return Object.values(cl.fileAssignments).reduce((sum, paths) => sum + paths.length, 0);
        })();
        return (
          <ContextMenu
            x={clHeaderCtxMenu.x} y={clHeaderCtxMenu.y}
            items={dynItems(baseItems, clFileCount)}
            onSelect={handleClHeaderContextMenuSelect}
            onClose={() => setClHeaderCtxMenu(null)}
          />
        );
      })()}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  app: {
    display: 'flex', flexDirection: 'column' as const, height: '100vh',
    background: 'var(--vscode-sideBar-background)', color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)', overflow: 'hidden',
    userSelect: 'none' as const,
  },
  notificationBar: {
    display: 'flex', alignItems: 'flex-start', gap: '7px',
    padding: '6px 8px 6px 10px', flexShrink: 0,
    background: 'var(--vscode-inputValidation-warningBackground, rgba(255,170,0,0.12))',
    borderBottom: '1px solid var(--vscode-inputValidation-warningBorder, rgba(255,170,0,0.4))',
    color: 'var(--vscode-editorWarning-foreground, #e9ae00)',
    fontSize: '11px', lineHeight: '1.5',
  } as React.CSSProperties,
  notificationText: {
    flex: 1, wordBreak: 'break-word' as const, minWidth: 0,
  } as React.CSSProperties,
  notificationClose: {
    background: 'transparent', border: 'none', cursor: 'pointer', padding: '1px 2px',
    color: 'inherit', opacity: 0.7, display: 'flex', alignItems: 'center', flexShrink: 0,
    fontSize: '13px', borderRadius: '2px',
  } as React.CSSProperties,
  tabBar: {
    display: 'flex', borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)', flexShrink: 0,
    position: 'relative' as const, overflow: 'hidden' as const,
  } as React.CSSProperties,
  tab: (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', flexShrink: 0,
    padding: active ? '5px 12px' : '5px 10px',
    fontSize: '12px',
    cursor: 'pointer', background: 'transparent', border: 'none',
    borderBottom: active ? '2px solid var(--vscode-focusBorder)' : '2px solid transparent',
    opacity: active ? 1 : 0.6, fontFamily: 'var(--vscode-font-family)',
    fontWeight: active ? '600' : 'normal', whiteSpace: 'nowrap' as const,
    transition: 'opacity 0.1s, border-color 0.1s', color: 'var(--vscode-foreground)',
  }),
  tabDropdownBtn: {
    display: 'flex', alignItems: 'center', flex: 1, minWidth: 0,
    padding: '5px 10px', fontSize: '12px',
    cursor: 'pointer', background: 'transparent', border: 'none',
    borderBottom: '2px solid transparent',
    fontFamily: 'var(--vscode-font-family)', fontWeight: '600',
    color: 'var(--vscode-foreground)', transition: 'background 0.1s',
  } as React.CSSProperties,
  // Reads as a continuation of the dropdown button above it: the tab bar's own background, only a bottom edge.
  tabDropdownMenu: {
    background: 'var(--vscode-sideBar-background)',
    border: 'none',
    borderBottom: '1px solid var(--vscode-panel-border)',
    borderRadius: 0,
    // Bottom edge only: the −6px spread cancels the 6px blur on the sides and top, and the 6px offset pushes it all below.
    boxShadow: '0 6px 6px -6px rgba(0,0,0,0.3)',
  } as React.CSSProperties,
  pushBadge: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px',
    padding: '0 5px',
    fontSize: '10px',
    fontWeight: 'bold' as const,
    lineHeight: '16px',
    marginLeft: '5px',
    flexShrink: 0,
  } as React.CSSProperties,
  main: { display: 'flex', flexDirection: 'column' as const, flex: 1, overflow: 'hidden' },
  repoList: { flex: 1, minHeight: 0 },
  filteredEmptyState: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '10px',
    padding: '32px 16px', color: 'var(--vscode-foreground)', opacity: 0.7,
    fontSize: '12px', textAlign: 'center' as const,
  } as React.CSSProperties,
  clearFilterBtn: { padding: '4px 9px', fontSize: '11px' } as React.CSSProperties,
  // Shelve name prompt bar (above commit form)
  detachedBanner: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px',
    background: 'color-mix(in srgb, var(--vscode-statusBarItem-warningBackground, #c6a300) 15%, transparent)',
    borderBottom: '1px solid color-mix(in srgb, var(--vscode-statusBarItem-warningBackground, #c6a300) 35%, transparent)',
    fontSize: '11px', color: 'var(--vscode-foreground)', flexShrink: 0,
  } as React.CSSProperties,
  detachedBannerBtn: { padding: '2px 7px', fontSize: '11px', flexShrink: 0 } as React.CSSProperties,
  detachedBannerDismissBtn: {
    background: 'transparent', color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: 'none', borderRadius: '3px', padding: '2px 7px', cursor: 'pointer',
    fontSize: '11px', flexShrink: 0, opacity: 0.5,
  } as React.CSSProperties,
  shelvePromptBar: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)', flexShrink: 0,
  } as React.CSSProperties,
  shelvePromptInput: {
    flex: 1, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-focusBorder)', borderRadius: '3px',
    padding: '3px 6px', fontSize: '12px', fontFamily: 'var(--vscode-font-family)', outline: 'none',
  } as React.CSSProperties,
  shelvePromptOk: {
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
    border: 'none', borderRadius: '3px', padding: '3px 7px', cursor: 'pointer',
    fontSize: '13px', display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  shelvePromptCancel: {
    background: 'transparent', color: 'var(--vscode-foreground)', border: 'none',
    borderRadius: '3px', padding: '3px 5px', cursor: 'pointer',
    fontSize: '13px', display: 'flex', alignItems: 'center', opacity: 0.6,
  } as React.CSSProperties,
  fullCenter: {
    height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--vscode-sideBar-background)', color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)',
  },
  initRepoBtn: {
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
    border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
    fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: '500' as const,
  },
  secondaryBtn: {
    background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)',
    border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
    fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: '500' as const,
  },
};

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e.message + '\n' + e.stack }; }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 16, color: 'red', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
        {this.state.error}
      </div>
    );
    return this.props.children;
  }
}

export { App as CommitApp };

const _rootEl = document.getElementById('root');
if (_rootEl && !isEmbedded()) {
  createRoot(_rootEl).render(<ErrorBoundary><App /></ErrorBoundary>);
}
