import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PullRequestHeader } from './components/PullRequestHeader';
import { DescriptionPanel } from './components/DescriptionPanel';
import { CommentsThread } from './components/CommentsThread';
import { ChangedFilesList } from './components/ChangedFilesList';
import { CommitsList } from './components/CommitsList';
import { MergeActions } from './components/MergeActions';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import type {
  ChangedFile, HostToPrDetailMsg, IconThemeData, MergeStrategy, PrDetailToHostMsg, PullRequestComment,
  PullRequestCommit, PullRequestDetail, PullRequestSummary,
} from '../../host/types/messages';

type TabId = 'overview' | 'changes' | 'commits';

function App() {
  const [summary, setSummary] = useState<PullRequestSummary | null>(null);
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | undefined>();

  const [comments, setComments] = useState<PullRequestComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [postingComment, setPostingComment] = useState(false);

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [iconTheme, setIconTheme] = useState<IconThemeData | null>(null);

  const [commits, setCommits] = useState<PullRequestCommit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(true);
  const [commitFiles, setCommitFiles] = useState<Record<string, ChangedFile[]>>({});
  const [commitFilesLoading, setCommitFilesLoading] = useState<Record<string, boolean>>({});

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | undefined>();
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | undefined>();
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | undefined>();
  const [checkingOut, setCheckingOut] = useState(false);

  const send = useCallback((msg: PrDetailToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToPrDetailMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'PRDETAIL_INIT':
          setSummary(msg.summary);
          send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
          send({ type: 'PRDETAIL_REQUEST_FILES' });
          send({ type: 'PRDETAIL_REQUEST_COMMITS' });
          break;
        case 'PRDETAIL_LOADED':
          setDetailLoading(false);
          setDetail(msg.detail);
          break;
        case 'PRDETAIL_LOAD_ERROR':
          setDetailLoading(false);
          setDetailError(msg.error);
          break;
        case 'PRDETAIL_COMMENTS_RESULT':
          setCommentsLoading(false);
          setComments(msg.comments);
          break;
        case 'PRDETAIL_COMMENT_POSTED':
          setPostingComment(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
          break;
        case 'PRDETAIL_FILES_RESULT':
          setFilesLoading(false);
          setFiles(msg.files);
          break;
        case 'PRDETAIL_COMMITS_RESULT':
          setCommitsLoading(false);
          setCommits(msg.commits);
          break;
        case 'PRDETAIL_COMMIT_FILES_RESULT':
          setCommitFilesLoading(prev => ({ ...prev, [msg.sha]: false }));
          setCommitFiles(prev => ({ ...prev, [msg.sha]: msg.files }));
          break;
        case 'PRDETAIL_ICON_THEME':
          setIconTheme(msg.iconTheme);
          break;
        case 'PRDETAIL_MERGE_RESULT':
          setMerging(false);
          if (msg.ok) {
            setMergeError(undefined);
            send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          } else {
            setMergeError(msg.error ?? 'Failed to merge pull request');
          }
          break;
        case 'PRDETAIL_CLOSE_RESULT':
          setClosing(false);
          if (msg.ok) {
            setCloseError(undefined);
            send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          } else {
            setCloseError(msg.error ?? 'Failed to close pull request');
          }
          break;
        case 'PRDETAIL_REOPEN_RESULT':
          setReopening(false);
          if (msg.ok) {
            setReopenError(undefined);
            send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          } else {
            setReopenError(msg.error ?? 'Failed to reopen pull request');
          }
          break;
        case 'PRDETAIL_CHECKOUT_RESULT':
          setCheckingOut(false);
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [send]);

  const handleOpenInBrowser = useCallback(() => {
    send({ type: 'PRDETAIL_OPEN_IN_BROWSER' });
  }, [send]);

  const handleViewAllChanges = useCallback(() => {
    send({ type: 'PRDETAIL_VIEW_ALL_CHANGES' });
  }, [send]);

  const handleCheckout = useCallback(() => {
    setCheckingOut(true);
    send({ type: 'PRDETAIL_CHECKOUT' });
  }, [send]);

  const handlePostComment = useCallback((body: string) => {
    setPostingComment(true);
    send({ type: 'PRDETAIL_POST_COMMENT', body });
  }, [send]);

  const handleOpenFile = useCallback((file: ChangedFile) => {
    send({ type: 'PRDETAIL_OPEN_FILE_DIFF', file });
  }, [send]);

  const handleRequestCommitFiles = useCallback((sha: string) => {
    setCommitFilesLoading(prev => ({ ...prev, [sha]: true }));
    send({ type: 'PRDETAIL_REQUEST_COMMIT_FILES', sha });
  }, [send]);

  const handleOpenCommitFileDiff = useCallback((file: ChangedFile, commitSha: string, parentSha: string | undefined) => {
    send({ type: 'PRDETAIL_OPEN_COMMIT_FILE_DIFF', file, commitSha, parentSha });
  }, [send]);

  const handleOpenCommitAllChanges = useCallback((commitSha: string, parentSha: string | undefined) => {
    send({ type: 'PRDETAIL_OPEN_COMMIT_ALL_CHANGES', commitSha, parentSha });
  }, [send]);

  const handleMerge = useCallback((strategy: MergeStrategy) => {
    setMerging(true);
    setMergeError(undefined);
    send({ type: 'PRDETAIL_MERGE', strategy });
  }, [send]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setCloseError(undefined);
    send({ type: 'PRDETAIL_CLOSE' });
  }, [send]);

  const handleReopen = useCallback(() => {
    setReopening(true);
    setReopenError(undefined);
    send({ type: 'PRDETAIL_REOPEN' });
  }, [send]);

  if (!summary) return <div style={css.loading}>Loading…</div>;

  return (
    <div style={css.page}>
      <PullRequestHeader
        summary={summary}
        detail={detail}
        checkingOut={checkingOut}
        onOpenInBrowser={handleOpenInBrowser}
        onViewAllChanges={handleViewAllChanges}
        onCheckout={handleCheckout}
      />

      <div style={css.tabBar}>
        {([
          { id: 'overview' as const, label: 'Overview', icon: 'note' },
          { id: 'changes' as const, label: 'Changes', icon: 'diff', count: files.length || undefined },
          { id: 'commits' as const, label: 'Commits', icon: 'git-commit', count: commits.length || undefined },
        ]).map(tab => (
          <button
            key={tab.id}
            style={css.tab(activeTab === tab.id)}
            onClick={() => setActiveTab(tab.id)}
          >
            <Codicon name={tab.icon} style={{ fontSize: '13px', marginRight: '5px' }} />
            {tab.label}
            {tab.count !== undefined && <span style={css.tabCount}>{tab.count}</span>}
          </button>
        ))}
      </div>

      <div style={css.body}>
        {detailError && <div style={css.errorBanner}>{detailError}</div>}

        {activeTab === 'overview' && (
          <>
            <section style={css.section}>
              <h3 style={css.sectionTitle}>Description</h3>
              <div style={css.descriptionBox}>
                <DescriptionPanel description={detail?.description ?? ''} loading={detailLoading} />
              </div>
            </section>
            <section style={css.commentsSection}>
              <CommentsThread
                comments={comments}
                commits={commits}
                loading={commentsLoading}
                posting={postingComment}
                canClose={detail?.capabilities.canClose === true && (detail?.state === 'open' || detail?.state === 'draft')}
                closing={closing}
                closeError={closeError}
                onPostComment={handlePostComment}
                onClose={handleClose}
                onOpenCommitAllChanges={handleOpenCommitAllChanges}
                mergeActions={detail && (
                  <MergeActions
                    detail={detail}
                    merging={merging}
                    mergeError={mergeError}
                    reopening={reopening}
                    reopenError={reopenError}
                    onMerge={handleMerge}
                    onReopen={handleReopen}
                  />
                )}
              />
            </section>
          </>
        )}

        {activeTab === 'changes' && (
          <section style={css.section}>
            <ChangedFilesList files={files} loading={filesLoading} iconTheme={iconTheme} onOpenFile={handleOpenFile} />
          </section>
        )}

        {activeTab === 'commits' && (
          <section style={css.section}>
            <CommitsList
              commits={commits}
              loading={commitsLoading}
              iconTheme={iconTheme}
              commitFiles={commitFiles}
              commitFilesLoading={commitFilesLoading}
              onRequestCommitFiles={handleRequestCommitFiles}
              onOpenCommitFileDiff={handleOpenCommitFileDiff}
            />
          </section>
        )}
      </div>
    </div>
  );
}

const css = {
  loading: {
    height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)', fontSize: '13px', opacity: 0.6,
  } as React.CSSProperties,
  page: {
    display: 'flex', flexDirection: 'column' as const, height: '100vh',
    background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)',
    fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size, 13px)',
  } as React.CSSProperties,
  tabBar: {
    display: 'flex', gap: '2px', padding: '0 24px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0,
  } as React.CSSProperties,
  tab: (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', padding: '8px 12px', fontSize: '12px', cursor: 'pointer',
    background: 'transparent', border: 'none', color: active ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
    borderBottom: active ? '2px solid var(--vscode-focusBorder)' : '2px solid transparent',
    fontWeight: active ? 600 : 'normal',
  }),
  tabCount: {
    marginLeft: '6px', fontSize: '10px', padding: '0 5px', borderRadius: '8px',
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
  body: { flex: 1, overflow: 'auto', padding: '0 24px 24px' } as React.CSSProperties,
  errorBanner: {
    marginTop: '16px', fontSize: '12px', padding: '8px 10px', borderRadius: '3px',
    color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)',
  } as React.CSSProperties,
  section: { marginTop: '20px' } as React.CSSProperties,
  commentsSection: {
    marginTop: '28px', paddingTop: '20px', borderTop: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  descriptionBox: {
    border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', padding: '14px',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '11px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', opacity: 0.6,
    fontWeight: 600, marginBottom: '10px',
  } as React.CSSProperties,
};

createRoot(document.getElementById('root')!).render(<App />);
