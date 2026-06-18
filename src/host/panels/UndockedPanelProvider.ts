import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { CommitPanelProvider } from './CommitPanelProvider';
import type { GitLogPanelProvider } from './GitLogPanelProvider';
import type { CommitToHostMsg, HostToCommitMsg, LogToHostMsg, HostToLogMsg } from '../types/messages';

type UndockedToHostMsg = CommitToHostMsg | LogToHostMsg;

type HostToUndockedMsg =
  | { target: 'commit'; msg: HostToCommitMsg }
  | { target: 'log'; msg: HostToLogMsg };

function isLogMsg(msg: UndockedToHostMsg): msg is LogToHostMsg {
  return (msg as { type: string }).type.startsWith('LOG_');
}

export class UndockedPanelProvider implements vscode.Disposable {
  public static readonly viewType = 'gitcharm.undocked';

  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private currentShowCommit = true;
  private movedToNewWindow = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly commitPanel: CommitPanelProvider,
    private readonly logPanel: GitLogPanelProvider,
  ) {}

  open(target: 'editorTab' | 'newWindow', showCommit = true): void {
    if (this.panel) {
      this.panel.reveal();
      if (this.currentShowCommit !== showCommit) {
        this.currentShowCommit = showCommit;
        // Reload HTML with new config — most reliable way to change layout on existing panel
        this.panel.webview.html = getWebviewHtml(
          this.panel.webview,
          this.extensionUri,
          'undockedPanel',
          'GitCharm',
          { showCommit },
        );
      }
      if (target === 'newWindow' && !this.movedToNewWindow) {
        this.movedToNewWindow = true;
        vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => {});
      }
      return;
    }

    this.currentShowCommit = showCommit;

    this.panel = vscode.window.createWebviewPanel(
      UndockedPanelProvider.viewType,
      'GitCharm',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.extensionUri,
          vscode.Uri.file(vscode.env.appRoot),
          ...vscode.extensions.all.map(e => vscode.Uri.file(e.extensionPath)),
        ],
      },
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'icons', 'git-commit-light.svg'),
      dark:  vscode.Uri.joinPath(this.extensionUri, 'media', 'icons', 'git-commit-dark.svg'),
    };

    this.panel.webview.html = getWebviewHtml(
      this.panel.webview,
      this.extensionUri,
      'undockedPanel',
      'GitCharm',
      { showCommit },
    );

    // Route incoming messages to the correct provider based on message type prefix
    this.panel.webview.onDidReceiveMessage(
      (msg: UndockedToHostMsg) => {
        if (isLogMsg(msg)) {
          if (msg.type === 'LOG_UNDOCK') return; // no-op: already undocked
          this.logPanel.handleUndockedMessage(msg, this);
        } else {
          this.commitPanel.handleUndockedMessage(msg as CommitToHostMsg, this);
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.movedToNewWindow = false;
      this.disposables.forEach(d => d.dispose());
      this.disposables = [];
    }, null, this.disposables);

    if (target === 'newWindow') {
      this.movedToNewWindow = true;
      vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => {});
    }
  }

  /** Send a message to the commit sub-app inside the undocked panel */
  postToCommit(msg: HostToCommitMsg): void {
    this.panel?.webview.postMessage({ target: 'commit', msg } satisfies HostToUndockedMsg);
  }

  /** Send a message to the log sub-app inside the undocked panel */
  postToLog(msg: HostToLogMsg): void {
    this.panel?.webview.postMessage({ target: 'log', msg } satisfies HostToUndockedMsg);
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
