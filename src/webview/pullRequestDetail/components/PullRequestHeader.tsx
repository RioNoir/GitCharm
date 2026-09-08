import React, { useEffect, useRef, useState } from 'react';
import type { PullRequestDetail, PullRequestSummary } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';

interface Props {
  summary: PullRequestSummary;
  detail: PullRequestDetail | null;
  checkingOut: boolean;
  canApprove: boolean;
  approving: boolean;
  canEdit: boolean;
  targetBranches: string[];
  targetBranchesLoading: boolean;
  updating: boolean;
  onOpenInBrowser: () => void;
  onViewAllChanges: () => void;
  onRefresh: () => void;
  onCheckoutPr: () => void;
  onCheckoutBranch: () => void;
  onApprove: () => void;
  onRequestTargetBranches: () => void;
  onUpdateTitle: (title: string) => void;
  onUpdateTargetBranch: (targetBranch: string) => void;
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

function EditableTitle({ title, canEdit, updating, onUpdate }: { title: string; canEdit: boolean; updating: boolean; onUpdate: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  if (!editing) {
    return (
      <span style={css.titleRowInner}>
        <span style={css.title}>{title}</span>
        {canEdit && (
          <button style={css.editIconBtn} onClick={() => { setDraft(title); setEditing(true); }} title="Edit title">
            <Codicon name="edit" style={{ fontSize: '13px' }} />
          </button>
        )}
      </span>
    );
  }

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) onUpdate(trimmed);
    setEditing(false);
  };

  return (
    <span style={css.titleEditRow}>
      <input
        autoFocus
        style={css.titleInput}
        value={draft}
        disabled={updating}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setEditing(false); }}
        onBlur={submit}
      />
    </span>
  );
}

function EditableTargetBranch({
  branchLabel, canEdit, targetBranches, targetBranchesLoading, updating, onRequestBranches, onUpdate,
}: {
  branchLabel: string; canEdit: boolean; targetBranches: string[]; targetBranchesLoading: boolean; updating: boolean;
  onRequestBranches: () => void; onUpdate: (branch: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <span style={css.branchPill}>
        {branchLabel}
        {canEdit && (
          <button
            style={css.editIconBtnInline}
            onClick={() => { setEditing(true); onRequestBranches(); }}
            title="Change target branch"
          >
            <Codicon name="edit" style={{ fontSize: '12px' }} />
          </button>
        )}
      </span>
    );
  }

  return (
    <select
      autoFocus
      style={css.branchSelect}
      disabled={updating || targetBranchesLoading}
      defaultValue=""
      onChange={e => { if (e.target.value) { onUpdate(e.target.value); setEditing(false); } }}
      onBlur={() => setEditing(false)}
    >
      <option value="" disabled>{targetBranchesLoading ? 'Loading branches…' : 'Select a branch…'}</option>
      {targetBranches.map(b => <option key={b} value={b}>{b}</option>)}
    </select>
  );
}

export function PullRequestHeader({
  summary, detail, checkingOut, canApprove, approving, canEdit, targetBranches, targetBranchesLoading, updating,
  onOpenInBrowser, onViewAllChanges, onRefresh, onCheckoutPr, onCheckoutBranch, onApprove, onRequestTargetBranches, onUpdateTitle, onUpdateTargetBranch,
}: Props) {
  const state = detail?.merged ? 'merged' : summary.state;
  const badge = stateBadge(state);
  const ci = detail?.ciStatus;
  const showConflictAlert = !!detail && detail.capabilities.hasMergeableState && detail.mergeableState === 'conflicting';

  const targetLabel = summary.targetRepoFullName ? `${summary.targetRepoFullName}:${summary.targetBranch}` : summary.targetBranch;
  const sourceRepoLabel = summary.sourceRepoFullName ?? summary.targetRepoFullName;
  const sourceLabel = sourceRepoLabel ? `${sourceRepoLabel}:${summary.sourceBranch}` : summary.sourceBranch;

  const checkoutItems: CheckoutMenuItem[] = [
    { icon: 'git-branch', label: 'Checkout Pull Request', description: `Creates a local branch pr/${summary.authorName}/${summary.number}`, onSelect: onCheckoutPr },
    { icon: 'repo-pull', label: 'Checkout Branch', description: `Downloads or updates the local "${summary.sourceBranch}" branch`, onSelect: onCheckoutBranch },
  ];

  return (
    <div style={css.header}>
      <div style={css.titleRow}>
        <span style={css.number}>#{summary.number}</span>
        <EditableTitle title={summary.title} canEdit={canEdit} updating={updating} onUpdate={onUpdateTitle} />

        <div style={css.actionsRow}>
          {canApprove && (
            <button style={css.approveBtn} onClick={onApprove} disabled={approving}>
              <Codicon name="check" style={{ fontSize: '13px' }} />
              {approving ? 'Approving…' : 'Approve'}
            </button>
          )}
          <CheckoutButton enabled={true} checkingOut={checkingOut} items={checkoutItems} />

          <div style={css.spacer} />

          <button style={css.iconBtn} onClick={onViewAllChanges} title="View all changes">
            <Codicon name="diff-multiple" style={{ fontSize: '14px' }} />
          </button>
          <button style={css.iconBtn} onClick={onRefresh} title="Refresh">
            <Codicon name="refresh" style={{ fontSize: '14px' }} />
          </button>
          <button style={css.iconBtn} onClick={onOpenInBrowser} title="Open in browser">
            <Codicon name="link-external" style={{ fontSize: '14px' }} />
          </button>
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
          <EditableTargetBranch
            branchLabel={targetLabel}
            canEdit={canEdit}
            targetBranches={targetBranches}
            targetBranchesLoading={targetBranchesLoading}
            updating={updating}
            onRequestBranches={onRequestTargetBranches}
            onUpdate={onUpdateTargetBranch}
          />
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
  titleEditRow: { flex: 1, minWidth: 0 } as React.CSSProperties,
  titleInput: {
    fontSize: '16px', fontWeight: 600, width: '100%', padding: '2px 6px', borderRadius: '3px',
    background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-focusBorder)', outline: 'none', fontFamily: 'inherit',
  } as React.CSSProperties,
  actionsRow: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } as React.CSSProperties,
  spacer: { width: '4px' },
  iconBtn: {
    background: 'transparent', border: '1px solid var(--vscode-panel-border)', borderRadius: '3px',
    padding: '4px 8px', cursor: 'pointer', color: 'inherit', display: 'flex', alignItems: 'center', flexShrink: 0,
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
  branchSelect: {
    fontSize: '12px', padding: '3px 6px', background: 'var(--vscode-dropdown-background)',
    color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-focusBorder)', borderRadius: '4px',
  } as React.CSSProperties,
  approveBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px', borderRadius: '4px',
    background: '#3fb950', color: '#fff',
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
    position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, zIndex: 50, minWidth: '260px',
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
};
