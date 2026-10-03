import '../shared/l10n';
import * as l10n from '@vscode/l10n';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IssueHeader } from './components/IssueHeader';
import { LinkedPullRequests } from './components/LinkedPullRequests';
import { DescriptionPanel } from '../pullRequestDetail/components/DescriptionPanel';
import { CommentsThread } from '../pullRequestDetail/components/CommentsThread';
import { PeopleField, EditFieldButton } from '../pullRequestDetail/components/PeoplePanel';
import { LabelsPanel } from '../pullRequestDetail/components/LabelsPanel';
import { getVsCodeApi, notifyHostReady } from '../shared/vscodeApi';
import { AiExplainFab } from '../shared/AiExplainFab';
import { Codicon } from '../shared/Codicon';
import { SkeletonBlock, SkeletonChips, SkeletonList } from '../shared/Skeleton';
import { MentionCandidatesContext, toMentionCandidates, type MentionCandidate } from '../shared/mentions';
import type {
  HostToIssueDetailMsg, IssueDetail, IssueDetailToHostMsg, IssueSummary, LinkedPullRequest, PullRequestComment, PullRequestEvent,
} from '../../host/types/messages';

function CollapsibleSection({ title, icon, first, headerAction, children }: { title: string; icon: string; first?: boolean; headerAction?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section style={first ? css.section : css.collapsibleSection}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button className="icon-btn" style={{ ...css.collapseHeader, flex: 1 }} onClick={() => setOpen(o => !o)}>
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '13px', opacity: 0.6 }} />
          <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.6 }} />
          <h3 style={css.sectionTitle}>{title}</h3>
        </button>
        {headerAction && <div onClick={e => e.stopPropagation()}>{headerAction}</div>}
      </div>
      {open && children}
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
      {children}
    </section>
  );
}

