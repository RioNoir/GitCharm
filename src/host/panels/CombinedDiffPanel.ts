import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { EMPTY_TREE } from '../git/combinedChanges';
import type { CommitSelectionGroup } from '../types/messages';
import { showGitError } from '../utils/gitErrorUtils';
import { logWarn } from '../utils/Logger';
import { plural } from '../utils/plural';

function gitUri(rootPath: string, ref: string, filePath: string): vscode.Uri {
  const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
  return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
}

/**
 * Opens one file of a multi-commit selection. With `baseRef`/`headRef` (combined mode) the diff
 * spans exactly those; otherwise it spans the oldest to the newest of `hashes` (snapshot mode).
 */
export async function openRangeFileDiff(
  manager: WorkspaceGitManager,
  repoId: string,
  hashes: string[],
  filePath: string,
  status?: string,
  oldPath?: string,
  baseRef?: string,
  headRef?: string,
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
    return;
  }

  try {
    let base = baseRef;
    let head = headRef;
    if (!base || !head) {
      const ordered = await repo.getCombinedFilesOrder(hashes);
      base = ordered[0];
      head = ordered[ordered.length - 1];
    }
    if (!base || !head) return;
    const originalPath = oldPath ?? filePath;
    const original = gitUri(repo.rootPath, status === 'A' ? EMPTY_TREE : base, originalPath);
    const modified = gitUri(repo.rootPath, status === 'D' ? EMPTY_TREE : head, filePath);
    const baseLabel = base === EMPTY_TREE ? '∅' : base.slice(0, 7);
    const title = `${path.basename(filePath)} (${baseLabel}…${head.slice(0, 7)})`;
    await vscode.commands.executeCommand('vscode.diff', original, modified, title);
  } catch (e: unknown) {
    showGitError('rangeDiff', e);
  }
}

/** Opens the combined changes of the selected commits — of one repo or several — in a multi-file diff editor. */
export async function openCombinedDiffPanel(
  _extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  groups: CommitSelectionGroup[],
): Promise<void> {
  const commitCount = groups.reduce((n, g) => n + g.hashes.length, 0);
  if (commitCount < 2) {
    logWarn('combinedDiff', 'Select at least 2 commits to view combined diff.');
    vscode.window.showErrorMessage(vscode.l10n.t('Select at least 2 commits to view combined diff.'));
    return;
  }

  const resources: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = [];
  const shortHashes: string[] = [];
  try {
    for (const group of groups) {
      const repo = manager.getRepo(group.repoId);
      if (!repo) {
        logWarn('combinedDiff', `Repository not found: ${group.repoId}`);
        continue;
      }
      const { files, orderedHashes } = await repo.getCombinedChanges(group.hashes);
      shortHashes.push(...orderedHashes.map(h => h.slice(0, 7)));
      for (const f of files) {
        const label = vscode.Uri.file(path.join(repo.rootPath, f.path));
        const original = gitUri(repo.rootPath, f.status === 'A' ? EMPTY_TREE : f.baseRef!, f.oldPath ?? f.path);
        const modified = gitUri(repo.rootPath, f.status === 'D' ? EMPTY_TREE : f.headRef!, f.path);
        resources.push([label, original, modified]);
      }
    }
  } catch (e: unknown) {
    showGitError('combinedDiff', e);
    return;
  }

  if (resources.length === 0) {
    const listed = groups.flatMap(g => g.hashes).map(h => h.slice(0, 7)).join(', ');
    logWarn('combinedDiff', `No files found for the selected commits (hashes: ${listed}).`);
    vscode.window.showWarningMessage(vscode.l10n.t('The selected commits have no changes left once combined ({0}).', listed));
    return;
  }

  const range = shortHashes.length > 0 ? `${shortHashes[0]}…${shortHashes[shortHashes.length - 1]}` : '';
  const title = groups.length > 1
    ? vscode.l10n.t('Combined changes ({0} commits in {1} repositories)', commitCount, groups.length)
    : plural(commitCount, vscode.l10n.t('{0} (1 commit)', range), vscode.l10n.t('{0} ({1} commits)', range, commitCount));
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}
