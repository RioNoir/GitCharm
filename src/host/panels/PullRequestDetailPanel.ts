import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { redactCredentialsInUrls, type PullRequestManager } from '../pullRequests/PullRequestManager';
import { PullRequestDocumentProvider } from '../pullRequests/PullRequestDocumentProvider';
import { loadIconTheme } from '../utils/IconThemeService';
import type { ChangedFile, FileDiffContent, HostToPrDetailMsg, PrDetailToHostMsg, PullRequestSummary } from '../types/messages';
import { formatGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logInfo, logWarn, logError } from '../utils/Logger';

const TAB_TITLE_MAX_LENGTH = 40;

function truncateTitle(title: string): string {
  return title.length > TAB_TITLE_MAX_LENGTH ? `${title.slice(0, TAB_TITLE_MAX_LENGTH)}…` : title;
}

/** QuickPickItem.iconPath accepts a remote https URI directly (same as the GitHub Pull Requests extension does for reviewer/assignee avatars in its own pickers) — no local caching needed. */
function avatarIconPath(avatarUrl: string | undefined): vscode.Uri | undefined {
  if (!avatarUrl) return undefined;
  try {
    return vscode.Uri.parse(avatarUrl, true);
  } catch {
    return undefined;
  }
}

/** Renders a label's color as a small filled circle, data-URI encoded — QuickPickItem has no direct way to
 * tint an item's background/text, so a colored swatch icon is the standard stand-in (same technique the
 * GitHub Pull Requests extension uses for its own label picker). */
