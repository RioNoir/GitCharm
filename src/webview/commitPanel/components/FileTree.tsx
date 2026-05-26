import React, { useState } from 'react';
import type { FileStatus, GitFileStatus } from '../../shared/types';
import type { ViewMode } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';

interface Props {
  repoId: string;
  files: FileStatus[];
  iconTheme?: IconThemeData | null;
  selectedFile: { repoId: string; path: string } | null;
  onSelect: (file: FileStatus) => void;
  onToggleFile: (repoId: string, path: string) => void;
  onSetFiles: (repoId: string, paths: string[], selected: boolean) => void;
  isFileSelected: (repoId: string, path: string) => boolean;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  onContextMenu: (e: React.MouseEvent, file: FileStatus) => void;
  onFolderContextMenu: (e: React.MouseEvent, repoId: string, folderPath: string, files: FileStatus[]) => void;
  onOpenFile: (file: FileStatus) => void;
  onRollback: (files: FileStatus[]) => void;
  onResolveMerge: (file: FileStatus) => void;
  viewMode: ViewMode;
}

const STATUS_COLORS: Record<GitFileStatus, string> = {
  modified:   'var(--vscode-gitDecoration-modifiedResourceForeground)',
  added:      'var(--vscode-gitDecoration-addedResourceForeground)',
  deleted:    'var(--vscode-gitDecoration-deletedResourceForeground)',
  renamed:    'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  copied:     'var(--vscode-gitDecoration-addedResourceForeground)',
  untracked:  'var(--vscode-gitDecoration-untrackedResourceForeground)',
  conflicted: 'var(--vscode-gitDecoration-conflictingResourceForeground)',
};

const STATUS_LETTERS: Record<GitFileStatus, string> = {
  modified: 'M', added: 'A', deleted: 'D',
  renamed: 'R', copied: 'C', untracked: 'U', conflicted: 'C',
};

const ICON_SIZE = 16;

// ── Tree data structure ────────────────────────────────────────────────────

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

// Collapse chains of dirs that contain only one child dir (IntelliJ-style path compacting).
// e.g. app/ → Models/ → Migrations/ becomes "app/Models/Migrations".
function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0] as TreeDir;
      return {
        kind: 'dir' as const,
        name: `${node.name}/${only.name}`,
        path: only.path,
        children: only.children,
      };
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

// ── Checkbox ───────────────────────────────────────────────────────────────

function Checkbox({ checked, indeterminate, onChange, onClick }: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate ?? false;
  }, [indeterminate]);
  return (
    <input ref={ref} type="checkbox" checked={checked}
      onChange={onChange} onClick={onClick} style={styles.checkbox} />
  );
}

// ── Layout constants ───────────────────────────────────────────────────────
// Each row: [BASE_PAD left] [checkbox ~14px] [treeDirInner paddingLeft 2px] [chevron 12px] [gap 4px] [folder icon 16px] ...
// The vertical guide line sits at the horizontal centre of the folder icon of the parent row.
// Centre of folder icon = BASE_PAD + depth*LEVEL_PAD + 14(checkbox) + 2(padding) + 12(chevron) + 4(gap) + 8(half icon) = BASE_PAD + depth*LEVEL_PAD + 40
// We encode this as GUIDE_OFFSET so children's guide div can be placed correctly.

const BASE_PAD  = 20;  // left padding at depth-0
const LEVEL_PAD = 20;  // indent per depth level

// ── Shared sub-props type ──────────────────────────────────────────────────

type SharedProps = Pick<Props,
  'repoId' | 'selectedFile' | 'onSelect' | 'onToggleFile' | 'onSetFiles' |
  'isFileSelected' | 'isCollapsed' | 'toggleCollapsed' | 'onContextMenu' |
  'onFolderContextMenu' | 'onOpenFile' | 'onRollback' | 'onResolveMerge' | 'iconTheme'
>;

// ── Directory node ─────────────────────────────────────────────────────────

function TreeDirNode({ node, depth, ...shared }: { node: TreeDir; depth: number } & SharedProps) {
  const { repoId, isCollapsed, toggleCollapsed, isFileSelected, onSetFiles, onRollback, onFolderContextMenu, iconTheme } = shared;
  const collapseKey = `${repoId}:${node.path}`;
  const open = !isCollapsed(collapseKey);
  const allFiles = collectFiles(node);
  const selectedCount = allFiles.filter(f => isFileSelected(repoId, f.path)).length;
  const allSelected = selectedCount === allFiles.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const [hovered, setHovered] = useState(false);

  return (
    <div>
      <div
        style={{ ...styles.treeDir, paddingLeft: `${BASE_PAD + depth * LEVEL_PAD}px` }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={(e) => { e.preventDefault(); onFolderContextMenu(e, repoId, node.path, allFiles); }}
      >
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={() => onSetFiles(repoId, allFiles.map(f => f.path), !allSelected)}
          onClick={(e) => e.stopPropagation()}
        />
        <div style={styles.treeDirInner} onClick={() => toggleCollapsed(collapseKey)}>
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.folderChevron} />
          <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={ICON_SIZE} />
          <span style={styles.folderName}>{node.name}</span>
          <span style={styles.dirCount}>{allFiles.length}</span>
        </div>
        {hovered && (
          <div style={styles.rowActions}>
            <button
              style={styles.actionBtn}
              title="Rollback all files in folder"
              onClick={(e) => { e.stopPropagation(); onRollback(allFiles); }}
            >
              <Codicon name="discard" />
            </button>
          </div>
        )}
      </div>
      {open && node.children.map((child, i) =>
        child.kind === 'dir'
          ? <TreeDirNode key={i} node={child} depth={depth + 1} {...shared} />
          : <FileRow key={i} file={child.file} depth={depth + 1} {...shared} />
      )}
    </div>
  );
}

