import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getWebviewHtml } from '../utils/webviewHtml';
import { attachAvatarResolver } from '../utils/avatarResolver';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import type { IssueManager } from '../issues/IssueManager';
import type { HostToIssueCreateMsg, IssueCreateToHostMsg, IssueSummary } from '../types/messages';
import { logInfo } from '../utils/Logger';
import { panelIcon } from '../utils/panelIcon';
import { webviewReadyGate } from '../utils/webviewReadyGate';
import { labelSwatchIconPath, pickUsers } from './IssueDetailPanel';

// Where GitHub, GitLab and Gitea/Forgejo look for a repo's single default issue template.
const ISSUE_TEMPLATE_PATHS = [
  '.github/ISSUE_TEMPLATE.md', '.github/issue_template.md', 'ISSUE_TEMPLATE.md', 'issue_template.md',
  'docs/ISSUE_TEMPLATE.md', 'docs/issue_template.md', '.gitlab/issue_templates/Default.md',
  '.gitea/ISSUE_TEMPLATE.md', '.gitea/issue_template.md', '.forgejo/ISSUE_TEMPLATE.md', '.forgejo/issue_template.md',
];

/** The template's text without the YAML front matter GitHub/Gitea templates may start with. */
async function readIssueTemplate(rootPath: string): Promise<string | undefined> {
  for (const rel of ISSUE_TEMPLATE_PATHS) {
    try {
      const raw = await fs.readFile(path.join(rootPath, rel), 'utf8');
      const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
      if (text) return text.slice(0, 4000);
    } catch { /* not there — try the next one */ }
  }
  return undefined;
}

export class CreateIssuePanel {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly issueManager: IssueManager,
    private readonly pullRequestManager: PullRequestManager,
    /** An issue was created — refresh the Issues tab and open it. */
    private readonly onCreated: (repoId: string, issue: IssueSummary) => void,
  ) {}

  async open(repoId: string): Promise<void> {
    const existing = this.panels.get(repoId);
    if (existing) {
      existing.reveal();
      return;
    }
    const meta = this.manager.getRepoMetas().find(m => m.id === repoId);
    if (!meta) {
      vscode.window.showErrorMessage(vscode.l10n.t('Repository not found'));
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'gitcharm.issueCreate',
      vscode.l10n.t('New Issue — {0}', meta.name),
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    panel.iconPath = panelIcon(this.extensionUri, 'issues');
    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'issueCreate', vscode.l10n.t('New Issue'));
    const gate = webviewReadyGate<HostToIssueCreateMsg>(panel);
    attachAvatarResolver(panel.webview);
    panel.webview.onDidReceiveMessage((msg: IssueCreateToHostMsg) => this.handleMessage(msg, repoId, panel));
    panel.onDidDispose(() => this.panels.delete(repoId));
    this.panels.set(repoId, panel);

    const [connection, capabilities, template] = await Promise.all([
      this.pullRequestManager.getConnectionStatus(repoId),
      this.issueManager.getCapabilities(repoId),
      readIssueTemplate(meta.rootPath),
    ]);
    gate.post({
      type: 'ISSUECREATE_INIT', repoId, repoName: meta.name, provider: connection.provider,
      canManageLabels: !!capabilities?.canManageLabels, canManageAssignees: !!capabilities?.canManageAssignees,
      singleAssignee: !!capabilities?.singleAssignee, template,
    });
  }

  private async handleMessage(msg: IssueCreateToHostMsg, repoId: string, panel: vscode.WebviewPanel): Promise<void> {
    const post = (m: HostToIssueCreateMsg) => panel.webview.postMessage(m);
    switch (msg.type) {
      case 'ISSUECREATE_REQUEST_MENTION_CANDIDATES': {
        post({ type: 'ISSUECREATE_MENTION_CANDIDATES', users: await this.issueManager.listMentionCandidates(repoId) });
        break;
      }

      case 'ISSUECREATE_PICK_ASSIGNEES': {
        const { items: users, error } = await this.issueManager.listAssignableUsers(repoId);
        if (error) { vscode.window.showErrorMessage(error); break; }
        const capabilities = await this.issueManager.getCapabilities(repoId);
        const ids = await pickUsers(users, msg.current.map(u => u.id), !!capabilities?.singleAssignee);
        if (ids) post({ type: 'ISSUECREATE_ASSIGNEES_PICKED', users: users.filter(u => ids.includes(u.id)) });
        break;
      }

      case 'ISSUECREATE_PICK_LABELS': {
        const { items: labels, error } = await this.issueManager.listAvailableLabels(repoId);
        if (error) { vscode.window.showErrorMessage(error); break; }
        const currentIds = new Set(msg.current.map(l => l.id));
        const picked = await vscode.window.showQuickPick(
          labels.map(l => ({ label: l.name, id: l.id, picked: currentIds.has(l.id), iconPath: labelSwatchIconPath(l.color) })),
          { title: vscode.l10n.t('Labels'), placeHolder: vscode.l10n.t('Select labels'), canPickMany: true },
        );
        if (picked) post({ type: 'ISSUECREATE_LABELS_PICKED', labels: labels.filter(l => picked.some(p => p.id === l.id)) });
        break;
      }

      case 'ISSUECREATE_SUBMIT': {
        const result = await this.issueManager.createIssue(repoId, {
          title: msg.title, description: msg.description, assigneeIds: msg.assigneeIds, labelIds: msg.labelIds,
        });
        post({ type: 'ISSUECREATE_SUBMIT_RESULT', ok: result.ok, error: result.ok ? undefined : result.error });
        if (result.ok && result.issue) {
          logInfo('issue-create', `Created issue #${result.issue.number} for ${repoId}`);
          // Created, but a follow-up step (e.g. Gitea labels) failed — say so without losing the issue.
          if (result.error) vscode.window.showWarningMessage(vscode.l10n.t('Issue #{0} was created, but: {1}', result.issue.number, result.error));
          panel.dispose();
          this.onCreated(repoId, result.issue);
        }
        break;
      }

      case 'ISSUECREATE_CANCEL': {
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
