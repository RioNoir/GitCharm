import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from '../utils/webviewHtml';
import { panelIcon } from '../utils/panelIcon';
import { webviewReadyGate } from '../utils/webviewReadyGate';
import { createGit } from '../git/gitClient';
import { parseRebaseTodo, serializeRebaseTodo } from '../git/rebaseTodo';
import { isProtectedBranch } from '../utils/protectedBranches';
import { formatGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logError, logInfo } from '../utils/Logger';
import { plural } from '../utils/plural';
import { openCommitFullDetailPanel } from './CommitFullDetailPanel';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import type { HostToRebaseMsg, RebaseCommit, RebasePlanEntry, RebaseToHostMsg } from '../types/messages';

/** Where an interactive rebase starts: from a commit of the current branch (included), or onto another branch. */
export type RebaseTarget = { kind: 'commit'; hash: string } | { kind: 'onto'; ref: string };

export interface InteractiveRebaseDeps {
  extensionUri: vscode.Uri;
  manager: WorkspaceGitManager;
  /** Called once git has moved the branch (or stopped part way), for the panels to reload. */
  onDidRebase: () => void;
}

function createPanel(extensionUri: vscode.Uri, title: string): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'gitcharm.interactiveRebase',
    title,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
  );
  panel.iconPath = panelIcon(extensionUri, 'history');
  panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'interactiveRebase', title);
  return panel;
}

/**
 * The interactive rebase editor of a rebase GitCharm starts itself: the plan is made in the editor and git
 * runs only once it is confirmed, with the new messages collected up front (see GitService.interactiveRebase).
 */
export class InteractiveRebasePanel {
  /** One editor per repository. */
  private static readonly open = new Map<string, InteractiveRebasePanel>();

  static async show(deps: InteractiveRebaseDeps, repoId: string, target: RebaseTarget): Promise<void> {
    const repo = deps.manager.getRepo(repoId);
    const meta = deps.manager.getRepoMetas().find(m => m.id === repoId);
    if (!repo || !meta) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
      return;
    }
    const existing = InteractiveRebasePanel.open.get(repoId);
    if (existing) {
      existing.panel.dispose();
    }
    const state = await repo.getMergeRebaseState();
    if (state) {
      void vscode.window.showWarningMessage(state === 'rebase'
        ? vscode.l10n.t('A rebase is already in progress in {0}. Continue or abort it first.', meta.name)
        : vscode.l10n.t('A merge is in progress in {0}. Commit or abort it first.', meta.name));
      return;
    }

    let upstream: string | null;
    let onto: string;
    try {
      if (target.kind === 'commit') {
        if (!(await repo.isAncestorOfHead(target.hash))) {
          void vscode.window.showWarningMessage(vscode.l10n.t('Commit {0} is not on the current branch.', target.hash.slice(0, 8)));
          return;
        }
        const { parents } = await repo.getCommitMeta(target.hash);
        upstream = parents[0] ?? null;
        onto = upstream ? upstream.slice(0, 8) : '';
      } else {
        upstream = target.ref;
        onto = target.ref;
      }
    } catch (e: unknown) {
      logError('interactiveRebase', formatGitError(e), getRawErrorDetail(e));
      void vscode.window.showErrorMessage(vscode.l10n.t('Interactive rebase failed: {0}', formatGitError(e)));
      return;
    }

