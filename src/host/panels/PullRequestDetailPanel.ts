import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { redactCredentialsInUrls, type PullRequestManager } from '../pullRequests/PullRequestManager';
import { PullRequestDocumentProvider } from '../pullRequests/PullRequestDocumentProvider';
import { loadIconTheme } from '../utils/IconThemeService';
import type { ChangedFile, FileDiffContent, HostToPrDetailMsg, PrDetailToHostMsg, PullRequestSummary } from '../types/messages';
import { formatGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logInfo, logWarn, logError } from '../utils/Logger';

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

    const meta = this.manager.getRepoMetas().find(m => m.id === repoId);
    if (!meta) {
      logWarn('pullrequest-detail-open', `Repository not found for repoId ${repoId}`);
      vscode.window.showErrorMessage('Repository not found');
      return;
    }

    const localResourceRoots: vscode.Uri[] = [this.extensionUri];
    for (const ext of vscode.extensions.all) {
      const themes: Array<{ id: string }> = ext.packageJSON?.contributes?.iconThemes ?? [];
      if (themes.length > 0) localResourceRoots.push(vscode.Uri.file(ext.extensionPath));
    }

    const panel = vscode.window.createWebviewPanel(
      'gitcharm.pullRequestDetail',
      `PR #${pr.number}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots }
    );
    panel.iconPath = new vscode.ThemeIcon('git-pull-request');

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      'pullRequestDetail',
      `PR #${pr.number}`
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

      case 'PRDETAIL_REQUEST_TARGET_BRANCHES': {
        if (!pr.targetRepoFullName) {
          post({ type: 'PRDETAIL_TARGET_BRANCHES_RESULT', branches: [], error: 'Target repository is unknown' });
          break;
        }
        const { items: branches, error } = await this.pullRequestManager.listTargetBranches(repoId, pr.targetRepoFullName);
        post({ type: 'PRDETAIL_TARGET_BRANCHES_RESULT', branches, error });
        break;
      }

      case 'PRDETAIL_UPDATE': {
        const result = await this.pullRequestManager.updatePullRequest(repoId, pr.number, { title: msg.title, targetBranch: msg.targetBranch });
        post({ type: 'PRDETAIL_UPDATE_RESULT', ok: result.ok, error: result.error });
        if (result.ok) {
          this.onChanged();
        } else {
          vscode.window.showErrorMessage(result.error ?? 'Failed to update pull request');
        }
        break;
      }

      case 'PRDETAIL_REQUEST_COLLABORATORS': {
        if (!pr.targetRepoFullName) {
          post({ type: 'PRDETAIL_COLLABORATORS_RESULT', collaborators: [], error: 'Target repository is unknown' });
          break;
        }
        const { items: collaborators, error } = await this.pullRequestManager.listCollaborators(repoId, pr.targetRepoFullName);
        post({ type: 'PRDETAIL_COLLABORATORS_RESULT', collaborators, error });
        break;
      }

      case 'PRDETAIL_UPDATE_REVIEWERS': {
        const result = await this.pullRequestManager.updateReviewers(repoId, pr.number, msg.userIds);
        post({ type: 'PRDETAIL_UPDATE_REVIEWERS_RESULT', ok: result.ok, error: result.error });
        if (result.ok) this.onChanged();
        else vscode.window.showErrorMessage(result.error ?? 'Failed to update reviewers');
        break;
      }

      case 'PRDETAIL_UPDATE_ASSIGNEES': {
        const result = await this.pullRequestManager.updateAssignees(repoId, pr.number, msg.userIds);
        post({ type: 'PRDETAIL_UPDATE_ASSIGNEES_RESULT', ok: result.ok, unsupported: 'unsupported' in result ? result.unsupported : undefined, error: result.error });
        if (result.ok) this.onChanged();
        else if (!('unsupported' in result)) vscode.window.showErrorMessage(result.error ?? 'Failed to update assignees');
        break;
      }

      case 'PRDETAIL_REQUEST_AVAILABLE_LABELS': {
        if (!pr.targetRepoFullName) {
          post({ type: 'PRDETAIL_AVAILABLE_LABELS_RESULT', labels: [], error: 'Target repository is unknown' });
          break;
        }
        const { items: labels, error } = await this.pullRequestManager.listAvailableLabels(repoId, pr.targetRepoFullName);
        post({ type: 'PRDETAIL_AVAILABLE_LABELS_RESULT', labels, error });
        break;
      }

      case 'PRDETAIL_UPDATE_LABELS': {
        const result = await this.pullRequestManager.updateLabels(repoId, pr.number, msg.labelIds);
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
