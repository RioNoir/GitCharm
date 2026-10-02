import React from 'react';
import { Codicon } from '../../shared/Codicon';

/**
 * The header of a repository's section in the Shelf and Stash tabs: a chevron that
 * collapses the section, the repo's dot (or icon when it's the only repo), its name, the
 * worktree branch when it is one, and on the right how many entries it holds. The only
 * repo listed can't be collapsed — there'd be nothing left in the tab.
 */
export function RepoSectionHeader({ repoName, repoColor, singleRepo, worktreeBranch, expanded, onToggle, count, countTitle }: {
  repoName: string;
  repoColor: string;
  singleRepo: boolean;
  worktreeBranch?: string;
  expanded: boolean;
  onToggle: () => void;
  /** Hidden while unknown (the list is loading). */
  count?: number;
  countTitle?: string;
}) {
  const collapsible = !singleRepo;
  return (
    <div
      style={css.header(repoColor, singleRepo)}
      {...(collapsible ? {
        onClick: onToggle,
        role: 'button',
        'aria-expanded': expanded,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } },
      } : {})}
    >
      {collapsible && <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={css.chevron} />}
      {singleRepo
        ? <Codicon name="repo" style={css.repoIcon} />
        : <span style={css.dot(repoColor)} />
      }
      <span style={css.repoName}>{repoName}</span>
      {worktreeBranch && (
        <span style={css.worktreeBadge}>
          <Codicon name="worktree" style={{ fontSize: '11px', marginRight: '3px', flexShrink: 0 }} />
          <span style={css.worktreeBadgeText}>{worktreeBranch}</span>
        </span>
      )}
      {count !== undefined && (
        <span style={css.count(count > 0)} title={countTitle}>{count}</span>
      )}
    </div>
  );
}

const css = {
  header: (color: string, singleRepo: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', minHeight: '26px',
    background: singleRepo
      ? 'color-mix(in srgb, var(--vscode-foreground) 7%, var(--vscode-sideBar-background))'
      : `color-mix(in srgb, ${color} 8%, var(--vscode-sideBar-background))`,
    borderBottom: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box', overflow: 'hidden', minWidth: 0,
    position: 'sticky', top: 0, zIndex: 1,
    cursor: singleRepo ? 'default' : 'pointer', userSelect: 'none', outline: 'none',
  }),
  chevron: { fontSize: '12px', opacity: 0.6, flexShrink: 0 } as React.CSSProperties,
  dot: (color: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  repoIcon: { fontSize: '13px', opacity: 0.7, flexShrink: 0 } as React.CSSProperties,
  repoName: {
    fontSize: '11px', fontWeight: 'bold' as const, opacity: 0.9, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flexShrink: 1,
  } as React.CSSProperties,
  worktreeBadge: {
    display: 'flex', alignItems: 'center', fontSize: '11px', fontWeight: 'normal' as const, letterSpacing: '0.02em',
    opacity: 0.55, minWidth: 0, overflow: 'hidden', flexShrink: 1,
  } as React.CSSProperties,
  worktreeBadgeText: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0,
  } as React.CSSProperties,
  // Same look as the file count on a Changes repo header: a badge when there's something, faint when empty.
  count: (nonEmpty: boolean): React.CSSProperties => ({
    marginLeft: 'auto',
    background: nonEmpty ? 'var(--vscode-badge-background)' : 'transparent',
    color: nonEmpty ? 'var(--vscode-badge-foreground)' : 'var(--vscode-foreground)',
    borderRadius: '8px',
    padding: nonEmpty ? '1px 5px' : '0',
    fontSize: '10px',
    fontWeight: 'bold',
    flexShrink: 0,
    opacity: nonEmpty ? 1 : 0.4,
    minWidth: '18px',
    textAlign: 'center',
  }),
};
