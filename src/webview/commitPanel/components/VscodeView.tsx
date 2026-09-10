import React, { useState } from 'react';
import type { FileStatus, RepoMeta, RepoStatus } from '../../shared/types';
import type { ViewMode } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { InlineIconBtn } from '../../shared/InlineIconBtn';
import { SingleRepoHeader } from './ProjectGroup';
import { branchColor, tagColor } from '../../shared/branchColors';
import { GenericFileTree } from '../../shared/GenericFileTree';

// ── Types ──────────────────────────────────────────────────────────────────

interface Props {
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
  selectedFile: { repoId: string; path: string } | null;
  ctxFile?: { repoId: string; path: string } | null;
  viewMode: ViewMode;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  hasExpandedDirs: (dirKeys: string[]) => boolean;
  setDirsCollapsed: (dirKeys: string[], collapsed: boolean) => void;
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

// ── Constants ────────────────────────────────────────────────────────────

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

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--vscode-foreground)';
}
function statusLetter(status: string): string {
  return STATUS_LETTERS[status] ?? 'M';
}


// ── Repo sub-group ────────────────────────────────────────────────────────

interface RepoSubGroupProps {
  repoStatus: RepoStatus;
  repoName: string;
  repoColor: string;
  staged: boolean;
  isFirst?: boolean;
  /** Suppresses the group's bottom border when it's the last repo group in its section — avoids a dangling border with nothing below to visually merge into. */
  isLast?: boolean;
  files: FileStatus[];
  viewMode: ViewMode;
  selectedFile: { repoId: string; path: string } | null;
  ctxFile?: { repoId: string; path: string } | null;
  iconTheme?: IconThemeData | null;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  hasExpandedDirs: (dirKeys: string[]) => boolean;
  setDirsCollapsed: (dirKeys: string[], collapsed: boolean) => void;
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

function VscodeRepoGroup({ repoStatus, repoName, repoColor, staged, files, viewMode, selectedFile, ctxFile, iconTheme, isCollapsed, toggleCollapsed, hasExpandedDirs, setDirsCollapsed, activeFolderPath, onSelectFile, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge, onStageFiles, onUnstageFiles, onRepoContextMenu, onBranchClick, onOpenChanges, isFirst = false, isLast = false, repoSelected, onToggleRepoSelection, singleRepo, isSubmodule, submodulePath, isWorktree, mainWorktreePath, onMultiSelect, multiSelectedFiles }: RepoSubGroupProps) {
  const repoId = repoStatus.repoId;
  const collapseKey = `vscode-repo-${staged ? 'staged' : 'unstaged'}:${repoId}`;
  const dirKeys: string[] = [];
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirKeys.push(`vscode-${staged ? 'staged' : 'unstaged'}-${repoId}:${parts.slice(0, i).join('/')}`);
  }
  const expanded = viewMode === 'tree' && hasExpandedDirs(dirKeys);
  const isEmpty = files.length === 0;
  // Empty repos default to collapsed; key presence means "explicitly opened"
  const collapsed = isEmpty ? !isCollapsed(collapseKey) : isCollapsed(collapseKey);
  const branchClr = repoStatus.branch.detachedTag ? tagColor() : branchColor(repoStatus.branch.name, false);
  const [hovered, setHovered] = useState(false);
  const [branchHovered, setBranchHovered] = useState(false);

  const onStage   = (file: FileStatus) => onStageFiles([file.path]);
  const onUnstage = (file: FileStatus) => onUnstageFiles([file.path]);
  const onStageFolder   = (fs: FileStatus[]) => onStageFiles(fs.map(f => f.path));
  const onUnstageFolder = (fs: FileStatus[]) => onUnstageFiles(fs.map(f => f.path));

  const dirCollapseKey = (dirPath: string) => `vscode-${staged ? 'staged' : 'unstaged'}-${repoId}:${dirPath}`;

  const isFileSelected = (file: FileStatus) =>
    (selectedFile?.repoId === file.repoId && selectedFile.path === file.path) ||
    (multiSelectedFiles?.some(f => f.repoId === file.repoId && f.path === file.path) ?? false);

  const isFileContextActive = (file: FileStatus) =>
    ctxFile?.repoId === file.repoId && ctxFile.path === file.path;

