import React, { useState } from 'react';
import type { WorktreeEntry } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';

interface RepoWorktrees {
  repoId: string;
  repoName: string;
  repoColor: string;
  worktrees: WorktreeEntry[];
  isLinkedWorktree: boolean;
}

interface Props {
  repos: RepoWorktrees[];
  loading: boolean;
  error: string | null;
  multiRepo: boolean;
  onDelete: (repoId: string, worktreePath: string, force: boolean) => void;
  onLock: (repoId: string, worktreePath: string) => void;
  onUnlock: (repoId: string, worktreePath: string) => void;
  onPrune: (repoId: string) => void;
  onOpenInExplorer: (repoId: string, worktreePath: string) => void;
  onOpenInNewWindow: (worktreePath: string) => void;
  onOpenInOS: (worktreePath: string) => void;
  onAddToWorkspace: (worktreePath: string) => void;
  onRequestCreate: (repoId: string) => void;
}

function ctxItems(entry: WorktreeEntry): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = [
    ...(entry.isInWorkspace ? [{ id: 'explorer', label: 'Reveal in Explorer', icon: 'folder-opened' } as ContextMenuEntry] : []),
    { id: 'newwindow',  label: 'Open in New Window',        icon: 'link-external' },
    { id: 'os',         label: 'Open in File Manager',      icon: 'folder' },
    ...(!entry.isInWorkspace ? [{ id: 'add-to-workspace', label: 'Add Folder to Workspace', icon: 'add' } as ContextMenuEntry] : []),
  ];
  if (!entry.isMain) {
    items.push(
      { separator: true },
      entry.isLocked
        ? { id: 'unlock', label: 'Unlock',        icon: 'unlock' }
        : { id: 'lock',   label: 'Lock',          icon: 'lock' },
      { separator: true },
      { id: 'delete',       label: 'Remove Worktree', icon: 'trash', danger: true },
      { id: 'force-delete', label: 'Force Remove',    icon: 'trash', danger: true },
    );
  }
  return items;
}

// ── Single worktree row ───────────────────────────────────────────────────────

