import React, { useState } from 'react';
import type { FileStatus, RepoMeta, RepoStatus } from '../../shared/types';
import type { ViewMode } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { InlineIconBtn } from '../../shared/InlineIconBtn';
import { SingleRepoHeader } from './ProjectGroup';
import { branchColor, tagColor } from '../../shared/branchColors';

// ── Types ──────────────────────────────────────────────────────────────────

interface Props {
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
  selectedFile: { repoId: string; path: string } | null;
  ctxFile?: { repoId: string; path: string } | null;
  viewMode: ViewMode;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  onSelectFile: (file: FileStatus) => void;
  onContextMenu: (e: React.MouseEvent, file: FileStatus, staged: boolean) => void;
  onFolderContextMenu: (e: React.MouseEvent, repoId: string, folderPath: string, files: FileStatus[], staged: boolean) => void;
  onOpenFile: (file: FileStatus) => void;
  onRollback: (files: FileStatus[]) => void;
  onResolveMerge: (file: FileStatus) => void;
  onStageFiles: (repoId: string, paths: string[]) => void;
  onUnstageFiles: (repoId: string, paths: string[]) => void;
  onStageAll: (repoId: string) => void;
  onUnstageAll: (repoId: string) => void;
  onRepoContextMenu: (e: React.MouseEvent, repoId: string, staged: boolean) => void;
  onBranchClick: (repoId: string) => void;
  onOpenStagedChanges: (repoId: string) => void;
  onOpenUnstagedChanges: (repoId: string) => void;
  iconTheme?: IconThemeData | null;
  activeFolderPath?: string | null;
  selectedRepos: Set<string>;
  onToggleRepoSelection: (repoId: string) => void;
  onOpenAllChanges?: (repoId: string) => void;
  onMultiSelect?: (file: FileStatus) => void;
  multiSelectedFiles?: FileStatus[];
}

// ── Tree helpers (same logic as FileTree) ─────────────────────────────────

type TreeFile = { kind: 'file'; file: FileStatus };
type TreeDir  = { kind: 'dir'; name: string; path: string; children: TreeNode[] };
type TreeNode = TreeFile | TreeDir;

function buildTree(files: FileStatus[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let nodes = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let dir = nodes.find((n): n is TreeDir => n.kind === 'dir' && n.name === name);
      if (!dir) { dir = { kind: 'dir', name, path: dirPath, children: [] }; nodes.push(dir); }
      nodes = dir.children;
    }
    nodes.push({ kind: 'file', file });
  }
  return collapseSingleChildDirs(root);
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

// ── Constants ────────────────────────────────────────────────────────────

const BASE_PAD = 20;
const LEVEL_PAD = 20;
const ICON_SIZE = 16;

const STATUS_COLORS: Record<string, string> = {
  modified:   'var(--vscode-gitDecoration-modifiedResourceForeground)',
  added:      'var(--vscode-gitDecoration-addedResourceForeground)',
  deleted:    'var(--vscode-gitDecoration-deletedResourceForeground)',
  renamed:    'var(--vscode-gitDecoration-renamedResourceForeground)',
  untracked:  'var(--vscode-gitDecoration-untrackedResourceForeground)',
  conflicted: 'var(--vscode-gitDecoration-conflictingResourceForeground)',
  ignored:    'var(--vscode-gitDecoration-ignoredResourceForeground)',
  submodule:  'var(--vscode-gitDecoration-submoduleResourceForeground)',
};
const STATUS_LETTERS: Record<string, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R',
  untracked: 'U', conflicted: 'C', ignored: 'I', submodule: 'S',
};

// ── File row (no checkbox) ────────────────────────────────────────────────

interface FileRowProps {
  file: FileStatus;
  depth: number;
  staged: boolean;
  selectedFile: { repoId: string; path: string } | null;
  ctxFile?: { repoId: string; path: string } | null;
  iconTheme?: IconThemeData | null;
  onSelect: (file: FileStatus) => void;
  onContextMenu: (e: React.MouseEvent, file: FileStatus) => void;
  onOpenFile: (file: FileStatus) => void;
  onRollback: (files: FileStatus[]) => void;
  onResolveMerge: (file: FileStatus) => void;
  onStage: (file: FileStatus) => void;
  onUnstage: (file: FileStatus) => void;
  onMultiSelect?: (file: FileStatus) => void;
  multiSelectedFiles?: FileStatus[];
}

