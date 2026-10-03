import React, { useEffect, useRef, useState } from 'react';
import type { IssueDetail, IssueSummary } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { avatarColor, initials, initialsFontSize } from '../../shared/avatars';
import { ForgeAvatarImg } from '../../shared/ForgeAvatarImg';
import { formatRelativeTime } from '../../shared/formatRelativeTime';
import { dateLocale, plural } from '../../shared/l10n';
import { interpolateNodes } from '../../pullRequestDetail/components/interpolateNodes';
import * as l10n from '@vscode/l10n';

interface Props {
  summary: IssueSummary;
  detail: IssueDetail | null;
  canEdit: boolean;
  updating: boolean;
  creatingBranch: boolean;
  onPickTitle: () => void;
  onCreateBranch: () => void;
  /** Present when AI is enabled: offers "Create Branch with AI" under the Create Branch button, and "Resolve with AI". */
  ai?: { modelLabel: string; resolveMode: 'agent' | 'text'; onCreateBranchWithAi: () => void; onResolve: () => void };
  onInsertReference: () => void;
  onRefresh: () => void;
  onOpenInBrowser: () => void;
}

function stateBadge(issue: Pick<IssueSummary, 'state' | 'stateReason'>): { icon: string; bg: string; label: string } {
  if (issue.state === 'open') return { icon: 'issues', bg: '#1a7f37', label: l10n.t({ message: 'Open', comment: ['Issue state'] }) };
  if (issue.stateReason === 'notPlanned' || issue.stateReason === 'duplicate') {
    return { icon: 'circle-slash', bg: '#6e7781', label: l10n.t({ message: 'Closed as not planned', comment: ['Issue state'] }) };
  }
  return { icon: 'pass', bg: '#8250df', label: l10n.t({ message: 'Closed', comment: ['Issue state'] }) };
}

