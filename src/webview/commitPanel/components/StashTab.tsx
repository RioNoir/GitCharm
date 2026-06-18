import React, { useState } from 'react';
import type { StashEntry } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import type { ViewMode } from '../store/commitStore';
import { useCommitStore } from '../store/commitStore';

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

const ICON_SIZE = 16;
const BASE_PAD  = 20;
const LEVEL_PAD = 20;

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

// ── Tree data structure ───────────────────────────────────────────────────────

type StashFile = StashEntry['files'][number];
interface TreeDir  { kind: 'dir';  name: string; path: string; children: TreeNode[] }
interface TreeFile { kind: 'file'; name: string; file: StashFile }
type TreeNode = TreeDir | TreeFile;

function buildTree(files: StashFile[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c): c is TreeDir => c.kind === 'dir' && c.name === part);
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  return collapseSingleChildDirs(root.children);
}

function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0] as TreeDir;
      return { kind: 'dir' as const, name: `${node.name}/${only.name}`, path: only.path, children: only.children };
    }
    return { ...node, children };
  });
}

function countFiles(node: TreeDir): number {
  let c = 0;
  for (const ch of node.children) {
    if (ch.kind === 'file') c++;
    else c += countFiles(ch);
  }
  return c;
}

// ── File row ──────────────────────────────────────────────────────────────────

