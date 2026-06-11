import React, { useEffect, useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useCommitStore } from './store/commitStore';
import { ProjectGroup } from './components/ProjectGroup';
import { ChangelistView } from './components/ChangelistView';
import { VscodeView } from './components/VscodeView';
import { UnifiedCommitForm } from './components/UnifiedCommitForm';
import { ContextMenu, type ContextMenuEntry } from './components/ContextMenu';
import { ShelvePanel } from './components/ShelvePanel';
import { StashTab } from './components/StashTab';
import { PushTab } from './components/PushTab';
import { WorktreePanel } from './components/WorktreePanel';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import type { CommitToHostMsg, HostToCommitMsg, ShelveEntry, StashEntry, UnpushedCommit, WorktreeEntry } from '../shared/msgTypes';
import type { FileStatus } from '../shared/types';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../shared/types';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Context menu items ────────────────────────────────────────────────────────

const REVEAL_OS_LABEL = 'Reveal in File Manager';

const FILE_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'rollback',        label: 'Rollback',            icon: 'discard' },
  { id: 'shelve',          label: 'Shelve',              icon: 'archive' },
  { id: 'stash',           label: 'Stash',               icon: 'save' },
  { id: 'diff',            label: 'Show Diff',           icon: 'diff' },
  { id: 'jump',            label: 'Jump to Source',      icon: 'go-to-file' },
  { id: 'reveal-explorer', label: 'Reveal in Explorer',  icon: 'list-tree' },
  { id: 'reveal-os',       label: REVEAL_OS_LABEL,       icon: 'folder-opened' },
  { separator: true },
  { id: 'gitignore',       label: 'Add to .gitignore',   icon: 'exclude' },
  { separator: true },
  { id: 'delete',          label: 'Delete',              icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',         label: 'Refresh',             icon: 'refresh' },
];

const FILE_CONTEXT_ITEMS_CONFLICT: ContextMenuEntry[] = [
  { id: 'resolve',   label: 'Resolve Conflicts',  icon: 'git-merge' },
  { separator: true },
  ...FILE_CONTEXT_ITEMS,
];

const FOLDER_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'rollback',  label: 'Rollback',           icon: 'discard' },
  { id: 'shelve',    label: 'Shelve Changes',      icon: 'archive' },
  { id: 'stash',     label: 'Stash Changes',       icon: 'save' },
  { separator: true },
  { id: 'gitignore', label: 'Add to .gitignore',  icon: 'exclude' },
  { separator: true },
  { id: 'delete',    label: 'Delete',              icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',   label: 'Refresh',             icon: 'refresh' },
];

const REPO_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'rollback',     label: 'Rollback',            icon: 'discard' },
  { id: 'shelve',       label: 'Shelve Changes',       icon: 'archive' },
  { id: 'stash',        label: 'Stash Changes',        icon: 'save' },
  { separator: true },
  { id: 'manage-repo',  label: 'Manage Repository',    icon: 'git-branch' },
  { id: 'view-git-log', label: 'View Git Log',         icon: 'git-commit' },
  { separator: true },
  { id: 'hide-repo',    label: 'Hide Repository',      icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',      label: 'Refresh',              icon: 'refresh' },
];

const REPO_CONTEXT_ITEMS_CHANGELISTS: ContextMenuEntry[] = [
  { id: 'rollback',     label: 'Rollback',             icon: 'discard' },
  { id: 'shelve',       label: 'Shelve Changes',        icon: 'archive' },
  { id: 'stash',        label: 'Stash Changes',         icon: 'save' },
  { separator: true },
  { id: 'add-to-git',   label: 'Add to Git',            icon: 'add' },
  { id: 'move-to-cl',   label: 'Move to Changelist…',  icon: 'list-unordered' },
  { separator: true },
  { id: 'manage-repo',  label: 'Manage Repository',     icon: 'git-branch' },
  { id: 'view-git-log', label: 'View Git Log',          icon: 'git-commit' },
  { separator: true },
  { id: 'hide-repo',    label: 'Hide Repository',       icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',      label: 'Refresh',               icon: 'refresh' },
];

const VSCODE_FILE_STAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'unstage',         label: 'Unstage',              icon: 'remove' },
  { separator: true },
  { id: 'diff',            label: 'Show Diff',            icon: 'diff' },
  { id: 'jump',            label: 'Jump to Source',       icon: 'go-to-file' },
  { id: 'reveal-explorer', label: 'Reveal in Explorer',   icon: 'list-tree' },
  { id: 'reveal-os',       label: REVEAL_OS_LABEL,        icon: 'folder-opened' },
  { separator: true },
  { id: 'refresh',         label: 'Refresh',              icon: 'refresh' },
];

const VSCODE_FILE_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage',           label: 'Stage',                icon: 'add' },
  { id: 'rollback',        label: 'Rollback',             icon: 'discard' },
  { id: 'shelve',          label: 'Shelve',               icon: 'archive' },
  { id: 'stash',           label: 'Stash',                icon: 'save' },
  { separator: true },
  { id: 'diff',            label: 'Show Diff',            icon: 'diff' },
  { id: 'jump',            label: 'Jump to Source',       icon: 'go-to-file' },
  { id: 'reveal-explorer', label: 'Reveal in Explorer',   icon: 'list-tree' },
  { id: 'reveal-os',       label: REVEAL_OS_LABEL,        icon: 'folder-opened' },
  { separator: true },
  { id: 'gitignore',       label: 'Add to .gitignore',    icon: 'exclude' },
  { separator: true },
  { id: 'delete',          label: 'Delete',               icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',         label: 'Refresh',              icon: 'refresh' },
];

const VSCODE_FOLDER_STAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'unstage',  label: 'Unstage Folder',       icon: 'remove' },
  { separator: true },
  { id: 'refresh',  label: 'Refresh',              icon: 'refresh' },
];

