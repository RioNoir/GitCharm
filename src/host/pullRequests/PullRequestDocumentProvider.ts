import * as vscode from 'vscode';

/**
 * Virtual document provider for pull request file diffs.
 * URI scheme: gitcharm-pr
 * Content is the raw file content fetched from the forge API at a specific ref (base or head),
 * since a PR's branches generally aren't checked out locally.
 */
export class PullRequestDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'gitcharm-pr';

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private readonly store = new Map<string, string>();

  set(uri: vscode.Uri, content: string): void {
    this.store.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.toString()) ?? '';
  }

  static buildUri(repoId: string, prNumber: number, side: 'base' | 'head', filePath: string): vscode.Uri {
    const fileName = filePath.split('/').pop() ?? filePath;
    return vscode.Uri.from({
      scheme: PullRequestDocumentProvider.scheme,
      authority: 'pr',
      path: `/${encodeURIComponent(repoId)}/${encodeURIComponent(String(prNumber))}/${side}/${fileName}`,
      query: encodeURIComponent(filePath),
    });
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
