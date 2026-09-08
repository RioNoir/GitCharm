import React, { useMemo, useState } from 'react';
import type { ChangedFile, IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';

interface Props {
  files: ChangedFile[];
  iconTheme: IconThemeData | null;
  onOpenFile: (file: ChangedFile) => void;
}

const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

const STATUS_COLORS: Record<string, string> = {
  M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
  A: 'var(--vscode-gitDecoration-addedResourceForeground)',
  D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
};

function statusColorFor(status: ChangedFile['status']): string {
  return STATUS_COLORS[STATUS_LETTER[status]] ?? 'var(--vscode-foreground)';
}

/* ─── Tree builder — ported from src/webview/gitLog/components/CommitDetail.tsx ─── */

interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  file: ChangedFile | null;
  fileCount: number;
}

function makeNode(name: string, fullPath: string): TreeNode {
  return { name, fullPath, children: new Map(), file: null, fileCount: 0 };
}

function buildTree(files: ChangedFile[]): TreeNode {
  const root = makeNode('', '');
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      if (!node.children.has(part)) node.children.set(part, makeNode(part, accumulated));
      node = node.children.get(part)!;
      if (i === parts.length - 1) node.file = f;
    }
  }
  computeFileCounts(root);
  return root;
}

function computeFileCounts(node: TreeNode): number {
  if (node.file) { node.fileCount = 1; return 1; }
  let count = 0;
  for (const child of node.children.values()) count += computeFileCounts(child);
  node.fileCount = count;
  return count;
}

function collapseSingleChildDirs(node: TreeNode): TreeNode {
  if (node.file) return node;
  if (node.children.size === 1) {
    const [, child] = node.children.entries().next().value as [string, TreeNode];
    if (!child.file) {
      const collapsed = collapseSingleChildDirs(child);
      const joinedName = node.name ? `${node.name}/${collapsed.name}` : collapsed.name;
      return { ...collapsed, name: joinedName };
    }
  }
  const newChildren = new Map<string, TreeNode>();
  for (const [k, v] of node.children) newChildren.set(k, collapseSingleChildDirs(v));
  return { ...node, children: newChildren };
}

/* ─── Rows ────────────────────────────────────────────────────────────────── */

function FlatFileRow({ file, iconTheme, onOpen }: { file: ChangedFile; iconTheme: IconThemeData | null; onOpen: () => void }) {
  const [hovered, setHovered] = useState(false);
  const color = statusColorFor(file.status);
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  const fileName = file.path.includes('/') ? file.path.slice(file.path.lastIndexOf('/') + 1) : file.path;
  return (
    <div
      style={css.row(hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onOpen}
      title={file.path}
    >
      <div style={{ width: 4, flexShrink: 0 }} />
      <FileIcon name={fileName} theme={iconTheme} size={14} style={css.fileIconBase} />
      <span style={css.fileName(color)}>{fileName}</span>
      {dir && <span style={css.dirPath}>{dir}</span>}
      {(file.additions !== undefined || file.deletions !== undefined) && (
        <span style={css.lineStats}>
          {file.additions !== undefined && <span style={css.additions}>+{file.additions}</span>}
          {file.deletions !== undefined && <span style={css.deletions}>-{file.deletions}</span>}
        </span>
      )}
      <span style={css.statusLetter(color)}>{STATUS_LETTER[file.status]}</span>
    </div>
  );
}

function TreeDir({ node, depth, allExpanded, iconTheme, onOpen }: {
  node: TreeNode;
  depth: number;
  allExpanded: boolean | null;
  iconTheme: IconThemeData | null;
  onOpen: (file: ChangedFile) => void;
}) {
  const [localOpen, setLocalOpen] = useState(true);
  const [hovered, setHovered] = useState(false);
  const open = allExpanded !== null ? allExpanded : localOpen;
  const indent = depth * 14;

  if (node.file) {
    const color = statusColorFor(node.file.status);
    return (
      <div
        style={css.row(hovered)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => onOpen(node.file!)}
        title={node.file.path}
      >
        <div style={{ width: indent + 18, flexShrink: 0 }} />
        <FileIcon name={node.name} theme={iconTheme} size={14} style={css.fileIconBase} />
        <span style={css.fileName(color)}>{node.name}</span>
        {(node.file.additions !== undefined || node.file.deletions !== undefined) && (
          <span style={css.lineStats}>
            {node.file.additions !== undefined && <span style={css.additions}>+{node.file.additions}</span>}
            {node.file.deletions !== undefined && <span style={css.deletions}>-{node.file.deletions}</span>}
          </span>
        )}
        <span style={css.statusLetter(color)}>{STATUS_LETTER[node.file.status]}</span>
      </div>
    );
  }

  const folderBaseName = node.name.includes('/') ? node.name.split('/').pop()! : node.name;

  return (
    <>
      <div
        style={css.dirRow(hovered)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => { if (allExpanded === null) setLocalOpen(o => !o); }}
      >
        <div style={{ width: indent, flexShrink: 0 }} />
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={css.chevron} />
        <FileIcon name={folderBaseName} isFolder isOpen={open} theme={iconTheme} size={16} style={css.folderIconBase} />
        <span style={css.dirName}>{node.name}</span>
        <span style={css.fileCountBadge}>{node.fileCount}</span>
      </div>
      {open && Array.from(node.children.values())
        .sort((a, b) => {
          if (!a.file && b.file) return -1;
          if (a.file && !b.file) return 1;
          return a.name.localeCompare(b.name);
        })
        .map(child => (
          <TreeDir key={child.fullPath} node={child} depth={depth + 1} allExpanded={allExpanded} iconTheme={iconTheme} onOpen={onOpen} />
        ))
      }
    </>
  );
}

/* ─── Public component ───────────────────────────────────────────────────── */

export function FileTreeView({ files, iconTheme, onOpenFile }: Props) {
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);

  const tree = useMemo(() => {
    if (files.length === 0) return null;
    return collapseSingleChildDirs(buildTree(files));
  }, [files]);

  if (files.length === 0) return <div style={css.empty}>No changed files.</div>;

  return (
    <div style={css.wrapper}>
      <div style={css.toolbar}>
        <span style={css.fileCountLabel}>{files.length} file{files.length === 1 ? '' : 's'} changed</span>
        <div style={{ flex: 1 }} />
        {viewMode === 'tree' && (
          <>
            <button style={css.toolbarBtn(false)} onClick={() => setAllExpanded(true)} title="Expand all">
              <Codicon name="expand-all" style={{ fontSize: '14px' }} />
            </button>
            <button style={css.toolbarBtn(false)} onClick={() => setAllExpanded(false)} title="Collapse all">
              <Codicon name="collapse-all" style={{ fontSize: '14px' }} />
            </button>
          </>
        )}
        <button style={css.toolbarBtn(viewMode === 'tree')} onClick={() => setViewMode('tree')} title="Tree view">
          <Codicon name="list-tree" style={{ fontSize: '14px' }} />
        </button>
        <button style={css.toolbarBtn(viewMode === 'flat')} onClick={() => setViewMode('flat')} title="Flat view">
          <Codicon name="list-flat" style={{ fontSize: '14px' }} />
        </button>
      </div>
      <div style={css.root}>
        {viewMode === 'flat'
          ? files.map(f => <FlatFileRow key={f.path} file={f} iconTheme={iconTheme} onOpen={() => onOpenFile(f)} />)
          : tree && Array.from(tree.children.values())
              .sort((a, b) => {
                if (!a.file && b.file) return -1;
                if (a.file && !b.file) return 1;
                return a.name.localeCompare(b.name);
              })
              .map(child => (
                <TreeDir key={child.fullPath} node={child} depth={0} allExpanded={allExpanded} iconTheme={iconTheme} onOpen={onOpenFile} />
              ))
        }
      </div>
    </div>
  );
}

