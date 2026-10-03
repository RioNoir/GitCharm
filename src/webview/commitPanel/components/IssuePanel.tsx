import React from 'react';
import type { RepoIssues, IssueSummary, ForgeProvider } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { InlineIconBtn } from '../../shared/InlineIconBtn';
import { EmptyTabState } from './EmptyTabState';
import { AuthorAvatar, ConnectPrompt, RepoSkeleton, css, row, useSkeletonStyle } from './PullRequestPanel';
import * as l10n from '@vscode/l10n';
import { plural } from '../../shared/l10n';

interface Props {
  repos: RepoIssues[];
  /** The workspace's only repo: neutral repo headers (repo icon, no color). */
  plainHeaders?: boolean;
  loading: boolean;
  loadingMore: Record<string, boolean>;
  multiRepo: boolean;
  expandedRepoIds: Set<string>;
  onToggleExpanded: (repoId: string) => void;
  onOpenInBrowser: (url: string) => void;
  onOpenDetail: (repoId: string, issue: IssueSummary) => void;
  onCreateBranch: (repoId: string, issue: IssueSummary) => void;
  onInsertReference: (issue: IssueSummary) => void;
  onOpenAccountPicker: (repoId: string) => void;
  onRequestCreate: (repoId: string) => void;
  onRefresh: (repoId: string) => void;
  onSetHostOverride: (host: string, provider: ForgeProvider) => void;
  onOpenFilters: (repoId: string) => void;
  onOpenSearch: (repoId: string) => void;
}

/** GitHub's issue colors: green open, purple completed, gray not planned. */
export function issueStateIcon(issue: Pick<IssueSummary, 'state' | 'stateReason'>): { icon: string; color: string; label: string } {
  if (issue.state === 'open') return { icon: 'issues', color: '#3fb950', label: l10n.t({ message: 'Open', comment: ['Issue state'] }) };
  if (issue.stateReason === 'notPlanned' || issue.stateReason === 'duplicate') {
    return { icon: 'circle-slash', color: 'var(--vscode-descriptionForeground)', label: l10n.t({ message: 'Closed as not planned', comment: ['Issue state'] }) };
  }
  return { icon: 'pass', color: '#a371f7', label: l10n.t({ message: 'Closed', comment: ['Issue state'] }) };
}

function LabelDots({ labels }: { labels: NonNullable<IssueSummary['labels']> }) {
  if (labels.length === 0) return null;
  return (
    <span style={rowExtra.labels} title={labels.map(l => l.name).join(', ')}>
      {labels.slice(0, 3).map(l => (
        <span key={l.id} style={rowExtra.labelChip(l.color)}>{l.name}</span>
      ))}
      {labels.length > 3 && <span style={rowExtra.moreLabels}>+{labels.length - 3}</span>}
    </span>
  );
}