function App() {
  const [summary, setSummary] = useState<IssueSummary | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | undefined>();

  const [comments, setComments] = useState<PullRequestComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [postingComment, setPostingComment] = useState(false);
  const [commentActionError, setCommentActionError] = useState<string | undefined>();
  const [events, setEvents] = useState<PullRequestEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [linkedPrs, setLinkedPrs] = useState<LinkedPullRequest[]>([]);
  const [linkedPrsLoading, setLinkedPrsLoading] = useState(true);
  const [linkedPrsError, setLinkedPrsError] = useState<string | undefined>();

  const [changingState, setChangingState] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatingAssignees, setUpdatingAssignees] = useState(false);
  const [updatingLabels, setUpdatingLabels] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState<string | undefined>();
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
  const [ai, setAi] = useState<{ enabled: boolean; explainModelLabel: string; issuesModelLabel: string; resolveMode: 'agent' | 'text' }>({
    enabled: false, explainModelLabel: '', issuesModelLabel: '', resolveMode: 'text',
  });

  const send = useCallback((msg: IssueDetailToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  const requestAll = useCallback(() => {
    send({ type: 'ISSUEDETAIL_REQUEST_DETAIL' });
    send({ type: 'ISSUEDETAIL_REQUEST_COMMENTS' });
    send({ type: 'ISSUEDETAIL_REQUEST_EVENTS' });
    send({ type: 'ISSUEDETAIL_REQUEST_LINKED_PRS' });
  }, [send]);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToIssueDetailMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'ISSUEDETAIL_INIT':
          setSummary(msg.summary);
          setAi({ enabled: msg.aiEnabled, explainModelLabel: msg.aiExplainModelLabel, issuesModelLabel: msg.aiIssuesModelLabel, resolveMode: msg.aiResolveMode });
          // Persisted so VS Code can restore this panel after a window reload.
          getVsCodeApi().setState({ repoId: msg.repoId, number: msg.number });
          requestAll();
          send({ type: 'ISSUEDETAIL_REQUEST_MENTION_CANDIDATES' });
          break;
        case 'ISSUEDETAIL_LOADED':
          setDetailLoading(false);
          setDetailError(undefined);
          setDetail(msg.detail);
          setSummary(msg.detail);
          break;
        case 'ISSUEDETAIL_LOAD_ERROR':
          setDetailLoading(false);
          setDetailError(msg.error);
          break;
        case 'ISSUEDETAIL_COMMENTS_RESULT':
          setCommentsLoading(false);
          setComments(msg.comments);
          if (msg.error) setCommentActionError(msg.error);
          break;
        case 'ISSUEDETAIL_EVENTS_RESULT':
          setEventsLoading(false);
          setEvents(msg.events);
          break;
        case 'ISSUEDETAIL_LINKED_PRS_RESULT':
          setLinkedPrsLoading(false);
          setLinkedPrs(msg.pullRequests);
          setLinkedPrsError(msg.error);
          break;
        case 'ISSUEDETAIL_MENTION_CANDIDATES':
          setMentionCandidates(toMentionCandidates(msg.users));
          break;
        case 'ISSUEDETAIL_COMMENT_POSTED':
          setPostingComment(false);
          if (msg.ok) send({ type: 'ISSUEDETAIL_REQUEST_COMMENTS' });
          break;
        case 'ISSUEDETAIL_COMMENT_UPDATED':
        case 'ISSUEDETAIL_COMMENT_DELETED':
          if (msg.ok) send({ type: 'ISSUEDETAIL_REQUEST_COMMENTS' });
          else if (msg.error) setCommentActionError(msg.error);
          break;
        case 'ISSUEDETAIL_STATE_RESULT':
          setChangingState(false);
          if (msg.ok) {
            send({ type: 'ISSUEDETAIL_REQUEST_DETAIL' });
            send({ type: 'ISSUEDETAIL_REQUEST_EVENTS' });
          }
          break;
        case 'ISSUEDETAIL_UPDATE_RESULT':
          setUpdating(false);
          if (msg.ok) {
            send({ type: 'ISSUEDETAIL_REQUEST_DETAIL' });
            send({ type: 'ISSUEDETAIL_REQUEST_EVENTS' });
          }
          break;
        case 'ISSUEDETAIL_UPDATE_ASSIGNEES_RESULT':
          setUpdatingAssignees(false);
          if (msg.ok) {
            send({ type: 'ISSUEDETAIL_REQUEST_DETAIL' });
            send({ type: 'ISSUEDETAIL_REQUEST_EVENTS' });
          }
          break;
        case 'ISSUEDETAIL_UPDATE_LABELS_RESULT':
          setUpdatingLabels(false);
          if (msg.ok) {
            send({ type: 'ISSUEDETAIL_REQUEST_DETAIL' });
            send({ type: 'ISSUEDETAIL_REQUEST_EVENTS' });
          }
          break;
        case 'ISSUEDETAIL_DESCRIPTION_UPDATED':
          setSavingDescription(false);
          if (msg.ok) {
            setEditingDescription(false);
            setDescriptionError(undefined);
            send({ type: 'ISSUEDETAIL_REQUEST_DETAIL' });
          } else {
            setDescriptionError(msg.error ?? l10n.t('Failed to update issue'));
          }
          break;
        case 'ISSUEDETAIL_CREATE_BRANCH_RESULT':
          setCreatingBranch(false);
          break;
      }
    };
    window.addEventListener('message', handler);
    notifyHostReady();
    return () => window.removeEventListener('message', handler);
  }, [send, requestAll]);

  const handleRefresh = useCallback(() => {
    setDetailLoading(true);
    setCommentsLoading(true);
    setEventsLoading(true);
    setLinkedPrsLoading(true);
    requestAll();
  }, [requestAll]);

  if (!summary) {
    return (
      <div style={css.loading}>
        {detailError ? <div style={css.errorBanner}>{detailError}</div> : (
          <div style={{ width: '280px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <SkeletonBlock width="60%" height={18} />
            <SkeletonBlock width="40%" height={12} />
          </div>
        )}
      </div>
    );
  }

  const canWrite = !!detail?.canWrite;
  const isOpen = (detail ?? summary).state === 'open';

  return (
    <MentionCandidatesContext.Provider value={mentionCandidates}>
      <div style={css.page} className="pr-detail-root">
        <IssueHeader
          summary={summary}
          detail={detail}
          canEdit={canWrite}
          updating={updating}
          creatingBranch={creatingBranch}
          onPickTitle={() => { setUpdating(true); send({ type: 'ISSUEDETAIL_PICK_TITLE' }); }}
          onCreateBranch={() => { setCreatingBranch(true); send({ type: 'ISSUEDETAIL_CREATE_BRANCH' }); }}
          ai={ai.enabled ? {
            modelLabel: ai.issuesModelLabel,
            resolveMode: ai.resolveMode,
            onCreateBranchWithAi: () => { setCreatingBranch(true); send({ type: 'ISSUEDETAIL_CREATE_BRANCH_AI' }); },
            onResolve: () => send({ type: 'ISSUEDETAIL_RESOLVE_AI' }),
          } : undefined}
          onInsertReference={() => send({ type: 'ISSUEDETAIL_INSERT_REFERENCE' })}
          onRefresh={handleRefresh}
          onOpenInBrowser={() => send({ type: 'ISSUEDETAIL_OPEN_IN_BROWSER' })}
        />

        {ai.enabled && <AiExplainFab modelLabel={ai.explainModelLabel} onClick={() => send({ type: 'ISSUEDETAIL_EXPLAIN' })} />}

        <div style={css.body}>
          {detailError && <div style={css.errorBanner}>{detailError}</div>}
          <div className="pr-overview-layout">
            <div className="pr-overview-main">
              <CollapsibleSection
                title={l10n.t('Description')} icon="note" first
                headerAction={canWrite && !editingDescription && (
                  <EditFieldButton title={l10n.t('Edit description')} updating={savingDescription} onPick={() => setEditingDescription(true)} />
                )}
              >
                <div style={editingDescription ? undefined : css.descriptionBox}>
                  <DescriptionPanel
                    description={detail?.description ?? ''}
                    loading={detailLoading && !detail}
                    editing={editingDescription}
                    saving={savingDescription}
                    saveError={descriptionError}
                    placeholder={l10n.t('Describe the issue…')}
                    onSave={description => { setSavingDescription(true); setDescriptionError(undefined); send({ type: 'ISSUEDETAIL_UPDATE_DESCRIPTION', description }); }}
                    onCancelEdit={() => { setEditingDescription(false); setDescriptionError(undefined); }}
                  />
                </div>
              </CollapsibleSection>
              <CollapsibleSection title={l10n.t('Activity')} icon="comment-discussion">
                <CommentsThread
                  subject="issue"
                  comments={comments}
                  commits={[]}
                  events={events}
                  loading={commentsLoading || eventsLoading}
                  posting={postingComment}
                  canClose={canWrite && isOpen}
                  closing={changingState}
                  canReopen={canWrite && !isOpen}
                  reopening={changingState}
                  onReopen={() => { setChangingState(true); send({ type: 'ISSUEDETAIL_REOPEN' }); }}
                  commentActionError={commentActionError}
                  onPostComment={body => { setPostingComment(true); send({ type: 'ISSUEDETAIL_POST_COMMENT', body }); }}
                  onUpdateComment={(commentId, body) => { setCommentActionError(undefined); send({ type: 'ISSUEDETAIL_UPDATE_COMMENT', commentId, body }); }}
                  onDeleteComment={commentId => { setCommentActionError(undefined); send({ type: 'ISSUEDETAIL_DELETE_COMMENT', commentId }); }}
                  onHideComment={() => undefined}
                  onUnhideComment={() => undefined}
                  onClose={() => { setChangingState(true); send({ type: 'ISSUEDETAIL_CLOSE' }); }}
                  onOpenCommitAllChanges={() => undefined}
                  onOpenReference={reference => send({ type: 'ISSUEDETAIL_OPEN_REFERENCE', reference })}
                  onOpenCommitReference={commit => send({ type: 'ISSUEDETAIL_OPEN_COMMIT', commit })}
                />
              </CollapsibleSection>
            </div>
            <div className="pr-overview-sidebar">
              <StaticSection
                title={l10n.t('Assignees')} icon="account" first
                headerAction={!!detail && detail.capabilities.canManageAssignees && canWrite && (
                  <EditFieldButton title={l10n.t('Edit assignees')} updating={updatingAssignees} onPick={() => { setUpdatingAssignees(true); send({ type: 'ISSUEDETAIL_PICK_ASSIGNEES' }); }} />
                )}
              >
                {!detail ? <SkeletonChips count={2} /> : <PeopleField people={detail.assignees} />}
              </StaticSection>
              <StaticSection
                title={l10n.t('Labels')} icon="tag"
                headerAction={!!detail && detail.capabilities.canManageLabels && canWrite && (
                  <EditFieldButton title={l10n.t('Edit labels')} updating={updatingLabels} onPick={() => { setUpdatingLabels(true); send({ type: 'ISSUEDETAIL_PICK_LABELS' }); }} />
                )}
              >
                {!detail ? <SkeletonChips count={2} /> : <LabelsPanel labels={detail.labels} hasLabels />}
              </StaticSection>
              <StaticSection title={l10n.t('Linked pull requests')} icon="git-pull-request">
                {linkedPrsLoading ? <SkeletonList rows={1} withAvatar={false} />
                  : linkedPrsError ? <span style={css.notAvailable}>{linkedPrsError}</span>
                  : <LinkedPullRequests pullRequests={linkedPrs} onOpen={pullRequest => send({ type: 'ISSUEDETAIL_OPEN_PULL_REQUEST', pullRequest })} />}
              </StaticSection>
            </div>
          </div>
        </div>
      </div>
    </MentionCandidatesContext.Provider>
  );
}

const css = {
  loading: {
    height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)', fontSize: '13px',
  } as React.CSSProperties,
  page: {
    display: 'flex', flexDirection: 'column' as const, height: '100vh',
    background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)',
    fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size, 13px)',
  } as React.CSSProperties,
  body: { flex: 1, overflow: 'auto', padding: '0 24px 24px', borderTop: '1px solid var(--vscode-panel-border)' } as React.CSSProperties,
  errorBanner: {
    marginTop: '16px', fontSize: '12px', padding: '8px 10px', borderRadius: '3px',
    color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)',
  } as React.CSSProperties,
  section: { marginTop: '20px' } as React.CSSProperties,
  collapsibleSection: { marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--vscode-panel-border)' } as React.CSSProperties,
  descriptionBox: { border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', padding: '14px' } as React.CSSProperties,
  sectionTitle: {
    fontSize: '11px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', opacity: 0.6, fontWeight: 600, margin: 0,
  } as React.CSSProperties,
  collapseHeader: {
    display: 'flex', alignItems: 'center', gap: '6px', width: '100%', background: 'transparent', border: 'none',
    padding: 0, marginBottom: '10px', cursor: 'pointer', color: 'inherit', textAlign: 'left' as const,
  } as React.CSSProperties,
  notAvailable: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
};

createRoot(document.getElementById('root')!).render(<App />);
