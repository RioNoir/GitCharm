import React, { useEffect, useRef, useState } from 'react';
import type { FileStatus, RepoStatus } from '../../shared/types';
import type { ViewMode } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { FileTree } from './FileTree';
import { Codicon } from '../../shared/Codicon';

// Deterministic hue from branch name — same name always yields same color.
const BRANCH_HUES: Record<string, number> = {
  main: 213, master: 213,
  develop: 160, dev: 160, development: 160,
  staging: 35, stage: 35,
  release: 270, production: 270, prod: 270,
};

function branchHue(name: string): number {
  const lower = name.toLowerCase();
  if (lower in BRANCH_HUES) return BRANCH_HUES[lower];
  const stripped = lower.replace(/^(feature|feat|fix|hotfix|bugfix|chore|refactor|release|support)[\\/\-]/, '');
  let h = 0;
  for (let i = 0; i < stripped.length; i++) h = (h * 31 + stripped.charCodeAt(i)) & 0xffff;
  return h % 360;
}

export function branchColor(name: string): { bg: string; fg: string; border: string } {
  const hue = branchHue(name);
  const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  return isDark ? {
    bg:     `hsla(${hue}, 55%, 50%, 0.15)`,
    fg:     `hsl(${hue}, 70%, 65%)`,
    border: `hsla(${hue}, 55%, 55%, 0.4)`,
  } : {
    bg:     `hsla(${hue}, 55%, 50%, 0.12)`,
    fg:     `hsl(${hue}, 55%, 28%)`,
    border: `hsla(${hue}, 55%, 40%, 0.55)`,
  };
}

interface Props {
  repoStatus: RepoStatus;
  repoName: string;
  repoColor: string;
  multiRepo: boolean;
  isFirst?: boolean;
  isSubmodule?: boolean;
  submodulePath?: string;
  isWorktree?: boolean;
  mainWorktreePath?: string;
  selectedFile: { repoId: string; path: string } | null;
  viewMode: ViewMode;
  isFileSelected: (repoId: string, path: string) => boolean;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  onToggleFile: (repoId: string, path: string) => void;
  onSetFiles: (repoId: string, paths: string[], selected: boolean) => void;
  onSelectFile: (file: FileStatus) => void;
  onContextMenu: (e: React.MouseEvent, file: FileStatus) => void;
  onFolderContextMenu: (e: React.MouseEvent, repoId: string, folderPath: string, files: FileStatus[]) => void;
  onOpenFile: (file: FileStatus) => void;
  onRollback: (files: FileStatus[]) => void;
  onResolveMerge: (file: FileStatus) => void;
  onBranchClick: (repoId: string) => void;
  onRepoContextMenu: (e: React.MouseEvent, repoId: string) => void;
  onOpenAllChanges: (repoId: string) => void;
  iconTheme?: IconThemeData | null;
  activeFolderPath?: string | null;
  ctxFile?: { repoId: string; path: string } | null;
}