function VscodeFileRow({ file, depth, staged, selectedFile, ctxFile, iconTheme, onSelect, onContextMenu, onOpenFile, onRollback, onResolveMerge, onStage, onUnstage, onMultiSelect, multiSelectedFiles }: FileRowProps) {
  const isSelected = selectedFile?.repoId === file.repoId && selectedFile.path === file.path;
  const isCtxActive = !isSelected && ctxFile?.repoId === file.repoId && ctxFile.path === file.path;
  const isMultiSelected = multiSelectedFiles?.some(f => f.repoId === file.repoId && f.path === file.path) ?? false;
  const color = STATUS_COLORS[file.status] ?? 'var(--vscode-foreground)';
  const letter = STATUS_LETTERS[file.status] ?? 'M';
  const fileName = file.path.split('/').pop() ?? file.path;
  const dir = (() => { const p = file.path.split('/'); return p.length > 1 ? p.slice(0, -1).join('/') : ''; })();
  const [hovered, setHovered] = useState(false);
  const isSubmodule = file.status === 'submodule';

  return (
    <div
      style={{ ...rowStyle(isSelected, isCtxActive, hovered), paddingLeft: `${BASE_PAD + depth * LEVEL_PAD}px`, ...(isMultiSelected && !isSelected ? { background: 'color-mix(in srgb, var(--vscode-list-inactiveSelectionBackground) 70%, var(--vscode-focusBorder, #007acc) 30%)' } : {}) }}
      onClick={isSubmodule ? undefined : (e) => {
        if ((e.metaKey || e.ctrlKey) && onMultiSelect) {
          e.stopPropagation();
          onMultiSelect(file);
          return;
        }
        onSelect(file);
      }}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, file); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={file.path}
    >
      <FileIcon name={fileName} theme={iconTheme} size={ICON_SIZE} />
      <div style={fileNameGroupStyle}>
        <span style={{ ...fileNameStyle, color }}>{fileName}</span>
        {depth === 0 && dir && <span style={dirPathStyle} title={dir}>{dir}</span>}
      </div>
      <div style={rowActionsStyle}>
        {!isSubmodule && <>
          {file.status === 'conflicted' && (
            <InlineIconBtn icon="git-merge" title="Resolve Conflicts" visible={hovered} onClick={e => { e.stopPropagation(); onResolveMerge(file); }} />
          )}
          <InlineIconBtn icon="go-to-file" title="Open file" visible={hovered} onClick={e => { e.stopPropagation(); onOpenFile(file); }} />
          {!staged && (
            <InlineIconBtn icon="discard" title="Rollback" visible={hovered} onClick={e => { e.stopPropagation(); onRollback([file]); }} />
          )}
          {staged ? (
            <InlineIconBtn icon="remove" title="Unstage" visible={hovered} onClick={e => { e.stopPropagation(); onUnstage(file); }} />
          ) : (
            <InlineIconBtn icon="add" title="Stage" visible={hovered} onClick={e => { e.stopPropagation(); onStage(file); }} />
          )}
        </>}
        <span style={statusLetterStyle(color)}>{letter}</span>
      </div>
    </div>
  );
}

// ── Dir node (no checkbox) ────────────────────────────────────────────────

interface DirNodeProps {
  node: TreeDir;
  depth: number;
  staged: boolean;
  selectedFile: { repoId: string; path: string } | null;
  ctxFile?: { repoId: string; path: string } | null;
  iconTheme?: IconThemeData | null;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  activeFolderPath?: string | null;
  repoId: string;
  onSelect: (file: FileStatus) => void;
  onContextMenu: (e: React.MouseEvent, file: FileStatus) => void;
  onFolderContextMenu: (e: React.MouseEvent, folderPath: string, files: FileStatus[]) => void;
  onOpenFile: (file: FileStatus) => void;
  onRollback: (files: FileStatus[]) => void;
  onResolveMerge: (file: FileStatus) => void;
  onStage: (file: FileStatus) => void;
  onUnstage: (file: FileStatus) => void;
  onStageFolder: (files: FileStatus[]) => void;
  onUnstageFolder: (files: FileStatus[]) => void;
  onMultiSelect?: (file: FileStatus) => void;
  multiSelectedFiles?: FileStatus[];
}

