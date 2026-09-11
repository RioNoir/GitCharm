import React, { useState } from 'react';
import type { IconThemeData } from '../../host/types/messages';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { TreeGuideLines, useTreeGuideHoverStyle } from './TreeGuides';

/**
 * Shared file-tree renderer used everywhere a set of changed files needs to be shown nested by
 * folder (or flat) with a status letter and +/- line stats — Shelf, Stash, Git Log commit detail,
 * and the PR "Changed Files" tab. NOT used by the Commit Panel's own Changes/Commit tab
 * (`FileTree.tsx`), which has its own checkboxes and staging interactions and stays separate.
 */

export interface GenericTreeFile {
  path: string;
  status: string;
  added?: number;
  removed?: number;
}

interface TreeDir<F extends GenericTreeFile> { kind: 'dir'; name: string; path: string; children: TreeNode<F>[] }
interface TreeFile<F extends GenericTreeFile> { kind: 'file'; name: string; file: F }
type TreeNode<F extends GenericTreeFile> = TreeDir<F> | TreeFile<F>;

function buildTree<F extends GenericTreeFile>(files: F[]): TreeNode<F>[] {
  const root: TreeDir<F> = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c): c is TreeDir<F> => c.kind === 'dir' && c.name === part);
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  return sortNodes(collapseSingleChildDirs(root.children));
}

// Collapse chains of dirs that contain only one child dir (IntelliJ-style path compacting).
// e.g. app/ → Models/ → Migrations/ becomes "app/Models/Migrations".
function collapseSingleChildDirs<F extends GenericTreeFile>(nodes: TreeNode<F>[]): TreeNode<F>[] {
  return nodes.map(node => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0] as TreeDir<F>;
      return { kind: 'dir' as const, name: `${node.name}/${only.name}`, path: only.path, children: only.children };
    }
    return { ...node, children };
  });
}

