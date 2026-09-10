import React, { useEffect, useRef, useState } from 'react';
import type { MergeStrategy, PullRequestDetail, PullRequestSummary } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';

interface Props {
  summary: PullRequestSummary;
  detail: PullRequestDetail | null;
  checkingOut: boolean;
  canApprove: boolean;
  approving: boolean;
  canEdit: boolean;
  updating: boolean;
  merging: boolean;
  mergeError?: string;
  reopening: boolean;
  reopenError?: string;
  onOpenInBrowser: () => void;
  onViewAllChanges: () => void;
  onRefresh: () => void;
  onCheckoutPr: () => void;
  onCheckoutBranch: () => void;
  onApprove: () => void;
  onPickTitle: () => void;
  onPickTargetBranch: () => void;
  onMerge: (strategy: MergeStrategy) => void;
  onReopen: () => void;
}

const STRATEGY_LABEL: Record<MergeStrategy, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
  fastForward: 'Fast-forward merge',
};

const STRATEGY_DESCRIPTION: Record<MergeStrategy, string> = {
  merge: 'All commits from this branch will be added to the base branch via a merge commit.',
  squash: 'All commits from this branch will be combined into one commit and added to the base branch.',
  rebase: 'The commits from this branch will be rebased and added to the base branch.',
  fastForward: 'The base branch will be moved forward to this branch, without a merge commit.',
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function stateBadge(state: PullRequestSummary['state']): { icon: string; bg: string; fg: string; label: string } {
  switch (state) {
    case 'draft':  return { icon: 'git-pull-request-draft', bg: 'var(--vscode-descriptionForeground)', fg: 'var(--vscode-editor-background)', label: 'Draft' };
    case 'merged': return { icon: 'git-merge',               bg: '#8957e5', fg: '#fff', label: 'Merged' };
    case 'closed': return { icon: 'git-pull-request-closed', bg: '#cf222e', fg: '#fff', label: 'Closed' };
    default:       return { icon: 'git-pull-request',        bg: '#1a7f37', fg: '#fff', label: 'Open' };
  }
}

function ciInfo(state: 'pending' | 'success' | 'failure' | 'unknown'): { icon: string; color: string; label: string } {
  switch (state) {
    case 'success': return { icon: 'pass-filled', color: '#3fb950', label: 'All checks have passed' };
    case 'failure': return { icon: 'error',       color: 'var(--vscode-errorForeground)', label: 'Some checks were not successful' };
    case 'pending': return { icon: 'sync',        color: 'var(--vscode-descriptionForeground)', label: 'Checks are running…' };
    default:        return { icon: 'question',    color: 'var(--vscode-descriptionForeground)', label: 'Check status unknown' };
  }
}

interface CheckoutMenuItem { icon: string; label: string; description: string; onSelect: () => void; }

function CheckoutButton({ enabled, checkingOut, items }: { enabled: boolean; checkingOut: boolean; items: CheckoutMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [open]);

  const main = items[0];

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
      <div style={css.checkoutSplit}>
        <button style={css.checkoutMainBtn} onClick={main.onSelect} disabled={!enabled || checkingOut}>
          <Codicon name="desktop-download" style={{ fontSize: '13px' }} />
          {checkingOut ? 'Checking out…' : 'Checkout'}
        </button>
        <div style={css.checkoutDivider} />
        <button style={css.checkoutChevronBtn} onClick={() => setOpen(o => !o)} disabled={!enabled || checkingOut} title="More checkout options">
          <Codicon name="chevron-down" style={{ fontSize: '12px' }} />
        </button>
      </div>
      {open && (
        <div style={css.checkoutMenu}>
          {items.map(item => (
            <div
              key={item.label}
              className="menu-item"
              style={css.checkoutMenuItem}
              onClick={() => { item.onSelect(); setOpen(false); }}
            >
              <Codicon name={item.icon} style={{ fontSize: '13px', marginTop: '2px', flexShrink: 0 }} />
              <div>
                <div style={css.checkoutMenuItemLabel}>{item.label}</div>
                <div style={css.checkoutMenuItemDesc}>{item.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** GitHub-style split merge button: a primary "Merge pull request" action plus a chevron dropdown listing every
 * strategy the provider supports, each with its own explanatory line and a checkmark on the currently selected one. */
function MergeButton({ strategies, merging, disabled, disabledTitle, onMerge }: {
  strategies: MergeStrategy[]; merging: boolean; disabled: boolean; disabledTitle?: string; onMerge: (strategy: MergeStrategy) => void;
}) {
  const [open, setOpen] = useState(false);
  const [strategy, setStrategy] = useState<MergeStrategy>(strategies[0]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
      <div style={css.mergeSplit}>
        <button
          style={css.mergeMainBtn}
          onClick={() => onMerge(strategy)}
          disabled={disabled || merging}
          title={disabled ? disabledTitle : undefined}
        >
          <Codicon name="git-merge" style={{ fontSize: '13px' }} />
          {merging ? 'Merging…' : 'Merge pull request'}
        </button>
        {strategies.length > 1 && (
          <>
            <div style={css.mergeDivider} />
            <button style={css.mergeChevronBtn} onClick={() => setOpen(o => !o)} disabled={disabled || merging} title="Select merge method">
              <Codicon name="chevron-down" style={{ fontSize: '12px' }} />
            </button>
          </>
        )}
      </div>
      {open && (
        <div style={css.mergeMenu}>
          {strategies.map(s => (
            <div key={s} className="menu-item" style={css.mergeMenuItem} onClick={() => { setStrategy(s); setOpen(false); }}>
              <Codicon name={s === strategy ? 'check' : 'blank'} style={{ fontSize: '13px', marginTop: '2px', flexShrink: 0 }} />
              <div>
                <div style={css.mergeMenuItemLabel}>{STRATEGY_LABEL[s]}</div>
                <div style={css.mergeMenuItemDesc}>{STRATEGY_DESCRIPTION[s]}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EditableTitle({ title, canEdit, updating, onPick }: { title: string; canEdit: boolean; updating: boolean; onPick: () => void }) {
  return (
    <span style={css.titleRowInner}>
      <span style={css.title}>{title}</span>
      {canEdit && (
        <button className="icon-btn" style={css.editIconBtn} onClick={onPick} disabled={updating} title="Edit title">
          <Codicon name="edit" style={{ fontSize: '13px' }} />
        </button>
      )}
    </span>
  );
}

function EditableTargetBranch({ branchLabel, canEdit, updating, onPick }: {
  branchLabel: string; canEdit: boolean; updating: boolean; onPick: () => void;
}) {
  return (
    <span style={css.branchPill}>
      {branchLabel}
      {canEdit && (
        <button className="icon-btn" style={css.editIconBtnInline} onClick={onPick} disabled={updating} title="Change target branch">
          <Codicon name="edit" style={{ fontSize: '12px' }} />
        </button>
      )}
    </span>
  );
}

export function PullRequestHeader({
  summary, detail, checkingOut, canApprove, approving, canEdit, updating,
  merging, mergeError, reopening, reopenError,
  onOpenInBrowser, onViewAllChanges, onRefresh, onCheckoutPr, onCheckoutBranch, onApprove, onPickTitle, onPickTargetBranch,
  onMerge, onReopen,
}: Props) {
  const state = detail?.merged ? 'merged' : summary.state;
  const badge = stateBadge(state);
  const ci = detail?.ciStatus;
  const isOpen = state === 'open' || state === 'draft';
  const isConflicting = !!detail && detail.capabilities.hasMergeableState && detail.mergeableState === 'conflicting';
  const showMergeableAlert = !!detail && !detail.merged && detail.capabilities.hasMergeableState && isOpen;
  const canShowMerge = !!detail && isOpen && detail.capabilities.canMerge && detail.canWrite && detail.capabilities.mergeStrategies.length > 0;
  const canShowReopen = !!detail && !isOpen && detail.capabilities.canReopen && detail.canWrite;

  const targetLabel = summary.targetRepoFullName ? `${summary.targetRepoFullName}:${summary.targetBranch}` : summary.targetBranch;
  const sourceRepoLabel = summary.sourceRepoFullName ?? summary.targetRepoFullName;
  const sourceLabel = sourceRepoLabel ? `${sourceRepoLabel}:${summary.sourceBranch}` : summary.sourceBranch;

  // Mirrors PullRequestManager.checkoutPullRequest's own sanitization, so the branch name shown here matches
  // the one actually created (e.g. "Riccardo Morandi" -> "riccardo-morandi").
  const safeAuthor = summary.authorName.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const checkoutItems: CheckoutMenuItem[] = [
    { icon: 'git-branch', label: 'Checkout Pull Request', description: `Creates a local branch pr/${safeAuthor}/${summary.number}`, onSelect: onCheckoutPr },
    { icon: 'repo-pull', label: 'Checkout Branch', description: `Downloads or updates the local "${summary.sourceBranch}" branch`, onSelect: onCheckoutBranch },
  ];

  return (
    <div style={css.header}>
      <div style={css.titleRow}>
        <span style={css.number}>#{summary.number}</span>
        <EditableTitle title={summary.title} canEdit={canEdit} updating={updating} onPick={onPickTitle} />

        <div style={css.actionsRow}>
          {canApprove && (
            <button style={css.approveBtn} onClick={onApprove} disabled={approving}>
              <Codicon name="check" style={{ fontSize: '13px' }} />
              {approving ? 'Approving…' : 'Approve'}
            </button>
          )}
          {canShowMerge && (
            <MergeButton
              strategies={detail.capabilities.mergeStrategies}
              merging={merging}
              disabled={isConflicting}
              disabledTitle={isConflicting ? 'Resolve conflicts before merging' : undefined}
              onMerge={onMerge}
            />
          )}
          {canShowReopen && (
            <button style={css.reopenBtn} disabled={reopening} onClick={onReopen}>
              <Codicon name="git-pull-request" style={{ fontSize: '13px' }} />
              {reopening ? 'Reopening…' : 'Reopen pull request'}
            </button>
          )}
          <CheckoutButton enabled={true} checkingOut={checkingOut} items={checkoutItems} />

          <div style={css.spacer} />

          <div style={css.iconBtnGroup}>
            <button className="icon-btn" style={css.iconBtnGrouped} onClick={onViewAllChanges} title="View all changes">
              <Codicon name="diff-multiple" style={{ fontSize: '14px' }} />
            </button>
            <div style={css.iconBtnGroupDivider} />
            <button className="icon-btn" style={css.iconBtnGrouped} onClick={onRefresh} title="Refresh">
              <Codicon name="refresh" style={{ fontSize: '14px' }} />
            </button>
            <div style={css.iconBtnGroupDivider} />
            <button className="icon-btn" style={css.iconBtnGrouped} onClick={onOpenInBrowser} title="Open in browser">
              <Codicon name="link-external" style={{ fontSize: '14px' }} />
            </button>
          </div>
        </div>
      </div>

      <div style={css.badgeRow}>
        <span style={css.badge(badge.bg, badge.fg)}>
          <Codicon name={badge.icon} style={{ fontSize: '13px' }} />
          {badge.label}
        </span>

        {summary.authorAvatarUrl
          ? <img src={summary.authorAvatarUrl} alt={summary.authorName} style={css.avatarImg} />
          : <span style={css.avatarFallback}>{initials(summary.authorName)}</span>
        }

        <span style={css.summaryText}>
          <strong>{summary.authorName}</strong> wants to merge changes into{' '}
          <EditableTargetBranch branchLabel={targetLabel} canEdit={canEdit} updating={updating} onPick={onPickTargetBranch} />
          {' '}from <span style={css.branchPill}>{sourceLabel}</span>
        </span>
      </div>

      {ci && (
        <div style={css.ciRow(ciInfo(ci.state).color)}>
          <Codicon name={ciInfo(ci.state).icon} style={{ fontSize: '14px' }} />
          <span>{ciInfo(ci.state).label}</span>
          {ci.url && (
            <a href={ci.url} style={css.ciLink}>View checks</a>
          )}
        </div>
      )}

      {showMergeableAlert && (
        <div style={isConflicting ? css.conflictAlert : css.cleanAlert}>
          <Codicon name={isConflicting ? 'warning' : 'check'} style={{ fontSize: '15px', flexShrink: 0 }} />
          <span>{isConflicting ? 'This branch has conflicts that must be resolved before merging.' : 'This branch has no conflicts with the base branch.'}</span>
        </div>
      )}
      {mergeError && (
        <div style={css.errorAlert}>
          <Codicon name="error" style={{ fontSize: '15px', flexShrink: 0 }} />
          <span>{mergeError}</span>
        </div>
      )}
      {reopenError && (
        <div style={css.errorAlert}>
          <Codicon name="error" style={{ fontSize: '15px', flexShrink: 0 }} />
          <span>{reopenError}</span>
        </div>
      )}
    </div>
  );
}

const css = {
  header: {
    display: 'flex', flexDirection: 'column' as const, gap: '10px',
    padding: '16px 24px', flexShrink: 0,
  } as React.CSSProperties,
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const } as React.CSSProperties,
  titleRowInner: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 } as React.CSSProperties,
  number: { opacity: 0.5, fontSize: '16px', flexShrink: 0 },
  title: {
    fontSize: '16px', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  editIconBtn: {
    background: 'transparent', border: 'none', color: 'inherit', opacity: 0.5, cursor: 'pointer',
    display: 'flex', alignItems: 'center', flexShrink: 0, padding: '2px',
  } as React.CSSProperties,
  editIconBtnInline: {
    background: 'transparent', border: 'none', color: 'inherit', opacity: 0.7, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', marginLeft: '4px', padding: 0, verticalAlign: 'middle',
  } as React.CSSProperties,
  actionsRow: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } as React.CSSProperties,
  spacer: { width: '4px' },
  iconBtnGroup: {
    display: 'flex', alignItems: 'stretch', border: '1px solid var(--vscode-panel-border)', borderRadius: '3px',
    overflow: 'hidden', flexShrink: 0,
  } as React.CSSProperties,
  iconBtnGrouped: {
    background: 'transparent', border: 'none', padding: '5px 8px', cursor: 'pointer', color: 'inherit',
    display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  iconBtnGroupDivider: {
    width: '1px', background: 'var(--vscode-panel-border)',
  } as React.CSSProperties,
  badgeRow: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: '8px', fontSize: '13px', minWidth: 0, rowGap: '6px', width: '100%',
  } as React.CSSProperties,
  badge: (bg: string, fg: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '999px',
    background: bg, color: fg, fontWeight: 600, fontSize: '12px', flexShrink: 0,
  }),
  avatarImg: { width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0 } as React.CSSProperties,
  avatarFallback: {
    width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '9px', fontWeight: 'bold' as const, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
  summaryText: {
    opacity: 0.85, minWidth: 0, lineHeight: 1.8, flex: 1,
  } as React.CSSProperties,
  branchPill: {
    display: 'inline-flex', alignItems: 'center', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '12px', background: 'color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
  } as React.CSSProperties,
  approveBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px', borderRadius: '4px',
    background: '#3fb950', color: '#fff',
    border: 'none', cursor: 'pointer', flexShrink: 0,
  } as React.CSSProperties,
  mergeSplit: {
    display: 'flex', borderRadius: '4px', overflow: 'hidden',
    background: '#1a7f37',
  } as React.CSSProperties,
  mergeMainBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px',
    background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  mergeDivider: {
    width: '1px', alignSelf: 'stretch' as const, margin: '4px 0', background: '#fff', opacity: 0.3,
  } as React.CSSProperties,
  mergeChevronBtn: {
    display: 'flex', alignItems: 'center', padding: '5px 7px',
    background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer',
  } as React.CSSProperties,
  mergeMenu: {
    position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, zIndex: 50, minWidth: '280px',
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', padding: '4px 0',
  } as React.CSSProperties,
  mergeMenuItem: {
    display: 'flex', gap: '8px', padding: '6px 12px', cursor: 'pointer',
  } as React.CSSProperties,
  mergeMenuItemLabel: { fontSize: '12px', fontWeight: 600 } as React.CSSProperties,
  mergeMenuItemDesc: { fontSize: '11px', opacity: 0.6, marginTop: '2px' } as React.CSSProperties,
  reopenBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px', borderRadius: '4px',
    background: '#1a7f37', color: '#fff',
    border: 'none', cursor: 'pointer', flexShrink: 0, fontWeight: 600,
  } as React.CSSProperties,
  checkoutSplit: {
    display: 'flex', borderRadius: '4px', overflow: 'hidden',
    background: 'var(--vscode-button-background)',
  } as React.CSSProperties,
  checkoutMainBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px',
    background: 'transparent', color: 'var(--vscode-button-foreground)', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  checkoutDivider: {
    width: '1px', alignSelf: 'stretch' as const, margin: '4px 0',
    background: 'var(--vscode-button-foreground)', opacity: 0.3,
  } as React.CSSProperties,
  checkoutChevronBtn: {
    display: 'flex', alignItems: 'center', padding: '5px 7px',
    background: 'transparent', color: 'var(--vscode-button-foreground)', border: 'none', cursor: 'pointer',
  } as React.CSSProperties,
  checkoutMenu: {
    position: 'absolute' as const, top: 'calc(100% + 4px)', right: 0, zIndex: 50, minWidth: '260px',
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', padding: '4px 0',
  } as React.CSSProperties,
  checkoutMenuItem: {
    display: 'flex', gap: '8px', padding: '6px 12px', cursor: 'pointer',
  } as React.CSSProperties,
  checkoutMenuItemLabel: { fontSize: '12px', fontWeight: 600 } as React.CSSProperties,
  checkoutMenuItemDesc: { fontSize: '11px', opacity: 0.6, marginTop: '2px' } as React.CSSProperties,
  ciRow: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color,
  }),
  ciLink: {
    marginLeft: '4px', fontSize: '11px', color: 'var(--vscode-textLink-foreground)',
  } as React.CSSProperties,
  conflictAlert: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: 'var(--vscode-inputValidation-warningForeground)', background: 'var(--vscode-inputValidation-warningBackground)',
    border: '1px solid var(--vscode-inputValidation-warningBorder)',
  } as React.CSSProperties,
  cleanAlert: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: '#3fb950', background: 'color-mix(in srgb, #3fb950 10%, transparent)', border: '1px solid color-mix(in srgb, #3fb950 25%, transparent)',
  } as React.CSSProperties,
  errorAlert: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)',
  } as React.CSSProperties,
};