function WorktreeRow({ entry, repoId, onDelete, onLock, onUnlock, onOpenInExplorer, onOpenInNewWindow, onOpenInOS, onAddToWorkspace }: {
  entry: WorktreeEntry;
  repoId: string;
  onDelete: Props['onDelete'];
  onLock: Props['onLock'];
  onUnlock: Props['onUnlock'];
  onOpenInExplorer: Props['onOpenInExplorer'];
  onOpenInNewWindow: Props['onOpenInNewWindow'];
  onOpenInOS: Props['onOpenInOS'];
  onAddToWorkspace: Props['onAddToWorkspace'];
}) {
  const [hovered, setHovered] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const dirName = entry.path.split(/[\\/]/).pop() ?? entry.path;

  const branchLabel = entry.isDetached
    ? entry.head ? entry.head.slice(0, 8) : 'detached HEAD'
    : entry.branchShort || entry.branch;

  return (
    <div style={row.root}>
      <div
        style={{ ...row.header, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        title={entry.path}
      >
        <Codicon
          name={entry.isMain ? 'repo' : 'repo-clone'}
          style={{ fontSize: '13px', opacity: entry.isMain ? 0.9 : 0.55, flexShrink: 0 }}
        />
        <div style={row.info}>
          <span style={row.name}>
            <span style={row.nameText}>{dirName}</span>
            {entry.isMain && <span style={row.mainBadge}>main</span>}
            {!entry.isMain && entry.isInWorkspace && <span style={row.workspaceBadge}>in workspace</span>}
            {entry.isLocked && (
              <Codicon name="lock" style={{ fontSize: '11px', opacity: 0.6 }} />
            )}
          </span>
          <span style={row.meta}>
            <span style={row.branch}>
              <Codicon name={entry.isDetached ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', marginRight: '3px', opacity: 0.6 }} />
              {branchLabel}
            </span>
            {entry.isPrunable && (
              <span style={row.prunableBadge}>prunable</span>
            )}
          </span>
        </div>
        {hovered && !entry.isMain && (
          <div style={row.actions}>
            {!entry.isInWorkspace && (
              <button
                style={row.btn}
                title="Add Folder to Workspace"
                onClick={e => { e.stopPropagation(); onAddToWorkspace(entry.path); }}
              >
                <Codicon name="add" />
              </button>
            )}
            {entry.isInWorkspace && (
              <button
                style={row.btn}
                title="Reveal in Explorer"
                onClick={e => { e.stopPropagation(); onOpenInExplorer(repoId, entry.path); }}
              >
                <Codicon name="folder-opened" />
              </button>
            )}
            <button
              style={row.btn}
              title="Open in New Window"
              onClick={e => { e.stopPropagation(); onOpenInNewWindow(entry.path); }}
            >
              <Codicon name="link-external" />
            </button>
            {entry.isLocked ? (
              <button
                style={row.btn}
                title="Unlock worktree"
                onClick={e => { e.stopPropagation(); onUnlock(repoId, entry.path); }}
              >
                <Codicon name="unlock" />
              </button>
            ) : (
              <button
                style={row.btn}
                title="Lock worktree"
                onClick={e => { e.stopPropagation(); onLock(repoId, entry.path); }}
              >
                <Codicon name="lock" />
              </button>
            )}
            <button
              style={{ ...row.btn, color: 'var(--vscode-errorForeground)' }}
              title="Remove worktree"
              onClick={e => { e.stopPropagation(); onDelete(repoId, entry.path, false); }}
            >
              <Codicon name="trash" />
            </button>
          </div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x} y={ctxMenu.y}
          items={ctxItems(entry)}
          onSelect={id => {
            setCtxMenu(null);
            if (id === 'explorer')        onOpenInExplorer(repoId, entry.path);
            if (id === 'newwindow')       onOpenInNewWindow(entry.path);
            if (id === 'os')              onOpenInOS(entry.path);
            if (id === 'add-to-workspace') onAddToWorkspace(entry.path);
            if (id === 'lock')            onLock(repoId, entry.path);
            if (id === 'unlock')          onUnlock(repoId, entry.path);
            if (id === 'delete')          onDelete(repoId, entry.path, false);
            if (id === 'force-delete')    onDelete(repoId, entry.path, true);
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ── Per-repo section ──────────────────────────────────────────────────────────

function RepoSection({ repo, multiRepo, onDelete, onLock, onUnlock, onPrune, onOpenInExplorer, onOpenInNewWindow, onOpenInOS, onAddToWorkspace, onRequestCreate }: {
  repo: RepoWorktrees;
  multiRepo: boolean;
  onDelete: Props['onDelete'];
  onLock: Props['onLock'];
  onUnlock: Props['onUnlock'];
  onPrune: Props['onPrune'];
  onOpenInExplorer: Props['onOpenInExplorer'];
  onOpenInNewWindow: Props['onOpenInNewWindow'];
  onOpenInOS: Props['onOpenInOS'];
  onAddToWorkspace: Props['onAddToWorkspace'];
  onRequestCreate: Props['onRequestCreate'];
}) {
  const hasPrunable = repo.worktrees.some(w => w.isPrunable);

  return (
    <div style={css.repoSection}>
      {multiRepo && (
        <div style={css.repoHeader(repo.repoColor)}>
          <span style={css.dot(repo.repoColor)} />
          <span style={css.repoName}>{repo.repoName}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '2px' }}>
            {hasPrunable && (
              <button
                style={css.headerBtn}
                title="Prune stale worktrees"
                onClick={() => onPrune(repo.repoId)}
              >
                <Codicon name="git-compare" style={{ fontSize: '12px' }} />
              </button>
            )}
            {!repo.isLinkedWorktree && (
              <button
                style={css.headerBtn}
                title="Add worktree"
                onClick={() => onRequestCreate(repo.repoId)}
              >
                <Codicon name="add" style={{ fontSize: '12px' }} />
              </button>
            )}
          </div>
        </div>
      )}
      {repo.worktrees.length === 0 ? (
        <div style={css.empty}>No worktrees</div>
      ) : (
        repo.worktrees.map(w => (
          <WorktreeRow
            key={w.path}
            entry={w}
            repoId={repo.repoId}
            onDelete={onDelete}
            onLock={onLock}
            onUnlock={onUnlock}
            onOpenInExplorer={onOpenInExplorer}
            onOpenInNewWindow={onOpenInNewWindow}
            onOpenInOS={onOpenInOS}
            onAddToWorkspace={onAddToWorkspace}
          />
        ))
      )}
      {!multiRepo && (hasPrunable || !repo.isLinkedWorktree) && (
        <div style={css.singleRepoActions}>
          {hasPrunable && (
            <button style={css.actionBtn} onClick={() => onPrune(repo.repoId)}>
              <Codicon name="git-compare" style={{ marginRight: '4px', fontSize: '12px' }} />
              Prune stale
            </button>
          )}
          {!repo.isLinkedWorktree && (
            <button style={css.actionBtn} onClick={() => onRequestCreate(repo.repoId)}>
              <Codicon name="add" style={{ marginRight: '4px', fontSize: '12px' }} />
              New Worktree
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function WorktreePanel({
  repos, loading, error, multiRepo,
  onDelete, onLock, onUnlock, onPrune,
  onOpenInExplorer, onOpenInNewWindow, onOpenInOS, onAddToWorkspace, onRequestCreate,
}: Props) {
  if (loading) return <div style={css.empty}>Loading…</div>;
  if (error) return (
    <div style={css.errorRow}>
      <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
      {error}
    </div>
  );

  const allEmpty = repos.every(r => r.worktrees.length === 0);

  return (
    <div style={css.root}>
      {allEmpty ? (
        <div style={css.empty}>No worktrees</div>
      ) : (
        repos.map(repo => (
          <RepoSection
            key={repo.repoId}
            repo={repo}
            multiRepo={multiRepo}
            onDelete={onDelete}
            onLock={onLock}
            onUnlock={onUnlock}
            onPrune={onPrune}
            onOpenInExplorer={onOpenInExplorer}
            onOpenInNewWindow={onOpenInNewWindow}
            onOpenInOS={onOpenInOS}
            onAddToWorkspace={onAddToWorkspace}
            onRequestCreate={onRequestCreate}
          />
        ))
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  root: { display: 'flex', flexDirection: 'column' as const },
  repoSection: { borderBottom: '1px solid var(--vscode-panel-border)' } as React.CSSProperties,
  repoHeader: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', minHeight: '26px',
    background: color + '14', borderBottom: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box',
  }),
  dot: (color: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  repoName: { fontSize: '11px', fontWeight: 'bold' as const, opacity: 0.9, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  headerBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '2px 4px', borderRadius: '3px', display: 'flex', alignItems: 'center',
    color: 'var(--vscode-foreground)', opacity: 0.7,
  } as React.CSSProperties,
  singleRepoActions: {
    display: 'flex', gap: '4px', padding: '6px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  actionBtn: {
    display: 'flex', alignItems: 'center', fontSize: '11px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none', borderRadius: '3px', padding: '3px 8px', cursor: 'pointer',
  } as React.CSSProperties,
  empty: { padding: '16px 12px', fontSize: '12px', opacity: 0.45, textAlign: 'center' as const },
  errorRow: {
    display: 'flex', alignItems: 'flex-start', padding: '4px 8px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
  } as React.CSSProperties,
};

const row = {
  root: { borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)' } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '5px 8px', cursor: 'default', minHeight: '32px',
  } as React.CSSProperties,
  info: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0 },
  name: {
    fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0,
  } as React.CSSProperties,
  nameText: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0, flexShrink: 1,
  } as React.CSSProperties,
  mainBadge: {
    fontSize: '9px', padding: '1px 5px', borderRadius: '3px', flexShrink: 0,
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
    fontWeight: 'normal', letterSpacing: '0.03em',
  } as React.CSSProperties,
  workspaceBadge: {
    fontSize: '9px', padding: '1px 5px', borderRadius: '3px', flexShrink: 0,
    background: 'var(--vscode-statusBarItem-remoteBackground)', color: 'var(--vscode-statusBarItem-remoteForeground)',
    fontWeight: 'normal', letterSpacing: '0.03em', opacity: 0.85,
  } as React.CSSProperties,
  meta: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '1px' } as React.CSSProperties,
  branch: {
    fontSize: '10px', opacity: 0.55, display: 'flex', alignItems: 'center',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  prunableBadge: {
    fontSize: '9px', padding: '0 4px', borderRadius: '3px', flexShrink: 0,
    background: 'var(--vscode-inputValidation-warningBackground)',
    color: 'var(--vscode-inputValidation-warningForeground)',
  } as React.CSSProperties,
  actions: { display: 'flex', gap: '2px', flexShrink: 0 } as React.CSSProperties,
  btn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '2px 4px', borderRadius: '3px', fontSize: '13px',
    display: 'flex', alignItems: 'center', opacity: 0.65,
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
};