function VscodeDirNode({ node, depth, staged, repoId, selectedFile, ctxFile, iconTheme, isCollapsed, toggleCollapsed, activeFolderPath, onSelect, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge, onStage, onUnstage, onStageFolder, onUnstageFolder, onMultiSelect, multiSelectedFiles }: DirNodeProps) {
  const collapseKey = `vscode-${staged ? 'staged' : 'unstaged'}-${repoId}:${node.path}`;
  const open = !isCollapsed(collapseKey);
  const allFiles = collectFiles(node);
  const [hovered, setHovered] = useState(false);
  const ctxActive = activeFolderPath === node.path;

  const childProps = { depth: depth + 1, staged, selectedFile, ctxFile, iconTheme, isCollapsed, toggleCollapsed, activeFolderPath, repoId, onSelect, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge, onStage, onUnstage, onStageFolder, onUnstageFolder, onMultiSelect, multiSelectedFiles };

  return (
    <div>
      <div
        style={{ ...treeDirStyle, paddingLeft: `${BASE_PAD + depth * LEVEL_PAD}px`, background: ctxActive ? 'var(--vscode-list-inactiveSelectionBackground)' : hovered ? 'var(--vscode-list-hoverBackground)' : undefined, borderRadius: '2px' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={e => { e.preventDefault(); onFolderContextMenu(e, node.path, allFiles); }}
      >
        <div style={treeDirInnerStyle} onClick={() => toggleCollapsed(collapseKey)}>
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '12px', opacity: 0.7, flexShrink: 0 }} />
          <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={ICON_SIZE} />
          <span style={folderNameStyle}>{node.name}</span>
        </div>
        <div style={rowActionsStyle}>
          {!staged && (
            <InlineIconBtn icon="discard" title="Rollback folder" visible={hovered} onClick={e => { e.stopPropagation(); onRollback(allFiles); }} />
          )}
          {staged ? (
            <InlineIconBtn icon="remove" title="Unstage folder" visible={hovered} onClick={e => { e.stopPropagation(); onUnstageFolder(allFiles); }} />
          ) : (
            <InlineIconBtn icon="add" title="Stage folder" visible={hovered} onClick={e => { e.stopPropagation(); onStageFolder(allFiles); }} />
          )}
          <span style={dirCountStyle}>{allFiles.length}</span>
        </div>
      </div>
      {open && node.children.map((child, i) =>
        child.kind === 'dir'
          ? <VscodeDirNode key={i} node={child} {...childProps} />
          : <VscodeFileRow key={i} file={child.file} depth={depth + 1} staged={staged} selectedFile={selectedFile} ctxFile={ctxFile} iconTheme={iconTheme} onSelect={onSelect} onContextMenu={onContextMenu} onOpenFile={onOpenFile} onRollback={onRollback} onResolveMerge={onResolveMerge} onStage={onStage} onUnstage={onUnstage} onMultiSelect={onMultiSelect} multiSelectedFiles={multiSelectedFiles} />
      )}
    </div>
  );
}

// ── Repo sub-group ────────────────────────────────────────────────────────

interface RepoSubGroupProps {
  repoStatus: RepoStatus;
  repoName: string;
  repoColor: string;
  staged: boolean;
  isFirst?: boolean;
  files: FileStatus[];
  viewMode: ViewMode;
  selectedFile: { repoId: string; path: string } | null;
  ctxFile?: { repoId: string; path: string } | null;
  iconTheme?: IconThemeData | null;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  activeFolderPath?: string | null;
  onSelectFile: (file: FileStatus) => void;
  onContextMenu: (e: React.MouseEvent, file: FileStatus) => void;
  onFolderContextMenu: (e: React.MouseEvent, repoId: string, folderPath: string, files: FileStatus[]) => void;
  onOpenFile: (file: FileStatus) => void;
  onRollback: (files: FileStatus[]) => void;
  onResolveMerge: (file: FileStatus) => void;
  onStageFiles: (paths: string[]) => void;
  onUnstageFiles: (paths: string[]) => void;
  onRepoContextMenu: (e: React.MouseEvent) => void;
  onBranchClick: (repoId: string) => void;
  onOpenChanges: () => void;
  repoSelected?: boolean;
  onToggleRepoSelection?: () => void;
  singleRepo?: boolean;
  isSubmodule?: boolean;
  submodulePath?: string;
  isWorktree?: boolean;
  mainWorktreePath?: string;
  onMultiSelect?: (file: FileStatus) => void;
  multiSelectedFiles?: FileStatus[];
}

