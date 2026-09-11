import React, { useState } from 'react';
import type { StashEntry } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { InlineIconBtn } from '../../shared/InlineIconBtn';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import type { ViewMode } from '../store/commitStore';
import { useCommitStore } from '../store/commitStore';
import { GenericFileTree } from '../../shared/GenericFileTree';

interface Props {
  repoId: string;
  repoName: string;
  repoColor: string;
  multiRepo: boolean;
  singleRepo?: boolean;
  worktreeBranch?: string;
  mainRepoName?: string;
  stashes: StashEntry[];
  loading: boolean;
  error: string | null;
  viewMode: ViewMode;
  onApply: (repoId: string, stashRef: string) => void;
  onPop: (repoId: string, stashRef: string) => void;
  onDrop: (repoId: string, stashRef: string) => void;
  onRename: (repoId: string, stashRef: string, currentMessage: string) => void;
  onRequestList: (repoId: string) => void;
  onOpenFileDiff: (repoId: string, stashRef: string, filePath: string) => void;
  expandAll?: boolean;
  /** Suppresses the section's bottom border when it's the last repo section in the list — avoids a dangling border with nothing below to visually merge into. */
  isLast?: boolean;
}

const STASH_CTX_ITEMS: ContextMenuEntry[] = [
  { id: 'pop',    label: 'Pop (apply & drop)', icon: 'git-stash-pop' },
  { id: 'apply',  label: 'Apply (keep stash)', icon: 'git-stash-apply' },
  { id: 'rename', label: 'Rename',             icon: 'edit' },
  { separator: true },
  { id: 'drop',   label: 'Delete',             icon: 'trash', danger: true },
];

const STATUS_COLORS: Record<string, string> = {
  // extended names (Shelf uses these)
  modified:  'var(--vscode-gitDecoration-modifiedResourceForeground)',
  added:     'var(--vscode-gitDecoration-addedResourceForeground)',
  deleted:   'var(--vscode-gitDecoration-deletedResourceForeground)',
  renamed:   'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  untracked: 'var(--vscode-gitDecoration-untrackedResourceForeground)',
  // git single-letter codes (Stash uses these)
  M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
  A: 'var(--vscode-gitDecoration-addedResourceForeground)',
  D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  '?': 'var(--vscode-gitDecoration-untrackedResourceForeground)',
};
const STATUS_LETTERS: Record<string, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U',
  M: 'M', A: 'A', D: 'D', R: 'R', '?': 'U',
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--vscode-foreground)';
}
function statusLetter(status: string): string {
  return STATUS_LETTERS[status] ?? 'M';
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: diffD > 365 ? 'numeric' : undefined });
  } catch { return iso; }
}

type StashFile = StashEntry['files'][number];

// ── Single stash entry row ────────────────────────────────────────────────────

