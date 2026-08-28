import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { FileStatus, RepoStatus } from '../../shared/types';
import type { RepoMeta } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';

// ── Tree types (mirrors FileTree logic) ──────────────────────────────────────

interface TreeDir { kind: 'dir'; name: string; path: string; children: TreeNode[] }
interface TreeFile { kind: 'file'; name: string; file: FileStatus }
type TreeNode = TreeDir | TreeFile;

function buildTree(files: FileStatus[]): TreeNode[] {
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

function collectFiles(node: TreeDir): FileStatus[] {
  const result: FileStatus[] = [];
  for (const child of node.children) {
    if (child.kind === 'file') result.push(child.file);
    else result.push(...collectFiles(child));
  }
  return result;
}

// ── Checkbox ──────────────────────────────────────────────────────────────────

function Checkbox({ checked, indeterminate, onChange, onClick }: {
  checked: boolean; indeterminate?: boolean; onChange: () => void; onClick?: (e: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate ?? false; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} onClick={onClick} style={s.checkbox} />;
}

// ── Dir node ──────────────────────────────────────────────────────────────────

function DirNode({ node, depth, selected, onToggle, onSetFiles }: {
  node: TreeDir; depth: number;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onSetFiles: (paths: string[], value: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const allFiles = collectFiles(node);
  const allPaths = allFiles.map(f => f.path);
  const selCount = allPaths.filter(p => selected.has(p)).length;
  const allSel = selCount === allPaths.length;
  const someSel = selCount > 0 && !allSel;

  return (
    <div>
      <div style={{ ...s.dirRow, paddingLeft: `${6 + depth * 16}px` }}>
        <Checkbox
          checked={allSel} indeterminate={someSel}
          onChange={() => onSetFiles(allPaths, !allSel)}
          onClick={e => e.stopPropagation()}
        />
        <div style={s.dirInner} onClick={() => setOpen(o => !o)}>
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={s.chevron} />
          <Codicon name={open ? 'folder-opened' : 'folder'} style={s.folderIcon} />
          <span style={s.dirName}>{node.name}</span>
          <span style={s.count}>{allFiles.length}</span>
        </div>
      </div>
      {open && node.children.map((child, i) =>
        child.kind === 'dir'
          ? <DirNode key={i} node={child} depth={depth + 1} selected={selected} onToggle={onToggle} onSetFiles={onSetFiles} />
          : <FileNode key={i} file={child.file} depth={depth + 1} selected={selected} onToggle={onToggle} />
      )}
    </div>
  );
}

// ── File node ─────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  modified:   'var(--vscode-gitDecoration-modifiedResourceForeground)',
  added:      'var(--vscode-gitDecoration-addedResourceForeground)',
  deleted:    'var(--vscode-gitDecoration-deletedResourceForeground)',
  renamed:    'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  untracked:  'var(--vscode-gitDecoration-untrackedResourceForeground)',
  conflicted: 'var(--vscode-gitDecoration-conflictingResourceForeground)',
};
const STATUS_LETTERS: Record<string, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?', conflicted: 'C',
};

function FileNode({ file, depth, selected, onToggle }: {
  file: FileStatus; depth: number; selected: Set<string>; onToggle: (path: string) => void;
}) {
  const checked = selected.has(file.path);
  const color = STATUS_COLORS[file.status] ?? 'var(--vscode-foreground)';
  const letter = STATUS_LETTERS[file.status] ?? 'M';
  const fileName = file.path.split('/').pop() ?? file.path;
  return (
    <div
      style={{ ...s.fileRow, paddingLeft: `${6 + depth * 16}px` }}
      onClick={() => onToggle(file.path)}
    >
      <Checkbox checked={checked} onChange={() => onToggle(file.path)} onClick={e => e.stopPropagation()} />
      <Codicon name="file" style={{ fontSize: '13px', opacity: 0.7, flexShrink: 0 }} />
      <span style={{ ...s.fileName, color }}>{fileName}</span>
      <span style={s.statusLetter(color)}>{letter}</span>
    </div>
  );
}

// ── Repo section ──────────────────────────────────────────────────────────────

function RepoSection({ repoStatus, repoName, repoColor, multiRepo, selected, onToggle, onSetFiles }: {
  repoStatus: RepoStatus; repoName: string; repoColor: string; multiRepo: boolean;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onSetFiles: (paths: string[], value: boolean) => void;
}) {
  const fileMap = new Map<string, FileStatus>();
  for (const f of repoStatus.unstagedFiles) fileMap.set(f.path, f);
  for (const f of repoStatus.stagedFiles) fileMap.set(f.path, f);
  const allFiles = Array.from(fileMap.values());
  const allPaths = allFiles.map(f => f.path);
  const selCount = allPaths.filter(p => selected.has(p)).length;
  const allSel = selCount === allPaths.length && allPaths.length > 0;
  const someSel = selCount > 0 && !allSel;

  const nodes = buildTree(allFiles);

  return (
    <div style={s.repoSection}>
      {multiRepo && (
        <div style={s.repoHeader}>
          <Checkbox
            checked={allSel} indeterminate={someSel}
            onChange={() => onSetFiles(allPaths, !allSel)}
            onClick={e => e.stopPropagation()}
          />
          <span style={s.repoDot(repoColor)} />
          <span style={s.repoName}>{repoName}</span>
          <span style={s.count}>{selCount}/{allPaths.length}</span>
        </div>
      )}
      <div>
        {nodes.map((node, i) =>
          node.kind === 'dir'
            ? <DirNode key={i} node={node} depth={multiRepo ? 1 : 0} selected={selected} onToggle={onToggle} onSetFiles={onSetFiles} />
            : <FileNode key={i} file={node.file} depth={multiRepo ? 1 : 0} selected={selected} onToggle={onToggle} />
        )}
      </div>
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

interface Props {
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
  onConfirm: (files: Array<{ repoId: string; path: string }>) => void;
  onClose: () => void;
}

export function RollbackModal({ repos, repoMetas, onConfirm, onClose }: Props) {
  const metaMap = new Map(repoMetas.map(m => [m.id, m]));
  const multiRepo = repos.length > 1;

  // selected: repoId → Set<path>
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() => {
    const init: Record<string, Set<string>> = {};
    for (const r of repos) {
      const fileMap = new Map<string, FileStatus>();
      for (const f of r.unstagedFiles) fileMap.set(f.path, f);
      for (const f of r.stagedFiles) fileMap.set(f.path, f);
      init[r.repoId] = new Set(fileMap.keys());
    }
    return init;
  });

  const toggle = useCallback((repoId: string, path: string) => {
    setSelected(prev => {
      const next = new Set(prev[repoId] ?? []);
      if (next.has(path)) next.delete(path); else next.add(path);
      return { ...prev, [repoId]: next };
    });
  }, []);

  const setFiles = useCallback((repoId: string, paths: string[], value: boolean) => {
    setSelected(prev => {
      const next = new Set(prev[repoId] ?? []);
      for (const p of paths) { if (value) next.add(p); else next.delete(p); }
      return { ...prev, [repoId]: next };
    });
  }, []);

  const totalSelected = Object.values(selected).reduce((n, s) => n + s.size, 0);

  const handleConfirm = () => {
    const files: Array<{ repoId: string; path: string }> = [];
    for (const [repoId, paths] of Object.entries(selected)) {
      for (const path of paths) files.push({ repoId, path });
    }
    if (files.length > 0) onConfirm(files);
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={s.header}>
          <Codicon name="discard" style={{ fontSize: '14px', opacity: 0.8 }} />
          <span style={s.title}>Rollback changes</span>
          <button style={s.closeBtn} onClick={onClose}>
            <Codicon name="close" />
          </button>
        </div>

        <div style={s.subtitle}>
          Select the files to discard. This action cannot be undone.
        </div>

        {/* Tree */}
        <div style={s.tree}>
          {repos.map(r => {
            const meta = metaMap.get(r.repoId);
            const repoName = meta?.name ?? r.repoId.split('/').pop() ?? r.repoId;
            const repoColor = meta?.color ?? '#4ec9b0';
            return (
              <RepoSection
                key={r.repoId}
                repoStatus={r}
                repoName={repoName}
                repoColor={repoColor}
                multiRepo={multiRepo}
                selected={selected[r.repoId] ?? new Set()}
                onToggle={(path) => toggle(r.repoId, path)}
                onSetFiles={(paths, value) => setFiles(r.repoId, paths, value)}
              />
            );
          })}
        </div>

        {/* Footer */}
        <div style={s.footer}>
          <span style={s.footerCount}>
            {totalSelected} file{totalSelected !== 1 ? 's' : ''} selected
          </span>
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{ ...s.confirmBtn, opacity: totalSelected === 0 ? 0.4 : 1 }}
            disabled={totalSelected === 0}
            onClick={handleConfirm}
          >
            <Codicon name="discard" style={{ marginRight: '5px' }} />
            Rollback {totalSelected > 0 ? totalSelected : ''} file{totalSelected !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    zIndex: 9000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modal: {
    background: 'var(--vscode-editor-background)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    width: '420px',
    maxWidth: '90vw',
    maxHeight: '70vh',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontWeight: 'bold' as const,
    fontSize: '13px',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    padding: '2px 4px',
    opacity: 0.6,
    fontSize: '14px',
    display: 'flex',
    alignItems: 'center',
  } as React.CSSProperties,
  subtitle: {
    padding: '7px 12px',
    fontSize: '11px',
    opacity: 0.55,
    borderBottom: '1px solid var(--vscode-panel-border)',
    flexShrink: 0,
    color: 'var(--vscode-errorForeground)',
  },
  tree: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '4px 0',
  },
  repoSection: {
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  repoHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 8px',
    background: 'var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.15))',
    fontSize: '11px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } as React.CSSProperties,
  repoDot: (color: string): React.CSSProperties => ({
    width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0,
  }),
  repoName: { flex: 1 },
  count: { fontSize: '10px', opacity: 0.45, flexShrink: 0 },
  dirRow: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '22px',
    paddingRight: '8px',
    gap: '0',
    fontSize: '12px',
  } as React.CSSProperties,
  dirInner: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flex: 1,
    cursor: 'pointer',
    userSelect: 'none' as const,
    paddingLeft: '2px',
  },
  chevron: { fontSize: '12px', opacity: 0.7, width: '12px', flexShrink: 0 },
  folderIcon: { fontSize: '14px', flexShrink: 0, color: 'var(--vscode-symbolIcon-folderForeground, #dcb67a)' },
  dirName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  fileRow: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '22px',
    paddingRight: '8px',
    gap: '3px',
    cursor: 'pointer',
    fontSize: '12px',
  } as React.CSSProperties,
  fileName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  statusLetter: (color: string): React.CSSProperties => ({
    fontSize: '10px', fontWeight: 'bold', color, flexShrink: 0, width: '12px', textAlign: 'center', opacity: 0.9,
  }),
  checkbox: { flexShrink: 0, margin: '0 3px 0 0' } as React.CSSProperties,
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    borderTop: '1px solid var(--vscode-panel-border)',
    flexShrink: 0,
  },
  footerCount: { flex: 1, fontSize: '11px', opacity: 0.5 },
  cancelBtn: {
    background: 'transparent',
    border: '1px solid var(--vscode-button-border, var(--vscode-panel-border))',
    color: 'var(--vscode-foreground)',
    borderRadius: '3px',
    padding: '4px 12px',
    cursor: 'pointer',
    fontSize: '12px',
  } as React.CSSProperties,
  confirmBtn: {
    background: 'var(--vscode-errorForeground)',
    border: 'none',
    color: '#fff',
    borderRadius: '3px',
    padding: '4px 12px',
    cursor: 'pointer',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    fontWeight: 'bold' as const,
  } as React.CSSProperties,
};
