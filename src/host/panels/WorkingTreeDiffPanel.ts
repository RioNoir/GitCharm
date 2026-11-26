import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { compareFileWithRef, openWorkingTreeFileChanges } from './CompareWithCommand';
import { showGitError } from '../utils/gitErrorUtils';

export interface BranchDiffFile { path: string; status: string; oldPath?: string }
export interface BranchDiffGroup { repoId: string; ref: string; files: BranchDiffFile[] }

/** Changed files per repository. `null` when a repository could not be read (already reported). */
export async function loadBranchDiffGroups(
  manager: WorkspaceGitManager,
  refs: { repoId: string; ref: string }[],
): Promise<BranchDiffGroup[] | null> {
  const groups: BranchDiffGroup[] = [];
  let failed = false;
  const seen = new Set<string>();
  for (const target of refs) {
    if (seen.has(target.repoId)) continue;
    seen.add(target.repoId);
    const repo = manager.getRepo(target.repoId);
    if (!repo) {
      failed = true;
      vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
      continue;
    }
    try {
      await repo.resolveRef(target.ref);
      const files = (await repo.getRefVsWorkingTreeFiles(target.ref, '')).filter(file => file.status !== 'U');
      if (files.length > 0) groups.push({ repoId: target.repoId, ref: target.ref, files });
    } catch (e: unknown) {
      failed = true;
      showGitError('diffWithWorkingTree', e);
    }
  }
  if (groups.length === 0 && failed) return null;
  return groups;
}

export async function showBranchFileDiff(
  manager: WorkspaceGitManager,
  file: { repoId: string; ref: string; filePath: string; status: string; oldPath?: string },
): Promise<void> {
  const repo = manager.getRepo(file.repoId);
  if (!repo) {
    vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
    return;
  }
  try {
    await compareFileWithRef(repo, file.filePath, file.ref, { status: file.status, oldPath: file.oldPath }, {
      preview: true,
      viewColumn: vscode.ViewColumn.Active,
    });
  } catch (e: unknown) {
    showGitError('diffWithWorkingTree', e);
  }
}

export async function showBranchDirDiff(
  manager: WorkspaceGitManager,
  dir: { repoId: string; ref: string; dirPath: string; files: BranchDiffFile[] },
  titleLabel: string,
): Promise<void> {
  const repo = manager.getRepo(dir.repoId);
  if (!repo) {
    vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
    return;
  }
  try {
    if (dir.files.length === 1) {
      const file = dir.files[0];
      await compareFileWithRef(repo, file.path, dir.ref, file, { preview: true, viewColumn: vscode.ViewColumn.Active });
      return;
    }
    await openWorkingTreeFileChanges(
      repo,
      dir.ref,
      dir.files,
      vscode.l10n.t('{0} (Working Tree) vs {1}', dir.dirPath, titleLabel || dir.ref),
    );
  } catch (e: unknown) {
    showGitError('diffWithWorkingTree', e);
  }
}

/** Asks, then makes the working tree match the branch for these files. Returns whether it ran. */
export async function takeBranchFiles(
  manager: WorkspaceGitManager,
  target: { repoId: string; ref: string; label: string; files: BranchDiffFile[]; targetPath: string },
): Promise<boolean> {
  const repo = manager.getRepo(target.repoId);
  if (!repo) {
    vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
    return false;
  }
  if (target.files.length === 0) return false;
  const replace = vscode.l10n.t('Get from Branch');
  const prompt = target.files.length === 1
    ? vscode.l10n.t('Update "{0}" to match "{1}"? Changes to this file in the working tree will be lost.', target.files[0].path, target.label)
    : vscode.l10n.t('Update {0} files under "{1}" to match "{2}"? Changes to these files in the working tree will be lost.', target.files.length, target.targetPath, target.label);
  const choice = await vscode.window.showWarningMessage(prompt, { modal: true }, replace);
  if (choice !== replace) return false;
  try {
    const paths = target.files.flatMap(file => file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path]);
    await repo.takePathsFromRef(target.ref, paths);
    return true;
  } catch (e: unknown) {
    showGitError('diffWithWorkingTree', e);
    return false;
  }
}
