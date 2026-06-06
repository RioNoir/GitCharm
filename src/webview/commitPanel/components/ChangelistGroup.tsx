import React, { useEffect, useRef, useState } from 'react';
import type { ChangelistData, FileStatus, RepoStatus } from '../../shared/types';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../../shared/types';
import type { ViewMode } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { FileTree } from './FileTree';
import { Codicon } from '../../shared/Codicon';

// ── Branch color (same logic as ProjectGroup) ─────────────────────────────────

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

function branchColor(name: string): { bg: string; fg: string; border: string } {
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

export interface RepoFileGroup {
  repoId: string;
  repoName: string;
  repoColor: string;
  repoStatus?: RepoStatus;
  files: FileStatus[];
  isSubmodule?: boolean;
  submodulePath?: string;
}

interface Props {
  changelist: ChangelistData;
  repoGroups: RepoFileGroup[];
  isFixed: boolean;
  multiRepo: boolean;
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
  onHeaderContextMenu: (e: React.MouseEvent, changelistId: string) => void;
  onRepoContextMenu: (e: React.MouseEvent, repoId: string, changelistId?: string) => void;
  onOpenChanges: (repoId: string) => void;
  onBranchClick: (repoId: string) => void;
  iconTheme?: IconThemeData | null;
  activeFolderPath?: string | null;
  ctxFile?: { repoId: string; path: string } | null;
}

export function ChangelistGroup({
  changelist, repoGroups, isFixed, multiRepo,
  selectedFile, viewMode,
  isFileSelected, isCollapsed, toggleCollapsed,
  onToggleFile, onSetFiles, onSelectFile, onContextMenu, onFolderContextMenu,
  onOpenFile, onRollback, onResolveMerge, onHeaderContextMenu, onRepoContextMenu, onOpenChanges, onBranchClick, iconTheme, activeFolderPath, ctxFile,
}: Props) {
  const collapseKey = `cl:${changelist.id}`;
  const collapsed = isCollapsed(collapseKey);

  const allFiles = repoGroups.flatMap(g => g.files);
  const totalFiles = allFiles.length;
  const selectedCount = allFiles.filter(f => isFileSelected(f.repoId, f.path)).length;
  const allSelected = totalFiles > 0 && selectedCount === totalFiles;
  const someSelected = selectedCount > 0 && !allSelected;

  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const g of repoGroups) {
      onSetFiles(g.repoId, g.files.map(f => f.path), !allSelected);
    }
  };

  const isUnversioned = changelist.id === CHANGELIST_UNVERSIONED_ID;
  const isDefault = changelist.id === CHANGELIST_DEFAULT_ID;
  const headerIcon = isUnversioned ? 'question' : isDefault ? 'source-control' : 'list-unordered';

  return (
    <div style={styles.container}>
      <div
        style={styles.header}
        onContextMenu={e => { e.preventDefault(); onHeaderContextMenu(e, changelist.id); }}
      >
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allSelected}
          onChange={() => {}}
          onClick={toggleAll}
          style={styles.clCheckbox}
          title="Select all files in this changelist"
        />
        <div style={styles.headerMain} onClick={() => toggleCollapsed(collapseKey)}>
          <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={styles.chevron} />
          <Codicon name={headerIcon} style={{ ...styles.clIcon, opacity: isUnversioned ? 0.6 : 0.8 }} />
          <span style={styles.clName}>{changelist.name}</span>
          <div style={styles.rightGroup}>
            {totalFiles > 0 && (
              <span style={styles.countBadge(selectedCount > 0)}>
                {selectedCount}/{totalFiles}
              </span>
            )}
          </div>
        </div>
      </div>

      {!collapsed && (
        <div style={styles.body}>
          {repoGroups.length === 0 ? (
            <div style={styles.empty}>No files</div>
          ) : (
            repoGroups.map((group, idx) => (
              <RepoSubGroup
                key={group.repoId}
                isFirst={idx === 0}
                repoId={group.repoId}
                repoName={group.repoName}
                repoColor={group.repoColor}
                repoStatus={group.repoStatus}
                files={group.files}
                multiRepo={multiRepo}
                isSubmodule={group.isSubmodule}
                submodulePath={group.submodulePath}
                selectedFile={selectedFile}
                viewMode={viewMode}
                isFileSelected={isFileSelected}
                isCollapsed={isCollapsed}
                toggleCollapsed={toggleCollapsed}
                onToggleFile={onToggleFile}
                onSetFiles={onSetFiles}
                onSelectFile={onSelectFile}
                onContextMenu={onContextMenu}
                onFolderContextMenu={onFolderContextMenu}
                onOpenFile={onOpenFile}
                onRollback={onRollback}
                onResolveMerge={onResolveMerge}
                onRepoContextMenu={onRepoContextMenu}
                onOpenChanges={onOpenChanges}
                onBranchClick={onBranchClick}
                iconTheme={iconTheme}
                activeFolderPath={activeFolderPath}
                changelistId={changelist.id}
                ctxFile={ctxFile}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Repo sub-group inside a changelist ────────────────────────────────────────

interface RepoSubGroupProps {
  repoId: string;
  repoName: string;
  repoColor: string;
  repoStatus?: RepoStatus;
  files: FileStatus[];
  multiRepo: boolean;
  isSubmodule?: boolean;
  submodulePath?: string;
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
  onRepoContextMenu: (e: React.MouseEvent, repoId: string, changelistId?: string) => void;
  onOpenChanges: (repoId: string) => void;
  onBranchClick: (repoId: string) => void;
  iconTheme?: IconThemeData | null;
  activeFolderPath?: string | null;
  changelistId?: string;
  ctxFile?: { repoId: string; path: string } | null;
  isFirst?: boolean;
}

function RepoSubGroup({
  repoId, repoName, repoColor, repoStatus, files, multiRepo, isSubmodule, submodulePath,
  selectedFile, viewMode,
  isFileSelected, isCollapsed, toggleCollapsed,
  onToggleFile, onSetFiles, onSelectFile, onContextMenu, onFolderContextMenu,
  onOpenFile, onRollback, onResolveMerge, onRepoContextMenu, onOpenChanges, onBranchClick, iconTheme, activeFolderPath, changelistId, ctxFile, isFirst = false,
}: RepoSubGroupProps) {
  const collapseKey = `cl-repo:${repoId}`;
  const collapsed = isCollapsed(collapseKey);
  const totalFiles = files.length;
  const selectedCount = files.filter(f => isFileSelected(repoId, f.path)).length;
  const allSelected = totalFiles > 0 && selectedCount === totalFiles;
  const someSelected = selectedCount > 0 && !allSelected;

  const branchClr = repoStatus ? branchColor(repoStatus.branch.name) : branchColor('main');
  const [hovered, setHovered] = useState(false);

  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSetFiles(repoId, files.map(f => f.path), !allSelected);
  };

  return (
    <div style={styles.repoSubGroup(isFirst)}>
      {multiRepo && (
        <div
          style={styles.repoHeader(repoColor)}
          onContextMenu={e => { e.preventDefault(); onRepoContextMenu(e, repoId, changelistId); }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={allSelected}
            onChange={() => {}}
            onClick={toggleAll}
            style={styles.repoCheckbox}
            title={`Select all files in ${repoName}`}
          />
          <div style={styles.repoHeaderMain} onClick={() => toggleCollapsed(collapseKey)}>
            <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={styles.repoChevron} />
            <span style={styles.repoDot(repoColor)} />
            <span style={styles.repoName}>{repoName}</span>
            {isSubmodule && (
              <span style={styles.submoduleBadge} title={submodulePath ? `Submodule: ${submodulePath}` : 'Submodule'}>SUB</span>
            )}
            {repoStatus && (
              <span
                style={styles.branchBadge(branchClr)}
                onClick={e => { e.stopPropagation(); onBranchClick(repoId); }}
                title={repoStatus.branch.detachedTag ? `Tag: ${repoStatus.branch.detachedTag} (detached HEAD)` : repoStatus.branch.detachedHash ? `Detached HEAD at ${repoStatus.branch.detachedHash}` : repoStatus.branch.name}
              >
                <Codicon
                  name={repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'}
                  style={{ fontSize: '10px', flexShrink: 0, opacity: 0.8 }}
                />
                <span style={styles.branchName}>
                  {repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name}
                </span>
              </span>
            )}
            <div style={styles.repoRightGroup}>
              <button
                data-action-btn=""
                style={{ ...styles.openChangesBtn, opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none' }}
                title="Open all changes"
                onClick={e => { e.stopPropagation(); onOpenChanges(repoId); }}
              >
                <Codicon name="diff-multiple" />
              </button>
              {totalFiles > 0 && (
                <span style={styles.repoCountBadge(selectedCount > 0)}>
                  {selectedCount}/{totalFiles}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
      {(!multiRepo || !collapsed) && (
        <FileTree
          repoId={repoId}
          files={files}
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
          basePad={multiRepo ? 36 : 24}
          activeFolderPath={activeFolderPath}
          ctxFile={ctxFile}
        />
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  container: {
    borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,

  // Changelist header — accent left border + solid background for clear hierarchy
  header: {
    display: 'flex',
    alignItems: 'center',
    background: 'var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.15))',
    borderLeft: '3px solid var(--vscode-focusBorder, var(--vscode-button-background, #007acc))',
    borderBottom: '1px solid var(--vscode-panel-border)',
    cursor: 'default',
    height: '26px',
    boxSizing: 'border-box',
  } as React.CSSProperties,

  // Changelist-level checkbox (leftmost) — margin compensates for 3px accent border
  clCheckbox: {
    margin: '0 0 0 3px',
    flexShrink: 0,
    accentColor: 'var(--vscode-button-background)',
  } as React.CSSProperties,

  headerMain: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 8px 3px 4px',
    cursor: 'pointer',
    flex: 1,
    fontSize: '11px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--vscode-sideBarSectionHeader-foreground)',
    userSelect: 'none' as const,
    minWidth: 0,
    overflow: 'hidden',
  },
  chevron: {
    fontSize: '12px',
    opacity: 0.7,
    flexShrink: 0,
  },
  clIcon: {
    fontSize: '13px',
    flexShrink: 0,
  },
  clName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 1,
    minWidth: '20px',
  } as React.CSSProperties,
  rightGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
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
  }),
  body: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  empty: {
    padding: '8px 24px',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    opacity: 0.4,
  },

  repoSubGroup: (_isFirst: boolean): React.CSSProperties => ({
  }),
  repoHeader: (color: string): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    background: color + '14',
    borderBottom: '1px solid var(--vscode-panel-border)',
    height: '26px',
    boxSizing: 'border-box',
  }),

  // Repo checkbox indented one level from changelist checkbox
  repoCheckbox: {
    margin: '0 0 0 18px',
    flexShrink: 0,
    accentColor: 'var(--vscode-button-background)',
  } as React.CSSProperties,

  repoHeaderMain: {
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
    color: 'var(--vscode-sideBarSectionHeader-foreground)',
    userSelect: 'none' as const,
    minWidth: 0,
    overflow: 'hidden',
  },
  repoChevron: {
    fontSize: '12px',
    opacity: 0.7,
    flexShrink: 0,
  },
  repoDot: (color: string): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  repoName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 10,
    minWidth: '20px',
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
    overflow: 'hidden',
  }),
  branchName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  repoRightGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  openChangesBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: 0.7,
    padding: '2px 2px',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    borderRadius: '3px',
  } as React.CSSProperties,
  repoCountBadge: (hasSelected: boolean): React.CSSProperties => ({
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    borderRadius: '8px',
    padding: '0',
    fontSize: '10px',
    fontWeight: 'bold',
    flexShrink: 0,
    opacity: hasSelected ? 0.8 : 0.35,
  }),
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
};