export function ProjectGroup({
  repoStatus, repoName, repoColor, multiRepo, isFirst = false,
  isSubmodule, submodulePath, isWorktree, mainWorktreePath,
  selectedFile, viewMode,
  isFileSelected, isCollapsed, toggleCollapsed,
  onToggleFile, onSetFiles, onSelectFile, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge,
  onBranchClick, onRepoContextMenu, onOpenAllChanges, iconTheme, activeFolderPath, ctxFile,
}: Props) {
  const repoId = repoStatus.repoId;
  const collapsed = isCollapsed(repoId);
  const branchClr = branchColor(repoStatus.branch.name);

  const fileMap = new Map<string, FileStatus>();
  for (const f of repoStatus.unstagedFiles) fileMap.set(f.path, f);
  for (const f of repoStatus.stagedFiles) fileMap.set(f.path, f);
  const allFiles = Array.from(fileMap.values());

  const totalFiles = allFiles.length;
  const selectedCount = allFiles.filter(f => isFileSelected(repoId, f.path)).length;
  const allSelected = totalFiles > 0 && selectedCount === totalFiles;
  const someSelected = selectedCount > 0 && !allSelected;

  const toggleAll = () => {
    onSetFiles(repoId, allFiles.map(f => f.path), !allSelected);
  };

  const [hovered, setHovered] = useState(false);

  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <div style={styles.container(isFirst)}>
      <div
        style={styles.header(repoColor)}
        onContextMenu={e => { e.preventDefault(); onRepoContextMenu(e, repoId); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allSelected}
          onChange={toggleAll}
          onClick={(e) => e.stopPropagation()}
          style={styles.repoCheckbox}
          title="Select all files in this repo"
        />

        <div style={styles.headerMain} onClick={() => toggleCollapsed(repoId)}>
          <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={styles.chevron} />
          <span style={styles.dot(repoColor)} />
          <span style={styles.name}>
            {isWorktree && mainWorktreePath ? mainWorktreePath.split('/').pop() ?? repoName : repoName}
          </span>
          {isSubmodule && (
            <span style={styles.submoduleBadge} title={submodulePath ? `Submodule: ${submodulePath}` : 'Submodule'}>
              SUB
            </span>
          )}
          <span
            style={styles.branchBadge(branchClr)}
            onClick={(e) => { e.stopPropagation(); onBranchClick(repoId); }}
            title={repoStatus.branch.detachedTag ? `Tag: ${repoStatus.branch.detachedTag} (detached HEAD)` : repoStatus.branch.detachedHash ? `Detached HEAD at ${repoStatus.branch.detachedHash}` : repoStatus.branch.name}
          >
            <Codicon name={isWorktree ? 'repo-clone' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0, opacity: 0.8 }} />
            <span style={styles.branchName}>{repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name}</span>
          </span>
          {totalFiles > 0 && (
            <div style={styles.rightGroup}>
              <button
                data-action-btn=""
                style={{ ...styles.openChangesBtn, opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none' }}
                onClick={e => { e.stopPropagation(); onOpenAllChanges(repoId); }}
                title="Open all changes"
              >
                <Codicon name="diff-multiple" />
              </button>
              <span style={styles.countBadge(selectedCount > 0)}>
                {selectedCount}/{totalFiles}
              </span>
            </div>
          )}
        </div>
      </div>

      {!collapsed && (
        <div style={styles.body}>
          {allFiles.length > 0 ? (
            <FileTree
              repoId={repoId}
              files={allFiles}
              iconTheme={iconTheme}
              selectedFile={selectedFile}
              onSelect={onSelectFile}
              onToggleFile={onToggleFile}
              onSetFiles={onSetFiles}
              isFileSelected={isFileSelected}
              isCollapsed={isCollapsed}
              toggleCollapsed={toggleCollapsed}
              onContextMenu={onContextMenu}
              onFolderContextMenu={onFolderContextMenu}
              onOpenFile={onOpenFile}
              onRollback={onRollback}
              onResolveMerge={onResolveMerge}
              viewMode={viewMode}
              activeFolderPath={activeFolderPath}
              ctxFile={ctxFile}
            />
          ) : (
            <div style={styles.noChanges}>No changes</div>
          )}
        </div>
      )}
    </div>
  );
}

interface SingleRepoHeaderProps {
  repoStatus: RepoStatus;
  repoName: string;
  repoColor: string;
  isSubmodule?: boolean;
  submodulePath?: string;
  isWorktree?: boolean;
  mainWorktreePath?: string;
  onBranchClick: (repoId: string) => void;
  onRepoContextMenu: (e: React.MouseEvent, repoId: string) => void;
  onOpenAllChanges: (repoId: string) => void;
  hideOpenChanges?: boolean;
}

export function SingleRepoHeader({ repoStatus, repoName, repoColor, isSubmodule, submodulePath, isWorktree, mainWorktreePath, onBranchClick, onRepoContextMenu, onOpenAllChanges, hideOpenChanges }: SingleRepoHeaderProps) {
  const repoId = repoStatus.repoId;
  const branchClr = branchColor(repoStatus.branch.name);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={styles.header(repoColor)}
      onContextMenu={e => { e.preventDefault(); onRepoContextMenu(e, repoId); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={styles.headerMain} onClick={() => onBranchClick(repoId)}>
        <span style={styles.dot(repoColor)} />
        <span style={styles.name}>
          {isWorktree && mainWorktreePath ? mainWorktreePath.split('/').pop() ?? repoName : repoName}
        </span>
        {isSubmodule && (
          <span style={styles.submoduleBadge} title={submodulePath ? `Submodule: ${submodulePath}` : 'Submodule'}>
            SUB
          </span>
        )}
        <span
          style={styles.branchBadge(branchClr)}
          onClick={e => { e.stopPropagation(); onBranchClick(repoId); }}
          title={repoStatus.branch.detachedTag ? `Tag: ${repoStatus.branch.detachedTag} (detached HEAD)` : repoStatus.branch.detachedHash ? `Detached HEAD at ${repoStatus.branch.detachedHash}` : repoStatus.branch.name}
        >
          <Codicon name={isWorktree ? 'repo-clone' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0, opacity: 0.8 }} />
          <span style={styles.branchName}>{repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name}</span>
        </span>
        {!hideOpenChanges && (
          <div style={styles.rightGroup}>
            <button
              data-action-btn=""
              style={{ ...styles.openChangesBtn, opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none' }}
              onClick={e => { e.stopPropagation(); onOpenAllChanges(repoId); }}
              title="Open all changes"
            >
              <Codicon name="diff-multiple" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: (_isFirst: boolean): React.CSSProperties => ({
  }),
  header: (color: string): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    background: color + '14',
    borderBottom: '1px solid var(--vscode-panel-border)',
    height: '26px',
    boxSizing: 'border-box',
  }),
  repoCheckbox: {
    margin: '0 0 0 6px',
    flexShrink: 0,
    accentColor: 'var(--vscode-button-background)',
  } as React.CSSProperties,
  headerMain: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 8px 3px 4px',
    cursor: 'pointer',
    flex: 1,
    fontSize: '11px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--vscode-foreground)',
    userSelect: 'none' as const,
    minWidth: 0,
  },
  chevron: {
    fontSize: '12px',
    opacity: 0.7,
    flexShrink: 0,
  },
  dot: (color: string): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  name: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 10,
    minWidth: '20px',
  } as React.CSSProperties,
  submoduleBadge: {
    fontSize: '9px',
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--vscode-badge-foreground)',
    background: 'var(--vscode-badge-background)',
    borderRadius: '3px',
    padding: '1px 4px',
    flexShrink: 0,
    opacity: 0.75,
  } as React.CSSProperties,
  branchBadge: (clr: { bg: string; fg: string; border: string }): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '10px',
    fontWeight: 'normal' as const,
    textTransform: 'none' as const,
    letterSpacing: 0,
    background: clr.bg,
    color: clr.fg,
    border: `1px solid ${clr.border}`,
    borderRadius: '3px',
    padding: '1px 5px',
    flexShrink: 1,
    minWidth: '0',
    maxWidth: '160px',
    marginLeft: '4px',
    cursor: 'pointer',
    overflow: 'hidden',
  }),
  branchName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  rightGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  countBadge: (hasSelected: boolean): React.CSSProperties => ({
    background: hasSelected ? 'var(--vscode-badge-background)' : 'transparent',
    color: hasSelected ? 'var(--vscode-badge-foreground)' : 'var(--vscode-foreground)',
    borderRadius: '8px',
    padding: hasSelected ? '1px 5px' : '0',
    fontSize: '10px',
    fontWeight: 'bold',
    flexShrink: 0,
    opacity: hasSelected ? 1 : 0.4,
    minWidth: '18px',
    textAlign: 'center',
  }),
  openChangesBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: 0.45,
    padding: '2px 4px',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    borderRadius: '3px',
  } as React.CSSProperties,
  body: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  noChanges: {
    padding: '12px 8px',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    opacity: 0.4,
    textAlign: 'center' as const,
  },
};
