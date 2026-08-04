import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';

export async function pickRefQuickPick(
  repo: GitService,
  opts: { placeHolder: string; title: string },
): Promise<string | undefined> {
  const [branches, tags] = await Promise.all([repo.getBranches(), repo.getTags()]);
  type RefItem = vscode.QuickPickItem & { ref: string };
  const items: RefItem[] = [
    { label: 'LOCAL BRANCHES', kind: vscode.QuickPickItemKind.Separator, ref: '' },
    ...branches.filter(b => !b.isRemote).map(b => ({
      label: `$(git-branch) ${b.name}`,
      description: b.isHead ? '(current)' : undefined,
      ref: b.name,
    })),
    { label: 'REMOTE BRANCHES', kind: vscode.QuickPickItemKind.Separator, ref: '' },
    ...branches.filter(b => b.isRemote).map(b => ({
      label: `$(cloud) ${b.name}`,
      ref: b.name,
    })),
    ...(tags.length ? [
      { label: 'TAGS', kind: vscode.QuickPickItemKind.Separator, ref: '' },
      ...tags.map(t => ({ label: `$(tag) ${t.name}`, ref: t.name })),
    ] : []),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: opts.placeHolder,
    title: opts.title,
    matchOnDescription: true,
  });
  return picked?.ref || undefined;
}
