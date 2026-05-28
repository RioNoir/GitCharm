import React, { useEffect, useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useCommitStore } from './store/commitStore';
import { ProjectGroup } from './components/ProjectGroup';
import { UnifiedCommitForm } from './components/UnifiedCommitForm';
import { ContextMenu, type ContextMenuEntry } from './components/ContextMenu';
import { ShelvePanel } from './components/ShelvePanel';
import { StashTab } from './components/StashTab';
import { PushTab } from './components/PushTab';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import type { CommitToHostMsg, HostToCommitMsg, ShelveEntry, StashEntry, UnpushedCommit } from '../shared/msgTypes';
import type { FileStatus } from '../shared/types';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Context menu items ────────────────────────────────────────────────────────

const FILE_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'rollback',  label: 'Rollback',            icon: 'discard' },
  { id: 'shelve',    label: 'Shelve',              icon: 'archive' },
  { id: 'stash',     label: 'Stash',               icon: 'save' },
  { id: 'diff',      label: 'Show Diff',           icon: 'diff' },
  { id: 'jump',      label: 'Jump to Source',      icon: 'go-to-file' },
  { separator: true },
  { id: 'gitignore', label: 'Add to .gitignore',  icon: 'exclude' },
  { separator: true },
  { id: 'delete',    label: 'Delete',              icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',   label: 'Refresh',             icon: 'refresh' },
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
  { id: 'rollback',  label: 'Rollback',           icon: 'discard' },
  { id: 'shelve',    label: 'Shelve Changes',      icon: 'archive' },
  { id: 'stash',     label: 'Stash Changes',       icon: 'save' },
  { separator: true },
  { id: 'refresh',   label: 'Refresh',             icon: 'refresh' },
];

