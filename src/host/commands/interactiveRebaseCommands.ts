import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { createGit } from '../git/gitClient';
import { InteractiveRebasePanel, RebaseTodoEditorProvider, type InteractiveRebaseDeps, type RebaseTarget } from '../panels/InteractiveRebasePanel';

// Interactive rebase, from the Log Panel (a commit's or a branch's context menu), the command palette, and a
// `git rebase -i` started in the terminal with sequence.editor set to `code --wait` (git-rebase-todo editor).

let deps: InteractiveRebaseDeps | undefined;

/** Opens the interactive rebase editor for the current branch of `repoId`. */
export function openInteractiveRebase(repoId: string, target: RebaseTarget): Promise<void> {
  return deps ? InteractiveRebasePanel.show(deps, repoId, target) : Promise.resolve();
}

export function registerInteractiveRebase(
  context: vscode.ExtensionContext,
  manager: WorkspaceGitManager,
  onDidRebase: () => void,
): void {
  deps = { extensionUri: context.extensionUri, manager, onDidRebase };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(RebaseTodoEditorProvider.viewType, new RebaseTodoEditorProvider(context.extensionUri), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('gitcharm.interactiveRebase', () => pickAndOpen(manager)),
  );
}

/** Command palette: the repository, then where to rebase from — a recent commit of the branch, or another branch. */
async function pickAndOpen(manager: WorkspaceGitManager): Promise<void> {
  const metas = manager.getRepoMetas();
  if (metas.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No Git repository found.'));
    return;
  }
  const meta = metas.length === 1 ? metas[0] : (await vscode.window.showQuickPick(
    metas.map(m => ({ label: m.name, description: m.rootPath, meta: m })),
    { title: vscode.l10n.t('Interactive Rebase'), placeHolder: vscode.l10n.t('Select a repository') },
  ))?.meta;
  const repo = meta && manager.getRepo(meta.id);
  if (!meta || !repo) return;

  const GS = '\x1D';
  const [log, branches] = await Promise.all([
    createGit(repo.rootPath).raw(['log', '-50', '--abbrev=8', `--format=%H${GS}%h${GS}%s${GS}%aN`]).catch(() => ''),
    repo.getBranches().catch(() => []),
  ]);
  type Item = vscode.QuickPickItem & { target?: RebaseTarget };
  const items: Item[] = [
    { label: vscode.l10n.t('Commits'), kind: vscode.QuickPickItemKind.Separator },
    ...log.trim().split('\n').filter(Boolean).map(line => {
      const [hash, shortHash, subject, author] = line.split(GS);
      return { label: `$(git-commit) ${subject}`, description: `${shortHash} · ${author}`, target: { kind: 'commit' as const, hash } };
    }),
    { label: vscode.l10n.t('Onto Branch'), kind: vscode.QuickPickItemKind.Separator },
    ...branches.filter(b => !b.isHead).map(b => ({
      label: `$(${b.isRemote ? 'cloud' : 'git-branch'}) ${b.name}`, target: { kind: 'onto' as const, ref: b.name },
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Interactive Rebase: {0}', meta.name),
    placeHolder: vscode.l10n.t('Rebase from a commit (included), or onto a branch'),
    matchOnDescription: true,
  });
  if (picked?.target) await openInteractiveRebase(meta.id, picked.target);
}
