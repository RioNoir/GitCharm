import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { panelIcon } from '../utils/panelIcon';
import { webviewReadyGate } from '../utils/webviewReadyGate';
import type { HunkEvent } from '../ai/conflictResolver';
import type { ConflictAiToHostMsg, HostToConflictAiMsg } from '../types/messages';

/**
 * The live view of an AI conflict resolution: one tab beside the editor, reused (and cleared) by each run, so
 * the model's explanation and the resolved lines can be followed as they are written.
 */
export class ConflictAiPanel {
  private static current: ConflictAiPanel | undefined;
  private readonly post: (msg: HostToConflictAiMsg) => void;

  /** Opens the view (or clears the open one) for a new run, without taking the focus. */
  static start(extensionUri: vscode.Uri, modelLabel: string): ConflictAiPanel {
    let view = ConflictAiPanel.current;
    if (view) {
      view.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'gitcharm.conflictAi',
        vscode.l10n.t('AI Conflict Resolution'),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
      );
      view = new ConflictAiPanel(panel, extensionUri);
      ConflictAiPanel.current = view;
    }
    view.post({ type: 'CONFLICTAI_RESET', modelLabel });
    return view;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    panel.iconPath = panelIcon(extensionUri, 'sparkle');
    panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'conflictAi', panel.title);
    const gate = webviewReadyGate<HostToConflictAiMsg>(panel);
    this.post = m => gate.post(m);
    const sub = panel.webview.onDidReceiveMessage(async (msg: ConflictAiToHostMsg) => {
      if (msg.type !== 'CONFLICTAI_OPEN_FILE') return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path));
      const position = new vscode.Position(Math.max(0, msg.line), 0);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(position, position) });
    });
    panel.onDidDispose(() => {
      sub.dispose();
      if (ConflictAiPanel.current === this) ConflictAiPanel.current = undefined;
    });
  }

  file(fileKey: string, path: string): void {
    this.post({ type: 'CONFLICTAI_FILE', fileKey, path });
  }

  hunk(fileKey: string, event: HunkEvent): void {
    switch (event.kind) {
      case 'start': {
        const { hunk } = event;
        this.post({
          type: 'CONFLICTAI_HUNK_START', fileKey, index: event.index, line: hunk.startLine,
          currentLabel: hunk.currentLabel, incomingLabel: hunk.incomingLabel,
          current: hunk.current.join('\n'), incoming: hunk.incoming.join('\n'), base: hunk.base?.join('\n'),
        });
        break;
      }
      case 'progress':
        this.post({ type: 'CONFLICTAI_HUNK_PROGRESS', fileKey, index: event.index, explanation: event.explanation, resolution: event.resolution });
        break;
      case 'done':
        this.post({ type: 'CONFLICTAI_HUNK_DONE', fileKey, index: event.index, explanation: event.explanation, resolution: event.resolution });
        break;
      case 'failed':
        this.post({ type: 'CONFLICTAI_HUNK_FAILED', fileKey, index: event.index, error: event.error });
        break;
    }
  }

  fileDone(fileKey: string, result: { resolved: number; failed: number; staged: boolean; error?: string }): void {
    this.post({ type: 'CONFLICTAI_FILE_DONE', fileKey, ...result });
  }

  runDone(cancelled: boolean): void {
    this.post({ type: 'CONFLICTAI_RUN_DONE', cancelled });
  }
}
