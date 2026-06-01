import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { parseConflictFile, hasConflictMarkers } from '../git/ConflictParser';
import type { MergeToHostMsg, HostToMergeMsg } from '../types/messages';

export class MergeEditorProvider implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager
  ) {}

  openForFile(filePath: string): void {
    if (this.panels.has(filePath)) {
      this.panels.get(filePath)!.reveal();
      return;
    }

    const fileName = path.basename(filePath);
    const panel = vscode.window.createWebviewPanel(
      'gitcharm.mergeEditor',
      `Merge: ${fileName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      'mergeEditor',
      `Merge: ${fileName}`
    );

    panel.webview.onDidReceiveMessage((msg: MergeToHostMsg) =>
      this.handleMessage(msg, filePath, panel.webview)
    );

    panel.onDidDispose(() => this.panels.delete(filePath));
    this.panels.set(filePath, panel);

    const repoId = this.findRepoForFile(filePath);
    const conflictFile = parseConflictFile(filePath, repoId ?? filePath);
    if (conflictFile) {
      panel.webview.postMessage({ type: 'MERGE_FILE_LOADED', file: conflictFile } satisfies HostToMergeMsg);
    } else {
      vscode.window.showErrorMessage(`GitCharm: No conflict markers found in ${fileName}`);
      panel.dispose();
    }
  }

  private findRepoForFile(filePath: string): string | undefined {
    for (const meta of this.manager.getRepoMetas()) {
      if (filePath.startsWith(meta.rootPath)) return meta.id;
    }
    return undefined;
  }

  private async handleMessage(msg: MergeToHostMsg, filePath: string, webview: vscode.Webview): Promise<void> {
    const post = (m: HostToMergeMsg) => webview.postMessage(m);

    switch (msg.type) {
      case 'MERGE_SAVE_FILE': {
        try {
          fs.writeFileSync(filePath, msg.resolvedContent, 'utf8');
          const repoId = this.findRepoForFile(filePath);
          if (repoId) {
            const repo = this.manager.getRepo(repoId);
            const relPath = path.relative(repo?.rootPath ?? '', filePath);
            await repo?.stageFiles([relPath]);
          }
          post({ type: 'MERGE_SAVE_RESULT', requestId: msg.requestId, ok: true });
          vscode.window.showInformationMessage(`GitCharm: File resolved and staged: ${path.basename(filePath)}`);
          vscode.commands.executeCommand('gitcharm.commitPanel.focus');
        } catch (e: unknown) {
          post({ type: 'MERGE_SAVE_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'MERGE_OPEN_FILE': {
        const uri = vscode.Uri.file(msg.filePath);
        await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
        break;
      }
    }
  }

  openCurrentEditorFile(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('GitCharm: No active file');
      return;
    }
    const filePath = editor.document.uri.fsPath;
    const content = editor.document.getText();
    if (!hasConflictMarkers(content)) {
      vscode.window.showWarningMessage('GitCharm: No conflict markers found in the current file');
      return;
    }
    this.openForFile(filePath);
  }

  dispose(): void {
    this.panels.forEach(p => p.dispose());
    this.panels.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
