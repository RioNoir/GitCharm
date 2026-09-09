import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PullRequestHeader } from './components/PullRequestHeader';
import { DescriptionPanel } from './components/DescriptionPanel';
import { CommentsThread } from './components/CommentsThread';
import { ChangedFilesList } from './components/ChangedFilesList';
import { CommitsList } from './components/CommitsList';
import { ChecksList } from './components/ChecksList';
import { MergeActions, hasMergeActionsContent } from './components/MergeActions';
import { PeopleField } from './components/PeoplePanel';
import { LabelsPanel } from './components/LabelsPanel';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import { SkeletonBlock, SkeletonChips } from '../shared/Skeleton';
import type {
  ChangedFile, CiCheck, HostToPrDetailMsg, IconThemeData, MergeStrategy, PrDetailToHostMsg, PullRequestComment,
  PullRequestCommit, PullRequestDetail, PullRequestLabel, PullRequestSummary, PullRequestUser,
} from '../../host/types/messages';

type TabId = 'overview' | 'changes' | 'commits' | 'checks';

function CollapsibleSection({ title, icon, defaultOpen = true, first, plain, children }: { title: string; icon: string; defaultOpen?: boolean; first?: boolean; plain?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={plain ? undefined : (first ? css.section : css.collapsibleSection)}>
      <button style={css.collapseHeader} onClick={() => setOpen(o => !o)}>
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '13px', opacity: 0.6 }} />
        <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.6 }} />
        <h3 style={css.sectionTitle}>{title}</h3>
      </button>
      {open && <div style={css.collapseBody}>{children}</div>}
    </section>
  );
}

function StaticSection({ title, icon, first, children }: { title: string; icon: string; first?: boolean; children: React.ReactNode }) {
  return (
    <section style={first ? css.section : css.collapsibleSection}>
      <div style={css.collapseHeader}>
        <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.6 }} />
        <h3 style={css.sectionTitle}>{title}</h3>
      </div>
      <div style={css.collapseBody}>{children}</div>
    </section>
  );
}

