import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PullRequestHeader } from './components/PullRequestHeader';
import { DescriptionPanel } from './components/DescriptionPanel';
import { CommentsThread } from './components/CommentsThread';
import { ChangedFilesList } from './components/ChangedFilesList';
import { CommitsList } from './components/CommitsList';
import { ChecksList } from './components/ChecksList';
import { PeopleField, EditFieldButton } from './components/PeoplePanel';
import { LabelsPanel } from './components/LabelsPanel';
import { AiExplainFab } from '../shared/AiExplainFab';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import { SkeletonBlock, SkeletonChips } from '../shared/Skeleton';
import type {
  ChangedFile, CiCheck, HostToPrDetailMsg, IconThemeData, MergeStrategy, PrDetailToHostMsg, PullRequestComment,
  PullRequestCommit, PullRequestDetail, PullRequestEvent, PullRequestSummary,
} from '../../host/types/messages';

type TabId = 'overview' | 'changes' | 'commits' | 'checks';

function CollapsibleSection({ title, icon, defaultOpen = true, first, plain, headerAction, children }: { title: string; icon: string; defaultOpen?: boolean; first?: boolean; plain?: boolean; headerAction?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={plain ? undefined : (first ? css.section : css.collapsibleSection)}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button className="icon-btn" style={{ ...css.collapseHeader, flex: 1 }} onClick={() => setOpen(o => !o)}>
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '13px', opacity: 0.6 }} />
          <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.6 }} />
          <h3 style={css.sectionTitle}>{title}</h3>
        </button>
        {headerAction && <div onClick={e => e.stopPropagation()}>{headerAction}</div>}
      </div>
      {open && <div style={css.collapseBody}>{children}</div>}
    </section>
  );
}

function StaticSection({ title, icon, first, headerAction, children }: { title: string; icon: string; first?: boolean; headerAction?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={first ? css.section : css.collapsibleSection}>
      <div style={css.collapseHeader}>
        <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.6 }} />
        <h3 style={css.sectionTitle}>{title}</h3>
        {headerAction && <div style={{ marginLeft: 'auto' }}>{headerAction}</div>}
      </div>
      <div style={css.collapseBody}>{children}</div>
    </section>
  );
}