function VscodeRepoGroup({ repoStatus, repoName, repoColor, staged, files, viewMode, selectedFile, ctxFile, iconTheme, isCollapsed, toggleCollapsed, activeFolderPath, onSelectFile, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge, onStageFiles, onUnstageFiles, onRepoContextMenu, onBranchClick, onOpenChanges, isFirst = false, repoSelected, onToggleRepoSelection, singleRepo, isSubmodule, submodulePath, isWorktree, mainWorktreePath, onMultiSelect, multiSelectedFiles }: RepoSubGroupProps) {
  const repoId = repoStatus.repoId;
  const collapseKey = `vscode-repo-${staged ? 'staged' : 'unstaged'}:${repoId}`;
  const isEmpty = files.length === 0;
  // Empty repos default to collapsed; key presence means "explicitly opened"
  const collapsed = isEmpty ? !isCollapsed(collapseKey) : isCollapsed(collapseKey);
  const branchClr = repoStatus.branch.detachedTag ? tagColor() : branchColor(repoStatus.branch.name, false);
  const [hovered, setHovered] = useState(false);

  const onStage   = (file: FileStatus) => onStageFiles([file.path]);
  const onUnstage = (file: FileStatus) => onUnstageFiles([file.path]);
  const onStageFolder   = (fs: FileStatus[]) => onStageFiles(fs.map(f => f.path));
  const onUnstageFolder = (fs: FileStatus[]) => onUnstageFiles(fs.map(f => f.path));

  const renderFiles = () => {
    if (viewMode === 'tree') {
      const nodes = buildTree(files);
      return nodes.map((node, i) =>
        node.kind === 'dir'
          ? <VscodeDirNode key={i} node={node} depth={0} staged={staged} repoId={repoId} selectedFile={selectedFile} ctxFile={ctxFile} iconTheme={iconTheme} isCollapsed={isCollapsed} toggleCollapsed={toggleCollapsed} activeFolderPath={activeFolderPath} onSelect={onSelectFile} onContextMenu={onContextMenu} onFolderContextMenu={(e, fp, fs) => onFolderContextMenu(e, repoId, fp, fs)} onOpenFile={onOpenFile} onRollback={onRollback} onResolveMerge={onResolveMerge} onStage={onStage} onUnstage={onUnstage} onStageFolder={onStageFolder} onUnstageFolder={onUnstageFolder} onMultiSelect={onMultiSelect} multiSelectedFiles={multiSelectedFiles} />
          : <VscodeFileRow key={i} file={node.file} depth={0} staged={staged} selectedFile={selectedFile} ctxFile={ctxFile} iconTheme={iconTheme} onSelect={onSelectFile} onContextMenu={onContextMenu} onOpenFile={onOpenFile} onRollback={onRollback} onResolveMerge={onResolveMerge} onStage={onStage} onUnstage={onUnstage} onMultiSelect={onMultiSelect} multiSelectedFiles={multiSelectedFiles} />
      );
    }
    return files.map((file, i) =>
      <VscodeFileRow key={i} file={file} depth={0} staged={staged} selectedFile={selectedFile} ctxFile={ctxFile} iconTheme={iconTheme} onSelect={onSelectFile} onContextMenu={onContextMenu} onOpenFile={onOpenFile} onRollback={onRollback} onResolveMerge={onResolveMerge} onStage={onStage} onUnstage={onUnstage} onMultiSelect={onMultiSelect} multiSelectedFiles={multiSelectedFiles} />
    );
  };

  return (
    <div style={repoGroupStyle(isFirst)}>
      {!singleRepo && (
        <div
          style={repoHeaderStyle(repoColor)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onContextMenu={e => { e.preventDefault(); onRepoContextMenu(e); }}
        >
          {staged && onToggleRepoSelection && (
            <input
              type="checkbox"
              checked={isEmpty ? false : (repoSelected ?? true)}
              onChange={e => { if (!isEmpty) { e.stopPropagation(); onToggleRepoSelection?.(); } }}
              onClick={e => e.stopPropagation()}
              title={isEmpty ? undefined : "Include this repository in the commit"}
              disabled={isEmpty}
              style={{ margin: '0 0 0 8px', flexShrink: 0, accentColor: 'var(--vscode-button-background)', cursor: isEmpty ? 'default' : 'pointer', ...(isEmpty ? { opacity: 0.3, pointerEvents: 'none' } : {}) }}
            />
          )}
          <div style={repoHeaderMainStyle} onClick={() => toggleCollapsed(collapseKey)}>
            <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={{ fontSize: '12px', opacity: 0.7, flexShrink: 0 }} />
            <span style={repoDotStyle(repoColor)} />
            <span style={repoNameStyle}>
              {isWorktree && mainWorktreePath ? mainWorktreePath.split('/').pop() ?? repoName : repoName}
            </span>
            {isSubmodule && (
              <span style={submoduleBadgeStyle} title={submodulePath ? `Submodule: ${submodulePath}` : 'Submodule'}>SUB</span>
            )}
            <span
              style={branchBadgeStyle(branchClr)}
              onClick={e => { e.stopPropagation(); onBranchClick(repoId); }}
              title={repoStatus.branch.detachedTag ? `Tag: ${repoStatus.branch.detachedTag} (detached HEAD)` : repoStatus.branch.detachedHash ? `Detached HEAD at ${repoStatus.branch.detachedHash}` : repoStatus.branch.name}
            >
              <Codicon name={isWorktree ? 'worktree' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0, opacity: 0.8 }} />
              <span style={branchNameStyle}>{repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name}</span>
            </span>
          </div>
          {!isEmpty && (
            <div style={repoActionsStyle}>
              <InlineIconBtn icon="diff-multiple" title={staged ? 'Open Staged Changes' : 'Open Changes'} visible={hovered} onClick={e => { e.stopPropagation(); onOpenChanges(); }} />
              {!staged && (
                <InlineIconBtn icon="discard" title="Rollback All" visible={hovered} onClick={e => { e.stopPropagation(); onRollback(files); }} />
              )}
              {staged ? (
                <InlineIconBtn icon="remove" title="Unstage All" visible={hovered} onClick={e => { e.stopPropagation(); onUnstageFiles(files.map(f => f.path)); }} />
              ) : (
                <InlineIconBtn icon="add" title="Stage All" visible={hovered} onClick={e => { e.stopPropagation(); onStageFiles(files.map(f => f.path)); }} />
              )}
              <span style={repoCountStyle}>{files.length}</span>
            </div>
          )}
        </div>
      )}
      {!collapsed && isEmpty && (
        <div style={{ padding: '12px 8px', fontSize: '12px', color: 'var(--vscode-foreground)', opacity: 0.4, textAlign: 'center' }}>No changes</div>
      )}
      {!collapsed && !isEmpty && <div>{renderFiles()}</div>}
      <div style={{ borderBottom: '1px solid var(--vscode-panel-border)' }} />
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────

interface SectionHeaderProps {
  title: string;
  icon: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  actionIcon?: string;
  actionTitle?: string;
  onAction?: () => void;
  secondActionIcon?: string;
  secondActionTitle?: string;
  onSecondAction?: () => void;
  openChangesIcon?: string;
  openChangesTitle?: string;
  onOpenChanges?: () => void;
}

function SectionHeader({ title, icon, count, collapsed, onToggle, onContextMenu, actionIcon, actionTitle, onAction, secondActionIcon, secondActionTitle, onSecondAction, openChangesIcon, openChangesTitle, onOpenChanges }: SectionHeaderProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={sectionHeaderStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e); }}
    >
      <div style={sectionHeaderMainStyle} onClick={onToggle}>
        <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={{ fontSize: '12px', opacity: 0.7, flexShrink: 0 }} />
        <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.8, flexShrink: 0 }} />
        <span style={sectionTitleStyle}>{title}</span>
      </div>
      {/* Right side always rendered to avoid layout shift */}
      <div style={repoActionsStyle}>
        {onOpenChanges && openChangesIcon && (
          <InlineIconBtn icon={openChangesIcon} title={openChangesTitle ?? ''} visible={hovered} onClick={e => { e.stopPropagation(); onOpenChanges(); }} />
        )}
        {onSecondAction && secondActionIcon && (
          <InlineIconBtn icon={secondActionIcon} title={secondActionTitle ?? ''} visible={hovered} onClick={e => { e.stopPropagation(); onSecondAction(); }} />
        )}
        {onAction && actionIcon && (
          <InlineIconBtn icon={actionIcon} title={actionTitle ?? ''} visible={hovered} onClick={e => { e.stopPropagation(); onAction(); }} />
        )}
        <span style={sectionCountStyle}>{count}</span>
      </div>
    </div>
  );
}

