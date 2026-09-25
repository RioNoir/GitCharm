import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import type { ChangedFile, HostToPrCreateMsg, PrCreateToHostMsg } from '../types/messages';
import { formatGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logInfo, logError } from '../utils/Logger';
import { getAiModelLabel } from '../utils/aiModelLabel';
import { buildPrompt } from '../ai/prompts';
import type { GitService } from '../git/GitService';
import { pickRefQuickPick } from '../utils/refPicker';
import { loadIconTheme } from '../utils/IconThemeService';
import { panelIcon } from '../utils/panelIcon';
import { webviewReadyGate } from '../utils/webviewReadyGate';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const RAW_STATUS_MAP: Record<string, ChangedFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed' };

// Where GitHub, GitLab and Gitea/Forgejo look for a repo's default PR description template.
const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md',
  '.gitlab/merge_request_templates/Default.md', '.gitea/pull_request_template.md', '.forgejo/pull_request_template.md',
];

async function readPullRequestTemplate(rootPath: string): Promise<string | undefined> {
  for (const rel of PR_TEMPLATE_PATHS) {
    try {
      const text = (await fs.readFile(path.join(rootPath, rel), 'utf8')).trim();
      if (text) return text.slice(0, 4000);
    } catch { /* not there — try the next one */ }
  }
  return undefined;
}

/** Strips what models add despite being told not to: a fence around the whole answer, and for a title a heading
 * marker, bold, quotes, a "Title:" prefix or extra lines. */