function IssueRow({ issue, repoId, suppressBorder = false, onOpenInBrowser, onOpenDetail, onCreateBranch, onInsertReference }: {
  issue: IssueSummary;
  repoId: string;
  suppressBorder?: boolean;
  onOpenInBrowser: Props['onOpenInBrowser'];
  onOpenDetail: Props['onOpenDetail'];
  onCreateBranch: Props['onCreateBranch'];
  onInsertReference: Props['onInsertReference'];
}) {
  const [hovered, setHovered] = React.useState(false);
  const s = issueStateIcon(issue);
  return (
    <div
      style={{ ...row.header, ...(suppressBorder ? { borderBottom: 'none' } : {}), background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onOpenDetail(repoId, issue)}
      title={issue.title}
    >
      <Codicon name={s.icon} style={{ fontSize: '14px', color: s.color, flexShrink: 0 }} />
      <div style={row.info}>
        <span style={row.name}>
          <span style={row.number}>#{issue.number}</span>
          <span style={row.nameText}>{issue.title}</span>
        </span>
        <span style={row.meta}>
          <AuthorAvatar name={issue.authorName} avatarUrl={issue.authorAvatarUrl} />
          {!!issue.commentCount && (
            <span style={rowExtra.comments} title={plural(issue.commentCount, l10n.t('1 comment'), l10n.t('{0} comments', issue.commentCount))}>
              <Codicon name="comment" style={{ fontSize: '11px' }} />
              {issue.commentCount}
            </span>
          )}
          {issue.labels && <LabelDots labels={issue.labels} />}
        </span>
      </div>
      {hovered && (
        <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
          {issue.state === 'open' && (
            <InlineIconBtn icon="git-branch" title={l10n.t('Create branch for this issue')} visible onClick={e => { e.stopPropagation(); onCreateBranch(repoId, issue); }} />
          )}
          <InlineIconBtn icon="git-commit" title={l10n.t('Reference in the commit message')} visible onClick={e => { e.stopPropagation(); onInsertReference(issue); }} />
          <InlineIconBtn icon="link-external" title={l10n.t('Open in browser')} visible onClick={e => { e.stopPropagation(); onOpenInBrowser(issue.url); }} />
        </div>
      )}
    </div>
  );
}

function RepoSection({ repo, multiRepo, singleRepo, plain = false, isLast = false, expanded, loadingMore, handlers }: {
  repo: RepoIssues;
  multiRepo: boolean;
  singleRepo?: boolean;
  plain?: boolean;
  isLast?: boolean;
  expanded: boolean;
  loadingMore: boolean;
  handlers: Omit<Props, 'repos' | 'plainHeaders' | 'loading' | 'loadingMore' | 'multiRepo' | 'expandedRepoIds'>;
}) {
  const connected = repo.connection.connected;
  const isCollapsible = multiRepo && !singleRepo;
  const isExpanded = singleRepo || expanded;
  const canList = connected && !repo.trackerDisabled;
  return (
    <div style={{ ...css.repoSection, ...(isExpanded && !isLast ? { borderBottom: '1px solid var(--vscode-panel-border)' } : {}) }}>
      <div
        style={{ ...css.repoHeader(repo.repoColor, plain), cursor: isCollapsible ? 'pointer' : 'default' }}
        onClick={isCollapsible ? () => handlers.onToggleExpanded(repo.repoId) : undefined}
      >
        {isCollapsible && (
          <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '12px', opacity: 0.6, flexShrink: 0 }} />
        )}
        {plain ? <Codicon name="repo" style={css.repoIcon} /> : <span style={css.dot(repo.repoColor)} />}
        <span style={css.repoName}>{repo.repoName}</span>
        {repo.pending && <Codicon name="loading" className="codicon-modifier-spin" style={{ fontSize: '11px', opacity: 0.5, flexShrink: 0 }} />}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '2px' }} onClick={e => e.stopPropagation()}>
          {canList && isExpanded && (
            <InlineIconBtn icon="search" title={l10n.t('Search issues')} onClick={() => handlers.onOpenSearch(repo.repoId)} />
          )}
          {canList && isExpanded && (
            <InlineIconBtn icon="filter" title={l10n.t('Filter issues')} onClick={() => handlers.onOpenFilters(repo.repoId)} />
          )}
          <InlineIconBtn icon="refresh" title={l10n.t('Refresh')} onClick={() => handlers.onRefresh(repo.repoId)} />
          {connected && !repo.connection.detectionFailed && (
            <InlineIconBtn icon="account" title={l10n.t('Switch account')} onClick={() => handlers.onOpenAccountPicker(repo.repoId)} />
          )}
          {canList && (
            <InlineIconBtn icon="add" title={l10n.t('New Issue')} onClick={() => handlers.onRequestCreate(repo.repoId)} />
          )}
        </div>
      </div>
      {isExpanded && (
        <>
          {repo.pending ? (
            <RepoSkeleton />
          ) : (
            <>
              {repo.error && (
                <div style={css.errorRow}>
                  <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
                  {repo.error}
                </div>
              )}
              {!connected ? (
                <ConnectPrompt repo={repo} onOpenAccountPicker={handlers.onOpenAccountPicker} onSetHostOverride={handlers.onSetHostOverride} />
              ) : repo.trackerDisabled ? (
                <div style={css.connectBox}>
                  <Codicon name="issues" style={{ fontSize: '20px', opacity: 0.5, marginBottom: '6px' }} />
                  <div style={{ ...css.connectText, marginBottom: 0 }}>{l10n.t('The issue tracker is turned off for this repository.')}</div>
                </div>
              ) : repo.issues.length === 0 ? (
                <div style={css.empty}>{l10n.t('No issues match the current filters')}</div>
              ) : (
                <>
                  {repo.issues.map((issue, idx) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      repoId={repo.repoId}
                      suppressBorder={!isLast && !loadingMore && idx === repo.issues.length - 1}
                      onOpenInBrowser={handlers.onOpenInBrowser}
                      onOpenDetail={handlers.onOpenDetail}
                      onCreateBranch={handlers.onCreateBranch}
                      onInsertReference={handlers.onInsertReference}
                    />
                  ))}
                  {loadingMore && <div style={css.loadingMore}>{l10n.t('Loading more…')}</div>}
                </>
              )}
            </>
          )}
          {!multiRepo && canList && !repo.pending && (
            <div style={css.singleRepoActions}>
              <button className="gc-btn-secondary" style={css.actionBtn} onClick={() => handlers.onOpenSearch(repo.repoId)}>
                <Codicon name="search" style={{ marginRight: '4px', fontSize: '12px' }} />
                {l10n.t('Search')}
              </button>
              <button className="gc-btn-secondary" style={css.actionBtn} onClick={() => handlers.onOpenFilters(repo.repoId)}>
                <Codicon name="filter" style={{ marginRight: '4px', fontSize: '12px' }} />
                {l10n.t('Filter')}
              </button>
              <button className="gc-btn-secondary" style={css.actionBtn} onClick={() => handlers.onRefresh(repo.repoId)}>
                <Codicon name="refresh" style={{ marginRight: '4px', fontSize: '12px' }} />
                {l10n.t('Refresh')}
              </button>
              <button className="gc-btn-secondary" style={css.actionBtn} onClick={() => handlers.onRequestCreate(repo.repoId)}>
                <Codicon name="add" style={{ marginRight: '4px', fontSize: '12px' }} />
                {l10n.t('New Issue')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** True once every listed repo has loaded and none has a remote: the tab then shows its empty state instead of the list. */
export function noIssueRepoHasRemote(repos: RepoIssues[]): boolean {
  return repos.length > 0 && repos.every(r => !r.pending && r.connection.noRemote);
}

export function IssuesNoRemoteState({ repoCount }: { repoCount: number }) {
  return repoCount === 1
    ? <EmptyTabState icon="cloud" message={l10n.t('The repository has no remote')} hint={l10n.t('Issues come from the Git forge hosting the remote (GitHub, GitLab, Bitbucket or Gitea). Once the repository has a remote, they show up here.')} />
    : <EmptyTabState icon="cloud" message={l10n.t('No repository has a remote')} hint={l10n.t('Issues come from the Git forge hosting each remote (GitHub, GitLab, Bitbucket or Gitea). Repositories with a remote show up here.')} />;
}

export function IssuePanel({ repos, loading, loadingMore, multiRepo, plainHeaders = false, expandedRepoIds, ...handlers }: Props) {
  useSkeletonStyle();
  return (
    <div style={css.root}>
      {loading && repos.length === 0 ? (
        <div style={css.empty}>{l10n.t('Loading…')}</div>
      ) : (
        repos.map((repo, idx) => (
          <RepoSection
            key={repo.repoId}
            repo={repo}
            multiRepo={multiRepo}
            singleRepo={repos.length === 1}
            plain={plainHeaders}
            isLast={idx === repos.length - 1}
            expanded={expandedRepoIds.has(repo.repoId)}
            loadingMore={!!loadingMore[repo.repoId]}
            handlers={handlers}
          />
        ))
      )}
    </div>
  );
}

/** Picks readable text (black/white) for a label's background — the heuristic forges use themselves. */
function contrastColor(hexColor: string): string {
  const hex = hexColor.replace(/^#/, '');
  if (hex.length !== 6) return '#000000';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000000' : '#ffffff';
}

const rowExtra = {
  comments: {
    fontSize: '10px', display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0,
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  labels: { display: 'flex', alignItems: 'center', gap: '3px', minWidth: 0, overflow: 'hidden' } as React.CSSProperties,
  labelChip: (color: string): React.CSSProperties => ({
    fontSize: '9px', lineHeight: '14px', padding: '0 5px', borderRadius: '7px', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '90px',
    background: `#${color.replace(/^#/, '')}`, color: contrastColor(color),
  }),
  moreLabels: { fontSize: '9px', opacity: 0.6, flexShrink: 0 } as React.CSSProperties,
};
