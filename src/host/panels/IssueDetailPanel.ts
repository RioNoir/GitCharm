import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import { issueBranchName, issueCommitReference, type IssueManager } from '../issues/IssueManager';
import type { HostToIssueDetailMsg, IssueDetailToHostMsg, IssueSummary } from '../types/messages';
import { promptBranchName } from '../utils/branchNamePrompt';
import { formatGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logError, logInfo, logWarn } from '../utils/Logger';
import { attachAvatarResolver, checkAvatarUrl } from '../utils/avatarResolver';
import { panelIcon } from '../utils/panelIcon';
import { webviewReadyGate } from '../utils/webviewReadyGate';
import type { PullRequestDetailPanel } from './PullRequestDetailPanel';
import type { IssueResolvePanel } from './IssueResolvePanel';
import { getAiModelLabel } from '../utils/aiModelLabel';
import { agentProviderFor } from '../ai/aiGenerate';
import { explainIssue, generateIssueBranchName, loadIssueContext } from '../issues/issueAiActions';
import { createGit } from '../git/gitClient';
import { openCommitFullDetailPanel } from './CommitFullDetailPanel';

const TAB_TITLE_MAX_LENGTH = 40;

function truncateTitle(title: string): string {
  return title.length > TAB_TITLE_MAX_LENGTH ? `${title.slice(0, TAB_TITLE_MAX_LENGTH)}…` : title;
}

function panelTitleFor(number: number, title?: string): string {
  return title ? vscode.l10n.t('Issue #{0} - {1}', number, truncateTitle(title)) : vscode.l10n.t('Issue #{0}', number);
}

async function avatarIconPath(avatarUrl: string | undefined): Promise<vscode.Uri | undefined> {
  const url = await checkAvatarUrl(avatarUrl);
  if (!url) return undefined;
  try {
    return vscode.Uri.parse(url, true);
  } catch {
    return undefined;
  }
}

/** A label's color as a small filled circle — QuickPickItem can't tint an item, so a swatch icon stands in. */
export function labelSwatchIconPath(hexColor: string): vscode.Uri {
  const color = `#${hexColor.replace(/^#/, '')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

/**
 * Creates a local branch for an issue and checks it out. The name offered is gitcharm.issues.branchNameTemplate's,
 * or with `useAi` one the AI writes from the issue's content — editable either way before the branch is created.
 */
export async function createBranchForIssue(
  manager: WorkspaceGitManager, issueManager: IssueManager, repoId: string, issue: Pick<IssueSummary, 'number' | 'title'>, useAi = false,
): Promise<{ ok: boolean; branchName?: string; error?: string }> {
  const repo = manager.getRepo(repoId);
  if (!repo) return { ok: false, error: vscode.l10n.t('Repository not found') };
  let suggested: string;
  if (useAi) {
    const name = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Asking the AI for a branch name…') },
      async () => {
        const context = await loadIssueContext(issueManager, repoId, issue.number);
        return 'error' in context ? context : generateIssueBranchName(issueManager, repoId, context);
      },
    );
    if (typeof name !== 'string') return { ok: false, error: name.error };
    suggested = name;
  } else {
    const username = await issueManager.getCurrentUsername(repoId).catch(() => undefined);
    suggested = issueBranchName(issue, username);
  }
  const branchName = await promptBranchName({
    title: vscode.l10n.t('Create Branch for Issue #{0}', issue.number),
    prompt: vscode.l10n.t('The branch is created from the current HEAD and checked out'),
    value: suggested,
  });
  if (!branchName) return { ok: true };
  try {
    await repo.checkout(branchName, true);
    logInfo('issue-create-branch', `Created branch "${branchName}" for issue #${issue.number}`);
    return { ok: true, branchName };
  } catch (e: unknown) {
    logError('issue-create-branch', formatGitError(e), getRawErrorDetail(e));
    return { ok: false, error: formatGitError(e) };
  }
}