function App() {
  const [summary, setSummary] = useState<PullRequestSummary | null>(null);
  const [currentUsername, setCurrentUsername] = useState<string | undefined>();
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | undefined>();

  const [comments, setComments] = useState<PullRequestComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [postingComment, setPostingComment] = useState(false);

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | undefined>();
  const [iconTheme, setIconTheme] = useState<IconThemeData | null>(null);

  const [commits, setCommits] = useState<PullRequestCommit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(true);
  const [commitsError, setCommitsError] = useState<string | undefined>();
  const [commitFiles, setCommitFiles] = useState<Record<string, ChangedFile[]>>({});
  const [commitFilesLoading, setCommitFilesLoading] = useState<Record<string, boolean>>({});

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
  const [targetBranches, setTargetBranches] = useState<string[]>([]);
  const [targetBranchesLoading, setTargetBranchesLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [collaborators, setCollaborators] = useState<PullRequestUser[]>([]);
  const [collaboratorsLoading, setCollaboratorsLoading] = useState(false);
  const [updatingReviewers, setUpdatingReviewers] = useState(false);
  const [updatingAssignees, setUpdatingAssignees] = useState(false);
  const [availableLabels, setAvailableLabels] = useState<PullRequestLabel[]>([]);
  const [availableLabelsLoading, setAvailableLabelsLoading] = useState(false);
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
          // Persisted so VS Code can restore this panel (via registerWebviewPanelSerializer) after a window reload/restart.
          getVsCodeApi().setState({ repoId: msg.repoId, number: msg.number });
          send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
          send({ type: 'PRDETAIL_REQUEST_FILES' });
          send({ type: 'PRDETAIL_REQUEST_COMMITS' });
          break;
        case 'PRDETAIL_LOADED':
          setDetailLoading(false);
          setDetail(msg.detail);
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
        case 'PRDETAIL_TARGET_BRANCHES_RESULT':
          setTargetBranchesLoading(false);
          setTargetBranches(msg.branches);
          break;
        case 'PRDETAIL_UPDATE_RESULT':
          setUpdating(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          break;
        case 'PRDETAIL_COLLABORATORS_RESULT':
          setCollaboratorsLoading(false);
          setCollaborators(msg.collaborators);
          break;
        case 'PRDETAIL_UPDATE_REVIEWERS_RESULT':
          setUpdatingReviewers(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          break;
        case 'PRDETAIL_UPDATE_ASSIGNEES_RESULT':
          setUpdatingAssignees(false);
          if (msg.ok) send({ type: 'PRDETAIL_REQUEST_DETAIL' });
          break;
        case 'PRDETAIL_AVAILABLE_LABELS_RESULT':
          setAvailableLabelsLoading(false);
          setAvailableLabels(msg.labels);
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
    send({ type: 'PRDETAIL_REQUEST_DETAIL' });
    send({ type: 'PRDETAIL_REQUEST_COMMENTS' });
    send({ type: 'PRDETAIL_REQUEST_FILES' });
    send({ type: 'PRDETAIL_REQUEST_COMMITS' });
  }, [send]);

  const handleCheckoutPr = useCallback(() => {
    setCheckingOut(true);
    send({ type: 'PRDETAIL_CHECKOUT_PR' });
  }, [send]);

  const handleCheckoutBranch = useCallback(() => {
    setCheckingOut(true);
    send({ type: 'PRDETAIL_CHECKOUT_BRANCH' });
  }, [send]);

  const handleRequestTargetBranches = useCallback(() => {
    setTargetBranchesLoading(true);
    send({ type: 'PRDETAIL_REQUEST_TARGET_BRANCHES' });
  }, [send]);

  const handleUpdateTitle = useCallback((title: string) => {
    setUpdating(true);
    send({ type: 'PRDETAIL_UPDATE', title });
  }, [send]);

  const handleUpdateTargetBranch = useCallback((targetBranch: string) => {
    setUpdating(true);
    send({ type: 'PRDETAIL_UPDATE', targetBranch });
  }, [send]);

  const handleRequestCollaborators = useCallback(() => {
    setCollaboratorsLoading(true);
    send({ type: 'PRDETAIL_REQUEST_COLLABORATORS' });
  }, [send]);

  const handleUpdateReviewers = useCallback((userIds: string[]) => {
    setUpdatingReviewers(true);
    send({ type: 'PRDETAIL_UPDATE_REVIEWERS', userIds });
  }, [send]);

  const handleUpdateAssignees = useCallback((userIds: string[]) => {
    setUpdatingAssignees(true);
    send({ type: 'PRDETAIL_UPDATE_ASSIGNEES', userIds });
  }, [send]);

  const handleRequestAvailableLabels = useCallback(() => {
    setAvailableLabelsLoading(true);
    send({ type: 'PRDETAIL_REQUEST_AVAILABLE_LABELS' });
  }, [send]);

  const handleUpdateLabels = useCallback((labelIds: string[]) => {
    setUpdatingLabels(true);
    send({ type: 'PRDETAIL_UPDATE_LABELS', labelIds });
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

  const handleApprove = useCallback(() => {
    setApproving(true);
    send({ type: 'PRDETAIL_SUBMIT_REVIEW', input: { event: 'approve' } });
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
    <div style={css.page}>
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
        targetBranches={targetBranches}
        targetBranchesLoading={targetBranchesLoading}
        updating={updating}
        onOpenInBrowser={handleOpenInBrowser}
        onViewAllChanges={handleViewAllChanges}
        onRefresh={handleRefresh}
        onCheckoutPr={handleCheckoutPr}
        onCheckoutBranch={handleCheckoutBranch}
        onApprove={handleApprove}
        onRequestTargetBranches={handleRequestTargetBranches}
        onUpdateTitle={handleUpdateTitle}
        onUpdateTargetBranch={handleUpdateTargetBranch}
      />

      <div style={css.tabBar}>
        {([
          { id: 'overview' as const, label: 'Overview', icon: 'note' },
          { id: 'changes' as const, label: 'Changes', icon: 'diff', count: files.length || undefined },
          { id: 'commits' as const, label: 'Commits', icon: 'git-commit', count: commits.length || undefined },
          { id: 'checks' as const, label: 'Checks', icon: 'checklist', count: checks.length || undefined },
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
                  loading={commentsLoading}
                  posting={postingComment}
                  canClose={detail?.capabilities.canClose === true && detail?.canWrite === true && (detail?.state === 'open' || detail?.state === 'draft')}
                  closing={closing}
                  closeError={closeError}
                  onPostComment={handlePostComment}
                  onClose={handleClose}
                  onOpenCommitAllChanges={handleOpenCommitAllChanges}
                  mergeActions={detail && hasMergeActionsContent(detail, mergeError, reopenError) && (
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
              </CollapsibleSection>
            </div>
            <div className="pr-overview-sidebar">
              <StaticSection title="Reviewers" icon="eye" first>
                {!detail ? <SkeletonChips count={2} /> : (
                  <PeopleField
                    label="Reviewers"
                    icon="eye"
                    showHeader={false}
                    people={detail.reviewers}
                    candidates={collaborators}
                    candidatesLoading={collaboratorsLoading}
                    canEdit={detail.capabilities.canManageReviewers && detail.canWrite}
                    updating={updatingReviewers}
                    onRequestCandidates={handleRequestCollaborators}
                    onUpdate={handleUpdateReviewers}
                  />
                )}
              </StaticSection>
              <StaticSection title="Assignees" icon="account">
                {!detail ? <SkeletonChips count={2} /> : !detail.capabilities.canManageAssignees ? (
                  <span style={css.notAvailable}>Not available for this provider</span>
                ) : (
                  <PeopleField
                    label="Assignees"
                    icon="account"
                    showHeader={false}
                    people={detail.assignees}
                    candidates={collaborators}
                    candidatesLoading={collaboratorsLoading}
                    canEdit={detail.capabilities.canManageAssignees && detail.canWrite}
                    updating={updatingAssignees}
                    onRequestCandidates={handleRequestCollaborators}
                    onUpdate={handleUpdateAssignees}
                  />
                )}
              </StaticSection>
              <StaticSection title="Labels" icon="tag">
                {!detail ? <SkeletonChips count={2} /> : !detail.capabilities.canManageLabels ? (
                  <span style={css.notAvailable}>Not available for this provider</span>
                ) : (
                  <LabelsPanel
                    labels={detail.labels}
                    hasLabels={detail.capabilities.canManageLabels}
                    canManageLabels={detail.capabilities.canManageLabels && detail.canWrite}
                    candidates={availableLabels}
                    candidatesLoading={availableLabelsLoading}
                    updating={updatingLabels}
                    onRequestCandidates={handleRequestAvailableLabels}
                    onUpdate={handleUpdateLabels}
                  />
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