function StashRow({ entry, repoId, viewMode, onApply, onPop, onDrop, onRename, onOpenFileDiff, expandAll, isLast }: {
  entry: StashEntry;
  repoId: string;
  viewMode: ViewMode;
  onApply: Props['onApply'];
  onPop: Props['onPop'];
  onDrop: Props['onDrop'];
  onRename: Props['onRename'];
  onOpenFileDiff: Props['onOpenFileDiff'];
  expandAll: boolean;
  isLast?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const iconTheme = useCommitStore(s => s.iconTheme);
  // Per-directory open state (tree mode)
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());

  // Sync with expand/collapse all
  React.useEffect(() => {
    setExpanded(expandAll);
  }, [expandAll]);

  const toggleDir = (path: string) => {
    setOpenDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  return (
    <div style={{ ...row.root, position: 'relative', ...(isLast ? { borderBottom: 'none' } : {}) }}>
      {/* Guide line from the header's chevron down through the expanded file list, replacing the box border. */}
      {expanded && <div style={row.expandedGuide} />}
      {/* Header */}
      <div
        style={{ ...row.header, background: ctxMenu ? 'var(--vscode-list-inactiveSelectionBackground)' : hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        onDoubleClick={() => onPop(repoId, entry.ref)}
        title={`${entry.ref} — double-click to pop`}
      >
        <button style={row.chevronBtn} onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '11px', opacity: 0.65 }} />
        </button>
        <Codicon name="git-stash" style={{ fontSize: '13px', opacity: 0.4, flexShrink: 0 }} />
        <div style={row.info}>
          <span style={row.name}>
            <span style={row.nameText}>{(entry.message || entry.ref).split('\n')[0]}</span>
          </span>
          <span style={row.meta}>
            {formatDate(entry.date)}
            {' · '}{entry.files.length} {entry.files.length === 1 ? 'file' : 'files'}
            {(() => {
              const a = entry.files.reduce((s, f) => s + (f.added   ?? 0), 0);
              const r = entry.files.reduce((s, f) => s + (f.removed ?? 0), 0);
              return (a > 0 || r > 0) ? <>{' '}<span style={row.statAdd}>+{a}</span>{' '}<span style={row.statDel}>-{r}</span></> : null;
            })()}
            {entry.branch && (
              <>
                {' · '}
                <Codicon name="git-branch" style={{ fontSize: '10px', marginRight: '3px' }} />
                {entry.branch}
              </>
            )}
          </span>
        </div>
        {hovered && (
          <div style={row.actions}>
            <InlineIconBtn icon="git-stash-pop" title="Pop (apply and drop)" visible onClick={e => { e.stopPropagation(); onPop(repoId, entry.ref); }} />
            <InlineIconBtn icon="git-stash-apply" title="Apply (keep stash)" visible onClick={e => { e.stopPropagation(); onApply(repoId, entry.ref); }} />
            <InlineIconBtn icon="trash" title="Drop stash" visible danger onClick={e => { e.stopPropagation(); onDrop(repoId, entry.ref); }} />
          </div>
        )}
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={row.fileList}>
          {entry.files.length === 0 ? (
            <div style={row.emptyFiles}>No files</div>
          ) : (
            <GenericFileTree<StashFile>
              files={entry.files}
              viewMode={viewMode}
              iconTheme={iconTheme}
              statusColor={statusColor}
              statusLetter={statusLetter}
              isDirOpen={dirPath => openDirs.has(dirPath)}
              toggleDir={toggleDir}
              onOpenFile={f => onOpenFileDiff(repoId, entry.ref, f.path)}
            />
          )}
        </div>
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x} y={ctxMenu.y}
          items={STASH_CTX_ITEMS}
          onSelect={id => {
            setCtxMenu(null);
            if (id === 'pop')    onPop(repoId, entry.ref);
            if (id === 'apply')  onApply(repoId, entry.ref);
            if (id === 'rename') onRename(repoId, entry.ref, entry.message);
            if (id === 'drop')   onDrop(repoId, entry.ref);
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

const SECTION_COLLAPSE_THRESHOLD = 5;

export function StashTab({
  repoId, repoName, repoColor, multiRepo, singleRepo = false,
  worktreeBranch, mainRepoName,
  stashes, loading, error, viewMode,
  onApply, onPop, onDrop, onRename, onRequestList: _onRequestList, onOpenFileDiff,
  expandAll = false, isLast = false,
}: Props) {
  const { isCollapsed, toggleCollapsed } = useCommitStore();
  const sectionKey = `stash-repo:${repoId}`;
  const isCollapsible = !singleRepo && stashes.length > SECTION_COLLAPSE_THRESHOLD;
  const sectionCollapsed = isCollapsible && isCollapsed(sectionKey);

  return (
    <div style={{ ...css.root, ...(!sectionCollapsed && !isLast ? {} : { borderBottom: 'none' }) }}>
      {multiRepo && (
        <div
          style={{ ...css.repoHeader(repoColor, singleRepo), cursor: isCollapsible ? 'pointer' : 'default' }}
          onClick={isCollapsible ? () => toggleCollapsed(sectionKey) : undefined}
        >
          {isCollapsible && (
            <Codicon name={sectionCollapsed ? 'chevron-right' : 'chevron-down'} style={{ fontSize: '12px', opacity: 0.6, flexShrink: 0 }} />
          )}
          {singleRepo
            ? <Codicon name="repo" style={css.repoIcon} />
            : <span style={css.dot(repoColor)} />
          }
          <span style={css.repoName}>{worktreeBranch ? mainRepoName ?? repoName : repoName}</span>
          {worktreeBranch && (
            <span style={css.worktreeBadge}>
              <Codicon name="worktree" style={{ fontSize: '11px', marginRight: '3px', flexShrink: 0 }} />
              <span style={css.worktreeBadgeText}>{worktreeBranch}</span>
            </span>
          )}
        </div>
      )}
      {error && (
        <div style={css.errorRow}>
          <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
          {error}
        </div>
      )}
      {!sectionCollapsed && (
        loading ? (
          <div style={css.empty}>Loading…</div>
        ) : stashes.length === 0 ? (
          <div style={css.empty}>No stashes</div>
        ) : (
          stashes.map((entry, i) => (
            <StashRow
              key={entry.ref}
              entry={entry}
              repoId={repoId}
              viewMode={viewMode}
              onApply={onApply}
              onPop={onPop}
              onDrop={onDrop}
              onRename={onRename}
              onOpenFileDiff={onOpenFileDiff}
              expandAll={expandAll}
              isLast={!isLast && i === stashes.length - 1}
            />
          ))
        )
      )}
    </div>
  );
}

export type { Props as StashTabProps };

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, borderBottom: '1px solid var(--vscode-panel-border)' },
  repoHeader: (color: string, singleRepo?: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', minHeight: '26px',
    background: singleRepo
      ? 'color-mix(in srgb, var(--vscode-foreground) 7%, var(--vscode-sideBar-background))'
      : `color-mix(in srgb, ${color} 8%, var(--vscode-sideBar-background))`,
    borderBottom: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box', overflow: 'hidden', minWidth: 0,
    position: 'sticky', top: 0, zIndex: 1,
  }),
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
  errorRow: {
    display: 'flex', alignItems: 'flex-start', padding: '4px 8px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
  } as React.CSSProperties,
  empty: { padding: '16px 12px', fontSize: '12px', opacity: 0.45, textAlign: 'center' as const },
};

const row = {
  root: { borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)' } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: '5px',
    padding: '5px 8px 5px 4px', cursor: 'default', minHeight: '32px',
  } as React.CSSProperties,
  chevronBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '1px 3px', display: 'flex', alignItems: 'center',
    color: 'var(--vscode-foreground)', flexShrink: 0,
  } as React.CSSProperties,
  info: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0 },
  name: { fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, overflow: 'hidden' } as React.CSSProperties,
  nameText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0, flex: '1 1 auto' } as React.CSSProperties,
  meta: { fontSize: '10px', opacity: 0.5, marginTop: '2px', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' } as React.CSSProperties,
  statAdd: { color: 'var(--vscode-gitDecoration-addedResourceForeground)', fontSize: '10px', opacity: 1 },
  statDel: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)', fontSize: '10px', opacity: 1 },
  actions: { display: 'flex', gap: '2px', flexShrink: 0 } as React.CSSProperties,
  fileList: {
    display: 'flex', flexDirection: 'column' as const,
    background: 'var(--vscode-sideBar-background)',
    paddingBottom: '4px',
  } as React.CSSProperties,
  // Replaces the box's border-bottom/fileList border-top while expanded: a single guide line
  // from the header's chevron down through the whole file list, rather than a boxed separator.
  expandedGuide: {
    position: 'absolute' as const, left: '12px', top: '32px', bottom: 0, width: '1px',
    background: 'var(--vscode-tree-indentGuidesStroke, var(--vscode-panel-border))',
    opacity: 0.5, pointerEvents: 'none' as const,
  } as React.CSSProperties,
  emptyFiles: { padding: '6px 24px', fontSize: '11px', opacity: 0.4 },
};