    const [{ commits, mergeCount }, branchInfo] = await Promise.all([repo.getRebaseCommits(upstream), repo.getCurrentBranch()]);
    if (commits.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to rebase: the current branch has no commits that are not on "{0}".', onto));
      return;
    }
    const branch = branchInfo.name || 'HEAD';
    const panel = createPanel(deps.extensionUri, vscode.l10n.t('Interactive Rebase: {0}', branch));
    const view = new InteractiveRebasePanel(panel, deps, repo, repoId, upstream, commits, branch);
    InteractiveRebasePanel.open.set(repoId, view);
    view.post({
      type: 'REBASE_INIT', mode: 'managed', repoName: meta.name, branch, onto, commits, mergeCount,
      protectedBranch: isProtectedBranch(branchInfo.name),
    });
  }

  private readonly post: (msg: HostToRebaseMsg) => void;
  private running = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: InteractiveRebaseDeps,
    private readonly repo: GitService,
    private readonly repoId: string,
    private readonly upstream: string | null,
    private readonly commits: RebaseCommit[],
    private readonly branch: string,
  ) {
    const gate = webviewReadyGate<HostToRebaseMsg>(panel);
    this.post = m => gate.post(m);
    const sub = panel.webview.onDidReceiveMessage((msg: RebaseToHostMsg) => { void this.onMessage(msg); });
    panel.onDidDispose(() => {
      sub.dispose();
      if (InteractiveRebasePanel.open.get(repoId) === this) InteractiveRebasePanel.open.delete(repoId);
    });
  }

  private async onMessage(msg: RebaseToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'REBASE_CANCEL':
        if (!this.running) this.panel.dispose();
        break;
      case 'REBASE_OPEN_COMMIT':
        await openCommitFullDetailPanel(this.deps.extensionUri, this.deps.manager, this.repoId, msg.hash);
        break;
      case 'REBASE_START':
        if (!this.running) await this.start(msg.plan);
        break;
    }
  }

  private async start(plan: RebasePlanEntry[]): Promise<void> {
    const repoName = path.basename(this.repo.rootPath);
    // Every commit after the first one changed is rewritten, so that is where a force push starts to be needed.
    const firstChanged = plan.findIndex((e, i) => e.action !== 'pick' || e.hash !== this.commits[i]?.hash);
    if (firstChanged < 0) {
      this.panel.dispose();
      return;
    }
    const rewrittenPushed = plan.slice(firstChanged).filter(e => this.commits.find(c => c.hash === e.hash)?.pushed).length;
    if (rewrittenPushed > 0) {
      const action = vscode.l10n.t('Rebase Anyway');
      const pushed = plural(rewrittenPushed,
        vscode.l10n.t('1 commit of the rebase has already been pushed.'),
        vscode.l10n.t('{0} commits of the rebase have already been pushed.', rewrittenPushed));
      const detail = isProtectedBranch(this.branch)
        ? vscode.l10n.t('"{0}" is a protected branch: rewriting its history means force pushing it, which GitCharm refuses.', this.branch)
        : vscode.l10n.t('Rewriting them means force pushing the branch, which can break the work of anyone who has pulled them.');
      if (await vscode.window.showWarningMessage(pushed, { modal: true, detail }, action) !== action) return;
    }

    let autostash = false;
    if (await this.repo.hasTrackedChanges()) {
      const action = vscode.l10n.t('Stash and Rebase');
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t('{0} has uncommitted changes.', repoName),
        { modal: true, detail: vscode.l10n.t('They are stashed before the rebase and restored after it.') },
        action);
      if (pick !== action) return;
      autostash = true;
    }

    this.running = true;
    this.post({ type: 'REBASE_BUSY', busy: true });
    const subjects = new Map(this.commits.map(c => [c.hash, c.subject]));
    let error: unknown;
    try {
      await this.repo.interactiveRebase(this.upstream, plan, subjects, autostash);
    } catch (e: unknown) {
      error = e;
    }
    this.running = false;
    const stopped = await this.repo.getMergeRebaseState() === 'rebase';
    this.deps.onDidRebase();

    if (error && !stopped) {
      logError('interactiveRebase', formatGitError(error), getRawErrorDetail(error));
      this.post({ type: 'REBASE_BUSY', busy: false });
      this.post({ type: 'REBASE_ERROR', error: formatGitError(error) });
      return;
    }
    this.panel.dispose();
    if (!stopped) {
      logInfo('interactiveRebase', `Rebased ${this.branch} in ${repoName}`);
      vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Rebased "{0}"', this.branch), 5000);
      return;
    }
    await reportStoppedRebase(this.repo, repoName);
  }
}

/** Tells why a rebase stopped part way — an edit, a conflict, or a failed message update — and where to go on. */
async function reportStoppedRebase(repo: GitService, repoName: string): Promise<void> {
  const [status, progress] = await Promise.all([repo.getStatusFresh().catch(() => undefined), repo.getRebaseProgress()]);
  const step = progress ? ` (${progress.step}/${progress.total})` : '';
  const message = (status?.conflictCount ?? 0) > 0
    ? vscode.l10n.t('The rebase in {0} stopped on conflicts{1}. Resolve them, then continue the rebase from the Commit Panel.', repoName, step)
    : vscode.l10n.t('The rebase in {0} stopped{1}. Make your changes, then continue the rebase from the Commit Panel.', repoName, step);
  const open = vscode.l10n.t('Open Commit Panel');
  if (await vscode.window.showInformationMessage(message, open) === open) {
    await vscode.commands.executeCommand('gitcharm.commitPanel.focus');
  }
}

