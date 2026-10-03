import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { hasConflictMarkers, parseConflicts } from '../git/ConflictParser';
import { resolveConflictsInFile, type ConflictResolution } from '../ai/conflictResolver';
import { logError } from '../utils/Logger';
import { getAiModelLabel } from '../utils/aiModelLabel';
import { ConflictAiPanel } from '../panels/ConflictAiPanel';
import { plural } from '../utils/plural';

// Resolving merge/rebase conflicts with the AI, from everywhere conflicts show up: the Commit Panel's
// conflicted files, the editor (a CodeLens per conflict, a title-bar button also shown in VS Code's merge
// editor), and a notification as soon as a git operation leaves a repository with conflicts.

const HAS_CONFLICTS_CONTEXT = 'gitcharm.activeEditorHasConflicts';

function aiEnabled(): boolean {
  return vscode.workspace.getConfiguration('gitcharm').get<boolean>('ai.enabled', true);
}

/** The file a title-bar command acts on: its argument, else the result of the active merge editor, else the active editor. */
function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  // VS Code's merge editor tab (TabInputTextMerge, missing from the typings of the oldest VS Code supported).
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { base?: unknown; result?: unknown } | undefined;
  if (input?.base instanceof vscode.Uri && input.result instanceof vscode.Uri) return input.result;
  return vscode.window.activeTextEditor?.document.uri;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Deps {
  manager: WorkspaceGitManager;
  extensionUri: vscode.Uri;
}

/** Stages a file in the repository it belongs to — what marks a conflicted file as resolved for git. */
async function stageResolved(manager: WorkspaceGitManager, uri: vscode.Uri): Promise<boolean> {
  const file = uri.fsPath;
  const meta = manager.getRepoMetas()
    .filter(m => file.startsWith(m.rootPath + path.sep))
    .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  const repo = meta && manager.getRepo(meta.id);
  if (!repo) return false;
  await repo.stageFiles([path.relative(repo.rootPath, file).split(path.sep).join('/')]);
  return true;
}

/** Tells how a resolution went, offering the details when some conflicts were left. */
function report(result: ConflictResolution & { total: number }, files: number, staged: number): void {
  if (result.resolved === 0) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('The AI could not resolve the conflicts: {0}', result.errors[0] ?? vscode.l10n.t('no answer')));
    return;
  }
  const what = files > 1
    ? vscode.l10n.t('Resolved {0} of {1} conflicts in {2} files with AI.', result.resolved, result.total, files)
    : plural(result.total,
      vscode.l10n.t('Resolved the conflict with AI.'),
      vscode.l10n.t('Resolved {0} of {1} conflicts with AI.', result.resolved, result.total));
  const next = staged > 0
    ? plural(staged, vscode.l10n.t('The file was staged as resolved.'), vscode.l10n.t('{0} files were staged as resolved.', staged))
    : vscode.l10n.t('Review the changes, then resolve the conflicts left.');
  if (result.failed > 0) {
    const details = vscode.l10n.t('Show Details');
    void vscode.window.showWarningMessage(`${what} ${next}`, details).then(picked => {
      if (picked === details) void vscode.window.showWarningMessage(result.errors.join('\n'), { modal: true });
    });
  } else {
    void vscode.window.showInformationMessage(`${what} ${next}`);
  }
}

/**
 * Resolves several files, one after another, under one cancellable progress notification, following along in
 * the live view. A file left without conflicts is saved and staged, which is what tells git it's resolved.
 */
async function resolveFiles(deps: Deps, uris: vscode.Uri[], save: boolean, hunks?: number[]): Promise<void> {
  const total = { total: 0, resolved: 0, failed: 0, errors: [] as string[] };
  let filesTouched = 0;
  let staged = 0;
  const view = ConflictAiPanel.start(deps.extensionUri, getAiModelLabel(vscode.workspace.getConfiguration('gitcharm'), 'resolveConflicts'));
  let cancelled = false;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Resolving conflicts with AI'), cancellable: true },
    async (progress, token) => {
      for (const [i, uri] of uris.entries()) {
        if (token.isCancellationRequested) break;
        const name = path.basename(uri.fsPath);
        const fileKey = uri.fsPath;
        progress.report({ message: uris.length > 1 ? `${name} (${i + 1}/${uris.length})` : name });
        view.file(fileKey, vscode.workspace.asRelativePath(uri, false));
        try {
          const r = await resolveConflictsInFile(uri, { save, hunks, token, onHunk: event => view.hunk(fileKey, event) });
          total.total += r.total;
          total.resolved += r.resolved;
          total.failed += r.failed;
          total.errors.push(...r.errors);
          if (r.resolved > 0) filesTouched++;
          const fileStaged = r.clean && await stageResolved(deps.manager, uri);
          if (fileStaged) staged++;
          view.fileDone(fileKey, { resolved: r.resolved, failed: r.failed, staged: fileStaged });
        } catch (err) {
          total.errors.push(`${name} — ${errorText(err)}`);
          logError('ai-resolve-conflict', name, errorText(err));
          view.fileDone(fileKey, { resolved: 0, failed: 0, staged: false, error: errorText(err) });
        }
      }
      cancelled = token.isCancellationRequested;
    },
  );
  view.runDone(cancelled);
  if (total.total === 0 && total.errors.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No conflict markers found in the current file'));
    return;
  }
  report(total, Math.max(filesTouched, 1), staged);
}