export class IssueDetailPanel {
  private panels = new Map<string, vscode.WebviewPanel>();
  /** Holds each open panel's current issue summary once known — the restore path wires the message handler before fetching it. */
  private currentIssueByPanel = new WeakMap<vscode.WebviewPanel, { value: IssueSummary | null }>();
  private pullRequestDetailPanel?: PullRequestDetailPanel;
  private issueResolvePanel?: IssueResolvePanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly issueManager: IssueManager,
    private readonly pullRequestManager: PullRequestManager,
    /** Something changed on the forge (state, title, labels…) — refresh the Issues tab. */
    private readonly onChanged: () => void,
    /** Inserts a reference to the issue into the Commit Panel's message. */
    private readonly insertReference: (text: string) => void,
  ) {}

  setPullRequestDetailPanel(panel: PullRequestDetailPanel): void {
    this.pullRequestDetailPanel = panel;
  }

  setIssueResolvePanel(panel: IssueResolvePanel): void {
    this.issueResolvePanel = panel;
  }

  async open(repoId: string, issue: IssueSummary): Promise<void> {
    const key = `${repoId}:${issue.number}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const panelTitle = panelTitleFor(issue.number, issue.title);
    const panel = vscode.window.createWebviewPanel(
      'gitcharm.issueDetail',
      panelTitle,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    this.setupPanel(panel, repoId, issue.number, panelTitle);
    await this.sendInit(panel, repoId, issue);
  }

  /** Re-hydrates a panel VS Code restored after a reload — only {repoId, number} were persisted, the summary is re-fetched. */
  async restore(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const s = state as { repoId?: unknown; number?: unknown } | null;
    if (!s || typeof s.repoId !== 'string' || typeof s.number !== 'number') {
      panel.dispose();
      return;
    }
    const { repoId, number } = s as { repoId: string; number: number };
    if (!this.manager.getRepoMetas().some(m => m.id === repoId)) {
      logWarn('issue-detail-restore', `Repository not found for repoId ${repoId}`);
      panel.dispose();
      return;
    }
    this.setupPanel(panel, repoId, number, panelTitleFor(number), /* keepExistingTitle */ true);
    const result = await this.issueManager.getIssueDetail(repoId, number);
    if ('error' in result) {
      webviewReadyGate<HostToIssueDetailMsg>(panel).post({ type: 'ISSUEDETAIL_LOAD_ERROR', error: result.error });
      return;
    }
    await this.sendInit(panel, repoId, result);
  }

  private setupPanel(panel: vscode.WebviewPanel, repoId: string, number: number, panelTitle: string, keepExistingTitle = false): void {
    const key = `${repoId}:${number}`;
    if (!keepExistingTitle) panel.title = panelTitle;
    panel.iconPath = panelIcon(this.extensionUri, 'issues');
    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'issueDetail', panelTitle);
    webviewReadyGate<HostToIssueDetailMsg>(panel);

    const current = { value: null as IssueSummary | null };
    this.currentIssueByPanel.set(panel, current);
    attachAvatarResolver(panel.webview);
    panel.webview.onDidReceiveMessage((msg: IssueDetailToHostMsg) => {
      const issue = current.value;
      if (!issue) return;
      return this.handleMessage(msg, repoId, issue, panel).catch(e => logError('issue-detail', formatGitError(e), getRawErrorDetail(e)));
    });
    panel.onDidDispose(() => { this.panels.delete(key); this.currentIssueByPanel.delete(panel); });
    this.panels.set(key, panel);
  }

  private async sendInit(panel: vscode.WebviewPanel, repoId: string, issue: IssueSummary): Promise<void> {
    const meta = this.manager.getRepoMetas().find(m => m.id === repoId);
    if (!meta) {
      vscode.window.showErrorMessage(vscode.l10n.t('Repository not found'));
      panel.dispose();
      return;
    }
    const holder = this.currentIssueByPanel.get(panel);
    if (holder) holder.value = issue;
    panel.title = panelTitleFor(issue.number, issue.title);

    const [connection, currentUsername] = await Promise.all([
      this.pullRequestManager.getConnectionStatus(repoId),
      this.issueManager.getCurrentUsername(repoId).catch(() => undefined),
    ]);
    const cfg = vscode.workspace.getConfiguration('gitcharm');
    webviewReadyGate<HostToIssueDetailMsg>(panel).post({
      type: 'ISSUEDETAIL_INIT', repoId, repoName: meta.name, number: issue.number, summary: issue, provider: connection.provider, currentUsername,
      aiEnabled: cfg.get('ai.enabled', true),
      aiExplainModelLabel: getAiModelLabel(cfg, 'explain'),
      aiIssuesModelLabel: getAiModelLabel(cfg, 'issues'),
      aiResolveMode: agentProviderFor('issues', cfg) ? 'agent' : 'text',
    });
  }

  private async handleMessage(msg: IssueDetailToHostMsg, repoId: string, issue: IssueSummary, panel: vscode.WebviewPanel): Promise<void> {
    const post = (m: HostToIssueDetailMsg) => panel.webview.postMessage(m);

    switch (msg.type) {
      case 'ISSUEDETAIL_REQUEST_DETAIL': {
        const result = await this.issueManager.getIssueDetail(repoId, issue.number);
        if ('error' in result) {
          post({ type: 'ISSUEDETAIL_LOAD_ERROR', error: result.error });
        } else {
          post({ type: 'ISSUEDETAIL_LOADED', detail: result });
          const holder = this.currentIssueByPanel.get(panel);
          if (holder) holder.value = result;
          if (result.title) panel.title = panelTitleFor(result.number, result.title);
        }
        break;
      }

      case 'ISSUEDETAIL_REQUEST_COMMENTS': {
        const { items: comments, error } = await this.issueManager.listComments(repoId, issue.number);
        post({ type: 'ISSUEDETAIL_COMMENTS_RESULT', comments, error });
        break;
      }

      case 'ISSUEDETAIL_REQUEST_EVENTS': {
        const { items: events, error } = await this.issueManager.listEvents(repoId, issue.number);
        post({ type: 'ISSUEDETAIL_EVENTS_RESULT', events, error });
        break;
      }

      case 'ISSUEDETAIL_REQUEST_LINKED_PRS': {
        const { items: pullRequests, error } = await this.issueManager.listLinkedPullRequests(repoId, issue.number);
        post({ type: 'ISSUEDETAIL_LINKED_PRS_RESULT', pullRequests, error });
        break;
      }

      case 'ISSUEDETAIL_REQUEST_MENTION_CANDIDATES': {
        post({ type: 'ISSUEDETAIL_MENTION_CANDIDATES', users: await this.issueManager.listMentionCandidates(repoId) });
        break;
      }

      case 'ISSUEDETAIL_POST_COMMENT': {
        const result = await this.issueManager.postComment(repoId, issue.number, msg.body);
        post({ type: 'ISSUEDETAIL_COMMENT_POSTED', ok: result.ok, error: result.error });
        if (!result.ok) vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to post comment'));
        break;
      }

      case 'ISSUEDETAIL_UPDATE_COMMENT': {
        const result = await this.issueManager.updateComment(repoId, issue.number, msg.commentId, msg.body);
        post({ type: 'ISSUEDETAIL_COMMENT_UPDATED', ok: result.ok, error: result.error });
        if (!result.ok) vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to update comment'));
        break;
      }

      case 'ISSUEDETAIL_DELETE_COMMENT': {
        const deleteLabel = vscode.l10n.t('Delete');
        const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t('Delete this comment?'), { modal: true }, deleteLabel);
        if (confirmed !== deleteLabel) { post({ type: 'ISSUEDETAIL_COMMENT_DELETED', ok: true }); break; }
        const result = await this.issueManager.deleteComment(repoId, issue.number, msg.commentId);
        post({ type: 'ISSUEDETAIL_COMMENT_DELETED', ok: result.ok, error: result.error });
        if (!result.ok) vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to delete comment'));
        break;
      }

      case 'ISSUEDETAIL_CLOSE':
      case 'ISSUEDETAIL_REOPEN': {
        const result = msg.type === 'ISSUEDETAIL_CLOSE'
          ? await this.issueManager.closeIssue(repoId, issue.number)
          : await this.issueManager.reopenIssue(repoId, issue.number);
        post({ type: 'ISSUEDETAIL_STATE_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        else vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to update issue'));
        break;
      }

      case 'ISSUEDETAIL_PICK_TITLE': {
        const title = await vscode.window.showInputBox({
          title: vscode.l10n.t('Edit Issue Title'), value: issue.title, prompt: vscode.l10n.t('Enter the new title'),
          validateInput: v => v.trim() ? undefined : vscode.l10n.t('Title cannot be empty'),
        });
        if (title === undefined || title.trim() === issue.title) { post({ type: 'ISSUEDETAIL_UPDATE_RESULT', ok: true }); break; }
        const result = await this.issueManager.updateIssue(repoId, issue.number, { title: title.trim() });
        post({ type: 'ISSUEDETAIL_UPDATE_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        else vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to update issue'));
        break;
      }

      case 'ISSUEDETAIL_UPDATE_DESCRIPTION': {
        const result = await this.issueManager.updateIssue(repoId, issue.number, { description: msg.description });
        post({ type: 'ISSUEDETAIL_DESCRIPTION_UPDATED', ok: result.ok, error: result.error });
        break;
      }

      case 'ISSUEDETAIL_PICK_ASSIGNEES': {
        const [{ items: users, error }, detail] = await Promise.all([
          this.issueManager.listAssignableUsers(repoId),
          this.issueManager.getIssueDetail(repoId, issue.number),
        ]);
        if (error || 'error' in detail) {
          post({ type: 'ISSUEDETAIL_UPDATE_ASSIGNEES_RESULT', ok: false, error: error ?? ('error' in detail ? detail.error : undefined) });
          vscode.window.showErrorMessage(error ?? ('error' in detail ? detail.error : vscode.l10n.t('Failed to update assignees')));
          break;
        }
        const ids = await pickUsers(users, detail.assignees.map(a => a.id), detail.capabilities.singleAssignee);
        if (!ids) { post({ type: 'ISSUEDETAIL_UPDATE_ASSIGNEES_RESULT', ok: true }); break; }
        const result = await this.issueManager.updateAssignees(repoId, issue.number, ids);
        post({ type: 'ISSUEDETAIL_UPDATE_ASSIGNEES_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        else if (!('unsupported' in result)) vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to update assignees'));
        break;
      }

      case 'ISSUEDETAIL_PICK_LABELS': {
        const [{ items: labels, error }, detail] = await Promise.all([
          this.issueManager.listAvailableLabels(repoId),
          this.issueManager.getIssueDetail(repoId, issue.number),
        ]);
        if (error || 'error' in detail) {
          post({ type: 'ISSUEDETAIL_UPDATE_LABELS_RESULT', ok: false, error: error ?? ('error' in detail ? detail.error : undefined) });
          vscode.window.showErrorMessage(error ?? ('error' in detail ? detail.error : vscode.l10n.t('Failed to update labels')));
          break;
        }
        const currentIds = new Set(detail.labels.map(l => l.id));
        const picked = await vscode.window.showQuickPick(
          labels.map(l => ({ label: l.name, id: l.id, picked: currentIds.has(l.id), iconPath: labelSwatchIconPath(l.color) })),
          { title: vscode.l10n.t('Labels'), placeHolder: vscode.l10n.t('Select labels'), canPickMany: true },
        );
        if (!picked) { post({ type: 'ISSUEDETAIL_UPDATE_LABELS_RESULT', ok: true }); break; }
        const result = await this.issueManager.updateLabels(repoId, issue.number, picked.map(p => p.id));
        post({ type: 'ISSUEDETAIL_UPDATE_LABELS_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        else if (!('unsupported' in result)) vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to update labels'));
        break;
      }

      case 'ISSUEDETAIL_OPEN_IN_BROWSER': {
        vscode.env.openExternal(vscode.Uri.parse(issue.url));
        break;
      }

      case 'ISSUEDETAIL_CREATE_BRANCH':
      case 'ISSUEDETAIL_CREATE_BRANCH_AI': {
        const result = await createBranchForIssue(this.manager, this.issueManager, repoId, issue, msg.type === 'ISSUEDETAIL_CREATE_BRANCH_AI');
        post({ type: 'ISSUEDETAIL_CREATE_BRANCH_RESULT', ...result });
        if (result.branchName) vscode.window.showInformationMessage(vscode.l10n.t('Switched to new branch "{0}"', result.branchName));
        else if (!result.ok) vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to create branch'));
        break;
      }

      case 'ISSUEDETAIL_EXPLAIN': {
        const { openAiExplainDetail } = await import('./AiExplainDetailPanel');
        const cfg = vscode.workspace.getConfiguration('gitcharm');
        openAiExplainDetail(
          this.extensionUri,
          { key: `issue:${repoId}:${issue.number}`, kind: 'issue', title: vscode.l10n.t('Issue #{0} — {1}', issue.number, issue.title) },
          getAiModelLabel(cfg, 'explain'),
          async onProgress => {
            const context = await loadIssueContext(this.issueManager, repoId, issue.number);
            return 'error' in context ? context : explainIssue(context, onProgress);
          },
        );
        break;
      }

      case 'ISSUEDETAIL_RESOLVE_AI': {
        this.issueResolvePanel?.open(repoId, issue);
        break;
      }

      case 'ISSUEDETAIL_INSERT_REFERENCE': {
        this.insertReference(issueCommitReference(issue));
        break;
      }

      case 'ISSUEDETAIL_OPEN_REFERENCE': {
        const ref = msg.reference;
        if (!ref.sameRepo) {
          vscode.env.openExternal(vscode.Uri.parse(ref.url));
        } else if (ref.kind === 'issue') {
          await this.open(repoId, {
            id: String(ref.number), number: ref.number, title: ref.title, url: ref.url, state: ref.state === 'closed' ? 'closed' : 'open',
            stateReason: ref.stateReason, authorName: '', createdAt: '', updatedAt: '',
          });
        } else {
          await this.openPullRequest(repoId, ref.number, ref.url);
        }
        break;
      }

      case 'ISSUEDETAIL_OPEN_COMMIT': {
        const { commit } = msg;
        const meta = this.manager.getRepoMetas().find(m => m.id === repoId);
        // The commit may only exist on the forge (another repository, or not fetched yet) — then show it there.
        const local = commit.sameRepo && meta
          ? await createGit(meta.rootPath).raw(['cat-file', '-e', `${commit.sha}^{commit}`]).then(() => true, () => false)
          : false;
        if (local) await openCommitFullDetailPanel(this.extensionUri, this.manager, repoId, commit.sha);
        else if (commit.url) vscode.env.openExternal(vscode.Uri.parse(commit.url));
        break;
      }

      case 'ISSUEDETAIL_OPEN_PULL_REQUEST': {
        const pr = msg.pullRequest;
        if (pr.sameRepo) await this.openPullRequest(repoId, pr.number, pr.url);
        else vscode.env.openExternal(vscode.Uri.parse(pr.url));
        break;
      }
    }
  }

  /** A pull request of this repository in its detail panel; the browser when it can't be loaded. */
  private async openPullRequest(repoId: string, number: number, url: string): Promise<void> {
    const detail = this.pullRequestDetailPanel ? await this.pullRequestManager.getPullRequestDetail(repoId, number) : undefined;
    if (!detail || 'error' in detail || !this.pullRequestDetailPanel) {
      vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    await this.pullRequestDetailPanel.open(repoId, detail);
  }

  dispose(): void {
    this.panels.forEach(p => p.dispose());
    this.panels.clear();
  }
}

/** Multi-select (or single-select, for forges with one assignee) user picker; undefined when cancelled. */
export async function pickUsers(
  users: { id: string; username: string; avatarUrl?: string }[], currentIds: string[], single: boolean,
): Promise<string[] | undefined> {
  const items = await Promise.all(users.map(async u => ({
    label: u.username, id: u.id, picked: currentIds.includes(u.id), iconPath: await avatarIconPath(u.avatarUrl),
    description: single && currentIds.includes(u.id) ? vscode.l10n.t('(current)') : undefined,
  })));
  if (single) {
    const NONE = '';
    const picked = await vscode.window.showQuickPick(
      [{ label: `$(circle-slash) ${vscode.l10n.t('No assignee')}`, id: NONE, picked: false, iconPath: undefined, description: undefined }, ...items],
      { title: vscode.l10n.t('Assignee'), placeHolder: vscode.l10n.t('Select an assignee') },
    );
    if (!picked) return undefined;
    return picked.id === NONE ? [] : [picked.id];
  }
  const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Assignees'), placeHolder: vscode.l10n.t('Select assignees'), canPickMany: true });
  return picked?.map(p => p.id);
}