// ── Single file row ────────────────────────────────────────────────────────

function FileRow({ file, depth = 0, ...shared }: { file: FileStatus; depth?: number } & SharedProps) {
  const { repoId, selectedFile, onSelect, onToggleFile, isFileSelected, onContextMenu, onOpenFile, onRollback, onResolveMerge, iconTheme } = shared;
  const isSelected = selectedFile?.repoId === file.repoId && selectedFile.path === file.path;
  const checked = isFileSelected(repoId, file.path);
  const color = STATUS_COLORS[file.status] ?? 'var(--vscode-foreground)';
  const letter = STATUS_LETTERS[file.status] ?? 'M';
  const fileName = file.path.split('/').pop() ?? file.path;
  const dir = (() => { const p = file.path.split('/'); return p.length > 1 ? p.slice(0, -1).join('/') : ''; })();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{ ...styles.row(isSelected), paddingLeft: `${BASE_PAD + depth * LEVEL_PAD}px` }}
      onClick={() => onSelect(file)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, file); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={file.path}
    >
      <Checkbox
        checked={checked}
        onChange={() => onToggleFile(repoId, file.path)}
        onClick={(e) => e.stopPropagation()}
      />
      <FileIcon name={fileName} theme={iconTheme} size={ICON_SIZE} />
      <span style={styles.fileName(color)}>{fileName}</span>
      {depth === 0 && dir && <span style={styles.dirPath}>{dir}</span>}
      {hovered ? (
        <div style={styles.rowActions}>
          {file.status === 'conflicted' && (
            <button
              style={{ ...styles.actionBtn, color: 'var(--vscode-gitDecoration-conflictingResourceForeground)' }}
              title="Resolve Conflicts"
              onClick={(e) => { e.stopPropagation(); onResolveMerge(file); }}
            >
              <Codicon name="git-merge" />
            </button>
          )}
          <button
            style={styles.actionBtn}
            title="Open file"
            onClick={(e) => { e.stopPropagation(); onOpenFile(file); }}
          >
            <Codicon name="go-to-file" />
          </button>
          <button
            style={styles.actionBtn}
            title="Rollback"
            onClick={(e) => { e.stopPropagation(); onRollback([file]); }}
          >
            <Codicon name="discard" />
          </button>
        </div>
      ) : (
        <>
          <span style={styles.statusLetter(color)}>{letter}</span>
          {file.staged && <span style={styles.stagedDot} title="Already staged" />}
        </>
      )}
    </div>
  );
}

// ── Public component ───────────────────────────────────────────────────────

export function FileTree({ repoId, files, iconTheme, selectedFile, onSelect, onToggleFile, onSetFiles, isFileSelected, isCollapsed, toggleCollapsed, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge, viewMode }: Props) {
  if (files.length === 0) return null;

  const shared: SharedProps = { repoId, iconTheme, selectedFile, onSelect, onToggleFile, onSetFiles, isFileSelected, isCollapsed, toggleCollapsed, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge };

  if (viewMode === 'tree') {
    const nodes = buildTree(files);
    return (
      <div style={styles.container}>
        {nodes.map((node, i) =>
          node.kind === 'dir'
            ? <TreeDirNode key={i} node={node} depth={0} {...shared} />
            : <FileRow key={i} file={node.file} depth={0} {...shared} />
        )}
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {files.map((file) => (
        <FileRow key={`${file.repoId}-${file.path}`} file={file} depth={0} {...shared} />
      ))}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = {
  container: { display: 'flex', flexDirection: 'column' as const },
  checkbox: { flexShrink: 0, margin: '0 3px 0 0', accentColor: 'var(--vscode-button-background)' } as React.CSSProperties,
  row: (selected: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    paddingRight: '8px',
    cursor: 'pointer',
    background: selected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    borderRadius: '2px',
    minHeight: '22px',
    fontSize: '12px',
    gap: '3px',
  }),
  fileName: (color: string): React.CSSProperties => ({
    color,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  }),
  dirPath: {
    fontSize: '11px',
    opacity: 0.45,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 1,
    maxWidth: '80px',
  },
  statusLetter: (color: string): React.CSSProperties => ({
    fontSize: '10px',
    fontWeight: 'bold',
    color,
    flexShrink: 0,
    width: '12px',
    textAlign: 'center',
    opacity: 0.9,
  }),
  stagedDot: {
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: 'var(--vscode-gitDecoration-addedResourceForeground)',
    flexShrink: 0,
    marginLeft: '1px',
  } as React.CSSProperties,
  treeDir: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '22px',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    paddingRight: '8px',
    gap: '0',
  } as React.CSSProperties,
  treeDirInner: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flex: 1,
    cursor: 'pointer',
    userSelect: 'none' as const,
    paddingLeft: '2px',
  },
  folderChevron: { fontSize: '12px', opacity: 0.7, width: '12px', flexShrink: 0 },
  folderName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  dirCount: { fontSize: '10px', opacity: 0.45, flexShrink: 0 },
  rowActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  actionBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '3px',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    opacity: 0.7,
  } as React.CSSProperties,
};