/**
 * The interactive rebase editor for a git-rebase-todo file git opened in VS Code — a rebase started in the
 * terminal with sequence.editor set to `code --wait`. The plan is written back to the file and its tab closed,
 * which lets git carry on; git asks for new messages itself, in an editor of its own.
 */
export class RebaseTodoEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'gitcharm.rebaseTodo';

  constructor(private readonly extensionUri: vscode.Uri) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const parsed = parseRebaseTodo(document.getText());
    // Lines the editor can't show (exec, merges, update-ref…) would be lost by writing the plan back.
    if (parsed.unsupported.length > 0 || parsed.entries.length === 0) {
      panel.dispose();
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      if (parsed.unsupported.length > 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t('This rebase todo has commands the interactive rebase editor does not support, so it is open as text.'));
      }
      return;
    }

    // The todo lives in <git dir>/rebase-merge; git works from the git dir as well as from the work tree.
    const gitDir = path.dirname(path.dirname(document.uri.fsPath));
    const git = createGit(gitDir);
    const commits = await readTodoCommits(git, parsed.entries.map(e => e.hash));
    const headName = await readFile(path.join(gitDir, 'rebase-merge', 'head-name'));
    const ontoHash = await readFile(path.join(gitDir, 'rebase-merge', 'onto'));
    const branch = headName.replace(/^refs\/heads\//, '') || 'HEAD';
    const onto = ontoHash ? (await git.raw(['name-rev', '--name-only', '--no-undefined', ontoHash]).catch(() => '')).trim() || ontoHash.slice(0, 8) : '';
    const repoName = path.basename(gitDir) === '.git' ? path.basename(path.dirname(gitDir)) : path.basename(gitDir);

    panel.title = vscode.l10n.t('Interactive Rebase: {0}', branch);
    panel.iconPath = panelIcon(this.extensionUri, 'history');
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'interactiveRebase', panel.title);
    const gate = webviewReadyGate<HostToRebaseMsg>(panel);
    gate.post({
      type: 'REBASE_INIT', mode: 'todo', repoName, branch, onto, commits,
      actions: parsed.entries.map(e => e.action), mergeCount: 0, protectedBranch: isProtectedBranch(branch),
    });

    const subjects = new Map(commits.map(c => [c.hash, c.subject]));
    const sub = panel.webview.onDidReceiveMessage(async (msg: RebaseToHostMsg) => {
      switch (msg.type) {
        case 'REBASE_START':
          await this.finish(document, serializeRebaseTodo(msg.plan, subjects));
          break;
        case 'REBASE_CANCEL':
          // An empty todo is how git is told to abort the rebase.
          await this.finish(document, '');
          break;
        case 'REBASE_OPEN_COMMIT':
          break;
      }
    });
    panel.onDidDispose(() => sub.dispose());
  }

  /** Writes the todo, saves it, and closes its tab — `code --wait` returns to git once the file is closed. */
  private async finish(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
      .filter(t => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === document.uri.toString());
    await vscode.window.tabGroups.close(tabs);
  }
}

async function readFile(file: string): Promise<string> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString('utf8').trim();
  } catch {
    return '';
  }
}

/** The commits of a todo, in its order, looked up by their (short) hashes. */
async function readTodoCommits(git: ReturnType<typeof createGit>, hashes: string[]): Promise<RebaseCommit[]> {
  const RS = '\x1E', GS = '\x1D';
  const raw = await git.raw(['log', '--no-walk=unsorted', '--abbrev=8', `--format=%H${GS}%h${GS}%aN${GS}%aI${GS}%B${RS}`, ...hashes, '--']).catch(() => '');
  const byHash = raw.split(RS).map(r => r.replace(/^\n/, '')).filter(Boolean).map(record => {
    const [hash, shortHash, authorName, authorDate, body = ''] = record.split(GS);
    const message = body.trim();
    return { hash, shortHash, authorName, authorDate, message, subject: message.split('\n')[0] ?? '', pushed: false };
  });
  return hashes.map(h => byHash.find(c => c.hash.startsWith(h.toLowerCase()))
    ?? { hash: h, shortHash: h.slice(0, 8), authorName: '', authorDate: '', message: '', subject: '', pushed: false });
}
