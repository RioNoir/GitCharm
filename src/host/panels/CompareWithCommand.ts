import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import { pickRefQuickPick } from '../utils/refPicker';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function gitUri(rootPath: string, ref: string, filePath: string): vscode.Uri {
  const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
  return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
}

export async function compareFileWithRef(repo: GitService, filePath: string, ref: string): Promise<void> {
  const original = gitUri(repo.rootPath, ref, filePath);
  const modified = vscode.Uri.file(path.join(repo.rootPath, filePath));
  await vscode.commands.executeCommand('vscode.diff', original, modified, `${filePath} (Working Tree) vs ${ref}`);
}

export async function compareFolderWithRef(repo: GitService, folderPath: string, ref: string): Promise<void> {
  const files = await repo.getRefVsWorkingTreeFiles(ref, folderPath);
  const resources = files
    .filter(f => f.status !== 'U')
    .map(f => {
      const label = vscode.Uri.file(path.join(repo.rootPath, f.path));
      const original = gitUri(repo.rootPath, f.status === 'A' ? EMPTY_TREE : ref, f.path);
      const modified = vscode.Uri.file(path.join(repo.rootPath, f.path));
      return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
    });
  const title = `${folderPath || path.basename(repo.rootPath)} vs ${ref}`;
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

export async function compareWithCommand(manager: WorkspaceGitManager, fileUri: vscode.Uri): Promise<void> {
  const metas = manager.getRepoMetas();
  const meta = metas.find(m => fileUri.fsPath.startsWith(m.rootPath + path.sep) || fileUri.fsPath === m.rootPath)
    ?? metas.find(m => fileUri.fsPath.startsWith(m.rootPath));
  if (!meta) {
    vscode.window.showErrorMessage('No git repository found for this path.');
    return;
  }
  const repo = manager.getRepo(meta.id);
  if (!repo) {
    vscode.window.showErrorMessage('Repository not found.');
    return;
  }

  const relPath = path.relative(meta.rootPath, fileUri.fsPath).replace(/\\/g, '/');

  let isDirectory = false;
  try {
    const stat = await vscode.workspace.fs.stat(fileUri);
    isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    vscode.window.showErrorMessage('Path not found.');
    return;
  }

  const pickedRef = await pickRefQuickPick(repo, {
    placeHolder: `Compare ${relPath || '.'} with…`,
    title: 'GitCharm - Compare With',
  });
  if (!pickedRef) return;

  let refHash: string;
  try {
    refHash = await repo.resolveRef(pickedRef);
  } catch {
    vscode.window.showErrorMessage(`Cannot resolve ref "${pickedRef}"`);
    return;
  }

  if (isDirectory) {
    await compareFolderWithRef(repo, relPath, refHash);
  } else {
    await compareFileWithRef(repo, relPath, refHash);
  }
}