// ── Main VscodeView ───────────────────────────────────────────────────────

export function VscodeView({
  repos, repoMetas, selectedFile, ctxFile, viewMode,
  isCollapsed, toggleCollapsed,
  onSelectFile, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge,
  onStageFiles, onUnstageFiles, onStageAll, onUnstageAll,
  onRepoContextMenu, onBranchClick, onOpenStagedChanges, onOpenUnstagedChanges, iconTheme, activeFolderPath,
  selectedRepos, onToggleRepoSelection, onOpenAllChanges,
  onMultiSelect, multiSelectedFiles,
}: Props) {
  const metaMap = new Map(repoMetas.map(m => [m.id, m]));
  const STAGED_COLLAPSE_KEY = 'vscode-section:staged';
  const UNSTAGED_COLLAPSE_KEY = 'vscode-section:unstaged';
  const stagedCollapsed   = isCollapsed(STAGED_COLLAPSE_KEY);
  const unstagedCollapsed = isCollapsed(UNSTAGED_COLLAPSE_KEY);

  const totalStaged   = repos.reduce((s, r) => s + r.stagedFiles.length, 0);
  const totalUnstaged = repos.reduce((s, r) => s + r.unstagedFiles.length, 0);

  const isSingleRepo = repos.length === 1;
  const singleRepoStatus = isSingleRepo ? repos[0] : null;
  const singleMeta = singleRepoStatus ? metaMap.get(singleRepoStatus.repoId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {/* ── Single-repo top header ── */}
      {singleRepoStatus && (
        <SingleRepoHeader
          repoStatus={singleRepoStatus}
          repoName={singleMeta?.name ?? singleRepoStatus.repoId.split('/').pop() ?? singleRepoStatus.repoId}
          repoColor={singleMeta?.color ?? '#4ec9b0'}
          isSubmodule={singleMeta?.isSubmodule}
          submodulePath={singleMeta?.submodulePath}
          isWorktree={singleMeta?.isWorktree}
          mainWorktreePath={singleMeta?.mainWorktreePath}
          onBranchClick={onBranchClick}
          onRepoContextMenu={(e, rid) => onRepoContextMenu(e, rid, true)}
          onOpenAllChanges={onOpenAllChanges ?? (() => {})}
          hideOpenChanges
        />
      )}

      {/* ── Staged Changes ── */}
      <SectionHeader
        title="Staged Changes"
        icon="git-commit"
        count={totalStaged}
        collapsed={stagedCollapsed}
        onToggle={() => toggleCollapsed(STAGED_COLLAPSE_KEY)}
        onContextMenu={e => {/* no-op for now */}}
        actionIcon={totalStaged > 0 ? "remove" : undefined}
        actionTitle={totalStaged > 0 ? "Unstage All" : undefined}
        onAction={totalStaged > 0 ? () => repos.forEach(r => onUnstageAll(r.repoId)) : undefined}
        openChangesIcon={isSingleRepo ? 'diff-multiple' : undefined}
        openChangesTitle={isSingleRepo ? 'Open Staged Changes' : undefined}
        onOpenChanges={isSingleRepo && singleRepoStatus ? () => onOpenStagedChanges(singleRepoStatus.repoId) : undefined}
      />
      {!stagedCollapsed && repos.filter(r => r.stagedFiles.length > 0).map((r, idx) => {
        const meta = metaMap.get(r.repoId);
        return (
          <VscodeRepoGroup
            key={r.repoId}
            isFirst={idx === 0}
            repoStatus={r}
            repoName={meta?.name ?? r.repoId.split('/').pop() ?? r.repoId}
            repoColor={meta?.color ?? '#4ec9b0'}
            staged={true}
            files={r.stagedFiles}
            viewMode={viewMode}
            selectedFile={selectedFile}
            ctxFile={ctxFile}
            iconTheme={iconTheme}
            isCollapsed={isCollapsed}
            toggleCollapsed={toggleCollapsed}
            activeFolderPath={activeFolderPath}
            onSelectFile={onSelectFile}
            onContextMenu={(e, file) => onContextMenu(e, file, true)}
            onFolderContextMenu={(e, rid, fp, fs) => onFolderContextMenu(e, rid, fp, fs, true)}
            onOpenFile={onOpenFile}
            onRollback={onRollback}
            onResolveMerge={onResolveMerge}
            onStageFiles={paths => onStageFiles(r.repoId, paths)}
            onUnstageFiles={paths => onUnstageFiles(r.repoId, paths)}
            onRepoContextMenu={e => onRepoContextMenu(e, r.repoId, true)}
            onBranchClick={onBranchClick}
            onOpenChanges={() => onOpenStagedChanges(r.repoId)}
            repoSelected={selectedRepos.has(r.repoId)}
            onToggleRepoSelection={() => onToggleRepoSelection(r.repoId)}
            singleRepo={isSingleRepo}
            isSubmodule={meta?.isSubmodule}
            submodulePath={meta?.submodulePath}
            isWorktree={meta?.isWorktree}
            mainWorktreePath={meta?.mainWorktreePath}
            onMultiSelect={onMultiSelect}
            multiSelectedFiles={multiSelectedFiles}
          />
        );
      })}

      {/* ── Changes ── */}
      <SectionHeader
        title="Changes"
        icon="git-pull-request"
        count={totalUnstaged}
        collapsed={unstagedCollapsed}
        onToggle={() => toggleCollapsed(UNSTAGED_COLLAPSE_KEY)}
        onContextMenu={e => {/* no-op */}}
        actionIcon={totalUnstaged > 0 ? "add" : undefined}
        actionTitle={totalUnstaged > 0 ? "Stage All" : undefined}
        onAction={totalUnstaged > 0 ? () => repos.forEach(r => onStageAll(r.repoId)) : undefined}
        secondActionIcon={totalUnstaged > 0 ? "discard" : undefined}
        secondActionTitle={totalUnstaged > 0 ? "Rollback All" : undefined}
        onSecondAction={totalUnstaged > 0 ? () => onRollback(repos.flatMap(r => r.unstagedFiles)) : undefined}
        openChangesIcon={isSingleRepo ? 'diff-multiple' : undefined}
        openChangesTitle={isSingleRepo ? 'Open Changes' : undefined}
        onOpenChanges={isSingleRepo && singleRepoStatus ? () => onOpenUnstagedChanges(singleRepoStatus.repoId) : undefined}
      />
      {!unstagedCollapsed && repos.filter(r => r.stagedFiles.length === 0 || r.unstagedFiles.length > 0).map((r, idx) => {
        const meta = metaMap.get(r.repoId);
        return (
          <VscodeRepoGroup
            key={r.repoId}
            isFirst={idx === 0}
            repoStatus={r}
            repoName={meta?.name ?? r.repoId.split('/').pop() ?? r.repoId}
            repoColor={meta?.color ?? '#4ec9b0'}
            staged={false}
            files={r.unstagedFiles}
            viewMode={viewMode}
            selectedFile={selectedFile}
            ctxFile={ctxFile}
            iconTheme={iconTheme}
            isCollapsed={isCollapsed}
            toggleCollapsed={toggleCollapsed}
            activeFolderPath={activeFolderPath}
            onSelectFile={onSelectFile}
            onContextMenu={(e, file) => onContextMenu(e, file, false)}
            onFolderContextMenu={(e, rid, fp, fs) => onFolderContextMenu(e, rid, fp, fs, false)}
            onOpenFile={onOpenFile}
            onRollback={onRollback}
            onResolveMerge={onResolveMerge}
            onStageFiles={paths => onStageFiles(r.repoId, paths)}
            onUnstageFiles={paths => onUnstageFiles(r.repoId, paths)}
            onRepoContextMenu={e => onRepoContextMenu(e, r.repoId, false)}
            onBranchClick={onBranchClick}
            onOpenChanges={() => onOpenUnstagedChanges(r.repoId)}
            singleRepo={isSingleRepo}
            isSubmodule={meta?.isSubmodule}
            submodulePath={meta?.submodulePath}
            isWorktree={meta?.isWorktree}
            mainWorktreePath={meta?.mainWorktreePath}
            onMultiSelect={onMultiSelect}
            multiSelectedFiles={multiSelectedFiles}
          />
        );
      })}

      <div style={{ flex: 1, minHeight: '40px' }} />
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: 'var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08))',
  borderLeft: '3px solid var(--vscode-focusBorder, var(--vscode-button-background, #007acc))',
  borderBottom: '1px solid var(--vscode-panel-border)',
  position: 'sticky',
  top: 0,
  zIndex: 1,
  height: '26px',
  boxSizing: 'border-box',
};

const sectionHeaderMainStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '3px 8px 3px 8px',
  cursor: 'pointer',
  flex: 1,
  fontSize: '11px',
  fontWeight: 'bold',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--vscode-foreground)',
  userSelect: 'none',
};