  const handleOpenFile = (file: FileStatus, e: React.MouseEvent) => {
    if (file.status === 'submodule') return;
    if ((e.metaKey || e.ctrlKey) && onMultiSelect) {
      e.stopPropagation();
      onMultiSelect(file);
      return;
    }
    onSelectFile(file);
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
              style={branchBadgeStyle(branchClr, branchHovered)}
              onClick={e => { e.stopPropagation(); onBranchClick(repoId); }}
              onMouseEnter={e => { e.stopPropagation(); setBranchHovered(true); }}
              onMouseLeave={e => { e.stopPropagation(); setBranchHovered(false); }}
              title={repoStatus.branch.detachedTag ? `Tag: ${repoStatus.branch.detachedTag} (detached HEAD)` : repoStatus.branch.detachedHash ? `Detached HEAD at ${repoStatus.branch.detachedHash}` : repoStatus.branch.name}
            >
              <Codicon name={isWorktree ? 'worktree' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0, opacity: 0.8 }} />
              <span style={branchNameStyle}>{repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name}</span>
            </span>
          </div>
          {!isEmpty && (
            <div style={repoActionsStyle}>
              {viewMode === 'tree' && !collapsed && dirKeys.length > 0 && (
                <InlineIconBtn
                  icon={expanded ? 'collapse-all' : 'expand-all'}
                  title={expanded ? 'Collapse' : 'Expand'}
                  visible={hovered}
                  onClick={e => { e.stopPropagation(); setDirsCollapsed(dirKeys, expanded); }}
                />
              )}
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
      {!collapsed && !isEmpty && (
        <GenericFileTree<FileStatus>
          files={files}
          viewMode={viewMode}
          iconTheme={iconTheme}
          statusColor={statusColor}
          statusLetter={statusLetter}
          isDirOpen={dirPath => !isCollapsed(dirCollapseKey(dirPath))}
          toggleDir={dirPath => toggleCollapsed(dirCollapseKey(dirPath))}
          isFileSelected={isFileSelected}
          isFileContextActive={isFileContextActive}
          onOpenFile={handleOpenFile}
          onContextMenuFile={(e, file) => onContextMenu(e, file)}
          onContextMenuDir={(e, dirPath, files) => onFolderContextMenu(e, repoId, dirPath, files)}
          isDirContextActive={dirPath => activeFolderPath === dirPath}
          renderFileActions={(file, hovered) => file.status === 'submodule' ? null : (
            <>
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
            </>
          )}
          renderDirActions={(dirFiles, hovered) => (
            <>
              {!staged && (
                <InlineIconBtn icon="discard" title="Rollback folder" visible={hovered} onClick={e => { e.stopPropagation(); onRollback(dirFiles); }} />
              )}
              {staged ? (
                <InlineIconBtn icon="remove" title="Unstage folder" visible={hovered} onClick={e => { e.stopPropagation(); onUnstageFolder(dirFiles); }} />
              ) : (
                <InlineIconBtn icon="add" title="Stage folder" visible={hovered} onClick={e => { e.stopPropagation(); onStageFolder(dirFiles); }} />
              )}
            </>
          )}
        />
      )}
      {!isLast && <div style={{ borderBottom: '1px solid var(--vscode-panel-border)' }} />}
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
  isCollapsed, toggleCollapsed, hasExpandedDirs, setDirsCollapsed,
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
      {!stagedCollapsed && (() => {
        const stagedRepos = repos.filter(r => r.stagedFiles.length > 0);
        return stagedRepos.map((r, idx) => {
          const meta = metaMap.get(r.repoId);
          return (
            <VscodeRepoGroup
              key={r.repoId}
              isFirst={idx === 0}
              isLast={idx === stagedRepos.length - 1}
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
              hasExpandedDirs={hasExpandedDirs}
              setDirsCollapsed={setDirsCollapsed}
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
        });
      })()}

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
      {!unstagedCollapsed && (() => {
        const unstagedRepos = repos.filter(r => r.stagedFiles.length === 0 || r.unstagedFiles.length > 0);
        return unstagedRepos.map((r, idx) => {
          const meta = metaMap.get(r.repoId);
          return (
            <VscodeRepoGroup
              key={r.repoId}
              isFirst={idx === 0}
              isLast={idx === unstagedRepos.length - 1}
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
              hasExpandedDirs={hasExpandedDirs}
              setDirsCollapsed={setDirsCollapsed}
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
        });
      })()}

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
  background: `color-mix(in srgb, ${color} 8%, var(--vscode-sideBar-background))`,
  height: '26px',
  boxSizing: 'border-box',
  minWidth: 0,
  // Sticks just below the section header (Staged Changes / Changes) above it, which is itself sticky at top:0.
  position: 'sticky', top: '26px', zIndex: 1,
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

/** `hovered` mirrors the Log panel's "selected row" badge look — solid background instead of the usual 20%-tint. */
const branchBadgeStyle = (color: string, hovered = false): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: '3px',
  fontSize: '10px', fontWeight: 600, textTransform: 'none', letterSpacing: 0,
  background: hovered ? color : `${color}33`,
  color: hovered ? 'var(--vscode-editor-background)' : color,
  border: `1px solid ${hovered ? color : `${color}88`}`,
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

const repoActionsStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0', flexShrink: 0, paddingRight: '8px',
};

const submoduleBadgeStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--vscode-badge-foreground)', background: 'var(--vscode-badge-background)',
  borderRadius: '3px', padding: '1px 4px', flexShrink: 0, opacity: 0.75,
};
