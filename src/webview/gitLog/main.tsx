import React, { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLogStore } from './store/logStore';
import { BranchSidebar } from './components/BranchSidebar';
import { CommitList } from './components/CommitList';
import { CommitDetail } from './components/CommitDetail';
import { CommitFiltersBar } from './components/CommitFiltersBar';
import { assignLanes } from './utils/graphLayout';
import type { GraphLayout } from './utils/graphLayout';
import { ResizeHandle } from '../shared/ResizeHandle';
import { useResize } from '../shared/useResize';
import { Codicon } from '../shared/Codicon';
import { getVsCodeApi } from '../shared/vscodeApi';
import type { LogToHostMsg, HostToLogMsg } from '../../host/types/messages';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const LOAD_STEP = 150;


function App() {
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
  // Prevents concurrent requests
  const loadingInFlightRef = useRef(false);
  // Current requestId — used to discard responses from superseded requests
  const activeRequestIdRef = useRef<string | null>(null);

  const send = useCallback((msg: LogToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  const request = useCallback(<T extends HostToLogMsg>(msg: LogToHostMsg): Promise<T> => {
    return new Promise((resolve) => {
      const reqId = generateId();
      const m = { ...msg, requestId: reqId } as LogToHostMsg & { requestId: string };
      pendingRef.current.set(reqId, r => resolve(r as T));
      getVsCodeApi().postMessage(m);
    });
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
          const match = msg.requestId === activeRequestIdRef.current;
          if (!match) break;
          loadingInFlightRef.current = false;
          store.appendCommits(msg.commits, msg.isLast);
          break;
        }
        case 'LOG_COMMIT_FILES':
          // Only process responses that belong to the selected commit (no requestId = legacy broadcast)
          // Responses with requestId are handled by pendingRef or the popover's own listener
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
        case 'LOG_BRANCH_OP_RESULT':
          if (!msg.ok && msg.error) {
            console.error('Branch operation failed:', msg.error);
          }
          break;
        case 'LOG_SCROLL_TO_COMMIT':
          store.setPendingScrollHash(msg.hash);
          break;
        case 'LOG_FILTER_BY_REPO':
          filterRepoRef.current(msg.repoId, msg.branch ?? null);
          break;
        case 'LOG_REMOTES_RESULT':
          break;
      }
    };
    window.addEventListener('message', handler);

    // Initial load
    const initReqId = generateId();
    activeRequestIdRef.current = initReqId;
    send({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: [],
      limit: LOAD_STEP,
      skip: 0,
      requestId: initReqId,
    });

    return () => window.removeEventListener('message', handler);
  }, []);


  const sendAppendRequest = useCallback((f: import('./store/logStore').CommitFilters, skip: number) => {
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
      // git --after and --before are exclusive; use time suffixes to make the range fully inclusive
      filterDateFrom: f.dateFrom ? `${f.dateFrom}T00:00:00` : undefined,
      filterDateTo: f.dateTo ? `${f.dateTo}T23:59:59` : undefined,
    } satisfies LogToHostMsg);
  }, []);

  const loadMore = useCallback(() => {
    const s = useLogStore.getState();
    if (loadingInFlightRef.current || !s.hasMore) return;
    sendAppendRequest(s.commitFilters, s.commits.length);
  }, [sendAppendRequest]);

  const reloadCommits = useCallback((overrides?: Partial<import('./store/logStore').CommitFilters>) => {
    loadingInFlightRef.current = false;
    const f = { ...useLogStore.getState().commitFilters, ...overrides };
    useLogStore.getState().resetCommits();
    sendAppendRequest(f, 0);
  }, [sendAppendRequest]);

  // Keep reloadRef current so the message handler (mounted once) always calls the latest version
  reloadRef.current = reloadCommits;

  const handleLoadMore = useCallback(() => {
    loadMore();
  }, [loadMore]);

  // When a commit is selected, load its files
  useEffect(() => {
    const { selectedCommit } = store;
    if (!selectedCommit) return;
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
    store.commitFilters.text ||
    store.commitFilters.author ||
    store.commitFilters.branch ||
    store.commitFilters.dateFrom ||
    store.commitFilters.dateTo
  );

  // assignLanes is expensive — run it off the render path via useEffect + rAF
  // so scroll events never block the UI thread waiting for layout recalc.
  const [graphLayout, setGraphLayout] = useState<GraphLayout>(() =>
    assignLanes(store.commits, isFiltered)
  );

  const layoutRafRef = useRef<number | null>(null);
  const pendingCommitsRef = useRef(store.commits);
  const pendingFilteredRef = useRef(isFiltered);
  pendingCommitsRef.current = store.commits;
  pendingFilteredRef.current = isFiltered;

  useEffect(() => {
    if (layoutRafRef.current !== null) cancelAnimationFrame(layoutRafRef.current);
    layoutRafRef.current = requestAnimationFrame(() => {
      layoutRafRef.current = null;
      setGraphLayout(assignLanes(pendingCommitsRef.current, pendingFilteredRef.current));
    });
    return () => { if (layoutRafRef.current !== null) cancelAnimationFrame(layoutRafRef.current); };
  }, [store.commits, isFiltered, themeVersion]);

  const currentBranchByRepo = useMemo(() => {
    const map: Record<string, string> = {};
    store.branches.forEach(b => { if (b.isHead && !b.isRemote) map[b.repoId] = b.name; });
    return map;
  }, [store.branches]);

  // Authoritative HEAD hash per repo — from branch metadata, not commit refs.
  // Used to show the HEAD badge on exactly the right commit regardless of ref timing.
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

  const selectedRepoColor = store.selectedCommit
    ? repoColors[store.selectedCommit.repoId]
    : undefined;

  // text/author are debounced inside DebouncedInput; branch/date/repo fire immediately
  const handleFilterChange = useCallback((key: keyof import('./store/logStore').CommitFilters, value: string) => {
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

  const showNoRepo = store.repos.length === 0 && store.initialized;
  const noRepoOverlay = showNoRepo ? (
    <div style={noRepoOverlayStyle}>
      {!store.hasWorkspaceFolder ? (
        <>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
            You have not yet opened a folder.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '200px' }}>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_OPEN_FOLDER' })}>Open Folder</button>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_CLONE_REPO' })}>Clone Repository</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
            The folder currently open doesn't have a Git repository. You can initialize a repository which will enable source control features powered by Git.
          </div>
          <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_INIT_REPO' })}>
            Initialize Repository
          </button>
        </>
      )}
    </div>
  ) : null;

  return (
    <div style={{ ...appStyle, position: 'relative' }} onContextMenu={e => e.preventDefault()}>
      {noRepoOverlay}
      {/* Filters bar (contains Fetch All on the right) */}
      <CommitFiltersBar
        filters={store.commitFilters}
        branches={store.branches}
        tags={store.tags}
        repos={store.repos}
        onFilterChange={handleFilterChange}
        onRepoChange={handleRepoChange}
        onClear={handleClearFilters}
        onFetchAll={() => send({ type: 'LOG_FETCH_ALL' })}
      />

      {/* Main layout */}
      <div style={{ ...mainLayout, visibility: showNoRepo ? 'hidden' : 'visible' }}>
        {/* Branch sidebar */}
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
          onBranchFilterSelect={useCallback((branchName: string) => {
            handleFilterChange('branch', branchName);
          }, [handleFilterChange])}
          onCheckout={(repoIds, branch) => {
            repoIds.forEach(repoId => {
              getVsCodeApi().postMessage({ type: 'LOG_CHECKOUT', requestId: generateId(), repoId, branchName: branch } satisfies LogToHostMsg);
            });
          }}
          onMerge={(repoId, from) => {
            const reqId = generateId();
            getVsCodeApi().postMessage({ type: 'LOG_MERGE', requestId: reqId, repoId, from } satisfies LogToHostMsg);
          }}
          onRebase={(repoId, onto) => {
            const reqId = generateId();
            getVsCodeApi().postMessage({ type: 'LOG_REBASE', requestId: reqId, repoId, onto } satisfies LogToHostMsg);
          }}
          onDelete={(repoIds, branchName) => {
            getVsCodeApi().postMessage({ type: 'LOG_DELETE_BRANCH_MULTI', requestId: generateId(), repoIds, branchName } satisfies LogToHostMsg);
          }}
          onFetchRepo={(repoId) => {
            const reqId = generateId();
            getVsCodeApi().postMessage({ type: 'LOG_FETCH_REPO', requestId: reqId, repoId } satisfies LogToHostMsg);
          }}
          onPull={(repoId) => {
            const reqId = generateId();
            getVsCodeApi().postMessage({ type: 'LOG_PULL', requestId: reqId, repoId } satisfies LogToHostMsg);
          }}
          onPush={(repoId) => {
            getVsCodeApi().postMessage({ type: 'LOG_PUSH_PICK', repoId } satisfies LogToHostMsg);
          }}
          onCheckoutTag={(repoIds, tagName) => {
            repoIds.forEach(repoId => {
              getVsCodeApi().postMessage({ type: 'LOG_CHECKOUT_TAG', requestId: generateId(), repoId, tagName } satisfies LogToHostMsg);
            });
          }}
          onMergeTag={(repoIds, tagName) => {
            getVsCodeApi().postMessage({ type: 'LOG_MERGE_TAG_MULTI', requestId: generateId(), repoIds, tagName } satisfies LogToHostMsg);
          }}
          onPushTag={(repoId, tagName) => {
            getVsCodeApi().postMessage({ type: 'LOG_PUSH_TAG_PICK', repoId, tagName } satisfies LogToHostMsg);
          }}
          onDeleteTag={(repoIds, tagName) => {
            getVsCodeApi().postMessage({ type: 'LOG_DELETE_TAG_MULTI', requestId: generateId(), repoIds, tagName } satisfies LogToHostMsg);
          }}
          onCollapse={() => setSidebarCollapsed(true)}
          hidden={sidebarCollapsed}
        />
        {!sidebarCollapsed && <ResizeHandle onMouseDown={onSidebarResize} />}

        {/* Commit list (center) */}
        <CommitList
          layout={graphLayout}
          selectedHash={store.selectedCommit?.hash ?? null}
          repoColors={repoColors}
          repos={store.repos}
          currentBranchByRepo={currentBranchByRepo}
          headHashByRepo={headHashByRepo}
          onSelect={(commit) => { store.selectCommit(commit); setDetailCollapsed(false); }}
          onLoadMore={handleLoadMore}
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

        {/* Commit detail (right) — hidden when no commit selected or closed */}
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

const noRepoOverlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 10,
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: '12px', padding: '24px',
  background: 'var(--vscode-sideBar-background)', color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
};

const initRepoBtnStyle: React.CSSProperties = {
  background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
  border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
  fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: 500,
};

const secondaryBtnStyle: React.CSSProperties = {
  background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)',
  border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
  fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: 500,
};

const appStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--vscode-editor-background)',
  color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
  overflow: 'hidden',
  userSelect: 'none',
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

const mainLayout: React.CSSProperties = {
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


createRoot(document.getElementById('root')!).render(<App />);
