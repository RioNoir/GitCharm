import React from 'react';
import type { ChangelistData, FileStatus, RepoMeta, RepoStatus } from '../../shared/types';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../../shared/types';
import type { ViewMode } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { ChangelistGroup } from './ChangelistGroup';
import { SingleRepoHeader } from './ProjectGroup';

interface Props {
  changelists: ChangelistData[];
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
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

export function ChangelistView({
  changelists, repos, repoMetas,
  selectedFile, viewMode,
  isFileSelected, isCollapsed, toggleCollapsed,
  onToggleFile, onSetFiles, onSelectFile, onContextMenu, onFolderContextMenu,
  onOpenFile, onRollback, onResolveMerge, onHeaderContextMenu, onRepoContextMenu, onOpenChanges, onBranchClick, iconTheme, activeFolderPath, ctxFile,
}: Props) {
  // Build a lookup: repoId+path → changelist id
  const fileToChangelist = new Map<string, string>();
  for (const cl of changelists) {
    for (const [repoId, paths] of Object.entries(cl.fileAssignments)) {
      for (const p of paths) fileToChangelist.set(`${repoId}::${p}`, cl.id);
    }
  }

  const metaMap = new Map(repoMetas.map(m => [m.id, m]));
  const multiRepo = repos.length > 1;

  // For each changelist, compute which files (from the live git status) belong to it
  const changelistFiles = new Map<string, Map<string, FileStatus[]>>(); // clId → repoId → files
  for (const cl of changelists) {
    changelistFiles.set(cl.id, new Map());
  }

  for (const r of repos) {
    // Unversioned Files: always computed live from git status (untracked files), never from fileAssignments
    const unvMap = changelistFiles.get(CHANGELIST_UNVERSIONED_ID);
    if (unvMap) {
      const untracked = r.unstagedFiles.filter(f => f.status === 'untracked');
      if (untracked.length > 0) {
        unvMap.set(r.repoId, untracked);
      }
    }

    // All other files: staged + non-untracked unstaged, routed by fileAssignments
    const fileMap = new Map<string, FileStatus>();
    for (const f of r.stagedFiles) fileMap.set(f.path, f);
    for (const f of r.unstagedFiles) {
      if (f.status !== 'untracked') fileMap.set(f.path, f);
    }

    for (const file of fileMap.values()) {
      const key = `${r.repoId}::${file.path}`;
      const clId = fileToChangelist.get(key) ?? CHANGELIST_DEFAULT_ID;

      const clMap = changelistFiles.get(clId);
      if (!clMap) continue;
      if (!clMap.has(r.repoId)) clMap.set(r.repoId, []);
      clMap.get(r.repoId)!.push(file);
    }
  }

  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    onHeaderContextMenu(e, 'empty');
  };

  const singleRepo = !multiRepo && repos.length === 1 ? repos[0] : null;
  const singleMeta = singleRepo ? metaMap.get(singleRepo.repoId) : null;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}
      onContextMenu={handleEmptyContextMenu}
    >
      {singleRepo && (
        <SingleRepoHeader
          repoStatus={singleRepo}
          repoName={singleMeta?.name ?? singleRepo.repoId.split('/').pop() ?? singleRepo.repoId}
          repoColor={singleMeta?.color ?? '#4ec9b0'}
          isSubmodule={singleMeta?.isSubmodule}
          submodulePath={singleMeta?.submodulePath}
          isWorktree={singleMeta?.isWorktree}
          mainWorktreePath={singleMeta?.mainWorktreePath}
          onBranchClick={onBranchClick}
          onRepoContextMenu={(e, rid) => onRepoContextMenu(e, rid)}
          onOpenAllChanges={onOpenChanges}
        />
      )}
      {changelists.map(cl => {
        const clMap = changelistFiles.get(cl.id) ?? new Map<string, FileStatus[]>();
        const repoGroups = Array.from(clMap.entries())
          .filter(([, files]) => files.length > 0)
          .map(([repoId, files]) => {
            const meta = metaMap.get(repoId);
            const repoStatus = repos.find(r => r.repoId === repoId);
            return {
              repoId,
              repoName: meta?.name ?? repoId.split('/').pop() ?? repoId,
              repoColor: meta?.color ?? '#4ec9b0',
              repoStatus,
              files,
              isSubmodule: meta?.isSubmodule,
              submodulePath: meta?.submodulePath,
              isWorktree: meta?.isWorktree,
              mainWorktreePath: meta?.mainWorktreePath,
            };
          });

        // Hide "Unversioned Files" when empty
        if (cl.id === CHANGELIST_UNVERSIONED_ID && repoGroups.length === 0) return null;

        const isFixed = cl.id === CHANGELIST_DEFAULT_ID || cl.id === CHANGELIST_UNVERSIONED_ID;

        return (
          <ChangelistGroup
            key={cl.id}
            changelist={cl}
            repoGroups={repoGroups}
            isFixed={isFixed}
            multiRepo={multiRepo}
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
            onHeaderContextMenu={onHeaderContextMenu}
            onRepoContextMenu={onRepoContextMenu}
            onOpenChanges={onOpenChanges}
            onBranchClick={onBranchClick}
            iconTheme={iconTheme}
            activeFolderPath={activeFolderPath}
            ctxFile={ctxFile}
          />
        );
      })}
      {/* Spacer to ensure the empty area below also captures right-click */}
      <div style={{ flex: 1, minHeight: '40px' }} onContextMenu={e => { e.preventDefault(); onHeaderContextMenu(e, 'empty'); }} />
    </div>
  );
}