/** The conflicted files of a repository, or of every repository. */
async function conflictedFiles(manager: WorkspaceGitManager, repoId?: string): Promise<vscode.Uri[]> {
  const status = await manager.getAllStatuses();
  const seen = new Set<string>();
  return status.repos
    .filter(r => !repoId || r.repoId === repoId)
    .flatMap(r => [...r.stagedFiles, ...r.unstagedFiles])
    .filter(f => f.status === 'conflicted' && !seen.has(f.absolutePath) && seen.add(f.absolutePath))
    .map(f => vscode.Uri.file(f.absolutePath));
}

/** "Resolve with AI" above each conflict, plus "Resolve all" on the first one when there are several. */
class ConflictCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  refresh(): void {
    this.changeEmitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!aiEnabled()) return [];
    const text = doc.getText();
    if (!hasConflictMarkers(text)) return [];
    const hunks = parseConflicts(text);
    return hunks.flatMap((hunk, index) => {
      const range = new vscode.Range(hunk.startLine, 0, hunk.startLine, 0);
      const lenses = [new vscode.CodeLens(range, {
        title: `$(sparkle) ${vscode.l10n.t('Resolve with AI')}`,
        command: 'gitcharm.resolveConflictHunkWithAi',
        arguments: [doc.uri, index],
      })];
      if (index === 0 && hunks.length > 1) {
        lenses.push(new vscode.CodeLens(range, {
          title: vscode.l10n.t('Resolve all {0} with AI', hunks.length),
          command: 'gitcharm.resolveConflictsWithAi',
          arguments: [doc.uri],
        }));
      }
      return lenses;
    });
  }
}

/**
 * Offers to resolve the conflicts as soon as a git operation (merge, rebase, pull, cherry-pick, stash pop…)
 * leaves a repository with some. Only a change from none to some counts: conflicts already there when
 * GitCharm starts, or more of them appearing later in the same merge, don't ask again.
 */
function watchNewConflicts(manager: WorkspaceGitManager): vscode.Disposable {
  const previous = new Map<string, number>();
  return manager.onStatusChange(status => {
    for (const repo of status.repos) {
      const before = previous.get(repo.repoId);
      previous.set(repo.repoId, repo.conflictCount);
      if (before === undefined || before > 0 || repo.conflictCount === 0) continue;
      const cfg = vscode.workspace.getConfiguration('gitcharm');
      if (!cfg.get<boolean>('ai.enabled', true) || !cfg.get<boolean>('ai.offerConflictResolution', true)) continue;
      const name = manager.getRepoMetas().find(m => m.id === repo.repoId)?.name ?? path.basename(repo.repoId);
      const resolve = vscode.l10n.t('Resolve with AI');
      const open = vscode.l10n.t('Open Commit Panel');
      const message = plural(repo.conflictCount,
        vscode.l10n.t('{0}: 1 file has conflicts. Resolve it with AI?', name),
        vscode.l10n.t('{0}: {1} files have conflicts. Resolve them with AI?', name, repo.conflictCount));
      void vscode.window.showWarningMessage(message, resolve, open).then(picked => {
        if (picked === resolve) void vscode.commands.executeCommand('gitcharm.resolveAllConflictsWithAi', repo.repoId);
        else if (picked === open) void vscode.commands.executeCommand('gitcharm.commitPanel.focus');
      });
    }
  });
}

export function registerConflictAiCommands(context: vscode.ExtensionContext, manager: WorkspaceGitManager): void {
  const deps: Deps = { manager, extensionUri: context.extensionUri };
  const codeLens = new ConflictCodeLensProvider();

  const updateContext = () => {
    const doc = vscode.window.activeTextEditor?.document;
    void vscode.commands.executeCommand('setContext', HAS_CONFLICTS_CONTEXT, !!doc && doc.uri.scheme === 'file' && hasConflictMarkers(doc.getText()));
  };
  updateContext();

  context.subscriptions.push(
    vscode.commands.registerCommand('gitcharm.resolveConflictsWithAi', async (arg?: unknown, options?: { save?: boolean }) => {
      const uri = targetUri(arg);
      if (!uri) {
        void vscode.window.showWarningMessage(vscode.l10n.t('No active file'));
        return;
      }
      await resolveFiles(deps, [uri], options?.save ?? false);
    }),

    vscode.commands.registerCommand('gitcharm.resolveConflictHunkWithAi', async (uri: vscode.Uri, hunkIndex: number) => {
      await resolveFiles(deps, [uri], false, [hunkIndex]);
    }),

    vscode.commands.registerCommand('gitcharm.resolveAllConflictsWithAi', async (repoId?: string) => {
      const uris = await conflictedFiles(manager, typeof repoId === 'string' ? repoId : undefined);
      if (uris.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t('There are no conflicted files.'));
        return;
      }
      await resolveFiles(deps, uris, true);
    }),

    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('gitcharm.ai.enabled')) codeLens.refresh(); }),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document === vscode.window.activeTextEditor?.document) updateContext(); }),
    watchNewConflicts(manager),
  );
}