function App() {
  const [summary, setSummary] = useState<PullRequestSummary | null>(null);
  const [currentUsername, setCurrentUsername] = useState<string | undefined>();
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiModelLabel, setAiModelLabel] = useState('');
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | undefined>();

  const [comments, setComments] = useState<PullRequestComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [postingComment, setPostingComment] = useState(false);
  const [commentActionError, setCommentActionError] = useState<string | undefined>();

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | undefined>();
  const [iconTheme, setIconTheme] = useState<IconThemeData | null>(null);

  const [commits, setCommits] = useState<PullRequestCommit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(true);
  const [commitsError, setCommitsError] = useState<string | undefined>();
  const [commitFiles, setCommitFiles] = useState<Record<string, ChangedFile[]>>({});
  const [commitFilesLoading, setCommitFilesLoading] = useState<Record<string, boolean>>({});

  const [events, setEvents] = useState<PullRequestEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [, setEventsError] = useState<string | undefined>();

  const [checks, setChecks] = useState<CiCheck[]>([]);
  const [checksLoading, setChecksLoading] = useState(true);
  const [checksError, setChecksError] = useState<string | undefined>();

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | undefined>();
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | undefined>();
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | undefined>();
  const [checkingOut, setCheckingOut] = useState(false);
  const [approving, setApproving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatingReviewers, setUpdatingReviewers] = useState(false);
  const [updatingAssignees, setUpdatingAssignees] = useState(false);
  const [updatingLabels, setUpdatingLabels] = useState(false);

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
          setCurrentUsername(msg.currentUsername);
          setAiEnabled(msg.aiEnabled);
          setAiModelLabel(msg.aiModelLabel);
          // Persisted so VS Code can restore this panel (via registerWebviewPanelSerializer) after a window reload/restart.
          getVsCodeApi().setState({ repoId: msg.repoId, number: msg.number });
          send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
          send({ type: 'PRDETAIL_REQUEST_FILES' });
          send({ type: 'PRDETAIL_REQUEST_COMMITS' });
          send({ type: 'PRDETAIL_REQUEST_EVENTS' });
          break;
        case 'PRDETAIL_LOADED':
          setDetailLoading(false);
          setDetail(msg.detail);
          // PullRequestDetail is a superset of PullRequestSummary — keep summary in sync so the header (title,
          // target branch label) reflects edits immediately instead of the stale value from PRDETAIL_INIT.
          setSummary(msg.detail);
          setChecksLoading(true);
          send({ type: 'PRDETAIL_REQUEST_CHECKS', headSha: msg.detail.headSha });
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
        case 'PRDETAIL_COMMENT_UPDATED':
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
          else if (msg.error) setCommentActionError(msg.error);
          break;
        case 'PRDETAIL_COMMENT_DELETED':
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
          else if (msg.error) setCommentActionError(msg.error);
          break;
        case 'PRDETAIL_COMMENT_HIDDEN':
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
          else if (msg.error && !msg.unsupported) setCommentActionError(msg.error);
          break;
        case 'PRDETAIL_COMMENT_UNHIDDEN':
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
          else if (msg.error && !msg.unsupported) setCommentActionError(msg.error);
          break;
        case 'PRDETAIL_FILES_RESULT':
          setFilesLoading(false);
          setFiles(msg.files);
          setFilesError(msg.error);
          break;
        case 'PRDETAIL_COMMITS_RESULT':
          setCommitsLoading(false);
          setCommits(msg.commits);
          setCommitsError(msg.error);
          break;
        case 'PRDETAIL_EVENTS_RESULT':
          setEventsLoading(false);
          setEvents(msg.events);
          setEventsError(msg.error);
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
        case 'PRDETAIL_REVIEW_RESULT':
          setApproving(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          break;
        case 'PRDETAIL_UPDATE_RESULT':
          setUpdating(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          break;
        case 'PRDETAIL_UPDATE_REVIEWERS_RESULT':
          setUpdatingReviewers(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          break;
        case 'PRDETAIL_UPDATE_ASSIGNEES_RESULT':
          setUpdatingAssignees(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          break;
        case 'PRDETAIL_UPDATE_LABELS_RESULT':
          setUpdatingLabels(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          break;
        case 'PRDETAIL_CHECKS_RESULT':
          setChecksLoading(false);
          setChecks(msg.checks);
          setChecksError(msg.error);
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

  const handleRefresh = useCallback(() => {
    setDetailLoading(true);
    setCommentsLoading(true);
    setFilesLoading(true);
    setCommitsLoading(true);
    setEventsLoading(true);
    send({ type: 'PRDETAIL_REQUEST_DETAIL' });
    send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
    send({ type: 'PRDETAIL_REQUEST_FILES' });
    send({ type: 'PRDETAIL_REQUEST_COMMITS' });
    send({ type: 'PRDETAIL_REQUEST_EVENTS' });
  }, [send]);

  const handleCheckoutPr = useCallback(() => {
    setCheckingOut(true);
    send({ type: 'PRDETAIL_CHECKOUT_PR' });
  }, [send]);

  const handleCheckoutBranch = useCallback(() => {
    setCheckingOut(true);
    send({ type: 'PRDETAIL_CHECKOUT_BRANCH' });
  }, [send]);

  // Each of these opens a native VS Code QuickPick/InputBox on the host, which applies the update itself
  // (Enter to confirm, Esc to cancel with no change) and reports back through the existing *_RESULT messages.
  const handlePickTitle = useCallback(() => {
    setUpdating(true);
    send({ type: 'PRDETAIL_PICK_TITLE' });
  }, [send]);

  const handlePickTargetBranch = useCallback(() => {
    setUpdating(true);
    send({ type: 'PRDETAIL_PICK_TARGET_BRANCH' });
  }, [send]);

  const handlePickReviewers = useCallback(() => {
    setUpdatingReviewers(true);
    send({ type: 'PRDETAIL_PICK_REVIEWERS' });
  }, [send]);

  const handlePickAssignees = useCallback(() => {
    setUpdatingAssignees(true);
    send({ type: 'PRDETAIL_PICK_ASSIGNEES' });
  }, [send]);

  const handlePickLabels = useCallback(() => {
    setUpdatingLabels(true);
    send({ type: 'PRDETAIL_PICK_LABELS' });
  }, [send]);

  const handlePostComment = useCallback((body: string) => {
    setPostingComment(true);
    send({ type: 'PRDETAIL_POST_COMMENT', body });
  }, [send]);

  const handleUpdateComment = useCallback((commentId: string, body: string) => {
    setCommentActionError(undefined);
    send({ type: 'PRDETAIL_UPDATE_COMMENT', commentId, body });
  }, [send]);

  const handleDeleteComment = useCallback((commentId: string) => {
    setCommentActionError(undefined);
    send({ type: 'PRDETAIL_DELETE_COMMENT', commentId });
  }, [send]);

  const handleHideComment = useCallback((commentId: string) => {
    setCommentActionError(undefined);
    send({ type: 'PRDETAIL_HIDE_COMMENT', commentId });
  }, [send]);

  const handleUnhideComment = useCallback((commentId: string) => {
    setCommentActionError(undefined);
    send({ type: 'PRDETAIL_UNHIDE_COMMENT', commentId });
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

  const handleApprove = useCallback(() => {
    setApproving(true);
    send({ type: 'PRDETAIL_SUBMIT_REVIEW', input: { event: 'approve' } });
  }, [send]);

  const handleExplain = useCallback(() => {
    send({ type: 'PRDETAIL_EXPLAIN' });
  }, [send]);

  if (!summary) {
    return (
      <div style={css.loading}>
        <div style={{ width: '280px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <SkeletonBlock width="60%" height={18} />
          <SkeletonBlock width="40%" height={12} />
        </div>
      </div>
    );
  }

  return (
    <div style={css.page} className="pr-detail-root">
      <PullRequestHeader
        summary={summary}
        detail={detail}
        checkingOut={checkingOut}
        canApprove={
          !!detail && detail.capabilities.canApprove && (detail.state === 'open' || detail.state === 'draft')
          && !(!!currentUsername && currentUsername === detail.authorName)
        }
        approving={approving}
        canEdit={!!detail && detail.capabilities.canClose && detail.canWrite && (detail.state === 'open' || detail.state === 'draft')}
        updating={updating}
        merging={merging}
        mergeError={mergeError}
        reopening={reopening}
        reopenError={reopenError}
        onOpenInBrowser={handleOpenInBrowser}
        onViewAllChanges={handleViewAllChanges}
        onRefresh={handleRefresh}
        onCheckoutPr={handleCheckoutPr}
        onCheckoutBranch={handleCheckoutBranch}
        onApprove={handleApprove}
        onPickTitle={handlePickTitle}
        onPickTargetBranch={handlePickTargetBranch}
        onMerge={handleMerge}
        onReopen={handleReopen}
      />

      {aiEnabled && <AiExplainFab modelLabel={aiModelLabel} onClick={handleExplain} />}

      <div style={css.tabBar}>
        {([
          { id: 'overview' as const, label: 'Overview', icon: 'note', count: (commentsLoading ? summary?.commentCount : comments.length) || undefined },
          { id: 'changes' as const, label: 'Changes', icon: 'diff', count: files.length || undefined },
          { id: 'commits' as const, label: 'Commits', icon: 'git-commit', count: commits.length || undefined },
          { id: 'checks' as const, label: 'Checks', icon: 'checklist', count: checks.length || undefined },
        ]).map(tab => (
          <button
            key={tab.id}
            className="icon-btn"
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
          <div className="pr-overview-layout">
            <div className="pr-overview-main">
              <CollapsibleSection title="Description" icon="note" first>
                <div style={css.descriptionBox}>
                  <DescriptionPanel description={detail?.description ?? ''} loading={detailLoading} />
                </div>
              </CollapsibleSection>
              <CollapsibleSection title="Activity" icon="comment-discussion">
                <CommentsThread
                  comments={comments}
                  commits={commits}
                  events={events}
                  loading={commentsLoading || commitsLoading || eventsLoading}
                  posting={postingComment}
                  canClose={detail?.capabilities.canClose === true && detail?.canWrite === true && (detail?.state === 'open' || detail?.state === 'draft')}
                  closing={closing}
                  closeError={closeError}
                  commentActionError={commentActionError}
                  onPostComment={handlePostComment}
                  onUpdateComment={handleUpdateComment}
                  onDeleteComment={handleDeleteComment}
                  onHideComment={handleHideComment}
                  onUnhideComment={handleUnhideComment}
                  onClose={handleClose}
                  onOpenCommitAllChanges={handleOpenCommitAllChanges}
                />
              </CollapsibleSection>
            </div>
            <div className="pr-overview-sidebar">
              <StaticSection
                title="Reviewers" icon="eye" first
                headerAction={!!detail && detail.capabilities.canManageReviewers && detail.canWrite && (
                  <EditFieldButton label="Reviewers" updating={updatingReviewers} onPick={handlePickReviewers} />
                )}
              >
                {!detail ? <SkeletonChips count={2} /> : <PeopleField people={detail.reviewers} />}
              </StaticSection>
              <StaticSection
                title="Assignees" icon="account"
                headerAction={!!detail && detail.capabilities.canManageAssignees && detail.canWrite && (
                  <EditFieldButton label="Assignees" updating={updatingAssignees} onPick={handlePickAssignees} />
                )}
              >
                {!detail ? <SkeletonChips count={2} /> : !detail.capabilities.canManageAssignees ? (
                  <span style={css.notAvailable}>Not available for this provider</span>
                ) : (
                  <PeopleField people={detail.assignees} />
                )}
              </StaticSection>
              <StaticSection
                title="Labels" icon="tag"
                headerAction={!!detail && detail.capabilities.canManageLabels && detail.canWrite && (
                  <EditFieldButton label="Labels" updating={updatingLabels} onPick={handlePickLabels} />
                )}
              >
                {!detail ? <SkeletonChips count={2} /> : !detail.capabilities.canManageLabels ? (
                  <span style={css.notAvailable}>Not available for this provider</span>
                ) : (
                  <LabelsPanel labels={detail.labels} hasLabels={detail.capabilities.canManageLabels} />
                )}
              </StaticSection>
            </div>
          </div>
        )}

        {activeTab === 'changes' && (
          <section style={css.section}>
            {filesError && <div style={css.errorBanner}>{filesError}</div>}
            <ChangedFilesList files={files} loading={filesLoading} iconTheme={iconTheme} onOpenFile={handleOpenFile} />
          </section>
        )}

        {activeTab === 'commits' && (
          <section style={css.section}>
            {commitsError && <div style={css.errorBanner}>{commitsError}</div>}
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

        {activeTab === 'checks' && (
          <section style={css.section}>
            {checksError && <div style={css.errorBanner}>{checksError}</div>}
            <ChecksList checks={checks} loading={checksLoading} />
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
    marginLeft: '6px', fontSize: '12px', fontWeight: 600, padding: '2px 7px', borderRadius: '10px',
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
  body: { flex: 1, overflow: 'auto', padding: '0 24px 24px' } as React.CSSProperties,
  errorBanner: {
    marginTop: '16px', fontSize: '12px', padding: '8px 10px', borderRadius: '3px',
    color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)',
  } as React.CSSProperties,
  section: { marginTop: '20px' } as React.CSSProperties,
  descriptionBox: {
    border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', padding: '14px',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '11px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', opacity: 0.6,
    fontWeight: 600, margin: 0,
  } as React.CSSProperties,
  collapsibleSection: {
    marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  collapseHeader: {
    display: 'flex', alignItems: 'center', gap: '6px', width: '100%', background: 'transparent', border: 'none',
    padding: 0, marginBottom: '10px', cursor: 'pointer', color: 'inherit', textAlign: 'left' as const,
  } as React.CSSProperties,
  collapseBody: {} as React.CSSProperties,
  notAvailable: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
};

createRoot(document.getElementById('root')!).render(<App />);
