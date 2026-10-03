import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { panelIcon } from '../utils/panelIcon';
import { webviewReadyGate } from '../utils/webviewReadyGate';
import { getAiModelLabel } from '../utils/aiModelLabel';
import { logError, logInfo } from '../utils/Logger';
import { formatGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { promptBranchName } from '../utils/branchNamePrompt';
import { buildSimpleUnifiedDiff } from '../utils/simpleUnifiedDiff';
import { agentProviderFor, generateForOperation, runAgentForOperation } from '../ai/aiGenerate';
import { PullRequestDocumentProvider } from '../pullRequests/PullRequestDocumentProvider';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { issueCommitReference, type IssueManager } from '../issues/IssueManager';
import {
  buildFileSelectionPrompt, buildResolveAgentPrompt, buildResolveTextPrompt, buildTextProposal, collectWorktreeChanges,
  createScratchWorktree, dirtyFilesAmong, listRepositoryFiles, parseFileSelection, parseResolveAnswer, readSelectedFiles,
  removeScratchWorktree, writeProposal, type IssueContext, type ProposedChange,
} from '../issues/issueAi';
import { generateIssueBranchName, loadIssueContext } from '../issues/issueAiActions';
import type { HostToIssueResolveMsg, IssueResolveFile, IssueResolveToHostMsg, IssueSummary } from '../types/messages';

/** Large enough for a plan plus edits to several files — only the Anthropic API needs an explicit bound. */
const TEXT_MAX_TOKENS = 16_000;
const TEXT_TIMEOUT_MS = 10 * 60_000;

function countChangedLines(change: ProposedChange): { additions: number; deletions: number } {
  if (change.status === 'added') return { additions: change.after.split('\n').length, deletions: 0 };
  if (change.status === 'deleted') return { additions: 0, deletions: change.before.split('\n').length };
  const diff = buildSimpleUnifiedDiff(change.before, change.after);
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

interface Session {
  panel: vscode.WebviewPanel;
  repoId: string;
  issue: IssueSummary;
  id: number;
  abort?: AbortController;
  context?: IssueContext;
  changes: ProposedChange[];
  running: boolean;
  applied: boolean;
}

/**
 * "Resolve with AI": works out a fix for an issue and shows it as a proposal — the plan and every changed file with
 * its diff. Nothing touches the user's working tree until "Apply": then a branch is created from HEAD and the files
 * are written, without committing. With Claude Code or Codex the agent edits files itself, in a throwaway worktree;
 * with any other provider the model picks the files to read and answers with edit blocks.
 */
export class IssueResolvePanel {
  private sessions = new Map<string, Session>();
  private nextSessionId = 1;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly issueManager: IssueManager,
    private readonly docProvider: PullRequestDocumentProvider,
    /** The proposal is in the working tree on its new branch — show the Commit Panel with a draft message. */
    private readonly onApplied: (repoId: string, issue: IssueSummary, commitDraft: string) => void,
  ) {}

  open(repoId: string, issue: IssueSummary): void {
    const key = `${repoId}:${issue.number}`;
    const existing = this.sessions.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'gitcharm.issueResolve',
      vscode.l10n.t('Resolve #{0} with AI', issue.number),
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    panel.iconPath = panelIcon(this.extensionUri, 'sparkle');
    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'issueResolve', panel.title);
    webviewReadyGate<HostToIssueResolveMsg>(panel);

    const session: Session = { panel, repoId, issue, id: this.nextSessionId++, changes: [], running: false, applied: false };
    this.sessions.set(key, session);
    panel.webview.onDidReceiveMessage((msg: IssueResolveToHostMsg) => this.handleMessage(session, msg).catch(e => {
      logError('issue-resolve', formatGitError(e), getRawErrorDetail(e));
    }));
    panel.onDidDispose(() => {
      session.abort?.abort();
      this.sessions.delete(key);
    });
    void this.run(session);
  }

  private post(session: Session, msg: HostToIssueResolveMsg): void {
    webviewReadyGate<HostToIssueResolveMsg>(session.panel).post(msg);
  }

  private async run(session: Session): Promise<void> {
    const meta = this.manager.getRepoMetas().find(m => m.id === session.repoId);
    if (!meta) {
      this.post(session, { type: 'ISSUERESOLVE_ERROR', error: vscode.l10n.t('Repository not found') });
      return;
    }
    const cfg = vscode.workspace.getConfiguration('gitcharm');
    const agent = agentProviderFor('issues', cfg);
    const abort = new AbortController();
    session.abort = abort;
    session.running = true;
    session.changes = [];
    this.post(session, {
      type: 'ISSUERESOLVE_INIT', repoName: meta.name, number: session.issue.number, title: session.issue.title,
      mode: agent ? 'agent' : 'text', modelLabel: getAiModelLabel(cfg, 'issues'),
    });
    this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'preparing' });

    try {
      const context = session.context ?? await loadIssueContext(this.issueManager, session.repoId, session.issue.number);
      if ('error' in context) throw new Error(context.error);
      session.context = context;

      let summary: string;
      let result: { changes: ProposedChange[]; warnings: string[] };
      if (agent) {
        this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'agentWorking' });
        const worktree = await createScratchWorktree(meta.rootPath, `${meta.name}-${session.issue.number}`);
        try {
          summary = await runAgentForOperation('issues', buildResolveAgentPrompt(context, cfg), cfg, {
            cwd: worktree,
            signal: abort.signal,
            onProgress: text => this.post(session, { type: 'ISSUERESOLVE_PROGRESS', text }),
          });
          this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'collecting' });
          result = await collectWorktreeChanges(worktree);
        } finally {
          await removeScratchWorktree(meta.rootPath, worktree);
        }
      } else {
        this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'selectingFiles' });
        const { files, truncated } = await listRepositoryFiles(meta.rootPath);
        const selectionAnswer = await generateForOperation('issues', buildFileSelectionPrompt(context, files, truncated, cfg), cfg, {
          maxTokens: 2000, timeoutMs: TEXT_TIMEOUT_MS, signal: abort.signal,
        });
        const selected = parseFileSelection(selectionAnswer, files);
        this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'readingFiles' });
        const contents = await readSelectedFiles(meta.rootPath, selected);
        this.post(session, { type: 'ISSUERESOLVE_FILES_READ', paths: [...contents.keys()] });
        this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'generating' });
        const answer = await generateForOperation('issues', buildResolveTextPrompt(context, contents, cfg), cfg, {
          maxTokens: TEXT_MAX_TOKENS, timeoutMs: TEXT_TIMEOUT_MS, signal: abort.signal, preserveIndentation: true,
          onProgress: text => this.post(session, { type: 'ISSUERESOLVE_PROGRESS', text }),
        });
        this.post(session, { type: 'ISSUERESOLVE_PROGRESS', text: answer });
        this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'collecting' });
        const parsed = parseResolveAnswer(answer);
        summary = parsed.plan;
        result = await buildTextProposal(meta.rootPath, parsed.blocks, contents);
      }

      session.changes = result.changes;
      const files: IssueResolveFile[] = result.changes.map(c => ({ path: c.path, status: c.status, ...countChangedLines(c) }));
      this.post(session, { type: 'ISSUERESOLVE_RESULT', summary, files, warnings: result.warnings });
      this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'ready' });
      logInfo('issue-resolve', `AI proposal for issue #${session.issue.number}: ${files.length} file(s)`);
    } catch (e) {
      if (abort.signal.aborted) {
        this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'cancelled' });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        logError('issue-resolve', `Failed to resolve issue #${session.issue.number}`, message);
        this.post(session, { type: 'ISSUERESOLVE_ERROR', error: message });
        this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'failed' });
      }
    } finally {
      session.running = false;
    }
  }

  private diffUris(session: Session, change: ProposedChange): [vscode.Uri, vscode.Uri] {
    // The session id keeps a retried proposal from showing a previous one's cached content.
    const virtualPath = `ai-${session.id}/${change.path}`;
    const left = PullRequestDocumentProvider.buildUri(session.repoId, session.issue.number, 'base', virtualPath);
    const right = PullRequestDocumentProvider.buildUri(session.repoId, session.issue.number, 'head', virtualPath);
    this.docProvider.set(left, change.before);
    this.docProvider.set(right, change.after);
    return [left, right];
  }

  private async handleMessage(session: Session, msg: IssueResolveToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'ISSUERESOLVE_OPEN_DIFF': {
        const change = session.changes.find(c => c.path === msg.path);
        if (!change) break;
        const [left, right] = this.diffUris(session, change);
        await vscode.commands.executeCommand('vscode.diff', left, right, vscode.l10n.t('{0} (AI proposal)', change.path), { preview: true });
        break;
      }

      case 'ISSUERESOLVE_VIEW_ALL': {
        if (session.changes.length === 0) break;
        const resources = session.changes.map(c => {
          const [left, right] = this.diffUris(session, c);
          return [right, left, right] as [vscode.Uri, vscode.Uri, vscode.Uri];
        });
        await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('Issue #{0} — AI proposal', session.issue.number), resources);
        break;
      }

      case 'ISSUERESOLVE_CANCEL': {
        session.abort?.abort();
        break;
      }

      case 'ISSUERESOLVE_RETRY': {
        if (!session.running) void this.run(session);
        break;
      }

      case 'ISSUERESOLVE_DISCARD': {
        session.panel.dispose();
        break;
      }

      case 'ISSUERESOLVE_APPLY': {
        await this.apply(session);
        break;
      }

      case 'ISSUERESOLVE_OPEN_COMMIT_PANEL': {
        this.onApplied(session.repoId, session.issue, this.commitDraft(session));
        break;
      }
    }
  }

  private commitDraft(session: Session): string {
    return `${session.issue.title}\n\n${issueCommitReference(session.issue)}`;
  }

  /** Creates a branch from HEAD named for the issue (the AI's suggestion, editable) and writes the proposal there. */
  private async apply(session: Session): Promise<void> {
    const repo = this.manager.getRepo(session.repoId);
    const meta = this.manager.getRepoMetas().find(m => m.id === session.repoId);
    if (!repo || !meta || session.changes.length === 0 || session.applied || !session.context) return;

    const dirty = await dirtyFilesAmong(meta.rootPath, session.changes.map(c => c.path));
    if (dirty.length > 0) {
      const overwrite = vscode.l10n.t('Overwrite');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('These files have uncommitted changes that the proposal would overwrite:'),
        { modal: true, detail: dirty.join('\n') },
        overwrite,
      );
      if (choice !== overwrite) return;
    }

    const context = session.context;
    const suggested = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Suggesting a branch name…') },
      () => generateIssueBranchName(this.issueManager, session.repoId, context),
    );
    const branchName = await promptBranchName({
      title: vscode.l10n.t('Branch for the Fix of Issue #{0}', session.issue.number),
      prompt: vscode.l10n.t('The branch is created from the current HEAD, then the proposed changes are written to it (not committed)'),
      value: suggested,
    });
    if (!branchName) return;

    this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'applying' });
    try {
      await repo.checkout(branchName, true);
      await writeProposal(meta.rootPath, session.changes);
      session.applied = true;
      logInfo('issue-resolve', `Applied the AI proposal for issue #${session.issue.number} on "${branchName}"`);
      this.post(session, { type: 'ISSUERESOLVE_APPLIED', branchName });
      this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'applied' });
      this.onApplied(session.repoId, session.issue, this.commitDraft(session));
    } catch (e) {
      const message = formatGitError(e);
      logError('issue-resolve-apply', message, getRawErrorDetail(e));
      this.post(session, { type: 'ISSUERESOLVE_ERROR', error: message });
      this.post(session, { type: 'ISSUERESOLVE_PHASE', phase: 'ready' });
      vscode.window.showErrorMessage(message);
    }
  }

  dispose(): void {
    this.sessions.forEach(s => s.panel.dispose());
    this.sessions.clear();
  }
}