const css = {
  wrapper: { display: 'flex', flexDirection: 'column' as const, gap: '8px' },
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
  toolbar: { display: 'flex', alignItems: 'center', gap: '6px' } as React.CSSProperties,
  fileCountLabel: { fontSize: '12px', opacity: 0.6 },
  toolbarBtn: (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '26px',
    background: active ? 'var(--vscode-toolbar-activeBackground)' : 'transparent',
    border: '1px solid transparent', borderColor: active ? 'var(--vscode-panel-border)' : 'transparent',
    borderRadius: '4px', cursor: 'pointer', color: 'inherit', opacity: 0.9,
  }),
  root: {
    display: 'flex', flexDirection: 'column' as const, border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px', overflow: 'hidden', fontSize: '12px',
  } as React.CSSProperties,
  row: (hovered: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '4px', paddingRight: '10px', paddingTop: '2px', paddingBottom: '2px',
    cursor: 'pointer', minHeight: '24px', userSelect: 'none' as const,
    background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent',
  }),
  dirRow: (hovered: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '3px', padding: '2px 10px 2px 0', cursor: 'pointer',
    minHeight: '24px', userSelect: 'none' as const,
    background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent',
  }),
  chevron: { fontSize: '10px', opacity: 0.5, flexShrink: 0, width: '14px' } as React.CSSProperties,
  fileIconBase: { opacity: 0.9 } as React.CSSProperties,
  folderIconBase: { color: 'var(--vscode-symbolIcon-folderForeground, #dcb67a)' } as React.CSSProperties,
  dirName: {
    fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, opacity: 0.85, flex: 1,
  } as React.CSSProperties,
  fileCountBadge: {
    fontSize: '10px', opacity: 0.5, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px', padding: '0 5px', minWidth: '16px', textAlign: 'center' as const, flexShrink: 0,
  } as React.CSSProperties,
  statusLetter: (color: string): React.CSSProperties => ({ fontSize: '11px', fontWeight: 'bold' as const, color, minWidth: '14px', flexShrink: 0, textAlign: 'right' as const }),
  fileName: (color: string): React.CSSProperties => ({
    color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1,
  }),
  dirPath: {
    fontSize: '10px', opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: '160px',
  } as React.CSSProperties,
  lineStats: {
    display: 'flex', gap: '3px', flexShrink: 0, fontSize: '10px', fontFamily: 'var(--vscode-editor-font-family, monospace)',
  } as React.CSSProperties,
  additions: { color: 'var(--vscode-gitDecoration-addedResourceForeground)' } as React.CSSProperties,
  deletions: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)' } as React.CSSProperties,
};