function cleanGeneratedText(raw: string, field: 'title' | 'description'): string {
  const text = raw.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, '$1').trim();
  if (field === 'description') return text.replace(/^description\s*:\s*\n?/i, '').trim();
  const firstLine = text.split('\n').find(l => l.trim()) ?? '';
  return firstLine.trim()
    .replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').replace(/^title\s*:\s*/i, '')
    .replace(/^["'`](.*)["'`]$/, '$1').trim();
}

function mapRawFileToChangedFile(f: { path: string; status: string; added?: number; removed?: number; oldPath?: string }): ChangedFile {
  return { path: f.path, oldPath: f.oldPath, status: RAW_STATUS_MAP[f.status[0]] ?? 'modified', additions: f.added, deletions: f.removed };
}

/** Builds a `git:`-scheme URI for `filePath` at `ref` — the same virtual content source VS Code's built-in Git extension serves, so no custom content provider is needed for local branch-vs-branch diffs (see BranchStatusBar.compareSingleRepo, which this mirrors). */
function gitUri(rootPath: string, ref: string, filePath: string): vscode.Uri {
  const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
  return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
}

export class CreatePullRequestPanel {
  private panels = new Map<string, vscode.WebviewPanel>();
  /** Most recent PRCREATE_REQUEST_COMPARE requestId per repo — lets a stale in-flight compare discard its own result instead of clobbering a newer one. */
  private latestCompareRequestId = new Map<string, string>();

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
      vscode.window.showErrorMessage(vscode.l10n.t('Repository not found'));
      return;
    }

    const connection = await this.pullRequestManager.getConnectionStatus(repoId);

    // Icon theme assets (SVG icons, icon fonts) live in the icon theme's own extension, not GitCharm's —
    // without granting access here, FileIcon's <img>/@font-face URIs fail to load silently (see PullRequestDetailPanel, same fix).
    const localResourceRoots: vscode.Uri[] = [this.extensionUri];
    for (const ext of vscode.extensions.all) {
      const themes: Array<{ id: string }> = ext.packageJSON?.contributes?.iconThemes ?? [];
      if (themes.length > 0) localResourceRoots.push(vscode.Uri.file(ext.extensionPath));
    }

    const panelTitle = vscode.l10n.t('New Pull Request — {0}', meta.name);
    const panel = vscode.window.createWebviewPanel(
      'gitcharm.createPullRequest',
      panelTitle,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots }
    );
    panel.iconPath = panelIcon(this.extensionUri, 'git-pull-request');

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      'pullRequestCreate',
      panelTitle
    );
    const gate = webviewReadyGate<HostToPrCreateMsg>(panel);

    const iconThemeWatcher = vscode.workspace.onDidChangeConfiguration(async e => {
      if (!e.affectsConfiguration('workbench.iconTheme')) return;
      const iconTheme = await loadIconTheme(panel.webview).catch(() => ({ type: 'none' as const }));
      panel.webview.postMessage({ type: 'PRCREATE_ICON_THEME', iconTheme } satisfies HostToPrCreateMsg);
    });

    panel.webview.onDidReceiveMessage((msg: PrCreateToHostMsg) => this.handleMessage(msg, repoId, panel));
    panel.onDidDispose(() => { this.panels.delete(repoId); this.latestCompareRequestId.delete(repoId); iconThemeWatcher.dispose(); });
    this.panels.set(repoId, panel);

    const cfg = vscode.workspace.getConfiguration('gitcharm');
    gate.post({
      type: 'PRCREATE_INIT', repoId, repoName: meta.name, provider: connection.provider,
      aiEnabled: cfg.get('ai.enabled', true), aiModelLabel: getAiModelLabel(cfg),
    } satisfies HostToPrCreateMsg);

    const iconTheme = await loadIconTheme(panel.webview).catch(() => ({ type: 'none' as const }));
    gate.post({ type: 'PRCREATE_ICON_THEME', iconTheme });
  }

  private async handleMessage(msg: PrCreateToHostMsg, repoId: string, panel: vscode.WebviewPanel): Promise<void> {
    const post = (m: HostToPrCreateMsg) => panel.webview.postMessage(m);

    switch (msg.type) {
      case 'PRCREATE_REQUEST_BRANCHES': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) { post({ type: 'PRCREATE_BRANCHES_RESULT', branches: [], error: vscode.l10n.t('Repository not found') }); break; }
        try {
          const branches = await repo.getBranches();
          post({ type: 'PRCREATE_BRANCHES_RESULT', branches });
        } catch (e: unknown) {
          post({ type: 'PRCREATE_BRANCHES_RESULT', branches: [], error: formatGitError(e) });
        }
        break;
      }

      case 'PRCREATE_PICK_BRANCH': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) { post({ type: 'PRCREATE_BRANCH_PICKED', requestId: msg.requestId, role: msg.role, branch: undefined }); break; }
        const picked = await pickRefQuickPick(repo, {
          placeHolder: msg.role === 'source' ? vscode.l10n.t('Select source branch') : vscode.l10n.t('Select target branch'),
          title: msg.role === 'source' ? vscode.l10n.t('Pull Request: Source Branch') : vscode.l10n.t('Pull Request: Target Branch'),
          includeTags: false,
        });
        post({ type: 'PRCREATE_BRANCH_PICKED', requestId: msg.requestId, role: msg.role, branch: picked });
        break;
      }

      case 'PRCREATE_REQUEST_COMPARE': {
        this.latestCompareRequestId.set(repoId, msg.requestId);
        const repo = this.manager.getRepo(repoId);
        if (!repo) { post({ type: 'PRCREATE_COMPARE_RESULT', requestId: msg.requestId, files: [], commits: [], error: vscode.l10n.t('Repository not found') }); break; }
        try {
          const [baseHash, headHash] = await Promise.all([repo.resolveRef(msg.targetBranch), repo.resolveRef(msg.sourceBranch)]);
          const [rawFiles, commits] = await Promise.all([
            repo.getFilesBetween([baseHash, headHash]),
            repo.getCommitsBetween(baseHash, headHash),
          ]);
          if (this.latestCompareRequestId.get(repoId) !== msg.requestId) break;
          post({ type: 'PRCREATE_COMPARE_RESULT', requestId: msg.requestId, files: rawFiles.map(mapRawFileToChangedFile), commits });
        } catch (e: unknown) {
          if (this.latestCompareRequestId.get(repoId) !== msg.requestId) break;
          post({ type: 'PRCREATE_COMPARE_RESULT', requestId: msg.requestId, files: [], commits: [], error: formatGitError(e) });
        }
        break;
      }

      case 'PRCREATE_OPEN_FILE_DIFF': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) break;
        try {
          const [baseHash, headHash] = await Promise.all([repo.resolveRef(msg.targetBranch), repo.resolveRef(msg.sourceBranch)]);
          const isAdded = msg.file.status === 'added';
          const isDeleted = msg.file.status === 'deleted';
          const left = gitUri(repo.rootPath, isAdded ? EMPTY_TREE : baseHash, msg.file.oldPath ?? msg.file.path);
          const right = gitUri(repo.rootPath, isDeleted ? EMPTY_TREE : headHash, msg.file.path);
          const title = vscode.l10n.t('{0} ({1} vs {2})', msg.file.path, msg.sourceBranch, msg.targetBranch);
          await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
        } catch (e: unknown) {
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot open diff: {0}', formatGitError(e)));
        }
        break;
      }

      case 'PRCREATE_OPEN_NATIVE_COMPARE': {
        const repo = this.manager.getRepo(repoId);
        if (!repo) break;
        try {
          const [baseHash, headHash] = await Promise.all([repo.resolveRef(msg.targetBranch), repo.resolveRef(msg.sourceBranch)]);
          const rawFiles = await repo.getFilesBetween([baseHash, headHash]);
          if (rawFiles.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t("No differences between '{0}' and '{1}'.", msg.targetBranch, msg.sourceBranch));
            break;
          }
          const resources = rawFiles.filter(f => f.status !== 'U').map(f => {
            const label = vscode.Uri.file(path.join(repo.rootPath, f.path));
            const original = gitUri(repo.rootPath, f.status === 'A' ? EMPTY_TREE : baseHash, f.oldPath ?? f.path);
            const modified = gitUri(repo.rootPath, f.status === 'D' ? EMPTY_TREE : headHash, f.path);
            return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
          });
          await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('{0} vs {1}', msg.sourceBranch, msg.targetBranch), resources);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot open comparison: {0}', formatGitError(e)));
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

      case 'PRCREATE_REQUEST_MENTION_CANDIDATES': {
        const users = await this.pullRequestManager.listMentionCandidates(repoId);
        post({ type: 'PRCREATE_MENTION_CANDIDATES', users });
        break;
      }

      case 'PRCREATE_GENERATE': {
        const repo = this.manager.getRepo(repoId);
        const { requestId, field } = msg;
        if (!repo) { post({ type: 'PRCREATE_GENERATE_RESULT', requestId, field, error: vscode.l10n.t('Repository not found') }); break; }
        try {
          const text = await this.generateField(repo, msg, partial => post({ type: 'PRCREATE_GENERATE_PROGRESS', requestId, field, text: partial }));
          post({ type: 'PRCREATE_GENERATE_RESULT', requestId, field, text });
        } catch (e: unknown) {
          logError('pullrequest-ai-generate', formatGitError(e), getRawErrorDetail(e));
          post({ type: 'PRCREATE_GENERATE_RESULT', requestId, field, error: formatGitError(e) });
        }
        break;
      }
    }
  }

  /** Same AI provider/settings as the commit message generator, fed with what the PR would contain: its
   * commits' messages, changed files and the merge-base diff. Generates one field at a time (each has its own
   * button, like the commit message's); whatever is already typed in the other field is passed along so the
   * two stay consistent. */
  private async generateField(
    repo: GitService,
    input: { field: 'title' | 'description'; sourceBranch: string; targetBranch: string; title: string; description: string },
    onProgress: (textSoFar: string) => void,
  ): Promise<string> {
    const { field, sourceBranch, targetBranch } = input;
    const cfg = vscode.workspace.getConfiguration('gitcharm');
    const maxDiffChars: number = cfg.get('ai.maxDiffChars', 8000);
    const [baseHash, headHash] = await Promise.all([repo.resolveRef(targetBranch), repo.resolveRef(sourceBranch)]);
    const [messages, rawFiles, diff, template] = await Promise.all([
      repo.getCommitMessagesBetween(baseHash, headHash),
      repo.getFilesBetween([baseHash, headHash]),
      repo.getBranchDiff(baseHash, headHash, maxDiffChars),
      field === 'description' ? readPullRequestTemplate(repo.rootPath) : Promise.resolve(undefined),
    ]);
    if (messages.length === 0 && rawFiles.length === 0) {
      throw new Error(vscode.l10n.t("No differences between '{0}' and '{1}'.", targetBranch, sourceBranch));
    }

    const otherTitle = input.title.trim();
    const otherDescription = input.description.trim();
    const prompt = buildPrompt(field === 'title' ? 'pullRequestTitle' : 'pullRequestDescription', [
      `## Source branch: ${sourceBranch}`,
      `## Target branch: ${targetBranch}`,
      field === 'title' && otherDescription && `## Pull request description\n${otherDescription.slice(0, 4000)}`,
      field === 'description' && otherTitle && `## Pull request title\n${otherTitle}`,
      messages.length > 0 && `## Commits (oldest first)\n${messages.slice(0, 50).map(m => `- ${m.replace(/\n+/g, '\n  ')}`).join('\n')}`,
      '## Changed files',
      rawFiles.slice(0, 100).map(f => `${f.status[0].toUpperCase()} ${f.path}`).join('\n'),
      diff && `\n## Diff\n\`\`\`diff\n${diff}\n\`\`\``,
      template && `\n## Pull request template\n${template}`,
    ], cfg);

    const { cleanPartialModelOutput, generateWithAI } = await import('../ai/aiGenerate');
    const raw = await generateWithAI(cfg.get('ai.provider', 'vscode-lm'), prompt, cfg, {
      onProgress: partial => {
        const cleaned = cleanPartialModelOutput(partial);
        onProgress(field === 'title' ? cleaned.split('\n')[0] : cleaned);
      },
    });
    const text = cleanGeneratedText(raw, field);
    if (!text) throw new Error(vscode.l10n.t('{0} returned an empty response', 'AI'));
    return text;
  }

  dispose(): void {
    this.panels.forEach(p => p.dispose());
    this.panels.clear();
  }
}
