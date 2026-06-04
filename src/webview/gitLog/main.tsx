import React, { useEffect, useCallback, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { useLogStore } from './store/logStore';
import { BranchSidebar } from './components/BranchSidebar';
import { CommitList } from './components/CommitList';
import { CommitDetail } from './components/CommitDetail';
import { CommitFiltersBar } from './components/CommitFiltersBar';
import { assignLanes } from './utils/graphLayout';
import { ResizeHandle } from '../shared/ResizeHandle';
import { useResize } from '../shared/useResize';
import { getVsCodeApi } from '../shared/vscodeApi';
import type { LogToHostMsg, HostToLogMsg } from '../../host/types/messages';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const BATCH_SIZE = 200;
const BG_BATCH_SIZE = 500;
// Delay between background batches (ms) — keeps the UI thread free
const BG_DELAY = 120;

function App() {
  const store = useLogStore();
  const pendingRef = useRef<Map<string, (msg: HostToLogMsg) => void>>(new Map());
  const { panelRef: sidebarRef, onMouseDown: onSidebarResize } = useResize('right', 220, 120, 400);
  const { panelRef: detailRef, onMouseDown: onDetailResize } = useResize('left', 380, 200, 600);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  // Generation counter — incremented on every reload so stale bg batches are ignored
  const bgGenRef = useRef(0);
  const bgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      }

      switch (msg.type) {
        case 'LOG_INIT_DATA':
          store.setRepos(msg.repos);
          store.setBranches(msg.branches);
          if (msg.iconTheme) store.setIconTheme(msg.iconTheme);
          break;
        case 'LOG_COMMITS_BATCH': {
          store.appendCommits(msg.commits, msg.isLast);
          if (!msg.isLast) {
            scheduleBgLoad(bgGenRef.current);
          } else {
            useLogStore.getState().setBackgroundLoading(false);
          }
          break;
        }
        case 'LOG_COMMIT_FILES':
          store.setCommitFiles(msg.files);
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
        case 'LOG_REMOTES_RESULT':
          break;
      }
    };
    window.addEventListener('message', handler);

    // Initial load
    send({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: [],
      limit: BATCH_SIZE,
      skip: 0,
    });


    return () => window.removeEventListener('message', handler);
  }, []);

  const scheduleBgLoad = useCallback((gen: number) => {
    if (bgTimerRef.current) clearTimeout(bgTimerRef.current);
    bgTimerRef.current = setTimeout(() => {
      if (gen !== bgGenRef.current) return;
      const s = useLogStore.getState();
      if (!s.hasMore) { s.setBackgroundLoading(false); return; }
      const f = s.commitFilters;
      getVsCodeApi().postMessage({
        type: 'LOG_REQUEST_COMMITS',
        repoIds: f.repoId ? [f.repoId] : [],
        limit: BG_BATCH_SIZE,
        skip: s.commits.length,
        filterText: f.text || undefined,
        filterAuthor: f.author || undefined,
        filterBranch: f.branch || undefined,
        filterDateFrom: f.dateFrom || undefined,
        filterDateTo: f.dateTo || undefined,
      });
    }, BG_DELAY);
  }, []);

  const reloadCommits = useCallback((overrides?: Partial<import('./store/logStore').CommitFilters>) => {
    // Cancel any in-flight background load
    if (bgTimerRef.current) clearTimeout(bgTimerRef.current);
    const gen = ++bgGenRef.current;

    const f = { ...useLogStore.getState().commitFilters, ...overrides };
    useLogStore.getState().resetCommits();
    useLogStore.getState().setLoadingCommits(true);
    send({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: f.repoId ? [f.repoId] : [],
      limit: BATCH_SIZE,
      skip: 0,
      filterText: f.text || undefined,
      filterAuthor: f.author || undefined,
      filterBranch: f.branch || undefined,
      filterDateFrom: f.dateFrom || undefined,
      filterDateTo: f.dateTo || undefined,
    });
  }, [send]);

  // Keep reloadRef current so the message handler (mounted once) always calls the latest version
  reloadRef.current = reloadCommits;

  // Load more on scroll (manual trigger — kept for scroll-to-hash fallback)
  const handleLoadMore = useCallback(() => {
    // Background loading is already fetching everything; nothing to do
    const s = useLogStore.getState();
    if (s.loadingCommits || s.backgroundLoading || !s.hasMore) return;
    // Force an immediate bg fetch instead of waiting for the next scheduled one
    if (bgTimerRef.current) clearTimeout(bgTimerRef.current);
    scheduleBgLoad(bgGenRef.current);
  }, [scheduleBgLoad]);

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
    } satisfies LogToHostMsg);
  }, [store.fileLoadSeq]);

  const repoColors = useMemo(() => {
    const map: Record<string, string> = {};
    store.repos.forEach(r => { map[r.id] = r.color; });
    return map;
  }, [store.repos]);

  const laidOutCommits = useMemo(() => assignLanes(store.commits), [store.commits]);

  const currentBranchByRepo = useMemo(() => {
    const map: Record<string, string> = {};
    store.branches.forEach(b => { if (b.isHead && !b.isRemote) map[b.repoId] = b.name; });
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

  const handleClearFilters = useCallback(() => {
    const cleared = { text: '', author: '', branch: '', dateFrom: '', dateTo: '', repoId: null };
    store.setCommitFilters(cleared);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits(cleared);
  }, [reloadCommits]);

  const hasSelectedCommit = !!store.selectedCommit;

  return (
    <div style={appStyle} onContextMenu={e => e.preventDefault()}>
      {/* Filters bar (contains Fetch All on the right) */}
      <CommitFiltersBar
        filters={store.commitFilters}
        branches={store.branches}
        repos={store.repos}
        onFilterChange={handleFilterChange}
        onRepoChange={handleRepoChange}
        onClear={handleClearFilters}
        onFetchAll={() => send({ type: 'LOG_FETCH_ALL' })}
      />

      {/* Main layout */}
      <div style={mainLayout}>
        {/* Branch sidebar */}
        <BranchSidebar
          ref={sidebarRef}
          repos={store.repos}
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
        />
        <ResizeHandle onMouseDown={onSidebarResize} />

        {/* Commit list (center) */}
        <CommitList
          commits={laidOutCommits}
          selectedHash={store.selectedCommit?.hash ?? null}
          repoColors={repoColors}
          repos={store.repos}
          currentBranchByRepo={currentBranchByRepo}
          onSelect={(commit) => store.selectCommit(commit)}
          onLoadMore={handleLoadMore}
          hasMore={store.hasMore && !store.loadingCommits && !store.backgroundLoading}
          loading={store.loadingCommits}
          backgroundLoading={store.backgroundLoading}
          scrollToHash={store.pendingScrollHash}
          onScrolledToHash={() => store.setPendingScrollHash(null)}
        />

        {hasSelectedCommit && <ResizeHandle onMouseDown={onDetailResize} />}

        {/* Commit detail (right) — hidden when no commit selected */}
        {hasSelectedCommit && (
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
            />
          </div>
        )}
      </div>
    </div>
  );
}

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