function FileRow({ file, repoId, entry, depth = 0, onOpenFileDiff }: {
  file: StashFile;
  repoId: string;
  entry: StashEntry;
  depth?: number;
  onOpenFileDiff: Props['onOpenFileDiff'];
}) {
  const [hovered, setHovered] = useState(false);
  const iconTheme = useCommitStore(s => s.iconTheme);
  const fname = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
  const color = STATUS_COLORS[file.status] ?? 'var(--vscode-foreground)';
  const letter = STATUS_LETTERS[file.status] ?? 'M';
  const paddingLeft = BASE_PAD + depth * LEVEL_PAD;

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', minHeight: '22px', fontSize: '12px',
        gap: '3px', paddingLeft, paddingRight: '8px', cursor: 'pointer', borderRadius: '2px',
        background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent',
      }}
      onClick={() => onOpenFileDiff(repoId, entry.ref, file.path)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${file.path} — click to open diff`}
    >
      <FileIcon name={fname} theme={iconTheme} size={ICON_SIZE} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <span style={{ color, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{fname}</span>
        {depth === 0 && dir && (
          <span style={{ fontSize: '11px', opacity: 0.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>{dir}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <span style={{ fontSize: '11px', fontWeight: 'bold', color, width: '14px', textAlign: 'center', opacity: 0.9, marginLeft: '6px' }}>{letter}</span>
      </div>
    </div>
  );
}

// ── Tree directory node ───────────────────────────────────────────────────────

function TreeDirNode({ node, depth, repoId, entry, onOpenFileDiff, openDirs, toggleDir }: {
  node: TreeDir;
  depth: number;
  repoId: string;
  entry: StashEntry;
  onOpenFileDiff: Props['onOpenFileDiff'];
  openDirs: Set<string>;
  toggleDir: (path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const iconTheme = useCommitStore(s => s.iconTheme);
  const open = openDirs.has(node.path);
  const paddingLeft = BASE_PAD + depth * LEVEL_PAD;
  const fc = countFiles(node);

  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'center', minHeight: '22px', fontSize: '12px',
          paddingLeft, paddingRight: '8px', gap: '0', borderRadius: '2px',
          background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent',
          color: 'var(--vscode-foreground)',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => toggleDir(node.path)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1, cursor: 'pointer', userSelect: 'none', paddingLeft: '2px' }}>
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '12px', opacity: 0.7, width: '12px', flexShrink: 0 }} />
          <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={ICON_SIZE} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        </div>
        <span style={{ fontSize: '11px', opacity: 0.45, flexShrink: 0, marginLeft: '6px', width: '14px', textAlign: 'center' }}>{fc}</span>
      </div>
      {open && node.children.map(child =>
        child.kind === 'dir'
          ? <TreeDirNode key={child.path} node={child} depth={depth + 1} repoId={repoId} entry={entry} onOpenFileDiff={onOpenFileDiff} openDirs={openDirs} toggleDir={toggleDir} />
          : <FileRow key={child.file.path} file={child.file} repoId={repoId} entry={entry} depth={depth + 1} onOpenFileDiff={onOpenFileDiff} />
      )}
    </div>
  );
}

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
  // Per-directory open state (tree mode)
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());

  const treeNodes = viewMode === 'tree' ? buildTree(entry.files) : null;

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
    <div style={{ ...row.root, ...(isLast ? { borderBottom: 'none' } : {}) }}>
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
            {entry.branch && <span style={row.branchBadge}><Codicon name="git-branch" style={{ fontSize: '9px', opacity: 0.8, flexShrink: 0 }} />{entry.branch}</span>}
          </span>
          <span style={row.meta}>
            {formatDate(entry.date)}
            {' · '}{entry.files.length} {entry.files.length === 1 ? 'file' : 'files'}
            {(() => {
              const a = entry.files.reduce((s, f) => s + (f.added   ?? 0), 0);
              const r = entry.files.reduce((s, f) => s + (f.removed ?? 0), 0);
              return (a > 0 || r > 0) ? <>{' '}<span style={row.statAdd}>+{a}</span>{' '}<span style={row.statDel}>-{r}</span></> : null;
            })()}
          </span>
        </div>
        {hovered && (
          <div style={row.actions}>
            <button style={row.btn} title="Pop (apply and drop)" onClick={e => { e.stopPropagation(); onPop(repoId, entry.ref); }}>
              <Codicon name="git-stash-pop" />
            </button>
            <button style={{ ...row.btn, opacity: 0.5 }} title="Apply (keep stash)" onClick={e => { e.stopPropagation(); onApply(repoId, entry.ref); }}>
              <Codicon name="git-stash-apply" />
            </button>
            <button style={{ ...row.btn, color: 'var(--vscode-errorForeground)' }} title="Drop stash" onClick={e => { e.stopPropagation(); onDrop(repoId, entry.ref); }}>
              <Codicon name="trash" />
            </button>
          </div>
        )}
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={row.fileList}>
          {entry.files.length === 0 ? (
            <div style={row.emptyFiles}>No files</div>
          ) : viewMode === 'tree' && treeNodes ? (
            treeNodes.map(node =>
              node.kind === 'dir'
                ? <TreeDirNode key={node.path} node={node} depth={0} repoId={repoId} entry={entry} onOpenFileDiff={onOpenFileDiff} openDirs={openDirs} toggleDir={toggleDir} />
                : <FileRow key={node.file.path} file={node.file} repoId={repoId} entry={entry} depth={0} onOpenFileDiff={onOpenFileDiff} />
            )
          ) : (
            entry.files.map(f => (
              <FileRow key={f.path} file={f} repoId={repoId} entry={entry} onOpenFileDiff={onOpenFileDiff} />
            ))
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

export function StashTab({
  repoId, repoName, repoColor, multiRepo, singleRepo = false,
  worktreeBranch, mainRepoName,
  stashes, loading, error, viewMode,
  onApply, onPop, onDrop, onRename, onRequestList, onOpenFileDiff,
  expandAll = false,
}: Props) {
  return (
    <div style={css.root}>
      {multiRepo && (
        <div style={css.repoHeader(repoColor, singleRepo)}>
          {singleRepo
            ? <Codicon name="repo" style={css.repoIcon} />
            : <span style={css.dot(repoColor)} />
          }
          <span style={css.repoName}>{worktreeBranch ? mainRepoName ?? repoName : repoName}</span>
          {worktreeBranch && (
            <span style={css.worktreeBadge}>
              <Codicon name="worktree" style={{ fontSize: '11px', marginRight: '3px' }} />
              {worktreeBranch}
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
      {loading ? (
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
            isLast={i === stashes.length - 1}
          />
        ))
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
    background: singleRepo ? 'color-mix(in srgb, var(--vscode-foreground) 7%, transparent)' : color + '14',
    borderBottom: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box',
  }),
  dot: (color: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  repoIcon: { fontSize: '13px', opacity: 0.7, flexShrink: 0 } as React.CSSProperties,
  repoName: { fontSize: '11px', fontWeight: 'bold' as const, opacity: 0.9, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  worktreeBadge: { display: 'flex', alignItems: 'center', fontSize: '11px', fontWeight: 'normal' as const, letterSpacing: '0.02em', color: 'var(--vscode-badge-foreground)', background: 'var(--vscode-badge-background)', borderRadius: '3px', padding: '1px 5px 1px 4px', flexShrink: 0, opacity: 0.75 } as React.CSSProperties,
  errorRow: {
    display: 'flex', alignItems: 'flex-start', padding: '4px 8px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
  } as React.CSSProperties,
  empty: { padding: '16px 12px', fontSize: '12px', opacity: 0.45, textAlign: 'center' as const },
};

const row = {
  root: { borderBottom: '1px solid var(--vscode-panel-border)' } as React.CSSProperties,
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
  nameText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 } as React.CSSProperties,
  branchBadge: {
    fontSize: '9px', padding: '1px 5px', borderRadius: '3px', flexShrink: 0,
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
    fontWeight: 'normal', letterSpacing: '0.03em',
    display: 'inline-flex', alignItems: 'center', gap: '3px',
  } as React.CSSProperties,
  meta: { fontSize: '10px', opacity: 0.5, marginTop: '2px', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' } as React.CSSProperties,
  statAdd: { color: 'var(--vscode-gitDecoration-addedResourceForeground)', fontSize: '10px', opacity: 1 },
  statDel: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)', fontSize: '10px', opacity: 1 },
  actions: { display: 'flex', gap: '2px', flexShrink: 0 } as React.CSSProperties,
  btn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '2px 4px', borderRadius: '3px', fontSize: '13px',
    display: 'flex', alignItems: 'center', opacity: 0.65,
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  fileList: {
    display: 'flex', flexDirection: 'column' as const,
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
  } as React.CSSProperties,
  emptyFiles: { padding: '6px 24px', fontSize: '11px', opacity: 0.4 },
};
