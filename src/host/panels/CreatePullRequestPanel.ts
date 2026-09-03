import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import type { HostToPrCreateMsg, PrCreateToHostMsg } from '../types/messages';
import { formatGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logInfo, logError } from '../utils/Logger';

export class CreatePullRequestPanel {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly pullRequestManager: PullRequestManager,
    private readonly onCreated: () => void,
  ) {}

  async open(repoId: string): Promise<void> {
    if (this.panels.has(repoId)) {
      this.panels.get(repoId)!.reveal();
      return;
    }

    const meta = this.manager.getRepoMetas().find(m => m.id === repoId);
    if (!meta) {
      vscode.window.showErrorMessage('Repository not found');
      return;
    }

    const connection = await this.pullRequestManager.getConnectionStatus(repoId);

    const panel = vscode.window.createWebviewPanel(
      'gitcharm.createPullRequest',
      `New Pull Request — ${meta.name}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] }
    );

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      'pullRequestCreate',
      `New Pull Request — ${meta.name}`
    );

    panel.webview.onDidReceiveMessage((msg: PrCreateToHostMsg) => this.handleMessage(msg, repoId, panel));
    panel.onDidDispose(() => this.panels.delete(repoId));
    this.panels.set(repoId, panel);

    panel.webview.postMessage({
      type: 'PRCREATE_INIT', repoId, repoName: meta.name, provider: connection.provider,
    } satisfies HostToPrCreateMsg);
  }

  private async handleMessage(msg: PrCreateToHostMsg, repoId: string, panel: vscode.WebviewPanel): Promise<void> {
    const post = (m: HostToPrCreateMsg) => panel.webview.postMessage(m);

    switch (msg.type) {
      case 'PRCREATE_REQUEST_BRANCHES': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) { post({ type: 'PRCREATE_BRANCHES_RESULT', branches: [], error: 'Repository not found' }); break; }
        try {
          const branches = await repo.getBranches();
          post({ type: 'PRCREATE_BRANCHES_RESULT', branches });
        } catch (e: unknown) {
          post({ type: 'PRCREATE_BRANCHES_RESULT', branches: [], error: formatGitError(e) });
        }
        break;
      }

      case 'PRCREATE_SUBMIT': {
        try {
          const result = await this.pullRequestManager.createPullRequest(repoId, msg.input);
          post({ type: 'PRCREATE_SUBMIT_RESULT', ok: result.ok, pr: result.pr, error: result.error });
          if (result.ok) {
            logInfo('pullrequest-create', `Created PR #${result.pr?.number} for ${repoId}`);
            this.onCreated();
            panel.dispose();
          }
        } catch (e: unknown) {
          logError('pullrequest-create', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'PRCREATE_SUBMIT_RESULT', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'PRCREATE_CANCEL': {
        panel.dispose();
        break;
      }
    }
  }

  dispose(): void {
    this.panels.forEach(p => p.dispose());
    this.panels.clear();
  }
}
