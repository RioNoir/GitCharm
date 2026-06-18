/**
 * Undocked panel — mounts both the Git Log and Commit Panel side by side.
 *
 * Host → Webview messages are wrapped: { target: 'log'|'commit', msg: <payload> }
 * Webview → Host messages are raw — the host routes them by type prefix (LOG_* vs COMMIT_*).
 *
 * acquireVsCodeApi() is called once; all sub-app components share the same API
 * instance within this bundle. Incoming messages are dispatched to each sub-app
 * via the central dispatcher below, which fires synthetic MessageEvents.
 */

// ── Must be the very first import — patches window.addEventListener ───────────
import './setupDispatch';

import React, { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

// ── Log sub-app components ────────────────────────────────────────────────────
import { useLogStore } from '../gitLog/store/logStore';
import { BranchSidebar } from '../gitLog/components/BranchSidebar';
import { CommitList } from '../gitLog/components/CommitList';
import { CommitDetail } from '../gitLog/components/CommitDetail';
import { CommitFiltersBar } from '../gitLog/components/CommitFiltersBar';
import { assignLanes } from '../gitLog/utils/graphLayout';
import type { GraphLayout } from '../gitLog/utils/graphLayout';

// ── Commit sub-app — mounts the full commit panel ────────────────────────────
// The App component from commitPanel is mounted as a self-contained child.
// It uses window.addEventListener('message', ...) for incoming messages and
// getVsCodeApi().postMessage for outgoing — both are handled by the shared
// singleton in this bundle.
import { CommitApp } from '../commitPanel/main';

// ── Shared utilities ──────────────────────────────────────────────────────────
import { ResizeHandle } from '../shared/ResizeHandle';
import { useResize } from '../shared/useResize';
import { Codicon } from '../shared/Codicon';
import { getVsCodeApi } from '../shared/vscodeApi';
import type { LogToHostMsg, HostToLogMsg } from '../../host/types/messages';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const LOAD_STEP = 150;

// ── Log sub-app ───────────────────────────────────────────────────────────────

function LogApp() {
  const store = useLogStore();
  const pendingRef = useRef<Map<string, (msg: HostToLogMsg) => void>>(new Map());
  const { panelRef: sidebarRef, onMouseDown: onSidebarResize } = useResize('right', 220, 120, 400);
  const { panelRef: detailRef, onMouseDown: onDetailResize } = useResize('left', 380, 200, 600);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    const obs = new MutationObserver(() => setThemeVersion(v => v + 1));
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  const filterRepoRef = useRef<(repoId: string | null, branch?: string | null) => void>(() => {});
  const loadingInFlightRef = useRef(false);
  const activeRequestIdRef = useRef<string | null>(null);

  const send = useCallback((msg: LogToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToLogMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;

      if ('requestId' in msg && msg.requestId && pendingRef.current.has(msg.requestId as string)) {
        const resolve = pendingRef.current.get(msg.requestId as string)!;
        pendingRef.current.delete(msg.requestId as string);
        resolve(msg);
        return;
      }

      switch (msg.type) {
        case 'LOG_INIT_DATA':
          store.setRepos(msg.repos, msg.hasWorkspaceFolder, msg.aiEnabled);
          store.setBranches(msg.branches);
          if (msg.iconTheme) store.setIconTheme(msg.iconTheme);
          break;
        case 'LOG_COMMITS_BATCH': {
          if (msg.requestId !== activeRequestIdRef.current) break;
          loadingInFlightRef.current = false;
          store.appendCommits(msg.commits, msg.isLast);
          break;
        }
        case 'LOG_COMMIT_FILES':
          if (!msg.requestId) store.setCommitFiles(msg.files);
          break;
        case 'LOG_REFS_UPDATE':
          store.updateBranches(msg.repoId, msg.branches);
          break;
        case 'LOG_TAGS_UPDATE':
          store.updateTags(msg.repoId, msg.tags);
          break;
        case 'LOG_REFRESH':
          reloadRef.current();
          break;
        case 'LOG_STASHES_BATCH':
          store.setStashes(msg.stashCommits);
          break;
        case 'LOG_SCROLL_TO_COMMIT':
          store.setPendingScrollHash(msg.hash);
          break;
        case 'LOG_FILTER_BY_REPO':
          filterRepoRef.current(msg.repoId, msg.branch ?? null);
          break;
      }
    };

    window.addEventListener('message', handler);

    const initReqId = generateId();
    activeRequestIdRef.current = initReqId;
    send({ type: 'LOG_REQUEST_COMMITS', repoIds: [], limit: LOAD_STEP, skip: 0, requestId: initReqId });

    return () => window.removeEventListener('message', handler);
  }, []);

  const sendAppendRequest = useCallback((f: import('../gitLog/store/logStore').CommitFilters, skip: number) => {
    if (loadingInFlightRef.current) return;
    loadingInFlightRef.current = true;
    const reqId = generateId();
    activeRequestIdRef.current = reqId;
    useLogStore.getState().setBackgroundLoading(true);
    getVsCodeApi().postMessage({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: f.repoId ? [f.repoId] : [],
      limit: LOAD_STEP,
      skip,
      requestId: reqId,
      filterText: f.text || undefined,
      filterAuthor: f.author || undefined,
      filterBranch: f.branch || undefined,
      filterDateFrom: f.dateFrom ? `${f.dateFrom}T00:00:00` : undefined,
      filterDateTo: f.dateTo ? `${f.dateTo}T23:59:59` : undefined,
    } satisfies LogToHostMsg);
  }, []);

  const loadMore = useCallback(() => {
    const s = useLogStore.getState();
    if (loadingInFlightRef.current || !s.hasMore) return;
    sendAppendRequest(s.commitFilters, s.commits.length);
  }, [sendAppendRequest]);

  const reloadCommits = useCallback((overrides?: Partial<import('../gitLog/store/logStore').CommitFilters>) => {
    loadingInFlightRef.current = false;
    const f = { ...useLogStore.getState().commitFilters, ...overrides };
    useLogStore.getState().resetCommits();
    sendAppendRequest(f, 0);
  }, [sendAppendRequest]);

  reloadRef.current = reloadCommits;

  useEffect(() => {
    const { selectedCommit } = store;
    if (!selectedCommit) return;
    if (selectedCommit.isStash) {
      store.setCommitFiles(selectedCommit.stashFiles ?? []);
      return;
    }
    store.setLoadingFiles(true);
    const reqId = generateId();
    pendingRef.current.set(reqId, (msg) => {
      if (msg.type === 'LOG_COMMIT_FILES') store.setCommitFiles(msg.files);
    });
    getVsCodeApi().postMessage({
      type: 'LOG_REQUEST_COMMIT_FILES',
      requestId: reqId,
      repoId: selectedCommit.repoId,
      hash: selectedCommit.hash,
      parents: selectedCommit.parents,
    } satisfies LogToHostMsg);
  }, [store.fileLoadSeq]);

  const repoColors = useMemo(() => {
    const map: Record<string, string> = {};
    store.repos.forEach(r => { map[r.id] = r.color; });
    return map;
  }, [store.repos]);

  const isFiltered = !!(
    store.commitFilters.text || store.commitFilters.author || store.commitFilters.branch ||
    store.commitFilters.dateFrom || store.commitFilters.dateTo
  );

  const commitsWithStashes = useMemo(() => {
    const branchFilter = store.commitFilters.branch;
    const visibleStashes = branchFilter ? store.stashes.filter(s => s.stashBranch === branchFilter) : store.stashes;
    if (visibleStashes.length === 0) return store.commits;
    const merged = [...store.commits, ...visibleStashes];
    merged.sort((a, b) => new Date(b.committerDate).getTime() - new Date(a.committerDate).getTime());
    return merged;
  }, [store.commits, store.stashes, store.commitFilters.branch]);

  const [graphLayout, setGraphLayout] = useState<GraphLayout>(() => assignLanes(commitsWithStashes, isFiltered));
  const layoutRafRef = useRef<number | null>(null);
  const pendingCommitsRef = useRef(commitsWithStashes);
  const pendingFilteredRef = useRef(isFiltered);
  pendingCommitsRef.current = commitsWithStashes;
  pendingFilteredRef.current = isFiltered;

  useEffect(() => {
    if (layoutRafRef.current !== null) cancelAnimationFrame(layoutRafRef.current);
    layoutRafRef.current = requestAnimationFrame(() => {
      layoutRafRef.current = null;
      setGraphLayout(assignLanes(pendingCommitsRef.current, pendingFilteredRef.current));
    });
    return () => { if (layoutRafRef.current !== null) cancelAnimationFrame(layoutRafRef.current); };
  }, [commitsWithStashes, isFiltered, themeVersion]);

  const currentBranchByRepo = useMemo(() => {
    const map: Record<string, string> = {};
    store.branches.forEach(b => { if (b.isHead && !b.isRemote) map[b.repoId] = b.name; });
    return map;
  }, [store.branches]);

  const headHashByRepo = useMemo(() => {
    const map: Record<string, string> = {};
    store.branches.forEach(b => {
      if (!b.isRemote && b.isHead) {
        if (b.lastCommitHash) map[b.repoId] = b.lastCommitHash;
        else if (b.detachedFullHash) map[b.repoId] = b.detachedFullHash;
      }
    });
    return map;
  }, [store.branches]);

  const selectedRepoColor = store.selectedCommit ? repoColors[store.selectedCommit.repoId] : undefined;

  const handleFilterChange = useCallback((key: keyof import('../gitLog/store/logStore').CommitFilters, value: string) => {
    store.setCommitFilters({ [key]: value });
    if (key === 'text' || key === 'author') {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => reloadCommits({ [key]: value }), 0);
    } else {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      reloadCommits({ [key]: value });
    }
  }, [reloadCommits]);

  const handleRepoChange = useCallback((repoId: string | null) => {
    store.setCommitFilters({ repoId });
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits({ repoId });
  }, [reloadCommits]);

  filterRepoRef.current = (repoId: string | null, branch?: string | null) => {
    const filters: { repoId: string | null; branch?: string } = { repoId };
    if (branch) filters.branch = branch;
    store.setCommitFilters(filters);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits(filters);
  };

  const handleClearFilters = useCallback(() => {
    const cleared = { text: '', author: '', branch: '', dateFrom: '', dateTo: '', repoId: null };
    store.setCommitFilters(cleared);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits(cleared);
  }, [reloadCommits]);

  const hasSelectedCommit = !!store.selectedCommit;

  return (
    <div style={logAppStyle} onContextMenu={e => e.preventDefault()}>
      <CommitFiltersBar
        filters={store.commitFilters}
        branches={store.branches}
        tags={store.tags}
        repos={store.repos}
        onFilterChange={handleFilterChange}
        onRepoChange={handleRepoChange}
        onClear={handleClearFilters}
        onFetchAll={() => send({ type: 'LOG_FETCH_ALL' })}
        hideUndock
      />

      <div style={logMainLayout}>
        {sidebarCollapsed && (
          <div style={collapsedSidebarStrip}>
            <button style={expandSidebarBtn} onClick={() => setSidebarCollapsed(false)} title="Expand sidebar">
              <Codicon name="layout-sidebar-left-off" style={{ fontSize: '14px' }} />
            </button>
          </div>
        )}
        <BranchSidebar
          ref={sidebarRef}
          repos={store.repos.filter(r => !r.isWorktree)}
          branches={store.branches}
          tags={store.tags}
          filter={store.branchFilter}
          selectedBranchFilter={store.commitFilters.branch}
          onFilterChange={store.setBranchFilter}
          onBranchFilterSelect={useCallback((b: string) => handleFilterChange('branch', b), [handleFilterChange])}
          onCheckout={(repoIds, branch) => repoIds.forEach(repoId => getVsCodeApi().postMessage({ type: 'LOG_CHECKOUT', requestId: generateId(), repoId, branchName: branch } satisfies LogToHostMsg))}
          onMerge={(repoId, from) => getVsCodeApi().postMessage({ type: 'LOG_MERGE', requestId: generateId(), repoId, from } satisfies LogToHostMsg)}
          onRebase={(repoId, onto) => getVsCodeApi().postMessage({ type: 'LOG_REBASE', requestId: generateId(), repoId, onto } satisfies LogToHostMsg)}
          onDelete={(repoIds, branchName) => getVsCodeApi().postMessage({ type: 'LOG_DELETE_BRANCH_MULTI', requestId: generateId(), repoIds, branchName } satisfies LogToHostMsg)}
          onFetchRepo={(repoId) => getVsCodeApi().postMessage({ type: 'LOG_FETCH_REPO', requestId: generateId(), repoId } satisfies LogToHostMsg)}
          onPull={(repoId) => getVsCodeApi().postMessage({ type: 'LOG_PULL', requestId: generateId(), repoId } satisfies LogToHostMsg)}
          onPush={(repoId) => getVsCodeApi().postMessage({ type: 'LOG_PUSH_PICK', repoId } satisfies LogToHostMsg)}
          onCheckoutTag={(repoIds, tagName) => repoIds.forEach(repoId => getVsCodeApi().postMessage({ type: 'LOG_CHECKOUT_TAG', requestId: generateId(), repoId, tagName } satisfies LogToHostMsg))}
          onMergeTag={(repoIds, tagName) => getVsCodeApi().postMessage({ type: 'LOG_MERGE_TAG_MULTI', requestId: generateId(), repoIds, tagName } satisfies LogToHostMsg)}
          onPushTag={(repoId, tagName) => getVsCodeApi().postMessage({ type: 'LOG_PUSH_TAG_PICK', repoId, tagName } satisfies LogToHostMsg)}
          onDeleteTag={(repoIds, tagName) => getVsCodeApi().postMessage({ type: 'LOG_DELETE_TAG_MULTI', requestId: generateId(), repoIds, tagName } satisfies LogToHostMsg)}
          onCollapse={() => setSidebarCollapsed(true)}
          hidden={sidebarCollapsed}
        />
        {!sidebarCollapsed && <ResizeHandle onMouseDown={onSidebarResize} />}

        <CommitList
          layout={graphLayout}
          selectedHash={store.selectedCommit?.hash ?? null}
          repoColors={repoColors}
          repos={store.repos}
          currentBranchByRepo={currentBranchByRepo}
          headHashByRepo={headHashByRepo}
          onSelect={(commit) => { store.selectCommit(commit); setDetailCollapsed(false); }}
          onLoadMore={loadMore}
          hasMore={store.hasMore}
          storeHasMore={store.hasMore}
          loading={store.loadingCommits}
          backgroundLoading={store.backgroundLoading}
          scrollToHash={store.pendingScrollHash}
          onScrolledToHash={() => store.setPendingScrollHash(null)}
          aiEnabled={store.aiEnabled}
          themeVersion={themeVersion}
        />

        {hasSelectedCommit && !detailCollapsed && <ResizeHandle onMouseDown={onDetailResize} />}

        {hasSelectedCommit && !detailCollapsed && (
          <div ref={detailRef} style={detailPane}>
            <CommitDetail
              commit={store.selectedCommit}
              files={store.commitFiles}
              selectedFile={store.selectedFile}
              loadingFiles={store.loadingFiles}
              repoColor={selectedRepoColor}
              repos={store.repos}
              iconTheme={store.iconTheme}
              onSelectFile={store.selectFile}
              onClose={() => setDetailCollapsed(true)}
              refColors={graphLayout.refColors}
              themeVersion={themeVersion}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Root split layout ─────────────────────────────────────────────────────────

declare const window: Window & { __INITIAL_CONFIG__?: { showCommit?: boolean } };

function UndockedApp() {
  const { panelRef: commitRef, onMouseDown: onCommitResize } = useResize('right', 420, 280, 700);
  const showCommit = window.__INITIAL_CONFIG__?.showCommit !== false;

  return (
    <div style={rootStyle}>
      {showCommit && (
        <>
          <div ref={commitRef} style={commitPane}>
            <CommitApp />
          </div>
          <ResizeHandle onMouseDown={onCommitResize} />
        </>
      )}
      <div style={logPane}>
        <LogApp />
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const rootStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  height: '100vh',
  overflow: 'hidden',
  background: 'var(--vscode-editor-background)',
  color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
};

const logPane: React.CSSProperties = {
  flex: 1,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const commitPane: React.CSSProperties = {
  width: '420px',
  flexShrink: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  borderLeft: '1px solid var(--vscode-panel-border)',
};

const logAppStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
  userSelect: 'none',
};

const logMainLayout: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  overflow: 'hidden',
  userSelect: 'none',
};

const detailPane: React.CSSProperties = {
  width: '380px',
  flexShrink: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  userSelect: 'text',
};

const collapsedSidebarStrip: React.CSSProperties = {
  width: '24px',
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: '6px',
  borderRight: '1px solid var(--vscode-panel-border)',
  background: 'var(--vscode-sideBar-background)',
};

const expandSidebarBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: '3px',
  borderRadius: '3px',
  color: 'var(--vscode-foreground)',
  opacity: 0.6,
};

createRoot(document.getElementById('root')!).render(<UndockedApp />);