/** "Create Branch" with a chevron for its AI variant — same split-button look as the PR panel's Checkout. */
function CreateBranchButton({ creatingBranch, onCreateBranch, onCreateBranchWithAi, modelLabel }: {
  creatingBranch: boolean; onCreateBranch: () => void; onCreateBranchWithAi?: () => void; modelLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
      <div style={css.split}>
        <button style={css.splitMain} onClick={onCreateBranch} disabled={creatingBranch} title={l10n.t('Create a local branch for this issue and check it out')}>
          <Codicon name="git-branch" style={{ fontSize: '13px' }} />
          {creatingBranch ? l10n.t('Creating branch…') : l10n.t('Create Branch')}
        </button>
        {onCreateBranchWithAi && (
          <>
            <div style={css.splitDivider} />
            <button style={css.splitChevron} onClick={() => setOpen(o => !o)} disabled={creatingBranch} title={l10n.t('More branch options')}>
              <Codicon name="chevron-down" style={{ fontSize: '12px' }} />
            </button>
          </>
        )}
      </div>
      {open && onCreateBranchWithAi && (
        <div style={css.menu}>
          <div className="menu-item" style={css.menuItem} onClick={() => { setOpen(false); onCreateBranch(); }}>
            <Codicon name="git-branch" style={{ fontSize: '13px', marginTop: '2px', flexShrink: 0 }} />
            <div>
              <div style={css.menuItemLabel}>{l10n.t('Create Branch')}</div>
              <div style={css.menuItemDesc}>{l10n.t('Named after the issue number and title')}</div>
            </div>
          </div>
          <div className="menu-item" style={css.menuItem} onClick={() => { setOpen(false); onCreateBranchWithAi(); }}>
            <Codicon name="sparkle" style={{ fontSize: '13px', marginTop: '2px', flexShrink: 0 }} />
            <div>
              <div style={css.menuItemLabel}>{l10n.t('Create Branch with AI')}</div>
              <div style={css.menuItemDesc}>
                {modelLabel ? l10n.t('A short name the AI writes from the issue ({0})', modelLabel) : l10n.t('A short name the AI writes from the issue')}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function IssueHeader({ summary, detail, canEdit, updating, creatingBranch, onPickTitle, onCreateBranch, ai, onInsertReference, onRefresh, onOpenInBrowser }: Props) {
  const issue = detail ?? summary;
  const badge = stateBadge(issue);
  const authorName = issue.authorName;
  return (
    <div style={css.header}>
      <div style={css.titleRow}>
        <span style={css.number}>#{issue.number}</span>
        <span style={css.titleInner}>
          <span style={css.title}>{issue.title}</span>
          {canEdit && (
            <button className="icon-btn" style={css.editIconBtn} onClick={onPickTitle} disabled={updating} title={l10n.t('Edit title')}>
              <Codicon name="edit" style={{ fontSize: '13px' }} />
            </button>
          )}
        </span>
        <div style={css.actionsRow}>
          {issue.state === 'open' && ai && (
            <button
              style={css.aiBtn}
              onClick={ai.onResolve}
              title={ai.resolveMode === 'agent'
                ? l10n.t('The AI agent ({0}) works out a fix in a scratch copy of the repository; you review it, then it goes to a new branch, uncommitted', ai.modelLabel)
                : l10n.t('The AI ({0}) reads the relevant files and proposes a fix; you review it, then it goes to a new branch, uncommitted', ai.modelLabel)}
            >
              <Codicon name="sparkle" style={{ fontSize: '13px' }} />
              {l10n.t('Resolve with AI')}
            </button>
          )}
          {issue.state === 'open' && (
            <CreateBranchButton
              creatingBranch={creatingBranch}
              onCreateBranch={onCreateBranch}
              onCreateBranchWithAi={ai?.onCreateBranchWithAi}
              modelLabel={ai?.modelLabel}
            />
          )}
          <div style={css.iconBtnGroup}>
            <button className="icon-btn" style={css.iconBtnGrouped} onClick={onInsertReference} title={l10n.t('Reference in the commit message')}>
              <Codicon name="git-commit" style={{ fontSize: '14px' }} />
            </button>
            <div style={css.iconBtnGroupDivider} />
            <button className="icon-btn" style={css.iconBtnGrouped} onClick={onRefresh} title={l10n.t('Refresh')}>
              <Codicon name="refresh" style={{ fontSize: '14px' }} />
            </button>
            <div style={css.iconBtnGroupDivider} />
            <button className="icon-btn" style={css.iconBtnGrouped} onClick={onOpenInBrowser} title={l10n.t('Open in browser')}>
              <Codicon name="link-external" style={{ fontSize: '14px' }} />
            </button>
          </div>
        </div>
      </div>

      <div style={css.badgeRow}>
        <span style={css.badge(badge.bg)}>
          <Codicon name={badge.icon} style={{ fontSize: '13px' }} />
          {badge.label}
        </span>
        {authorName && (
          <>
            <ForgeAvatarImg
              url={issue.authorAvatarUrl} alt={authorName} style={css.avatarImg}
              fallback={<span style={{ ...css.avatarFallback, background: avatarColor(authorName) }}>{initials(authorName)}</span>}
            />
            <span style={css.summaryText}>
              {issue.createdAt
                ? interpolateNodes(
                  l10n.t('{0} opened this issue {1}'),
                  <strong>{authorName}</strong>,
                  <span title={new Date(issue.createdAt).toLocaleString(dateLocale)}>{formatRelativeTime(issue.createdAt)}</span>,
                )
                : <strong>{authorName}</strong>}
              {!!issue.commentCount && (
                <span style={css.commentCount}>
                  {' · '}
                  {plural(issue.commentCount, l10n.t('1 comment'), l10n.t('{0} comments', issue.commentCount))}
                </span>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const css = {
  header: { display: 'flex', flexDirection: 'column' as const, gap: '10px', padding: '16px 24px', flexShrink: 0 } as React.CSSProperties,
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const } as React.CSSProperties,
  titleInner: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 } as React.CSSProperties,
  number: { opacity: 0.5, fontSize: '16px', flexShrink: 0 },
  title: { fontSize: '16px', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  editIconBtn: {
    background: 'transparent', border: 'none', color: 'inherit', opacity: 0.5, cursor: 'pointer',
    display: 'flex', alignItems: 'center', flexShrink: 0, padding: '2px',
  } as React.CSSProperties,
  actionsRow: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } as React.CSSProperties,
  aiBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px', borderRadius: '4px', whiteSpace: 'nowrap' as const,
    background: 'linear-gradient(135deg, #8957e5, #bc4c9c)', color: '#fff', border: 'none', cursor: 'pointer',
  } as React.CSSProperties,
  split: { display: 'flex', borderRadius: '4px', overflow: 'hidden', background: 'var(--vscode-button-background)' } as React.CSSProperties,
  splitMain: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px',
    background: 'transparent', color: 'var(--vscode-button-foreground)', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  splitDivider: { width: '1px', alignSelf: 'stretch' as const, margin: '4px 0', background: 'var(--vscode-button-foreground)', opacity: 0.3 } as React.CSSProperties,
  splitChevron: {
    display: 'flex', alignItems: 'center', padding: '5px 7px', background: 'transparent', color: 'var(--vscode-button-foreground)', border: 'none', cursor: 'pointer',
  } as React.CSSProperties,
  menu: {
    position: 'absolute' as const, top: 'calc(100% + 4px)', right: 0, zIndex: 50, minWidth: '280px',
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', padding: '4px 0',
  } as React.CSSProperties,
  menuItem: { display: 'flex', gap: '8px', padding: '6px 12px', cursor: 'pointer' } as React.CSSProperties,
  menuItemLabel: { fontSize: '12px' } as React.CSSProperties,
  menuItemDesc: { fontSize: '11px', opacity: 0.6, marginTop: '2px' } as React.CSSProperties,
  iconBtnGroup: {
    display: 'flex', alignItems: 'stretch', border: '1px solid var(--vscode-panel-border)', borderRadius: '3px', overflow: 'hidden', flexShrink: 0,
  } as React.CSSProperties,
  iconBtnGrouped: {
    background: 'transparent', border: 'none', padding: '5px 8px', cursor: 'pointer', color: 'inherit', display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  iconBtnGroupDivider: { width: '1px', background: 'var(--vscode-panel-border)' } as React.CSSProperties,
  badgeRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: '8px', fontSize: '13px', minWidth: 0, rowGap: '6px' } as React.CSSProperties,
  badge: (bg: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '999px',
    background: bg, color: '#fff', fontWeight: 600, fontSize: '12px', flexShrink: 0,
  }),
  avatarImg: { width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0 } as React.CSSProperties,
  avatarFallback: {
    width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: initialsFontSize(20), fontWeight: 600, lineHeight: 1, color: '#fff',
  } as React.CSSProperties,
  summaryText: { opacity: 0.85, minWidth: 0, lineHeight: 1.8, flex: 1 } as React.CSSProperties,
  commentCount: { opacity: 0.8 } as React.CSSProperties,
};