function labelSwatchIconPath(hexColor: string): vscode.Uri {
  const color = `#${hexColor.replace(/^#/, '')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

export class PullRequestDetailPanel {
  private panels = new Map<string, vscode.WebviewPanel>();
  private diffCache = new Map<string, FileDiffContent>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly pullRequestManager: PullRequestManager,
    private readonly prDocProvider: PullRequestDocumentProvider,
    private readonly onChanged: () => void,
  ) {}

  async open(repoId: string, pr: PullRequestSummary): Promise<void> {
    const key = `${repoId}:${pr.number}`;
    if (this.panels.has(key)) {
      this.panels.get(key)!.reveal();
      return;
    }

    const localResourceRoots: vscode.Uri[] = [this.extensionUri];
    for (const ext of vscode.extensions.all) {
      const themes: Array<{ id: string }> = ext.packageJSON?.contributes?.iconThemes ?? [];
      if (themes.length > 0) localResourceRoots.push(vscode.Uri.file(ext.extensionPath));
    }

    const panelTitle = pr.title ? `PR #${pr.number} - ${truncateTitle(pr.title)}` : `PR #${pr.number}`;

    const panel = vscode.window.createWebviewPanel(
      'gitcharm.pullRequestDetail',
      panelTitle,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots }
    );
    await this.setupPanel(panel, repoId, pr);
  }

  /** Re-hydrates a Pull Request Detail panel restored by VS Code after a window reload/restart — see registerWebviewPanelSerializer('gitcharm.pullRequestDetail', ...) in extension.ts. */
  async restore(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const s = state as { repoId?: unknown; number?: unknown } | null;
    if (!s || typeof s.repoId !== 'string' || typeof s.number !== 'number') {
      panel.dispose();
      return;
    }
    const result = await this.pullRequestManager.getPullRequestDetail(s.repoId, s.number);
    if ('error' in result) {
      logWarn('pullrequest-detail-restore', `Failed to restore PR detail panel: ${result.error}`);
      vscode.window.showWarningMessage(`Could not restore pull request #${s.number}: ${result.error}`);
      panel.dispose();
      return;
    }
    await this.setupPanel(panel, s.repoId, result);
  }

  private async setupPanel(panel: vscode.WebviewPanel, repoId: string, pr: PullRequestSummary): Promise<void> {
    const key = `${repoId}:${pr.number}`;

    const meta = this.manager.getRepoMetas().find(m => m.id === repoId);
    if (!meta) {
      logWarn('pullrequest-detail-open', `Repository not found for repoId ${repoId}`);
      vscode.window.showErrorMessage('Repository not found');
      panel.dispose();
      return;
    }

    const panelTitle = pr.title ? `PR #${pr.number} - ${truncateTitle(pr.title)}` : `PR #${pr.number}`;
    panel.title = panelTitle;
    panel.iconPath = new vscode.ThemeIcon('git-pull-request');

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      'pullRequestDetail',
      panelTitle
    );

    panel.webview.onDidReceiveMessage((msg: PrDetailToHostMsg) => this.handleMessage(msg, repoId, pr, panel));

    const iconThemeWatcher = vscode.workspace.onDidChangeConfiguration(async e => {
      if (!e.affectsConfiguration('workbench.iconTheme')) return;
      const iconTheme = await loadIconTheme(panel.webview).catch(() => ({ type: 'none' as const }));
      panel.webview.postMessage({ type: 'PRDETAIL_ICON_THEME', iconTheme } satisfies HostToPrDetailMsg);
    });
    panel.onDidDispose(() => { this.panels.delete(key); iconThemeWatcher.dispose(); });
    this.panels.set(key, panel);

    const currentUsername = await this.pullRequestManager.getCurrentUsername(repoId).catch(() => undefined);
    panel.webview.postMessage({
      type: 'PRDETAIL_INIT', repoId, repoName: meta.name, number: pr.number, summary: pr, currentUsername,
    } satisfies HostToPrDetailMsg);

    const iconTheme = await loadIconTheme(panel.webview).catch(() => ({ type: 'none' as const }));
    panel.webview.postMessage({ type: 'PRDETAIL_ICON_THEME', iconTheme } satisfies HostToPrDetailMsg);
  }

  private async handleMessage(msg: PrDetailToHostMsg, repoId: string, pr: PullRequestSummary, panel: vscode.WebviewPanel): Promise<void> {
    const post = (m: HostToPrDetailMsg) => panel.webview.postMessage(m);

    switch (msg.type) {
      case 'PRDETAIL_REQUEST_DETAIL': {
        const result = await this.pullRequestManager.getPullRequestDetail(repoId, pr.number);
        if ('error' in result) {
          post({ type: 'PRDETAIL_LOAD_ERROR', error: result.error });
        } else {
          post({ type: 'PRDETAIL_LOADED', detail: result });
          // Keep the editor tab title in sync after a title edit — `pr` itself is a snapshot captured when the
          // panel was opened/restored and is never mutated, so re-derive the title string on every fresh fetch.
          panel.title = result.title ? `PR #${result.number} - ${truncateTitle(result.title)}` : `PR #${result.number}`;
        }
        break;
      }

      case 'PRDETAIL_REQUEST_COMMENTS': {
        const { items: comments, error } = await this.pullRequestManager.listComments(repoId, pr.number);
        post({ type: 'PRDETAIL_COMMENTS_RESULT', comments, error });
        break;
      }

      case 'PRDETAIL_POST_COMMENT': {
        const result = await this.pullRequestManager.postComment(repoId, pr.number, msg.body);
        post({ type: 'PRDETAIL_COMMENT_POSTED', ok: result.ok, comment: result.comment, error: result.error });
        break;
      }

      case 'PRDETAIL_UPDATE_COMMENT': {
        const result = await this.pullRequestManager.updateComment(repoId, pr.number, msg.commentId, msg.body);
        post({ type: 'PRDETAIL_COMMENT_UPDATED', ok: result.ok, comment: result.comment, error: result.error });
        if (!result.ok) vscode.window.showErrorMessage(result.error ?? 'Failed to update comment');
        break;
      }

      case 'PRDETAIL_DELETE_COMMENT': {
        const confirmed = await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, 'Delete');
        if (confirmed !== 'Delete') { post({ type: 'PRDETAIL_COMMENT_DELETED', ok: true }); break; }
        const result = await this.pullRequestManager.deleteComment(repoId, pr.number, msg.commentId);
        post({ type: 'PRDETAIL_COMMENT_DELETED', ok: result.ok, commentId: msg.commentId, error: result.error });
        if (!result.ok) vscode.window.showErrorMessage(result.error ?? 'Failed to delete comment');
        break;
      }

      case 'PRDETAIL_HIDE_COMMENT': {
        const result = await this.pullRequestManager.hideComment(repoId, pr.number, msg.commentId);
        post({ type: 'PRDETAIL_COMMENT_HIDDEN', ok: result.ok, commentId: msg.commentId, unsupported: 'unsupported' in result ? result.unsupported : undefined, error: result.error });
        if (!result.ok && !('unsupported' in result)) vscode.window.showErrorMessage(result.error ?? 'Failed to hide comment');
        break;
      }

      case 'PRDETAIL_UNHIDE_COMMENT': {
        const result = await this.pullRequestManager.unhideComment(repoId, pr.number, msg.commentId);
        post({ type: 'PRDETAIL_COMMENT_UNHIDDEN', ok: result.ok, commentId: msg.commentId, unsupported: 'unsupported' in result ? result.unsupported : undefined, error: result.error });
        if (!result.ok && !('unsupported' in result)) vscode.window.showErrorMessage(result.error ?? 'Failed to unhide comment');
        break;
      }

      case 'PRDETAIL_REQUEST_FILES': {
        const { items: files, error } = await this.pullRequestManager.listChangedFiles(repoId, pr.number);
        post({ type: 'PRDETAIL_FILES_RESULT', files, error });
        break;
      }

      case 'PRDETAIL_OPEN_FILE_DIFF': {
        await this.openFileDiff(repoId, pr, msg.file, post);
        break;
      }

      case 'PRDETAIL_REQUEST_COMMITS': {
        const { items: commits, error } = await this.pullRequestManager.listCommits(repoId, pr.number);
        post({ type: 'PRDETAIL_COMMITS_RESULT', commits, error });
        break;
      }

      case 'PRDETAIL_REQUEST_EVENTS': {
        const { items: events, error } = await this.pullRequestManager.listEvents(repoId, pr.number);
        post({ type: 'PRDETAIL_EVENTS_RESULT', events, error });
        break;
      }

      case 'PRDETAIL_REQUEST_COMMIT_FILES': {
        const { items: files, error } = await this.pullRequestManager.listCommitFiles(repoId, msg.sha);
        post({ type: 'PRDETAIL_COMMIT_FILES_RESULT', sha: msg.sha, files, error });
        break;
      }

      case 'PRDETAIL_OPEN_COMMIT_FILE_DIFF': {
        await this.openCommitFileDiff(repoId, pr, msg.file, msg.commitSha, msg.parentSha, post);
        break;
      }

      case 'PRDETAIL_REQUEST_CHECKS': {
        const { items: checks, error } = await this.pullRequestManager.listChecks(repoId, msg.headSha);
        post({ type: 'PRDETAIL_CHECKS_RESULT', checks, error });
        break;
      }

      case 'PRDETAIL_MERGE': {
        try {
          const result = await this.pullRequestManager.mergePullRequest(repoId, pr.number, msg.strategy);
          post({ type: 'PRDETAIL_MERGE_RESULT', ok: result.ok, error: result.error });
          if (result.ok) {
            logInfo('pullrequest-merge', `Merged PR #${pr.number} for ${repoId}`);
            this.onChanged();
          }
        } catch (e: unknown) {
          logError('pullrequest-merge', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'PRDETAIL_MERGE_RESULT', ok: false, error: formatGitError(e) });
        }
        break;
      }

      case 'PRDETAIL_CLOSE': {
        const confirmed = await vscode.window.showWarningMessage(
          `Close pull request #${pr.number}?`, { modal: true }, 'Close Pull Request',
        );
        if (confirmed !== 'Close Pull Request') { post({ type: 'PRDETAIL_CLOSE_RESULT', ok: true }); break; }
        const result = await this.pullRequestManager.closePullRequest(repoId, pr.number);
        post({ type: 'PRDETAIL_CLOSE_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        break;
      }

      case 'PRDETAIL_REOPEN': {
        const result = await this.pullRequestManager.reopenPullRequest(repoId, pr.number);
        post({ type: 'PRDETAIL_REOPEN_RESULT', ok: result.ok, unsupported: 'unsupported' in result ? result.unsupported : undefined, error: result.error });
        if (result.ok) this.onChanged();
        break;
      }

      case 'PRDETAIL_SUBMIT_REVIEW': {
        const result = await this.pullRequestManager.submitReview(repoId, pr.number, msg.input);
        post({ type: 'PRDETAIL_REVIEW_RESULT', ok: result.ok, unsupported: 'unsupported' in result ? result.unsupported : undefined, error: result.error });
        if (result.ok) {
          this.onChanged();
        } else {
          vscode.window.showErrorMessage(result.error ?? 'Failed to submit review');
        }
        break;
      }

      case 'PRDETAIL_OPEN_IN_BROWSER': {
        vscode.env.openExternal(vscode.Uri.parse(pr.url));
        break;
      }

      case 'PRDETAIL_VIEW_ALL_CHANGES': {
        await this.openAllChanges(repoId, pr, post);
        break;
      }

      case 'PRDETAIL_OPEN_COMMIT_ALL_CHANGES': {
        await this.openCommitAllChanges(repoId, pr, msg.commitSha, msg.parentSha);
        break;
      }

      case 'PRDETAIL_CHECKOUT_PR': {
        await this.checkoutPullRequest(repoId, pr, 'pr', post);
        break;
      }

      case 'PRDETAIL_CHECKOUT_BRANCH': {
        await this.checkoutPullRequest(repoId, pr, 'branch', post);
        break;
      }

      case 'PRDETAIL_PICK_TITLE': {
        const detail = await this.pullRequestManager.getPullRequestDetail(repoId, pr.number);
        const currentTitle = 'error' in detail ? pr.title : detail.title;
        const title = await vscode.window.showInputBox({
          title: 'Edit Pull Request Title', value: currentTitle, prompt: 'Enter the new title', validateInput: v => v.trim() ? undefined : 'Title cannot be empty',
        });
        // Cancelled or unchanged — still report back (ok:true, no-op) so the webview clears its "updating" spinner.
        if (title === undefined || title.trim() === currentTitle) { post({ type: 'PRDETAIL_UPDATE_RESULT', ok: true }); break; }
        const result = await this.pullRequestManager.updatePullRequest(repoId, pr.number, { title: title.trim() });
        post({ type: 'PRDETAIL_UPDATE_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        else vscode.window.showErrorMessage(result.error ?? 'Failed to update pull request');
        break;
      }

      case 'PRDETAIL_PICK_TARGET_BRANCH': {
        if (!pr.targetRepoFullName) { post({ type: 'PRDETAIL_UPDATE_RESULT', ok: false, error: 'Target repository is unknown' }); break; }
        const { items: branches, error } = await this.pullRequestManager.listTargetBranches(repoId, pr.targetRepoFullName);
        if (error) { post({ type: 'PRDETAIL_UPDATE_RESULT', ok: false, error }); break; }
        const picked = await vscode.window.showQuickPick(
          branches.map(b => ({ label: b, description: b === pr.targetBranch ? '(current)' : undefined })),
          { title: 'Change Target Branch', placeHolder: 'Select the new target branch' },
        );
        if (!picked || picked.label === pr.targetBranch) { post({ type: 'PRDETAIL_UPDATE_RESULT', ok: true }); break; }
        const result = await this.pullRequestManager.updatePullRequest(repoId, pr.number, { targetBranch: picked.label });
        post({ type: 'PRDETAIL_UPDATE_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        else vscode.window.showErrorMessage(result.error ?? 'Failed to update pull request');
        break;
      }

      case 'PRDETAIL_PICK_REVIEWERS': {
        if (!pr.targetRepoFullName) { post({ type: 'PRDETAIL_UPDATE_REVIEWERS_RESULT', ok: false, error: 'Target repository is unknown' }); break; }
        const [{ items: collaborators, error }, detail] = await Promise.all([
          this.pullRequestManager.listCollaborators(repoId, pr.targetRepoFullName),
          this.pullRequestManager.getPullRequestDetail(repoId, pr.number),
        ]);
        if (error) { post({ type: 'PRDETAIL_UPDATE_REVIEWERS_RESULT', ok: false, error }); break; }
        const currentIds = new Set('error' in detail ? [] : detail.reviewers.map(r => r.id));
        const picked = await vscode.window.showQuickPick(
          collaborators.map(c => ({ label: c.username, id: c.id, picked: currentIds.has(c.id), iconPath: avatarIconPath(c.avatarUrl) })),
          { title: 'Reviewers', placeHolder: 'Select reviewers', canPickMany: true },
        );
        if (!picked) { post({ type: 'PRDETAIL_UPDATE_REVIEWERS_RESULT', ok: true }); break; }
        const result = await this.pullRequestManager.updateReviewers(repoId, pr.number, picked.map(p => p.id));
        post({ type: 'PRDETAIL_UPDATE_REVIEWERS_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        else vscode.window.showErrorMessage(result.error ?? 'Failed to update reviewers');
        break;
      }

      case 'PRDETAIL_PICK_ASSIGNEES': {
        if (!pr.targetRepoFullName) { post({ type: 'PRDETAIL_UPDATE_ASSIGNEES_RESULT', ok: false, error: 'Target repository is unknown' }); break; }
        const [{ items: collaborators, error }, detail] = await Promise.all([
          this.pullRequestManager.listCollaborators(repoId, pr.targetRepoFullName),
          this.pullRequestManager.getPullRequestDetail(repoId, pr.number),
        ]);
        if (error) { post({ type: 'PRDETAIL_UPDATE_ASSIGNEES_RESULT', ok: false, error }); break; }
        const currentIds = new Set('error' in detail ? [] : detail.assignees.map(a => a.id));
        const picked = await vscode.window.showQuickPick(
          collaborators.map(c => ({ label: c.username, id: c.id, picked: currentIds.has(c.id), iconPath: avatarIconPath(c.avatarUrl) })),
          { title: 'Assignees', placeHolder: 'Select assignees', canPickMany: true },
        );
        if (!picked) { post({ type: 'PRDETAIL_UPDATE_ASSIGNEES_RESULT', ok: true }); break; }
        const result = await this.pullRequestManager.updateAssignees(repoId, pr.number, picked.map(p => p.id));
        post({ type: 'PRDETAIL_UPDATE_ASSIGNEES_RESULT', ok: result.ok, unsupported: 'unsupported' in result ? result.unsupported : undefined, error: result.error });
        if (result.ok) this.onChanged();
        else if (!('unsupported' in result)) vscode.window.showErrorMessage(result.error ?? 'Failed to update assignees');
        break;
      }

      case 'PRDETAIL_PICK_LABELS': {
        if (!pr.targetRepoFullName) { post({ type: 'PRDETAIL_UPDATE_LABELS_RESULT', ok: false, error: 'Target repository is unknown' }); break; }
        const [{ items: availableLabels, error }, detail] = await Promise.all([
          this.pullRequestManager.listAvailableLabels(repoId, pr.targetRepoFullName),
          this.pullRequestManager.getPullRequestDetail(repoId, pr.number),
        ]);
        if (error) { post({ type: 'PRDETAIL_UPDATE_LABELS_RESULT', ok: false, error }); break; }
        const currentIds = new Set('error' in detail ? [] : detail.labels.map(l => l.id));
        const picked = await vscode.window.showQuickPick(
          availableLabels.map(l => ({ label: l.name, id: l.id, picked: currentIds.has(l.id), iconPath: labelSwatchIconPath(l.color) })),
          { title: 'Labels', placeHolder: 'Select labels', canPickMany: true },
        );
        if (!picked) { post({ type: 'PRDETAIL_UPDATE_LABELS_RESULT', ok: true }); break; }
        const result = await this.pullRequestManager.updateLabels(repoId, pr.number, picked.map(p => p.id));
        post({ type: 'PRDETAIL_UPDATE_LABELS_RESULT', ok: result.ok, unsupported: 'unsupported' in result ? result.unsupported : undefined, error: result.error });
        if (result.ok) this.onChanged();
        else if (!('unsupported' in result)) vscode.window.showErrorMessage(result.error ?? 'Failed to update labels');
        break;
      }
    }
  }

  private async checkoutPullRequest(repoId: string, pr: PullRequestSummary, mode: 'pr' | 'branch', post: (m: HostToPrDetailMsg) => void): Promise<void> {
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking out PR #${pr.number}…`, cancellable: false },
        () => this.pullRequestManager.checkoutPullRequest(repoId, pr, mode),
      );
      post({ type: 'PRDETAIL_CHECKOUT_RESULT', ok: result.ok, branchName: result.branchName, error: result.error });
      if (result.ok) {
        logInfo('pullrequest-checkout', `Checked out PR #${pr.number} as "${result.branchName}"`);
        vscode.window.showInformationMessage(`Checked out PR #${pr.number} as "${result.branchName}"`);
      } else {
        logError('pullrequest-checkout', `Failed to check out PR #${pr.number}`, result.error);
        vscode.window.showErrorMessage(result.error ?? 'Failed to check out pull request');
      }
    } catch (e: unknown) {
      const message = redactCredentialsInUrls(formatGitError(e));
      logError('pullrequest-checkout', message, redactCredentialsInUrls(getRawErrorDetail(e) ?? ''));
      post({ type: 'PRDETAIL_CHECKOUT_RESULT', ok: false, error: message });
      vscode.window.showErrorMessage(message);
    }
  }

  /** Opens every changed file in VS Code's native multi-diff editor (vscode.changes) instead of one tab per file. */
  private async openAllChanges(repoId: string, pr: PullRequestSummary, post: (m: HostToPrDetailMsg) => void): Promise<void> {
    const { items: files, error } = await this.pullRequestManager.listChangedFiles(repoId, pr.number);
    if (error) {
      vscode.window.showErrorMessage(error);
      return;
    }
    if (files.length === 0) {
      vscode.window.showInformationMessage('No changed files to show.');
      return;
    }

    const detailResult = await this.pullRequestManager.getPullRequestDetail(repoId, pr.number);
    if ('error' in detailResult) {
      post({ type: 'PRDETAIL_FILE_DIFF_ERROR', path: '', error: detailResult.error });
      return;
    }

    await this.openMultiDiff(
      repoId, pr, files,
      file => this.pullRequestManager.getFileDiff(repoId, pr.number, file, detailResult),
      `${repoId}:${pr.number}:`,
      file => file.oldPath ?? file.path,
      file => file.path,
      `PR #${pr.number} — ${pr.title}`,
    );
  }

  /** Opens every file changed by a single commit in the native multi-diff editor. */
  private async openCommitAllChanges(repoId: string, pr: PullRequestSummary, commitSha: string, parentSha: string | undefined): Promise<void> {
    const { items: files, error } = await this.pullRequestManager.listCommitFiles(repoId, commitSha);
    if (error) {
      vscode.window.showErrorMessage(error);
      return;
    }
    if (files.length === 0) {
      vscode.window.showInformationMessage('No changed files to show.');
      return;
    }

    await this.openMultiDiff(
      repoId, pr, files,
      file => this.pullRequestManager.getCommitFileDiff(repoId, pr.number, file, commitSha, parentSha),
      `${repoId}:commit:${commitSha}:`,
      file => `${commitSha}:${file.oldPath ?? file.path}`,
      file => `${commitSha}:${file.path}`,
      `${commitSha.slice(0, 8)} — ${pr.title}`,
    );
  }

  private async openMultiDiff(
    repoId: string, pr: PullRequestSummary, files: ChangedFile[],
    getDiff: (file: ChangedFile) => Promise<FileDiffContent | { error: string }>,
    cacheKeyPrefix: string,
    leftPath: (file: ChangedFile) => string,
    rightPath: (file: ChangedFile) => string,
    title: string,
  ): Promise<void> {
    const resources = await Promise.all(files.map(async file => {
      const cacheKey = `${cacheKeyPrefix}${file.path}`;
      let content = this.diffCache.get(cacheKey);
      if (!content) {
        const diffResult = await getDiff(file);
        if ('error' in diffResult) return null;
        content = diffResult;
        this.diffCache.set(cacheKey, content);
      }

      const leftUri = PullRequestDocumentProvider.buildUri(repoId, pr.number, 'base', leftPath(file));
      const rightUri = PullRequestDocumentProvider.buildUri(repoId, pr.number, 'head', rightPath(file));
      this.prDocProvider.set(leftUri, content.beforeContent);
      this.prDocProvider.set(rightUri, content.afterContent);
      return [rightUri, leftUri, rightUri] as [vscode.Uri, vscode.Uri, vscode.Uri];
    }));

    const validResources = resources.filter((r): r is [vscode.Uri, vscode.Uri, vscode.Uri] => r !== null);
    if (validResources.length === 0) {
      logWarn('pullrequest-multi-diff', `All ${files.length} file diffs failed to load for PR #${pr.number}`);
      vscode.window.showErrorMessage('Failed to load file diffs.');
      return;
    }

    await vscode.commands.executeCommand('vscode.changes', title, validResources);
  }

  private async openFileDiff(repoId: string, pr: PullRequestSummary, file: ChangedFile, post: (m: HostToPrDetailMsg) => void): Promise<void> {
    const cacheKey = `${repoId}:${pr.number}:${file.path}`;
    let content = this.diffCache.get(cacheKey);

    if (!content) {
      const detailResult = await this.pullRequestManager.getPullRequestDetail(repoId, pr.number);
      if ('error' in detailResult) {
        post({ type: 'PRDETAIL_FILE_DIFF_ERROR', path: file.path, error: detailResult.error });
        return;
      }
      const diffResult = await this.pullRequestManager.getFileDiff(repoId, pr.number, file, detailResult);
      if ('error' in diffResult) {
        post({ type: 'PRDETAIL_FILE_DIFF_ERROR', path: file.path, error: diffResult.error });
        return;
      }
      content = diffResult;
      this.diffCache.set(cacheKey, content);
    }

    const leftUri = PullRequestDocumentProvider.buildUri(repoId, pr.number, 'base', file.oldPath ?? file.path);
    const rightUri = PullRequestDocumentProvider.buildUri(repoId, pr.number, 'head', file.path);
    this.prDocProvider.set(leftUri, content.beforeContent);
    this.prDocProvider.set(rightUri, content.afterContent);

    const title = `${file.path} (PR #${pr.number})`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
  }

  private async openCommitFileDiff(repoId: string, pr: PullRequestSummary, file: ChangedFile, commitSha: string, parentSha: string | undefined, post: (m: HostToPrDetailMsg) => void): Promise<void> {
    const cacheKey = `${repoId}:commit:${commitSha}:${file.path}`;
    let content = this.diffCache.get(cacheKey);

    if (!content) {
      const diffResult = await this.pullRequestManager.getCommitFileDiff(repoId, pr.number, file, commitSha, parentSha);
      if ('error' in diffResult) {
        post({ type: 'PRDETAIL_FILE_DIFF_ERROR', path: file.path, error: diffResult.error });
        return;
      }
      content = diffResult;
      this.diffCache.set(cacheKey, content);
    }

    const leftUri = PullRequestDocumentProvider.buildUri(repoId, pr.number, 'base', `${commitSha}:${file.oldPath ?? file.path}`);
    const rightUri = PullRequestDocumentProvider.buildUri(repoId, pr.number, 'head', `${commitSha}:${file.path}`);
    this.prDocProvider.set(leftUri, content.beforeContent);
    this.prDocProvider.set(rightUri, content.afterContent);

    const title = `${file.path} (${commitSha.slice(0, 8)})`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
  }

  dispose(): void {
    this.panels.forEach(p => p.dispose());
    this.panels.clear();
  }
}