const VSCODE_FOLDER_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage',    label: 'Stage Folder',         icon: 'add' },
  { id: 'rollback', label: 'Rollback',             icon: 'discard' },
  { id: 'shelve',   label: 'Shelve Changes',        icon: 'archive' },
  { id: 'stash',    label: 'Stash Changes',         icon: 'save' },
  { separator: true },
  { id: 'gitignore',label: 'Add to .gitignore',    icon: 'exclude' },
  { separator: true },
  { id: 'delete',   label: 'Delete',               icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',  label: 'Refresh',              icon: 'refresh' },
];

const VSCODE_REPO_STAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'unstage-all',  label: 'Unstage All',        icon: 'remove' },
  { separator: true },
  { id: 'manage-repo',  label: 'Manage Repository',  icon: 'git-branch' },
  { id: 'view-git-log', label: 'View Git Log',        icon: 'git-commit' },
  { separator: true },
  { id: 'hide-repo',    label: 'Hide Repository',     icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',      label: 'Refresh',             icon: 'refresh' },
];

const VSCODE_REPO_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage-all',    label: 'Stage All',           icon: 'add' },
  { id: 'rollback',     label: 'Rollback',            icon: 'discard' },
  { id: 'shelve',       label: 'Shelve Changes',       icon: 'archive' },
  { id: 'stash',        label: 'Stash Changes',        icon: 'save' },
  { separator: true },
  { id: 'manage-repo',  label: 'Manage Repository',   icon: 'git-branch' },
  { id: 'view-git-log', label: 'View Git Log',         icon: 'git-commit' },
  { separator: true },
  { id: 'hide-repo',    label: 'Hide Repository',      icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',      label: 'Refresh',             icon: 'refresh' },
];

const SUBMODULE_FILE_STAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'unstage',  label: 'Unstage',   icon: 'remove' },
  { separator: true },
  { id: 'refresh',  label: 'Refresh',   icon: 'refresh' },
];

const SUBMODULE_FILE_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage',    label: 'Stage',     icon: 'add' },
  { separator: true },
  { id: 'refresh',  label: 'Refresh',   icon: 'refresh' },
];