// Directories before files, each group alphabetical — matches VS Code's own Explorer ordering.
function sortNodes<F extends GenericTreeFile>(nodes: TreeNode<F>[]): TreeNode<F>[] {
  return nodes
    .map(node => node.kind === 'dir' ? { ...node, children: sortNodes(node.children) } : node)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function collectFiles<F extends GenericTreeFile>(node: TreeDir<F>): F[] {
  const result: F[] = [];
  for (const child of node.children) {
    if (child.kind === 'file') result.push(child.file);
    else result.push(...collectFiles(child));
  }
  return result;
}

// ── Layout constants ────────────────────────────────────────────────────────
// Row: [BASE_PAD + depth*LEVEL_PAD] [dirInner paddingLeft 2px] [chevron 12px] [gap 4px] [icon 16px] [name]
// File rows mirror that leading layout (an invisible spacer stands in for the chevron) so a file
// icon lines up exactly under a directory icon at the same depth — a file nested one level
// inside a folder sits further right only because its depth is one greater (an extra LEVEL_PAD),
// same as in the Commit Panel's own Changes tree (FileTree.tsx), not because of any per-file offset.
const DEFAULT_BASE_PAD = 14;
const LEVEL_PAD = 8;
const ICON_SIZE = 16;
const CHEVRON_WIDTH = 12;
const INNER_GAP = 4;
const DIR_INNER_PAD = 2;
const ROW_GAP = 3;
// Centre of the expand/collapse chevron relative to row start = DIR_INNER_PAD + half chevron
// width(6) = 8 — matches VS Code's own indent guides, which sit under the twisty.
const GUIDE_OFFSET = DIR_INNER_PAD + CHEVRON_WIDTH / 2;
// File rows have no chevron, so a spacer stands in for [DIR_INNER_PAD + chevron + INNER_GAP] —
// the same distance a dir row's icon sits from its own row start. Its outer row uses `gap:
// ROW_GAP` (styles.row) between flex children (unlike dir rows, which use `gap: 0` and push all
// spacing inside `dirInner`), and that gap applies between this spacer and the icon too — so the
// spacer's own width must be shortened by ROW_GAP to compensate, or the file icon would land
// ROW_GAP px further right than the directory icon above it.
const FILE_ICON_SPACER_WIDTH = DIR_INNER_PAD + CHEVRON_WIDTH + INNER_GAP - ROW_GAP;

export interface GenericFileTreeProps<F extends GenericTreeFile> {
  files: F[];
  viewMode: 'tree' | 'flat';
  /** Left padding at depth 0, in px. Defaults to 20. */
  basePad?: number;
  iconTheme?: IconThemeData | null;
  statusColor: (status: string) => string;
  statusLetter: (status: string) => string;
  /** Whether a directory (by its path) is currently expanded. */
  isDirOpen: (dirPath: string) => boolean;
  toggleDir: (dirPath: string) => void;
  onOpenFile: (file: F, e: React.MouseEvent) => void;
  isFileSelected?: (file: F) => boolean;
  /** Highlights a file row as the current right-click context-menu target (when not also selected). */
  isFileContextActive?: (file: F) => boolean;
  onContextMenuFile?: (e: React.MouseEvent, file: F) => void;
  onContextMenuDir?: (e: React.MouseEvent, dirPath: string, files: F[]) => void;
  /** Highlights a directory row as the currently active folder (e.g. context-menu target). */
  isDirContextActive?: (dirPath: string) => boolean;
  /** Extra hover-revealed controls rendered at the right edge of a file row (e.g. "Unshelve this file"). */
  renderFileActions?: (file: F, hovered: boolean) => React.ReactNode;
  /** Extra hover-revealed controls rendered at the right edge of a directory row, before the file count. */
  renderDirActions?: (files: F[], hovered: boolean) => React.ReactNode;
}

function LineStats({ added, removed }: { added?: number; removed?: number }) {
  if (added == null && removed == null) return null;
  return (
    <span style={styles.lineStats}>
      {added != null && added > 0 && <span style={styles.added}>+{added}</span>}
      {removed != null && removed > 0 && <span style={styles.removed}>-{removed}</span>}
    </span>
  );
}

function FileRow<F extends GenericTreeFile>({ file, depth, basePad, ...shared }: { file: F; depth: number; basePad: number } & Pick<GenericFileTreeProps<F>,
  'iconTheme' | 'statusColor' | 'statusLetter' | 'onOpenFile' | 'isFileSelected' | 'isFileContextActive' | 'onContextMenuFile' | 'renderFileActions'
>) {
  const { iconTheme, statusColor, statusLetter, onOpenFile, isFileSelected, isFileContextActive, onContextMenuFile, renderFileActions } = shared;
  const [hovered, setHovered] = useState(false);
  const fname = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
  const color = statusColor(file.status);
  const letter = statusLetter(file.status);
  const selected = isFileSelected?.(file) ?? false;
  const ctxActive = !selected && (isFileContextActive?.(file) ?? false);

  return (
    <div
      style={{ ...styles.row(selected, hovered, ctxActive), position: 'relative', paddingLeft: `${basePad + depth * LEVEL_PAD}px` }}
      onClick={(e) => onOpenFile(file, e)}
      onContextMenu={onContextMenuFile ? (e) => { e.preventDefault(); onContextMenuFile(e, file); } : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={file.path}
    >
      <TreeGuideLines depth={depth} offset={basePad + GUIDE_OFFSET} step={LEVEL_PAD} />
      {/* Spacer standing in for the sibling dir row's chevron, so this file's icon lines up under a directory's icon rather than under its chevron. */}
      <div style={{ width: FILE_ICON_SPACER_WIDTH, flexShrink: 0 }} />
      <FileIcon name={fname} theme={iconTheme} size={ICON_SIZE} />
      <div style={styles.fileNameGroup}>
        <span style={styles.fileName(color)}>{fname}</span>
        {depth === 0 && dir && <span style={styles.dirPath} title={dir}>{dir}</span>}
      </div>
      <div style={styles.rowActions}>
        {renderFileActions?.(file, hovered)}
        <LineStats added={file.added} removed={file.removed} />
        <span style={styles.statusLetter(color)}>{letter}</span>
      </div>
    </div>
  );
}

function TreeDirNode<F extends GenericTreeFile>({ node, depth, basePad, ...shared }: { node: TreeDir<F>; depth: number; basePad: number } & Pick<GenericFileTreeProps<F>,
  'iconTheme' | 'statusColor' | 'statusLetter' | 'onOpenFile' | 'isFileSelected' | 'isFileContextActive' | 'onContextMenuFile' | 'renderFileActions' |
  'isDirOpen' | 'toggleDir' | 'onContextMenuDir' | 'isDirContextActive' | 'renderDirActions'
>) {
  const { iconTheme, isDirOpen, toggleDir, onContextMenuDir, isDirContextActive, renderDirActions } = shared;
  const [hovered, setHovered] = useState(false);
  const open = isDirOpen(node.path);
  const allFiles = collectFiles(node);
  const ctxActive = isDirContextActive?.(node.path) ?? false;

  return (
    <div>
      <div
        style={{ ...styles.dirRow(hovered, ctxActive), position: 'relative', paddingLeft: `${basePad + depth * LEVEL_PAD}px` }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={onContextMenuDir ? (e) => { e.preventDefault(); onContextMenuDir(e, node.path, allFiles); } : undefined}
        onClick={() => toggleDir(node.path)}
      >
        <TreeGuideLines depth={depth} offset={basePad + GUIDE_OFFSET} step={LEVEL_PAD} />
        <div style={styles.dirInner}>
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.chevron} />
          <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={ICON_SIZE} />
          <span style={styles.dirName}>{node.name}</span>
        </div>
        <div style={styles.rowActions}>
          {renderDirActions?.(allFiles, hovered)}
          <span style={styles.dirCount}>{allFiles.length}</span>
        </div>
      </div>
      {open && node.children.map((child, i) =>
        child.kind === 'dir'
          ? <TreeDirNode key={i} node={child} depth={depth + 1} basePad={basePad} {...shared} />
          : <FileRow key={i} file={child.file} depth={depth + 1} basePad={basePad} {...shared} />
      )}
    </div>
  );
}

export function GenericFileTree<F extends GenericTreeFile>({ files, viewMode, basePad = DEFAULT_BASE_PAD, ...shared }: GenericFileTreeProps<F>) {
  useTreeGuideHoverStyle();
  if (files.length === 0) return null;

  if (viewMode === 'tree') {
    const nodes = buildTree(files);
    return (
      <div style={styles.container} data-filetree-container>
        {nodes.map((node, i) =>
          node.kind === 'dir'
            ? <TreeDirNode key={i} node={node} depth={0} basePad={basePad} {...shared} />
            : <FileRow key={i} file={node.file} depth={0} basePad={basePad} {...shared} />
        )}
      </div>
    );
  }

  return (
    <div style={styles.container} data-filetree-container>
      {files.map((file, i) => (
        <FileRow key={i} file={file} depth={0} basePad={basePad} {...shared} />
      ))}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  container: { display: 'flex', flexDirection: 'column' as const },
  row: (selected: boolean, hovered: boolean, ctxActive = false): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: `${ROW_GAP}px`, minHeight: '22px', fontSize: '12px',
    paddingRight: '8px', cursor: 'pointer', borderRadius: '2px',
    background: selected
      ? 'var(--vscode-list-activeSelectionBackground)'
      : ctxActive
        ? 'var(--vscode-list-inactiveSelectionBackground)'
        : hovered
          ? 'var(--vscode-list-hoverBackground)'
          : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
  }),
  dirRow: (hovered: boolean, ctxActive = false): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', minHeight: '22px', fontSize: '12px',
    paddingRight: '8px', gap: '0', borderRadius: '2px', cursor: 'pointer',
    background: ctxActive
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : hovered
        ? 'var(--vscode-list-hoverBackground)'
        : 'transparent',
    color: 'var(--vscode-foreground)',
  }),
  dirInner: {
    display: 'flex', alignItems: 'center', gap: `${INNER_GAP}px`, flex: 1,
    cursor: 'pointer', userSelect: 'none' as const, paddingLeft: `${DIR_INNER_PAD}px`, minWidth: 0,
  } as React.CSSProperties,
  chevron: { fontSize: '12px', opacity: 0.7, width: `${CHEVRON_WIDTH}px`, flexShrink: 0 } as React.CSSProperties,
  dirName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  dirCount: { fontSize: '11px', opacity: 0.45, flexShrink: 0, marginLeft: '6px', width: '14px', textAlign: 'center' as const },
  fileNameGroup: {
    display: 'flex', alignItems: 'baseline', gap: '4px', flex: 1, minWidth: 0, overflow: 'hidden',
  } as React.CSSProperties,
  fileName: (color: string): React.CSSProperties => ({
    color, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
  }),
  dirPath: {
    fontSize: '11px', opacity: 0.45, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const, flexShrink: 1, minWidth: 0,
  },
  statusLetter: (color: string): React.CSSProperties => ({
    fontSize: '11px', fontWeight: 'bold', color, flexShrink: 0, width: '14px',
    textAlign: 'center', opacity: 0.9, marginLeft: '6px',
  }),
  rowActions: {
    display: 'flex', alignItems: 'center', gap: '0', marginLeft: 'auto', flexShrink: 0,
  } as React.CSSProperties,
  lineStats: {
    display: 'flex', gap: '3px', flexShrink: 0, fontSize: '10px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)', marginLeft: '6px',
  } as React.CSSProperties,
  added: { color: 'var(--vscode-gitDecoration-addedResourceForeground)' } as React.CSSProperties,
  removed: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)' } as React.CSSProperties,
};