const sectionTitleStyle: React.CSSProperties = {
  flex: 1,
};

const sectionCountStyle: React.CSSProperties = {
  background: 'var(--vscode-badge-background)',
  color: 'var(--vscode-badge-foreground)',
  borderRadius: '10px',
  padding: '1px 6px',
  fontSize: '10px',
  fontWeight: 'bold',
  flexShrink: 0,
  minWidth: '18px',
  textAlign: 'center',
  marginLeft: '6px',
};

const repoGroupStyle = (_isFirst: boolean): React.CSSProperties => ({
});

const repoHeaderStyle = (color: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  background: color + '14',
  height: '26px',
  boxSizing: 'border-box',
});

const repoHeaderMainStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '3px 0 3px 8px',
  cursor: 'pointer',
  flex: 1,
  fontSize: '11px',
  fontWeight: 'bold',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--vscode-foreground)',
  userSelect: 'none',
  minWidth: 0,
  overflow: 'hidden',
};

const repoDotStyle = (color: string): React.CSSProperties => ({
  width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0,
});

const repoNameStyle: React.CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 10, minWidth: '20px',
};

const branchBadgeStyle = (color: string): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: '3px',
  fontSize: '10px', fontWeight: 600, textTransform: 'none', letterSpacing: 0,
  background: `${color}33`, color, border: `1px solid ${color}88`,
  borderRadius: '3px', padding: '1px 5px', flexShrink: 1, minWidth: 0, maxWidth: '160px',
  marginLeft: '4px', cursor: 'pointer', overflow: 'hidden',
});