const CHANGELIST_EMPTY_AREA_ITEMS: ContextMenuEntry[] = [
  { id: 'cl-new',   label: 'New Changelist…', icon: 'add' },
  { separator: true },
  { id: 'refresh',  label: 'Refresh',         icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_FIXED: ContextMenuEntry[] = [
  { id: 'cl-rollback', label: 'Rollback',          icon: 'discard' },
  { id: 'cl-shelve',   label: 'Shelve Changes',    icon: 'archive' },
  { id: 'cl-stash',    label: 'Stash Changes',     icon: 'save' },
  { separator: true },
  { id: 'cl-new',      label: 'New Changelist…',   icon: 'add' },
  { separator: true },
  { id: 'refresh',     label: 'Refresh',           icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_UNVERSIONED: ContextMenuEntry[] = [
  { id: 'cl-rollback',   label: 'Rollback',         icon: 'discard' },
  { id: 'cl-shelve',     label: 'Shelve Changes',   icon: 'archive' },
  { id: 'cl-stash',      label: 'Stash Changes',    icon: 'save' },
  { separator: true },
  { id: 'cl-add-to-git', label: 'Add to Git',       icon: 'add' },
  { separator: true },
  { id: 'cl-new',        label: 'New Changelist…',  icon: 'add' },
  { separator: true },
  { id: 'refresh',       label: 'Refresh',          icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_CUSTOM: ContextMenuEntry[] = [
  { id: 'cl-rollback', label: 'Rollback',          icon: 'discard' },
  { id: 'cl-shelve',   label: 'Shelve Changes',    icon: 'archive' },
  { id: 'cl-stash',    label: 'Stash Changes',     icon: 'save' },
  { separator: true },
  { id: 'cl-new',      label: 'New Changelist…',   icon: 'add' },
  { id: 'cl-rename',   label: 'Rename Changelist…', icon: 'edit' },
  { separator: true },
  { id: 'cl-delete',   label: 'Delete Changelist',  icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',     label: 'Refresh',           icon: 'refresh' },
];

type TabId = 'changes' | 'shelf' | 'stash' | 'push' | 'worktree';

function App() {
  const store = useCommitStore();
  const pendingRef = useRef<Map<string, (msg: HostToCommitMsg) => void>>(new Map());

  // ── Tab ───────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('changes');

  // ── Shelve state ──────────────────────────────────────────────────────────
  const [shelveMap, setShelveMap]       = useState<Record<string, ShelveEntry[]>>({});
  const [shelveLoading, setShelveLoading] = useState<Record<string, boolean>>({});
  const [shelveError, setShelveError]   = useState<Record<string, string | null>>({});

  // ── Stash state ───────────────────────────────────────────────────────────
  const [stashMap, setStashMap]       = useState<Record<string, StashEntry[]>>({});
  const [stashLoading, setStashLoading] = useState<Record<string, boolean>>({});
  const [stashError, setStashError]   = useState<Record<string, string | null>>({});
  const [stashExpandAll, setStashExpandAll] = useState(false);

  // ── Worktree state ────────────────────────────────────────────────────────
  const [worktreeRepos, setWorktreeRepos] = useState<Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }>>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

  // ── Hidden repositories ───────────────────────────────────────────────────
  const [hiddenRepoIds, setHiddenRepoIds] = useState<string[]>([]);

  // ── Submodule detached HEAD warnings ─────────────────────────────────────
  // repoId → headCommit — shown as dismissable banner above the file tree
  const [detachedWarnings, setDetachedWarnings] = useState<Record<string, string>>({});

  // Track unstaged file counts per repo to detect new changes for auto-expand in vscode mode
  const prevUnstagedCountsRef = useRef<Map<string, number>>(new Map());

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Autopilot ─────────────────────────────────────────────────────────────
  const [generatingMessage, setGeneratingMessage]   = useState(false);

  // ── Dropdowns ─────────────────────────────────────────────────────────────
  const [viewMenuOpen, setViewMenuOpen]             = useState(false);
  const [shelveViewMenuOpen, setShelveViewMenuOpen] = useState(false);
  const viewMenuRef       = useRef<HTMLDivElement>(null);
  const shelveViewMenuRef = useRef<HTMLDivElement>(null);

  // ── Selected file (highlighted when diff is open or on right-click) ──────
  const [selectedFile, setSelectedFile] = useState<FileStatus | null>(null);

  // ── Context menus ─────────────────────────────────────────────────────────
  const [ctxFile, setCtxFile] = useState<{ repoId: string; path: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: FileStatus } | null>(null);
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

  // Close view-menus on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) setViewMenuOpen(false);
      if (shelveViewMenuRef.current && !shelveViewMenuRef.current.contains(e.target as Node)) setShelveViewMenuOpen(false);
    };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, []);

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
        case 'COMMIT_STATUS_UPDATE':
          store.setStatus(msg.repos, msg.status, msg.iconTheme, msg.fileViewMode, msg.defaultCommitAction, msg.hasWorkspaceFolder, msg.aiEnabled);
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
          if (msg.ok) {
            // Refresh push tab after any successful operation (commit, undo, push, etc.)
            const currentRepos = useCommitStore.getState().status?.repos ?? [];
            currentRepos.forEach(r => requestUnpushedCommits(r.repoId));
          } else if (msg.error && msg.error !== 'Cancelled') {
            notifyError(msg.error);
          }
          break;
        case 'COMMIT_GENERATE_MESSAGE_RESULT':
          setGeneratingMessage(false);
          if (msg.message) store.setCommitMessage(msg.message);
          else if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;
        case 'COMMIT_SET_MESSAGE':
          store.setCommitMessage(msg.message);
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
              notifyInfo(`Conflicts in ${msg.conflictFiles.length} file(s) — merge editor opened`);
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

        case 'COMMIT_HIDDEN_REPOS_UPDATE':
          setHiddenRepoIds(msg.hiddenRepoIds);
          break;

        case 'COMMIT_SWITCH_TAB':
          setActiveTab(msg.tab);
          if (msg.tab === 'push') repos.forEach(r => requestUnpushedCommits(r.repoId));
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

  const allRepos = store.status?.repos ?? [];
  const repos = hiddenRepoIds.length > 0 ? allRepos.filter(r => !hiddenRepoIds.includes(r.repoId)) : allRepos;
  const metaMap = new Map(store.repoMetas.map(m => [m.id, m]));
  const multiRepo = repos.length >= 1;

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
      case 'rollback':
        send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: file.repoId, path: file.path });
        break;
      case 'shelve':
        confirmShelve(file.repoId, 'Changes', [file.path]);
        break;
      case 'stash':
        doStash(file.repoId, 'WIP stash', [file.path]);
        break;
      case 'diff':
        openDiff(file.repoId, file.path);
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
        confirmShelve(ctx.repoId, 'Changes', ctx.files.map(f => f.path));
        break;
      case 'stash':
        doStash(ctx.repoId, 'WIP stash', ctx.files.map(f => f.path));
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
  }, [clHeaderCtxMenu, store.changelists, send]);

  // ── Push actions ──────────────────────────────────────────────────────────

  const doPush = (repoId: string) => {
    const remote = useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName ?? 'origin';
    send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId, remote });
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

  const doPushExplainCommit = (repoId: string, hash: string) => {
    send({ type: 'PUSH_EXPLAIN_COMMIT', repoId, hash } satisfies CommitToHostMsg);
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

  // ── Autopilot ─────────────────────────────────────────────────────────────

  const doAutopilot = useCallback(() => {
    if (generatingMessage) return;
    setGeneratingMessage(true);
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
        <span style={{ opacity: 0.5, fontSize: '13px' }}>Loading repositories…</span>
      </div>
    );
  }

  if (repos.length === 0 && store.status) {
    if (!store.hasWorkspaceFolder) {
      return (
        <div style={{ ...css.fullCenter, flexDirection: 'column', gap: '12px', padding: '24px' }}>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
            You have not yet opened a folder.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '200px' }}>
            <button style={css.initRepoBtn} onClick={() => send({ type: 'COMMIT_OPEN_FOLDER' } as CommitToHostMsg)}>Open Folder</button>
            <button style={css.initRepoBtn} onClick={() => send({ type: 'COMMIT_CLONE_REPO' } as CommitToHostMsg)}>Clone Repository</button>
          </div>
        </div>
      );
    }
    if (store.repoMetas.length === 0) {
      return (
        <div style={{ ...css.fullCenter, flexDirection: 'column', gap: '12px', padding: '24px' }}>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
            The folder currently open doesn't have a Git repository. You can initialize a repository which will enable source control features powered by Git.
          </div>
          <button
            style={css.initRepoBtn}
            onClick={() => send({ type: 'COMMIT_INIT_REPO' } as CommitToHostMsg)}
          >
            Initialize Repository
          </button>
        </div>
      );
    }
    return (
      <div style={css.fullCenter}>
        <div style={{ textAlign: 'center', opacity: 0.45 }}>
          <div style={{ fontSize: '22px' }}>✓</div>
          <div style={{ fontSize: '13px', marginTop: '6px' }}>No changes in workspace</div>
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

    // In vscode mode, commit only what's already staged — no stage/unstage manipulation
    if (freshState.changesViewMode === 'vscode') {
      const selectedSet = vscodeSelectedRepos;
      const targets = currentRepos
        .filter(r => r.stagedFiles.length > 0 && selectedSet.has(r.repoId))
        .map(r => ({ repoId: r.repoId, message: freshState.commitMessage, amend: freshState.amendFlags[r.repoId] ?? false, filesToStage: [], filesToUnstage: [] }));
      if (targets.length === 0) return;
      store.setLoading(true);

      getVsCodeApi().postMessage({ type: 'COMMIT_DO_COMMIT_MULTI', requestId: generateId(), repos: targets, andPush } satisfies CommitToHostMsg);
      store.setCommitMessage('');
      return;
    }

    const targets = currentRepos
      .filter(r => freshState.repoSelections[r.repoId] !== false)
      .map(r => {
        const repoId = r.repoId;
        const selectedPaths = new Set(freshState.getSelectedFilesForRepo(repoId));
        const stagedPaths = new Set(r.stagedFiles.map(f => f.path));
        const unstagedPaths = new Set(r.unstagedFiles.map(f => f.path));
        // Include partially-staged files so their unstaged changes are also committed.
        const filesToStage = Array.from(selectedPaths).filter(p => !stagedPaths.has(p) || unstagedPaths.has(p));
        const filesToUnstage = r.stagedFiles.map(f => f.path).filter(p => !selectedPaths.has(p));
        return { repoId, message: freshState.commitMessage, amend: freshState.amendFlags[repoId] ?? false, filesToStage, filesToUnstage };
      })
      .filter(r => {
        const repoStatus = currentRepos.find(rs => rs.repoId === r.repoId)!;
        const stagedAfter = new Set(repoStatus.stagedFiles.map(f => f.path));
        for (const p of r.filesToUnstage) stagedAfter.delete(p);
        for (const p of r.filesToStage) stagedAfter.add(p);
        return stagedAfter.size > 0;
      });
    if (targets.length === 0) return;
    store.setLoading(true);
    store.setError(null);
    getVsCodeApi().postMessage({ type: 'COMMIT_DO_COMMIT_MULTI', requestId: generateId(), repos: targets, andPush } satisfies CommitToHostMsg);
    store.setCommitMessage('');
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={css.app} onContextMenu={e => e.preventDefault()}>

      {/* ── Toolbar ── */}
      <div style={css.toolbar}>
        <div style={css.toolbarLeft}>
          <button style={css.iconBtn} title="Refresh" onClick={() => send({ type: 'COMMIT_REQUEST_STATUS' })}>
            <Codicon name="refresh" />
          </button>
          {activeTab === 'changes' && (<>
            <button style={css.iconBtn} title="Expand all" onClick={() => store.expandAll()}>
              <Codicon name="expand-all" />
            </button>
            <button style={css.iconBtn} title="Collapse all" onClick={() => store.collapseAll()}>
              <Codicon name="collapse-all" />
            </button>
            <div ref={viewMenuRef} style={{ position: 'relative' }}>
              <button style={css.iconBtn} title="View options" onClick={() => setViewMenuOpen(o => !o)}>
                <Codicon name="eye" />
              </button>
              {viewMenuOpen && (
                <div style={{ ...css.dropdownPanel, left: 0 }}>
                  <div style={css.dropdownTitle}>View</div>
                  {(['flat', 'tree'] as const).map(mode => (
                    <div
                      key={mode}
                      style={{ ...css.dropdownItem, fontWeight: store.viewMode === mode ? 'bold' : 'normal' }}
                      onClick={() => { store.setViewMode(mode); send({ type: 'COMMIT_SET_FILE_VIEW_MODE', mode }); setViewMenuOpen(false); }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Codicon name={mode === 'flat' ? 'list-unordered' : 'list-tree'} style={{ marginRight: '6px' }} />
                      {mode === 'flat' ? 'Flat list' : 'Tree view'}
                      {store.viewMode === mode && <Codicon name="check" style={{ marginLeft: 'auto' }} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>)}
          {activeTab === 'shelf' && (<>
            <button style={css.iconBtn} title="Expand all" onClick={() => {
              const allShelves = Object.values(shelveMap).flat();
              const shelveIds = allShelves.map(s => s.id);
              const dirPaths = new Set<string>();
              for (const s of allShelves) {
                for (const f of s.files) {
                  const parts = f.path.split('/');
                  for (let i = 1; i < parts.length; i++) dirPaths.add(parts.slice(0, i).join('/'));
                }
              }
              store.shelveExpandAll(shelveIds, Array.from(dirPaths));
            }}>
              <Codicon name="expand-all" />
            </button>
            <button style={css.iconBtn} title="Collapse all" onClick={() => {
              store.shelveCollapseAll([], []);
            }}>
              <Codicon name="collapse-all" />
            </button>
            <div ref={shelveViewMenuRef} style={{ position: 'relative' }}>
              <button style={css.iconBtn} title="View options" onClick={() => setShelveViewMenuOpen(o => !o)}>
                <Codicon name="eye" />
              </button>
              {shelveViewMenuOpen && (
                <div style={{ ...css.dropdownPanel, left: 0 }}>
                  <div style={css.dropdownTitle}>View</div>
                  {(['flat', 'tree'] as const).map(mode => (
                    <div
                      key={mode}
                      style={{ ...css.dropdownItem, fontWeight: store.shelveViewMode === mode ? 'bold' : 'normal' }}
                      onClick={() => { store.setShelveViewMode(mode); setShelveViewMenuOpen(false); }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Codicon name={mode === 'flat' ? 'list-unordered' : 'list-tree'} style={{ marginRight: '6px' }} />
                      {mode === 'flat' ? 'Flat list' : 'Tree view'}
                      {store.shelveViewMode === mode && <Codicon name="check" style={{ marginLeft: 'auto' }} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>)}
          {activeTab === 'stash' && (<>
            <button style={css.iconBtn} title="Expand all" onClick={() => setStashExpandAll(true)}>
              <Codicon name="expand-all" />
            </button>
            <button style={css.iconBtn} title="Collapse all" onClick={() => setStashExpandAll(false)}>
              <Codicon name="collapse-all" />
            </button>
          </>)}
          {hiddenRepoIds.length > 0 && (
            <button
              style={{ ...css.iconBtn, position: 'relative' }}
              title={`${hiddenRepoIds.length} hidden repositor${hiddenRepoIds.length === 1 ? 'y' : 'ies'} — click to manage`}
              onClick={() => send({ type: 'COMMIT_MANAGE_HIDDEN_REPOS' })}
            >
              <Codicon name="eye-closed" />
              <span style={{
                position: 'absolute', top: '1px', right: '1px',
                background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
                borderRadius: '8px', fontSize: '9px', lineHeight: '14px',
                minWidth: '14px', height: '14px', textAlign: 'center', padding: '0 3px',
              }}>{hiddenRepoIds.length}</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Tab bar ── */}
      {(() => {
        const totalToPush = repos.reduce((sum, r) => {
          if (r.branch.upstream) return sum + (r.branch.aheadBehind?.ahead ?? 0);
          return sum + (unpushedMap[r.repoId]?.commits?.length ?? 0);
        }, 0);
        return (
          <div style={css.tabBar}>
            {(['changes', 'shelf', 'stash', 'worktree', 'push'] as TabId[]).map(tab => {
              const changesLabel = (store.changesViewMode === 'changelists' || store.changesViewMode === 'vscode') ? 'Commit' : 'Changes';
              const label = tab === 'changes' ? changesLabel : tab === 'shelf' ? 'Shelf' : tab === 'stash' ? 'Stash' : tab === 'worktree' ? 'Worktrees' : 'Push';
              const iconName = tab === 'changes' ? 'source-control' : tab === 'shelf' ? 'archive' : tab === 'stash' ? 'save' : tab === 'worktree' ? 'repo-clone' : 'cloud-upload';
              return (
                <button
                  key={tab}
                  style={css.tab(activeTab === tab)}
                  title={label}
                  onClick={() => {
                    setActiveTab(tab);
                    if (tab === 'shelf') repos.forEach(r => requestShelveList(r.repoId));
                    if (tab === 'stash') repos.forEach(r => requestStashList(r.repoId));
                    if (tab === 'push') repos.forEach(r => requestUnpushedCommits(r.repoId));
                    if (tab === 'worktree') requestWorktreeList();
                  }}
                >
                  <Codicon
                    name={iconName}
                    style={{ marginRight: activeTab === tab ? '5px' : '0', fontSize: '13px', transition: 'margin 0.15s' }}
                  />
                  {activeTab === tab && (
                    <span style={{ animation: 'gs-tab-label-in 0.18s ease-out both', overflow: 'hidden', display: 'inline-block' }}>
                      {label}
                    </span>
                  )}
                  {tab === 'push' && totalToPush > 0 && (
                    <span style={css.pushBadge}>{totalToPush}</span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* ── Tab content ── */}
      <div style={css.main}>

        {activeTab === 'changes' && (<>

          {/* File list */}
          <div style={css.repoList}>
            {store.changesViewMode === 'vscode' ? (
              <VscodeView
                repos={repos}
                repoMetas={store.repoMetas}
                selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                ctxFile={ctxFile}
                viewMode={store.viewMode}
                isCollapsed={store.isCollapsed}
                toggleCollapsed={store.toggleCollapsed}
                onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                onContextMenu={(e, file, staged) => {
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
                onResolveMerge={f => send({ type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                onStageFiles={(rid, paths) => { store.isCollapsed('vscode-section:staged') && store.toggleCollapsed('vscode-section:staged'); send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: rid, paths }); }}
                onUnstageFiles={(rid, paths) => { store.isCollapsed('vscode-section:unstaged') && store.toggleCollapsed('vscode-section:unstaged'); send({ type: 'COMMIT_UNSTAGE_FILES', requestId: generateId(), repoId: rid, paths }); }}
                onStageAll={rid => { store.isCollapsed('vscode-section:staged') && store.toggleCollapsed('vscode-section:staged'); send({ type: 'COMMIT_STAGE_ALL', requestId: generateId(), repoId: rid }); }}
                onUnstageAll={rid => { store.isCollapsed('vscode-section:unstaged') && store.toggleCollapsed('vscode-section:unstaged'); send({ type: 'COMMIT_UNSTAGE_ALL', requestId: generateId(), repoId: rid }); }}
                onRepoContextMenu={(e, rid, staged) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, stagedSection: staged })}
                onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                onOpenStagedChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid, section: 'staged' })}
                onOpenUnstagedChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid, section: 'unstaged' })}
                iconTheme={store.iconTheme}
                activeFolderPath={activeFolderPath}
                selectedRepos={vscodeSelectedRepos}
                onToggleRepoSelection={toggleVscodeRepoSelection}
                onOpenAllChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
              />
            ) : store.changesViewMode === 'changelists' ? (
              <ChangelistView
                changelists={store.changelists}
                repos={repos}
                repoMetas={store.repoMetas}
                selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                viewMode={store.viewMode}
                isFileSelected={store.isFileSelected}
                isCollapsed={store.isCollapsed}
                toggleCollapsed={store.toggleCollapsed}
                onToggleFile={store.toggleFileSelection}
                onSetFiles={store.setFileSelections}
                onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                onContextMenu={(e, file) => { setCtxFile({ repoId: file.repoId, path: file.path }); setCtxMenu({ x: e.clientX, y: e.clientY, file }); }}
                onFolderContextMenu={(e, rid, folderPath, files) => { setActiveFolderPath(folderPath); setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files }); }}
                onOpenFile={f => send({ type: 'COMMIT_OPEN_FILE', repoId: f.repoId, filePath: f.path })}
                onRollback={files => {
                  if (files.length === 1) {
                    send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: files[0].repoId, path: files[0].path });
                  } else {
                    send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                  }
                }}
                onResolveMerge={f => send({ type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                onHeaderContextMenu={(e, clId) => setClHeaderCtxMenu({ x: e.clientX, y: e.clientY, changelistId: clId })}
                onRepoContextMenu={(e, rid, clId) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, changelistId: clId })}
                onOpenChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
                onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                iconTheme={store.iconTheme}
                activeFolderPath={activeFolderPath}
                ctxFile={ctxFile}
              />
            ) : (
              repos.map((repoStatus, idx) => {
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
                          <strong>{repoName}</strong> is in detached HEAD ({detachedCommit}). Checkout a branch to commit.
                        </span>
                        <button
                          style={css.detachedBannerBtn}
                          onClick={() => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId })}
                          title="Checkout or create a branch"
                        >
                          Checkout branch
                        </button>
                        <button
                          style={{ ...css.detachedBannerBtn, background: 'transparent', opacity: 0.5 }}
                          onClick={() => setDetachedWarnings(prev => { const n = { ...prev }; delete n[repoId]; return n; })}
                          title="Dismiss"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    <ProjectGroup
                      isFirst={idx === 0}
                      repoStatus={repoStatus}
                      repoName={repoName}
                      repoColor={repoColor}
                      multiRepo={multiRepo}
                      isSubmodule={meta?.isSubmodule}
                      submodulePath={meta?.submodulePath}
                      isWorktree={meta?.isWorktree}
                      mainWorktreePath={meta?.mainWorktreePath}
                      selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                      viewMode={store.viewMode}
                      isFileSelected={store.isFileSelected}
                      isCollapsed={store.isCollapsed}
                      toggleCollapsed={store.toggleCollapsed}
                      onToggleFile={store.toggleFileSelection}
                      onSetFiles={store.setFileSelections}
                      onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                      onContextMenu={(e, file) => { setCtxFile({ repoId: file.repoId, path: file.path }); setCtxMenu({ x: e.clientX, y: e.clientY, file }); }}
                      onFolderContextMenu={(e, rid, folderPath, files) => { setActiveFolderPath(folderPath); setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files }); }}
                      onOpenFile={f => send({ type: 'COMMIT_OPEN_FILE', repoId: f.repoId, filePath: f.path })}
                      onRollback={files => {
                        if (files.length === 1) {
                          send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: files[0].repoId, path: files[0].path });
                        } else {
                          send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                        }
                      }}
                      onResolveMerge={f => send({ type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                      onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                      onRepoContextMenu={(e, rid) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid })}
                      onOpenAllChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
                      iconTheme={store.iconTheme}
                      activeFolderPath={activeFolderPath}
                      ctxFile={ctxFile}
                    />
                  </React.Fragment>
                );
              })
            )}
          </div>

          {/* Shelve name prompt — appears above commit form */}
          {shelvePrompt && (
            <div style={css.shelvePromptBar}>
              <Codicon name="archive" style={{ flexShrink: 0, opacity: 0.65, fontSize: '14px' }} />
              <input
                ref={shelvePromptRef}
                style={css.shelvePromptInput}
                value={shelvePromptName}
                onChange={e => setShelvePromptName(e.target.value)}
                placeholder="Shelve name…"
                onKeyDown={e => {
                  if (e.key === 'Enter') confirmShelve(shelvePrompt.repoId, shelvePromptName, shelvePrompt.paths);
                  if (e.key === 'Escape') setShelvePrompt(null);
                }}
              />
              <button
                style={css.shelvePromptOk}
                onClick={() => confirmShelve(shelvePrompt.repoId, shelvePromptName, shelvePrompt.paths)}
                disabled={!shelvePromptName.trim()}
                title="Confirm shelve"
              >
                <Codicon name="check" />
              </button>
              <button style={css.shelvePromptCancel} onClick={() => setShelvePrompt(null)} title="Cancel">
                <Codicon name="close" />
              </button>
            </div>
          )}

          {/* Commit form */}
          <UnifiedCommitForm
            message={store.commitMessage}
            repoStatuses={repos}
            repoMetas={store.repoMetas}
            amendFlags={store.amendFlags}
            loading={store.loading}
            changesViewMode={store.changesViewMode}
            defaultCommitAction={store.defaultCommitAction}
            vscodeSelectedRepos={store.changesViewMode === 'vscode' ? vscodeSelectedRepos : undefined}
            getSelectedFilesForRepo={store.getSelectedFilesForRepo}
            onDeselectRepo={repoId => {
              if (store.changesViewMode === 'vscode') {
                toggleVscodeRepoSelection(repoId);
              } else {
                const r = repos.find(r => r.repoId === repoId);
                if (!r) return;
                const allPaths = [...r.stagedFiles, ...r.unstagedFiles].map(f => f.path);
                store.setFileSelections(repoId, allPaths, false);
              }
            }}
            onMessageChange={msg => store.setCommitMessage(msg)}
            onAmendToggle={repoId => store.setAmend(repoId, !(store.amendFlags[repoId] ?? false))}
            onCommit={() => doCommit(false)}
            onCommitAndPush={() => doCommit(true)}
            onPush={doPush}
            onPushAll={doPushAll}
            aiEnabled={store.aiEnabled}
            onAutopilot={doAutopilot}
            onAutopilotContextMenu={doAutopilotContextMenu}
            generatingMessage={generatingMessage}
            onShelve={() => {
              const name = store.commitMessage.trim();
              if (!name) return;
              for (const repoStatus of repos) {
                const selectedPaths = store.getSelectedFilesForRepo(repoStatus.repoId);
                if (selectedPaths.length === 0) continue;
                confirmShelve(repoStatus.repoId, name, selectedPaths);
              }
              store.setCommitMessage('');
            }}
            onStash={() => {
              const message = store.commitMessage.trim() || 'WIP stash';
              for (const repoStatus of repos) {
                const selectedPaths = store.getSelectedFilesForRepo(repoStatus.repoId);
                if (selectedPaths.length === 0) continue;
                doStash(repoStatus.repoId, message, selectedPaths);
              }
            }}
          />

        </>)}

        {activeTab === 'shelf' && (
          /* Shelf tab */
          <div style={css.repoList}>
            {repos.map(repoStatus => {
              const repoId = repoStatus.repoId;
              const meta = metaMap.get(repoId);
              const repoName = meta?.name ?? repoId.split('/').pop() ?? repoId;
              const repoColor = meta?.color ?? '#4ec9b0';
              const worktreeBranch = meta?.isWorktree
                ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
                : undefined;
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
                  shelves={shelveMap[repoId] ?? []}
                  loading={shelveLoading[repoId] ?? false}
                  error={shelveError[repoId] ?? null}
                  viewMode={store.shelveViewMode}
                  onUnshelve={handleUnshelve}
                  onUnshelveFile={handleUnshelveFile}
                  onDrop={handleDropShelve}
                  onRequestList={requestShelveList}
                  onOpenFileDiff={handleOpenFileDiff}
                />
              );
            })}
          </div>
        )}

        {activeTab === 'stash' && (
          /* Stash tab */
          <div style={css.repoList}>
            {repos.map(repoStatus => {
              const repoId = repoStatus.repoId;
              const meta = metaMap.get(repoId);
              const repoName = meta?.name ?? repoId.split('/').pop() ?? repoId;
              const repoColor = meta?.color ?? '#4ec9b0';
              const worktreeBranch = meta?.isWorktree
                ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
                : undefined;
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
                  stashes={stashMap[repoId] ?? []}
                  loading={stashLoading[repoId] ?? false}
                  error={stashError[repoId] ?? null}
                  viewMode={store.viewMode}
                  onApply={handleStashApply}
                  onPop={handleStashPop}
                  onDrop={handleStashDrop}
                  onRequestList={requestStashList}
                  onOpenFileDiff={handleStashShowFileDiff}
                  expandAll={stashExpandAll}
                />
              );
            })}
          </div>
        )}

        {activeTab === 'push' && (
          /* Push tab — manages its own scroll, footer anchored at bottom */
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <PushTab
              repos={repos}
              repoMetas={store.repoMetas}
              unpushedMap={unpushedMap}
              onPush={doPush}
              onPushAll={doPushAll}
              onOpenInLog={doOpenInLog}
              onUndoCommit={doUndoCommit}
              onSquash={doSquash}
              onDropCommits={doDropCommits}
              onRevertCommits={doRevertCommits}
              onEditCommitMsg={doEditCommitMsg}
              onOpenDetail={doPushOpenDetail}
              onExplainCommit={doPushExplainCommit}
              aiEnabled={store.aiEnabled}
            />
          </div>
        )}

        {activeTab === 'worktree' && (
          /* Worktree tab */
          <div style={css.repoList}>
            <WorktreePanel
              repos={worktreeRepos}
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
          </div>
        )}

      </div>

      {/* File context menu */}
      {ctxMenu && (() => {
        const file = ctxMenu.file;
        const isUntracked = file.status === 'untracked';
        const isSubmodule = file.status === 'submodule';
        const hasCustomCls = store.changelists.some(cl => cl.id !== CHANGELIST_DEFAULT_ID && cl.id !== CHANGELIST_UNVERSIONED_ID);
        const baseItems = file.status === 'conflicted' ? FILE_CONTEXT_ITEMS_CONFLICT : FILE_CONTEXT_ITEMS;
        let items: ContextMenuEntry[] = baseItems;
        if (isSubmodule) {
          items = ctxMenuStaged ? SUBMODULE_FILE_STAGED_ITEMS : SUBMODULE_FILE_UNSTAGED_ITEMS;
        } else if (store.changesViewMode === 'vscode') {
          items = ctxMenuStaged ? VSCODE_FILE_STAGED_ITEMS : VSCODE_FILE_UNSTAGED_ITEMS;
        } else if (store.changesViewMode === 'changelists') {
          if (isUntracked) {
            items = [
              { id: 'add-to-git', label: 'Add to Git',        icon: 'add' },
              { id: 'rollback',   label: 'Rollback',           icon: 'discard' },
              { id: 'shelve',     label: 'Shelve',             icon: 'archive' },
              { id: 'stash',      label: 'Stash',              icon: 'save' },
              { id: 'diff',       label: 'Show Diff',          icon: 'diff' },
              { id: 'jump',       label: 'Jump to Source',     icon: 'go-to-file' },
              { separator: true },
              { id: 'gitignore',  label: 'Add to .gitignore', icon: 'exclude' },
              { separator: true },
              { id: 'delete',     label: 'Delete',             icon: 'trash', danger: true },
              { separator: true },
              { id: 'refresh',    label: 'Refresh',            icon: 'refresh' },
            ];
          } else {
            items = hasCustomCls
              ? [...baseItems, { separator: true }, { id: 'move-to-cl', label: 'Move to Changelist…', icon: 'list-unordered' }]
              : baseItems;
          }
        }
        return (
          <ContextMenu
            x={ctxMenu.x} y={ctxMenu.y}
            items={items}
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
        let items: ContextMenuEntry[] = FOLDER_CONTEXT_ITEMS;
        if (store.changesViewMode === 'vscode') {
          items = folderCtxMenuStaged ? VSCODE_FOLDER_STAGED_ITEMS : VSCODE_FOLDER_UNSTAGED_ITEMS;
        } else if (store.changesViewMode === 'changelists') {
          if (allUntracked) {
            items = [
              { id: 'add-to-git', label: 'Add to Git',        icon: 'add' },
              { id: 'rollback',   label: 'Rollback',           icon: 'discard' },
              { id: 'shelve',     label: 'Shelve Changes',     icon: 'archive' },
              { id: 'stash',      label: 'Stash Changes',      icon: 'save' },
              { separator: true },
              { id: 'gitignore',  label: 'Add to .gitignore', icon: 'exclude' },
              { separator: true },
              { id: 'delete',     label: 'Delete',             icon: 'trash', danger: true },
              { separator: true },
              { id: 'refresh',    label: 'Refresh',            icon: 'refresh' },
            ];
          } else {
            items = hasCustomCls
              ? [...FOLDER_CONTEXT_ITEMS, { separator: true }, { id: 'move-to-cl', label: 'Move to Changelist…', icon: 'list-unordered' }]
              : FOLDER_CONTEXT_ITEMS;
          }
        }
        return (
          <ContextMenu
            x={folderCtxMenu.x} y={folderCtxMenu.y}
            items={items}
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
        let repoItems = REPO_CONTEXT_ITEMS;
        if (store.changesViewMode === 'vscode') {
          repoItems = repoCtxMenu.stagedSection ? VSCODE_REPO_STAGED_ITEMS : VSCODE_REPO_UNSTAGED_ITEMS;
        } else if (store.changesViewMode === 'changelists') {
          const baseItems: ContextMenuEntry[] = [
            { id: 'rollback',     label: 'Rollback',              icon: 'discard' },
            { id: 'shelve',       label: 'Shelve Changes',         icon: 'archive' },
            { id: 'stash',        label: 'Stash Changes',          icon: 'save' },
            { separator: true },
            ...(!isInDefaultCl ? [{ id: 'add-to-git', label: 'Add to Git', icon: 'add' } as ContextMenuEntry] : []),
            ...(hasCustomCls ? [{ id: 'move-to-cl', label: 'Move to Changelist…', icon: 'list-unordered' } as ContextMenuEntry] : []),
            { separator: true },
            { id: 'manage-repo',  label: 'Manage Repository',      icon: 'git-branch' },
            { id: 'view-git-log', label: 'View Git Log',           icon: 'git-commit' },
            { separator: true },
            { id: 'hide-repo',    label: 'Hide Repository',        icon: 'eye-closed' },
            { separator: true },
            { id: 'refresh',      label: 'Refresh',                icon: 'refresh' },
          ];
          repoItems = baseItems;
        }
        return (
          <ContextMenu
            x={repoCtxMenu.x} y={repoCtxMenu.y}
            items={repoItems}
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

      {/* Changelist header context menu (also used for empty-space click) */}
      {clHeaderCtxMenu && (() => {
        const isEmpty = clHeaderCtxMenu.changelistId === 'empty';
        const isUnversioned = clHeaderCtxMenu.changelistId === CHANGELIST_UNVERSIONED_ID;
        const isFixed = clHeaderCtxMenu.changelistId === CHANGELIST_DEFAULT_ID || isUnversioned;
        const items = isEmpty
          ? CHANGELIST_EMPTY_AREA_ITEMS
          : isUnversioned
            ? CHANGELIST_HEADER_ITEMS_UNVERSIONED
            : isFixed
              ? CHANGELIST_HEADER_ITEMS_FIXED
              : CHANGELIST_HEADER_ITEMS_CUSTOM;
        return (
          <ContextMenu
            x={clHeaderCtxMenu.x} y={clHeaderCtxMenu.y}
            items={items}
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
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '2px 6px', borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)', flexShrink: 0, gap: '4px',
  },
  toolbarLeft:  { display: 'flex', alignItems: 'center', gap: '1px' } as React.CSSProperties,
  iconBtn: {
    background: 'transparent', border: 'none', color: 'var(--vscode-foreground)',
    cursor: 'pointer', padding: '4px 5px', borderRadius: '3px',
    fontSize: '14px', display: 'flex', alignItems: 'center', opacity: 0.8,
  } as React.CSSProperties,
  dropdownPanel: {
    position: 'absolute' as const, top: '100%', left: 0, zIndex: 1000,
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    minWidth: '200px', maxWidth: '280px', padding: '4px 0', fontSize: '12px',
  },
  dropdownTitle: {
    padding: '4px 12px', fontSize: '10px', opacity: 0.5,
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  },
  dropdownItem: {
    display: 'flex', alignItems: 'center', padding: '5px 12px', cursor: 'pointer',
    background: 'transparent', overflow: 'hidden', textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const, gap: '4px',
  } as React.CSSProperties,
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
    background: 'var(--vscode-editor-background)', flexShrink: 0,
  } as React.CSSProperties,
  tab: (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center',
    padding: active ? '5px 12px' : '5px 10px',
    fontSize: '12px',
    cursor: 'pointer', background: 'transparent', border: 'none',
    borderBottom: active ? '2px solid var(--vscode-focusBorder)' : '2px solid transparent',
    opacity: active ? 1 : 0.6, fontFamily: 'var(--vscode-font-family)',
    fontWeight: active ? '600' : 'normal', whiteSpace: 'nowrap' as const,
    transition: 'opacity 0.1s, border-color 0.1s', color: 'var(--vscode-foreground)',
  }),
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
  repoList: { flex: 1, overflowY: 'auto' as const },
  // Shelve name prompt bar (above commit form)
  detachedBanner: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px',
    background: 'color-mix(in srgb, var(--vscode-statusBarItem-warningBackground, #c6a300) 15%, transparent)',
    borderBottom: '1px solid color-mix(in srgb, var(--vscode-statusBarItem-warningBackground, #c6a300) 35%, transparent)',
    fontSize: '11px', color: 'var(--vscode-foreground)', flexShrink: 0,
  } as React.CSSProperties,
  detachedBannerBtn: {
    background: 'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.1))',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: 'none', borderRadius: '3px', padding: '2px 7px', cursor: 'pointer',
    fontSize: '11px', flexShrink: 0,
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

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