type TabId = 'changes' | 'shelf' | 'stash' | 'push';

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
    const id = 'gitstorm-tab-kf';
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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: FileStatus } | null>(null);
  const [folderCtxMenu, setFolderCtxMenu] = useState<{
    x: number; y: number; repoId: string; folderPath: string; files: FileStatus[];
  } | null>(null);
  const [repoCtxMenu, setRepoCtxMenu] = useState<{ x: number; y: number; repoId: string } | null>(null);

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

  // Auto-dismiss error after 6 seconds
  useEffect(() => {
    if (!store.error) return;
    const t = setTimeout(() => store.setError(null), 6000);
    return () => clearTimeout(t);
  }, [store.error]);

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
          store.setStatus(msg.repos, msg.status, msg.iconTheme);
          break;
        case 'COMMIT_OP_RESULT':
          store.setLoading(false);
          if (msg.ok) {
            // Refresh push tab after any successful operation (commit, undo, push, etc.)
            const currentRepos = useCommitStore.getState().status?.repos ?? [];
            currentRepos.forEach(r => requestUnpushedCommits(r.repoId));
          } else if (msg.error && msg.error !== 'Cancelled') {
            store.setError(msg.error);
          }
          break;
        case 'COMMIT_GENERATE_MESSAGE_RESULT':
          setGeneratingMessage(false);
          if (msg.message) store.setCommitMessage(msg.message);
          else if (msg.error && msg.error !== 'Cancelled') store.setError(msg.error);
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
            if (msg.error && msg.error !== 'Cancelled') store.setError(msg.error);
          } else {
            if (msg.hasConflicts && msg.conflictFiles?.length) {
              store.setError(`Conflicts in ${msg.conflictFiles.length} file(s) — merge editor opened`);
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
            if (msg.error && msg.error !== 'Cancelled') store.setError(msg.error);
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

  const repos = store.status?.repos ?? [];
  const metaMap = new Map(store.repoMetas.map(m => [m.id, m]));
  const multiRepo = repos.length > 1;

  // When the push tab is open, refresh no-upstream repos whenever the set of those repos changes
  // (e.g. a branch gains/loses its remote tracking branch). Upstream repos are live via aheadBehind.ahead.
  // Full refresh on every status update is intentionally avoided to prevent visual noise.
  const noUpstreamKey = repos.filter(r => !r.branch.upstream).map(r => r.repoId).join(',');
  useEffect(() => {
    if (activeTab !== 'push' || !noUpstreamKey) return;
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
      case 'refresh':
        send({ type: 'COMMIT_REQUEST_STATUS' });
        break;
    }
  }, [repoCtxMenu, repos, doStash, confirmShelve, send]);

  // ── Push actions ──────────────────────────────────────────────────────────

  const doPush = (repoId: string) => {
    send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId, remote: 'origin' });
  };

  const doOpenInLog = (hash: string, repoId: string) => {
    send({ type: 'COMMIT_OPEN_LOG', hash, repoId });
  };

  const doUndoCommit = (repoId: string) => {
    send({ type: 'COMMIT_UNDO_COMMIT', requestId: generateId(), repoId });
  };

  const doPushAll = () => {
    const allRepos = useCommitStore.getState().status?.repos ?? [];
    for (const r of allRepos) {
      if ((r.branch.aheadBehind?.ahead ?? 0) > 0) {
        send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId: r.repoId, remote: 'origin' });
      }
    }
  };

  // ── Autopilot ─────────────────────────────────────────────────────────────

  const doAutopilot = useCallback(() => {
    if (generatingMessage) return;
    setGeneratingMessage(true);
    send({ type: 'COMMIT_GENERATE_MESSAGE', requestId: generateId() });
  }, [generatingMessage, send]);

  // ── Loading / empty states ────────────────────────────────────────────────

  if (repos.length === 0 && !store.status) {
    return (
      <div style={css.fullCenter}>
        <span style={{ opacity: 0.5, fontSize: '13px' }}>Loading repositories…</span>
      </div>
    );
  }

  if (repos.length === 0 && store.status) {
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
    const targets = repos
      .filter(r => store.repoSelections[r.repoId] !== false)
      .map(r => {
        const repoId = r.repoId;
        const selectedPaths = new Set(store.getSelectedFilesForRepo(repoId));
        const stagedPaths = new Set(r.stagedFiles.map(f => f.path));
        const filesToStage = Array.from(selectedPaths).filter(p => !stagedPaths.has(p));
        const filesToUnstage = r.stagedFiles.map(f => f.path).filter(p => !selectedPaths.has(p));
        return { repoId, message: store.commitMessage, amend: store.amendFlags[repoId] ?? false, filesToStage, filesToUnstage };
      })
      .filter(r => {
        const repoStatus = repos.find(rs => rs.repoId === r.repoId)!;
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
            <button style={css.iconBtn} title="Rollback" onClick={() => {
              const allFiles: Array<{ repoId: string; path: string }> = [];
              for (const r of repos) {
                const seen = new Set<string>();
                for (const f of [...r.unstagedFiles, ...r.stagedFiles]) {
                  if (!seen.has(f.path)) { seen.add(f.path); allFiles.push({ repoId: f.repoId, path: f.path }); }
                }
              }
              if (allFiles.length > 0) send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: allFiles });
            }}>
              <Codicon name="discard" />
            </button>
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
                      onClick={() => { store.setViewMode(mode); setViewMenuOpen(false); }}
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
            {(['changes', 'shelf', 'stash', 'push'] as TabId[]).map(tab => (
              <button
                key={tab}
                style={css.tab(activeTab === tab)}
                title={tab === 'changes' ? 'Changes' : tab === 'shelf' ? 'Shelf' : tab === 'stash' ? 'Stash' : 'Push'}
                onClick={() => {
                  setActiveTab(tab);
                  if (tab === 'shelf') repos.forEach(r => requestShelveList(r.repoId));
                  if (tab === 'stash') repos.forEach(r => requestStashList(r.repoId));
                  if (tab === 'push') repos.forEach(r => requestUnpushedCommits(r.repoId));
                }}
              >
                <Codicon
                  name={tab === 'changes' ? 'source-control' : tab === 'shelf' ? 'archive' : tab === 'stash' ? 'save' : 'cloud-upload'}
                  style={{ marginRight: activeTab === tab ? '5px' : '0', fontSize: '13px', transition: 'margin 0.15s' }}
                />
                {activeTab === tab && (
                  <span style={{ animation: 'gs-tab-label-in 0.18s ease-out both', overflow: 'hidden', display: 'inline-block' }}>
                    {tab === 'changes' ? 'Changes' : tab === 'shelf' ? 'Shelf' : tab === 'stash' ? 'Stash' : 'Push'}
                  </span>
                )}
                {tab === 'push' && totalToPush > 0 && (
                  <span style={css.pushBadge}>{totalToPush}</span>
                )}
              </button>
            ))}
          </div>
        );
      })()}

      {/* ── Error / info notification bar ── */}
      {store.error && (
        <div style={css.notificationBar}>
          <Codicon name="warning" style={{ flexShrink: 0, fontSize: '13px' }} />
          <span style={css.notificationText}>{store.error}</span>
          <button style={css.notificationClose} onClick={() => store.setError(null)} title="Dismiss">
            <Codicon name="close" />
          </button>
        </div>
      )}

      {/* ── Tab content ── */}
      <div style={css.main}>

        {activeTab === 'changes' && (<>

          {/* File list */}
          <div style={css.repoList}>
            {repos.map(repoStatus => {
              const repoId = repoStatus.repoId;
              const meta = metaMap.get(repoId);
              const repoName = meta?.name ?? repoId.split('/').pop() ?? repoId;
              const repoColor = meta?.color ?? '#4ec9b0';
              return (
                <ProjectGroup
                  key={repoId}
                  repoStatus={repoStatus}
                  repoName={repoName}
                  repoColor={repoColor}
                  multiRepo={multiRepo}
                  selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                  viewMode={store.viewMode}
                  isFileSelected={store.isFileSelected}
                  isCollapsed={store.isCollapsed}
                  toggleCollapsed={store.toggleCollapsed}
                  onToggleFile={store.toggleFileSelection}
                  onSetFiles={store.setFileSelections}
                  onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                  onContextMenu={(e, file) => { setSelectedFile(file); setCtxMenu({ x: e.clientX, y: e.clientY, file }); }}
                  onFolderContextMenu={(e, rid, folderPath, files) => setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files })}
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
                />
              );
            })}
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
            getSelectedFilesForRepo={store.getSelectedFilesForRepo}
            onMessageChange={msg => store.setCommitMessage(msg)}
            onAmendToggle={repoId => store.setAmend(repoId, !(store.amendFlags[repoId] ?? false))}
            onCommit={() => doCommit(false)}
            onCommitAndPush={() => doCommit(true)}
            onPush={doPush}
            onPushAll={doPushAll}
            onAutopilot={doAutopilot}
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
              return (
                <ShelvePanel
                  key={repoId}
                  repoId={repoId}
                  repoName={repoName}
                  repoColor={repoColor}
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
              return (
                <StashTab
                  key={repoId}
                  repoId={repoId}
                  repoName={repoName}
                  repoColor={repoColor}
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
          /* Push tab */
          <div style={css.repoList}>
            <PushTab
              repos={repos}
              repoMetas={store.repoMetas}
              unpushedMap={unpushedMap}
              onPush={doPush}
              onPushAll={doPushAll}
              onOpenInLog={doOpenInLog}
              onUndoCommit={doUndoCommit}
            />
          </div>
        )}

      </div>

      {/* File context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x} y={ctxMenu.y}
          items={ctxMenu.file.status === 'conflicted' ? FILE_CONTEXT_ITEMS_CONFLICT : FILE_CONTEXT_ITEMS}
          onSelect={handleContextMenuSelect}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Folder context menu */}
      {folderCtxMenu && (
        <ContextMenu
          x={folderCtxMenu.x} y={folderCtxMenu.y}
          items={FOLDER_CONTEXT_ITEMS}
          onSelect={handleFolderContextMenuSelect}
          onClose={() => setFolderCtxMenu(null)}
        />
      )}
      {repoCtxMenu && (
        <ContextMenu
          x={repoCtxMenu.x} y={repoCtxMenu.y}
          items={REPO_CONTEXT_ITEMS}
          onSelect={handleRepoContextMenuSelect}
          onClose={() => setRepoCtxMenu(null)}
        />
      )}
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
    borderRadius: '4px', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
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
