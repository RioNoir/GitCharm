import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from '../utils/webviewHtml';
import { EMPTY_TREE, openSmartDiff } from './GitLogPanelProvider';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { loadIconTheme } from '../utils/IconThemeService';
import { getAiModelLabel } from '../utils/aiModelLabel';
import { pickRefQuickPick } from '../utils/refPicker';
import { formatGitError, showGitError, getRawErrorDetail } from '../utils/gitErrorUtils';
import { logInfo, logWarn, logError } from '../utils/Logger';
import type { CommitFullDetailToHostMsg, HostToCommitFullDetailMsg, HostToLogMsg, LogToHostMsg } from '../types/messages';

const TAB_TITLE_MAX_LENGTH = 40;

function truncateTitle(title: string): string {
  return title.length > TAB_TITLE_MAX_LENGTH ? `${title.slice(0, TAB_TITLE_MAX_LENGTH)}…` : title;
}

function getLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  // The whole extension root — unlike the old vanilla-HTML panel this replaces, this one loads
  // a bundled React script from out/webview/commitFullDetail/, not just static media/ assets.
  const localResourceRoots: vscode.Uri[] = [extensionUri];
  // Add all icon theme extension roots so switching themes live doesn't break CSP
  for (const ext of vscode.extensions.all) {
    const themes: Array<{ id: string }> = ext.packageJSON?.contributes?.iconThemes ?? [];
    if (themes.length > 0) localResourceRoots.push(vscode.Uri.file(ext.extensionPath));
  }
  return localResourceRoots;
}

