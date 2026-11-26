import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import { pickRefQuickPick } from '../utils/refPicker';
import { logWarn, logError } from '../utils/Logger';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function gitUri(rootPath: string, ref: string, filePath: string): vscode.Uri {
  const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
  return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
}

/** The two sides of a working-tree diff, and the editor title that shows them. */
export function workingTreeFileDiff(
  repo: GitService,
  filePath: string,
  ref: string,
  file?: { status?: string; oldPath?: string },
): { original: vscode.Uri; modified: vscode.Uri; title: string } {
  const status = file?.status ?? 'M';
  const added = status === 'A' || status === 'C' || status === 'U';
  const originalPath = status === 'R' ? (file?.oldPath ?? filePath) : filePath;
  const original = gitUri(repo.rootPath, added ? EMPTY_TREE : ref, originalPath);
  const modified = status === 'D'
    ? gitUri(repo.rootPath, EMPTY_TREE, filePath)
    : vscode.Uri.file(path.join(repo.rootPath, filePath));
  return { original, modified, title: vscode.l10n.t('{0} ({1} ↔ Working Tree)', filePath, ref) };
}

export function workingTreeChangesTitle(dirPath: string, label: string): string {
  return vscode.l10n.t('{0} ({1} ↔ Working Tree)', dirPath, label);
}

export async function compareFileWithRef(
  repo: GitService,
  filePath: string,
  ref: string,
  file?: { status?: string; oldPath?: string },
  show?: { preview?: boolean; viewColumn?: vscode.ViewColumn },
): Promise<void> {
  const { original, modified, title } = workingTreeFileDiff(repo, filePath, ref, file);
  const options = show ? { preview: show.preview !== false, viewColumn: show.viewColumn } : undefined;
  await vscode.commands.executeCommand('vscode.diff', original, modified, title, options);
}

/** One editor listing every given file's diff against the working tree. */
export async function openWorkingTreeFileChanges(
  repo: GitService,
  ref: string,
  files: Array<{ path: string; status: string; oldPath?: string }>,
  title: string,
): Promise<void> {
  const resources = files
    .filter(file => file.status !== 'U')
    .map(file => {
      const label = vscode.Uri.file(path.join(repo.rootPath, file.path));
      const added = file.status === 'A' || file.status === 'C' || file.status === 'U';
      const originalPath = file.status === 'R' ? (file.oldPath ?? file.path) : file.path;
      const original = gitUri(repo.rootPath, added ? EMPTY_TREE : ref, originalPath);
      const modified = file.status === 'D'
        ? gitUri(repo.rootPath, EMPTY_TREE, file.path)
        : vscode.Uri.file(path.join(repo.rootPath, file.path));
      return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
    });
  if (resources.length === 0) return;
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

/** Opens the multi-file diff. Returns how many files it showed; 0 when the tree already matches. */
export async function compareFolderWithRef(repo: GitService, folderPath: string, ref: string, title?: string): Promise<number> {
  const files = await repo.getRefVsWorkingTreeFiles(ref, folderPath);
  const resources = files
    .filter(f => f.status !== 'U')
    .map(f => {
      const label = vscode.Uri.file(path.join(repo.rootPath, f.path));
      const added = f.status === 'A' || f.status === 'C' || f.status === 'U';
      const originalPath = f.status === 'R' ? (f.oldPath ?? f.path) : f.path;
      const original = gitUri(repo.rootPath, added ? EMPTY_TREE : ref, originalPath);
      const modified = f.status === 'D'
        ? gitUri(repo.rootPath, EMPTY_TREE, f.path)
        : vscode.Uri.file(path.join(repo.rootPath, f.path));
      return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
    });
  if (resources.length === 0) return 0;
  const resolvedTitle = title ?? vscode.l10n.t('{0} vs {1}', folderPath || path.basename(repo.rootPath), ref);
  await vscode.commands.executeCommand('vscode.changes', resolvedTitle, resources);
  return resources.length;
}

export async function compareWithCommand(manager: WorkspaceGitManager, fileUri: vscode.Uri): Promise<void> {
  const metas = manager.getRepoMetas();
  const meta = metas.find(m => fileUri.fsPath.startsWith(m.rootPath + path.sep) || fileUri.fsPath === m.rootPath)
    ?? metas.find(m => fileUri.fsPath.startsWith(m.rootPath));
  if (!meta) {
    logWarn('compareWith', 'No git repository found for this path.');
    vscode.window.showErrorMessage(vscode.l10n.t('No git repository found for this path.'));
    return;
  }
  const repo = manager.getRepo(meta.id);
  if (!repo) {
    logWarn('compareWith', 'Repository not found.');
    vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
    return;
  }

  const relPath = path.relative(meta.rootPath, fileUri.fsPath).replace(/\\/g, '/');

  let isDirectory = false;
  try {
    const stat = await vscode.workspace.fs.stat(fileUri);
    isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    logWarn('compareWith', 'Path not found.');
    vscode.window.showErrorMessage(vscode.l10n.t('Path not found.'));
    return;
  }

  const pickedRef = await pickRefQuickPick(repo, {
    placeHolder: vscode.l10n.t('Compare {0} with…', relPath || '.'),
    title: vscode.l10n.t('GitCharm - Compare With'),
  });
  if (!pickedRef) return;

  let refHash: string;
  try {
    refHash = await repo.resolveRef(pickedRef);
  } catch {
    logError('compareWith', `Cannot resolve ref "${pickedRef}"`);
    vscode.window.showErrorMessage(vscode.l10n.t('Cannot resolve ref "{0}"', pickedRef));
    return;
  }

  if (isDirectory) {
    await compareFolderWithRef(repo, relPath, refHash);
  } else {
    await compareFileWithRef(repo, relPath, refHash);
  }
}
