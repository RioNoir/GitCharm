import React from 'react';
import type { PullRequestDetail, PullRequestSummary } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';

interface Props {
  summary: PullRequestSummary;
  detail: PullRequestDetail | null;
  checkingOut: boolean;
  onOpenInBrowser: () => void;
  onViewAllChanges: () => void;
  onCheckout: () => void;
}

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

export function PullRequestHeader({ summary, detail, checkingOut, onOpenInBrowser, onViewAllChanges, onCheckout }: Props) {
  const state = detail?.merged ? 'merged' : summary.state;
  const badge = stateBadge(state);
  const ci = detail?.ciStatus;
  const showConflictAlert = !!detail && detail.capabilities.hasMergeableState && detail.mergeableState === 'conflicting';

  return (
    <div style={css.header}>
      <div style={css.titleRow}>
        <span style={css.number}>#{summary.number}</span>
        <span style={css.title}>{summary.title}</span>
        <button style={css.iconBtn} onClick={onViewAllChanges} title="View all changes">
          <Codicon name="diff-multiple" style={{ fontSize: '14px' }} />
        </button>
        <button style={css.iconBtn} onClick={onOpenInBrowser} title="Open in browser">
          <Codicon name="link-external" style={{ fontSize: '14px' }} />
        </button>
      </div>

      <div style={css.summaryCard}>
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
          <span style={css.branchPill}>
            {summary.targetRepoFullName ? `${summary.targetRepoFullName}:${summary.targetBranch}` : summary.targetBranch}
          </span> from{' '}
          <span style={css.branchPill}>
            {summary.sourceRepoFullName ? `${summary.sourceRepoFullName}:${summary.sourceBranch}` : summary.sourceBranch}
          </span>
        </span>

        <button style={{ ...css.checkoutBtn, marginLeft: 'auto' }} onClick={onCheckout} disabled={checkingOut}>
          <Codicon name="desktop-download" style={{ fontSize: '13px' }} />
          {checkingOut ? 'Checking out…' : 'Checkout'}
        </button>
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

      {showConflictAlert && (
        <div style={css.conflictAlert}>
          <Codicon name="warning" style={{ fontSize: '15px', flexShrink: 0 }} />
          <span>This branch has conflicts that must be resolved before merging.</span>
        </div>
      )}
    </div>
  );
}

const css = {
  header: {
    display: 'flex', flexDirection: 'column' as const, gap: '10px',
    padding: '16px 24px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0,
  } as React.CSSProperties,
  titleRow: { display: 'flex', alignItems: 'baseline', gap: '8px' } as React.CSSProperties,
  number: { opacity: 0.5, fontSize: '16px' },
  title: { fontSize: '16px', fontWeight: 600, flex: 1, minWidth: 0 } as React.CSSProperties,
  iconBtn: {
    background: 'transparent', border: '1px solid var(--vscode-panel-border)', borderRadius: '3px',
    padding: '4px 8px', cursor: 'pointer', color: 'inherit', display: 'flex', alignItems: 'center', flexShrink: 0,
  } as React.CSSProperties,
  summaryCard: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: '8px', fontSize: '13px', minWidth: 0, rowGap: '6px',
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
    opacity: 0.85, minWidth: 0,
  } as React.CSSProperties,
  branchPill: {
    display: 'inline-block', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '12px', background: 'color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
  } as React.CSSProperties,
  checkoutBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px', borderRadius: '4px',
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
    border: 'none', cursor: 'pointer', flexShrink: 0,
  } as React.CSSProperties,
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
};