export async function openCommitFullDetailPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  repoId: string,
  hash: string,
  opts: { autoExplain?: boolean } = {},
  profileService?: import('../git/GitProfileService').GitProfileService,
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    logWarn('commitFullDetail', 'Repository not found.');
    vscode.window.showErrorMessage('Repository not found.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'gitcharm.commitFullDetail',
    `Commit ${hash.slice(0, 7)}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: getLocalResourceRoots(extensionUri),
    }
  );
  await setupPanel(panel, extensionUri, manager, repoId, hash, opts, profileService);
}

/** Re-hydrates a Commit Full Detail panel restored by VS Code after a window reload/restart — see registerWebviewPanelSerializer('gitcharm.commitFullDetail', ...) in extension.ts. */
export async function deserializeCommitFullDetailPanel(
  panel: vscode.WebviewPanel,
  state: unknown,
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  profileService?: import('../git/GitProfileService').GitProfileService,
): Promise<void> {
  const s = state as { repoId?: unknown; hash?: unknown } | null;
  if (!s || typeof s.repoId !== 'string' || typeof s.hash !== 'string') {
    panel.dispose();
    return;
  }
  const repo = manager.getRepo(s.repoId);
  if (!repo) {
    logWarn('commitFullDetail', 'Repository not found while restoring commit full detail panel.');
    panel.dispose();
    return;
  }
  await setupPanel(panel, extensionUri, manager, s.repoId, s.hash, {}, profileService);
}

async function setupPanel(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  repoId: string,
  hash: string,
  opts: { autoExplain?: boolean },
  profileService?: import('../git/GitProfileService').GitProfileService,
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    logWarn('commitFullDetail', 'Repository not found.');
    vscode.window.showErrorMessage('Repository not found.');
    panel.dispose();
    return;
  }

  const isStash = hash.startsWith('stash@{');

  let commitInfo: { hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string; committerDate: string; parents: string[] };
  let files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
  let refs: string[] = [];
  let fullMessage = '';
  let stashBranch: string | undefined;
  let stashFiles: Array<{ path: string; status: string; added?: number; removed?: number }> | undefined;

  try {
    if (isStash) {
      // A stash ref isn't a real commit git log can decorate — read it from the stash
      // list instead, the same way the Git Log panel builds a stash's CommitNode.
      const stash = (await repo.stashList()).find(s => s.ref === hash);
      if (!stash) throw new Error('Stash not found');
      commitInfo = {
        hash: stash.ref, shortHash: stash.ref, message: stash.message || `WIP on ${stash.branch}`,
        authorName: '', authorEmail: '', authorDate: stash.date, committerDate: stash.date,
        parents: stash.parentHash ? [stash.parentHash] : [],
      };
      fullMessage = commitInfo.message;
      files = stash.files;
      stashBranch = stash.branch;
      stashFiles = stash.files;
    } else {
      // getCommitNode reuses GitService's batch-log parser (%D decoration token) to get real
      // refs pointing at this commit — getCommitMeta has no refs at all.
      const [node, meta, msg] = await Promise.all([
        repo.getCommitNode(hash).catch(() => null),
        repo.getCommitMeta(hash),
        repo.getFullCommitMessage(hash),
      ]);
      commitInfo = meta;
      refs = node?.refs ?? [];
      fullMessage = msg.trim();
      files = await repo.getCommitFiles(hash, commitInfo.parents);
    }
  } catch (e: unknown) {
    showGitError('commitFullDetail:load', e);
    panel.dispose();
    return;
  }

  const repoMeta = manager.getRepoMetas().find(r => r.id === repoId);
  const repoName = repoMeta?.name ?? repoId;

  const titlePrefix = isStash ? 'Stash' : 'Commit';
  panel.title = commitInfo.message ? `${titlePrefix} ${commitInfo.shortHash} - ${truncateTitle(commitInfo.message)}` : `${titlePrefix} ${commitInfo.shortHash}`;
  panel.iconPath = new vscode.ThemeIcon(isStash ? 'archive' : 'git-commit');

  // Re-applied here (not just at createWebviewPanel time) so a panel restored via
  // registerWebviewPanelSerializer also gets the icon theme extension roots.
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: getLocalResourceRoots(extensionUri),
  };

  panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'commitFullDetail', panel.title);

  panel.webview.onDidReceiveMessage((msg: CommitFullDetailToHostMsg | LogToHostMsg) => handleMessage(msg, repoId, hash, repo, panel, extensionUri));

  const iconThemeWatcher = vscode.workspace.onDidChangeConfiguration(async e => {
    if (!e.affectsConfiguration('workbench.iconTheme')) return;
    const newTheme = await loadIconTheme(panel.webview).catch(() => ({ type: 'none' as const }));
    panel.webview.postMessage({ type: 'COMMITFULLDETAIL_ICON_THEME', iconTheme: newTheme } satisfies HostToCommitFullDetailMsg);
  });
  panel.onDidDispose(() => iconThemeWatcher.dispose());

  const iconTheme = await loadIconTheme(panel.webview).catch(() => ({ type: 'none' as const }));
  const cfg = vscode.workspace.getConfiguration('gitcharm');

  // Only needed for a stash — its author section shows "you" (the active profile),
  // matching how it's committed, not a fixed author baked into the entry.
  let activeProfile: { name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' } | undefined;
  if (isStash && profileService) {
    const result = await profileService.getEffectiveProfile(repo.rootPath);
    if (result) {
      const { profile } = result;
      activeProfile = { name: profile.name, gitName: profile.gitName, gitEmail: profile.gitEmail, ...(profile.builtIn ? { builtIn: profile.builtIn } : {}) };
    }
  }

  panel.webview.postMessage({
    type: 'COMMITFULLDETAIL_INIT',
    repoId,
    repoName,
    commit: {
      hash: commitInfo.hash,
      shortHash: commitInfo.shortHash,
      repoId,
      message: commitInfo.message,
      authorName: commitInfo.authorName,
      authorEmail: commitInfo.authorEmail,
      authorDate: commitInfo.authorDate,
      committerDate: commitInfo.committerDate,
      parents: commitInfo.parents,
      refs,
      ...(isStash ? { isStash: true as const, stashRef: hash, stashBranch, stashFiles } : {}),
    },
    fullMessage,
    files,
    iconTheme,
    activeProfile,
    aiEnabled: cfg.get('ai.enabled', true),
    aiModelLabel: getAiModelLabel(cfg),
    autoExplain: opts.autoExplain ?? false,
  } satisfies HostToCommitFullDetailMsg);
}

/** Builds the AI prompt from the commit's diff/message/files and generates the explanation.
 * Returns the result rather than posting it — the caller displays it in the separate AI Explain Detail panel. */
async function explainCommit(
  hash: string,
  repo: import('../git/GitService').GitService,
): Promise<{ explanation?: string; error?: string }> {
  try {
    const cfg = vscode.workspace.getConfiguration('gitcharm');
    const maxDiffChars: number = cfg.get('ai.maxDiffChars', 8000);
    const configuredLang: string = cfg.get('ai.language', '');
    const language = configuredLang.trim() || vscode.env.language || 'en';

    const [diff, fullMessage, commitMeta] = await Promise.all([
      repo.getCommitDiff(hash, maxDiffChars),
      repo.getFullCommitMessage(hash),
      repo.getCommitMeta(hash),
    ]);
    const commitFiles = await repo.getCommitFiles(hash, commitMeta.parents);

    const fileList = commitFiles.slice(0, 50).map(f => `${f.status[0].toUpperCase()} ${f.path}`).join('\n');
    const prompt = [
      'You are a code reviewer explaining a git commit to a developer.',
      '',
      'Rules:',
      `- Write the explanation in this language: ${language}`,
      '- Start with a one-sentence summary of what this commit does',
      '- Then explain the key changes: what was modified and why',
      '- Be specific: reference file names, function names, or module names when relevant',
      '- Keep it concise but complete (3-8 sentences or bullet points)',
      '- The output is rendered as Markdown: use it (bold, lists, inline code) where it helps readability',
      '- Output ONLY the explanation, no code fences wrapping the whole response, no preamble',
      '',
      `## Commit: ${commitMeta.shortHash}`,
      `## Message: ${fullMessage.trim() || commitMeta.message}`,
      '',
      '## Changed files',
      fileList,
      diff ? `\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');

    const { generateWithAI } = await import('../ai/aiGenerate');
    const explanation = await generateWithAI(cfg.get('ai.provider', 'vscode-lm'), prompt, cfg);
    return { explanation };
  } catch (e: unknown) {
    logError('commitFullDetail:explain', formatGitError(e), getRawErrorDetail(e));
    return { error: formatGitError(e) };
  }
}

async function handleMessage(
  msg: CommitFullDetailToHostMsg | LogToHostMsg,
  repoId: string,
  hash: string,
  repo: import('../git/GitService').GitService,
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
): Promise<void> {
  const post = (m: HostToLogMsg | HostToCommitFullDetailMsg) => panel.webview.postMessage(m);

  switch (msg.type) {
    case 'COMMITFULLDETAIL_EXPLAIN': {
      const { openAiExplainDetail } = await import('./AiExplainDetailPanel');
      const cfg = vscode.workspace.getConfiguration('gitcharm');
      const shortHash = msg.hash.startsWith('stash@{') ? msg.hash : msg.hash.slice(0, 7);
      openAiExplainDetail(
        extensionUri,
        { key: `commit:${msg.repoId}:${msg.hash}`, kind: 'commit', title: `Commit ${shortHash}` },
        getAiModelLabel(cfg),
        () => explainCommit(msg.hash, repo),
      );
      return;
    }

    case 'LOG_REQUEST_COMMIT_FILES': {
      try {
        const requestedFiles = await repo.getCommitFiles(msg.hash, msg.parents);
        post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: requestedFiles });
      } catch (e: unknown) {
        logError('commitFullDetail:commitFiles', formatGitError(e), getRawErrorDetail(e));
        post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: formatGitError(e) });
      }
      return;
    }

    case 'LOG_REQUEST_MERGE_COMMITS': {
      try {
        const commits = await repo.getMergeCommits(msg.hash, msg.parents);
        post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits });
      } catch (e: unknown) {
        logError('commitFullDetail:mergeCommits', formatGitError(e), getRawErrorDetail(e));
        post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits: [], error: formatGitError(e) });
      }
      return;
    }

    // Branches that merely descend from this commit — kept separate from the refs
    // shown on the commit itself (see getRefsAt), which only cover exact matches.
    case 'LOG_REQUEST_COMMIT_BRANCHES': {
      const branches = await repo.getBranchesContaining(msg.hash).catch(() => ({ local: [], remote: [], tags: [] }));
      post({ type: 'LOG_COMMIT_BRANCHES_RESULT', requestId: msg.requestId, branches });
      return;
    }

    case 'LOG_OPEN_FILE_DIFF': {
      try {
        await openSmartDiff(repo, msg);
      } catch (e: unknown) {
        showGitError('commitFullDetail:openDiff', e);
      }
      return;
    }

    case 'LOG_OPEN_FILE': {
      try {
        const uri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
        await vscode.commands.executeCommand('vscode.open', uri);
      } catch (e: unknown) {
        showGitError('commitFullDetail:openFile', e);
      }
      return;
    }

    case 'LOG_REVEAL_IN_EXPLORER': {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(repo.rootPath, msg.filePath)));
      return;
    }

    case 'LOG_REVEAL_IN_OS': {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(repo.rootPath, msg.filePath)));
      return;
    }

    case 'LOG_SHOW_FILE_HISTORY': {
      await vscode.commands.executeCommand('gitcharm.showFileHistory', vscode.Uri.file(path.join(repo.rootPath, msg.filePath)));
      return;
    }

    case 'LOG_REVERT_FILE': {
      try {
        if (msg.fileStatus === 'A') {
          const uri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
          await vscode.workspace.fs.delete(uri, { useTrash: false });
        } else {
          await repo.revertFileToParent(msg.hash, msg.filePath);
        }
        post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
      } catch (e: unknown) {
        post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: formatGitError(e) });
        showGitError('commitFullDetail:revertFile', e);
      }
      return;
    }

    case 'LOG_CHERRY_PICK_FILE': {
      try {
        await repo.cherryPickFile(msg.hash, msg.filePath, msg.oldPath);
        post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
        logInfo('commitFullDetail:cherryPickFile', `Cherry-picked changes for ${msg.filePath}.`);
        vscode.window.showInformationMessage(`Cherry-picked changes for ${msg.filePath}.`);
      } catch (e: unknown) {
        const errMsg = formatGitError(e);
        post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
        if (errMsg.includes('FILE_CHERRY_PICK_CONFLICT')) {
          const conflictFiles = errMsg.split('FILE_CHERRY_PICK_CONFLICT:')[1]?.trim();
          logWarn('commitFullDetail:cherryPickFile', `Cherry-pick of ${msg.filePath} has conflicts${conflictFiles ? ` in ${conflictFiles}` : ''}.`);
          vscode.window.showWarningMessage(
            `Cherry-pick of ${msg.filePath} has conflicts${conflictFiles ? ` in ${conflictFiles}` : ''}. Resolve them in the editor.`
          );
        } else {
          showGitError('commitFullDetail:cherryPickFile', e);
        }
      }
      return;
    }

    case 'LOG_COMPARE_FILE_WITH': {
      const pickedRef = await pickRefQuickPick(repo, {
        placeHolder: `Compare ${msg.filePath} with…`,
        title: 'GitCharm - Compare With',
      });
      if (!pickedRef) return;
      let refHash: string;
      try {
        refHash = await repo.resolveRef(pickedRef);
      } catch {
        logError('commitFullDetail:compareWith', `Cannot resolve ref "${pickedRef}"`);
        vscode.window.showErrorMessage(`Cannot resolve ref "${pickedRef}"`);
        return;
      }
      const rootPath = repo.rootPath;
      const gitUri = (ref: string, filePath: string): vscode.Uri => {
        const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
        return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
      };
      const shortHash = msg.hash.slice(0, 7);
      await vscode.commands.executeCommand(
        'vscode.diff',
        gitUri(msg.hash, msg.filePath),
        gitUri(refHash, msg.filePath),
        `${msg.filePath} (${shortHash} vs ${pickedRef})`,
      );
      return;
    }

    case 'LOG_OPEN_COMMIT_CHANGES': {
      const commitFiles = await repo.getCommitFiles(msg.hash);
      const rootPath = repo.rootPath;
      const parentHash = (await repo.getParents(msg.hash))[0] ?? EMPTY_TREE;
      const gitUri = (ref: string, filePath: string): vscode.Uri => {
        const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
        return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
      };
      const resources = commitFiles
        .filter(f => f.status !== 'U')
        .map(f => {
          const label = vscode.Uri.file(path.join(rootPath, f.path));
          const original = gitUri(f.status === 'A' ? EMPTY_TREE : parentHash, f.oldPath ?? f.path);
          const modified = gitUri(f.status === 'D' ? EMPTY_TREE : msg.hash, f.path);
          return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
        });
      await vscode.commands.executeCommand('vscode.changes', `Changes in ${msg.hash.slice(0, 8)}`, resources);
      return;
    }

    default:
      return;
  }
}
