import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';

export async function openCombinedDiffPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  repoId: string,
  hashes: string[],
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    vscode.window.showErrorMessage('GitCharm: Repository not found.');
    return;
  }
  if (hashes.length < 2) {
    vscode.window.showErrorMessage('GitCharm: Select at least 2 commits to view combined diff.');
    return;
  }

  let files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
  let commitMetas: Array<{ hash: string; shortHash: string; message: string; authorName: string; authorDate: string }> = [];
  let orderedHashes: string[] = [];

  try {
    [files, commitMetas] = await Promise.all([
      repo.getCombinedFiles(hashes),
      Promise.all(hashes.map(h =>
        repo.getCommitMeta(h).then(m => m
          ? { hash: m.hash, shortHash: m.shortHash, message: m.message, authorName: m.authorName, authorDate: m.authorDate }
          : { hash: h, shortHash: h.slice(0, 7), message: '', authorName: '', authorDate: '' }
        )
      )),
    ]);
    orderedHashes = await repo.getCombinedFilesOrder(hashes);
    commitMetas.sort((a, b) => orderedHashes.indexOf(a.hash) - orderedHashes.indexOf(b.hash));
  } catch (e: unknown) {
    vscode.window.showErrorMessage(`GitCharm: Failed to load combined diff: ${String(e)}`);
    return;
  }

  if (files.length === 0) {
    vscode.window.showWarningMessage(`GitCharm: No files found for the selected commits (hashes: ${hashes.map(h => h.slice(0, 7)).join(', ')}). The commits may not be in the same repository branch.`);
    return;
  }

  const oldest = commitMetas[0];
  const newest = commitMetas[commitMetas.length - 1];
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const rootPath = repo.rootPath;

  const gitUri = (ref: string, filePath: string): vscode.Uri => {
    const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
    return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
  };

  const resources = files
    .filter(f => f.status !== 'U')
    .map(f => {
      const label = vscode.Uri.file(path.join(rootPath, f.path));
      const original = gitUri(f.status === 'A' ? EMPTY_TREE : `${oldest.hash}~1`, f.path);
      const modified = gitUri(f.status === 'D' ? EMPTY_TREE : newest.hash, f.path);
      return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
    });

  const title = `${oldest.shortHash}…${newest.shortHash} (${hashes.length} commits)`;
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