const branchNameStyle: React.CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
};

const repoCountStyle: React.CSSProperties = {
  fontSize: '10px', opacity: 0.5, fontWeight: 'normal',
  textTransform: 'none', letterSpacing: 0, flexShrink: 0,
  minWidth: '14px', textAlign: 'center', marginLeft: '6px',
};

const rowStyle = (selected: boolean, ctxActive = false, hovered = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', paddingRight: '8px',
  cursor: 'pointer',
  background: selected
    ? 'var(--vscode-list-activeSelectionBackground)'
    : ctxActive
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : hovered
        ? 'var(--vscode-list-hoverBackground)'
        : 'transparent',
  color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
  borderRadius: '2px', minHeight: '22px', fontSize: '12px', gap: '3px',
});

const fileNameGroupStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: '4px', flex: 1, minWidth: 0, overflow: 'hidden',
};

const fileNameStyle: React.CSSProperties = {
  flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
};

const dirPathStyle: React.CSSProperties = {
  fontSize: '11px', opacity: 0.5, overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0,
};

const statusLetterStyle = (color: string): React.CSSProperties => ({
  fontSize: '11px', fontWeight: 'bold', color, flexShrink: 0, width: '14px',
  textAlign: 'center', opacity: 0.9, marginLeft: '6px',
});

const rowActionsStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0', flexShrink: 0, marginLeft: 'auto',
};

const repoActionsStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0', flexShrink: 0, paddingRight: '8px',
};


const treeDirStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', minHeight: '22px',
  fontSize: '12px', color: 'var(--vscode-foreground)', paddingRight: '8px', gap: '0',
};

const treeDirInnerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '4px', flex: 1, cursor: 'pointer',
  paddingLeft: '2px', overflow: 'hidden',
};

const folderNameStyle: React.CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
};

const dirCountStyle: React.CSSProperties = {
  fontSize: '11px', opacity: 0.5, marginLeft: '6px', flexShrink: 0, minWidth: '14px', textAlign: 'center',
};

const submoduleBadgeStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--vscode-badge-foreground)', background: 'var(--vscode-badge-background)',
  borderRadius: '3px', padding: '1px 4px', flexShrink: 0, opacity: 0.75,
};
