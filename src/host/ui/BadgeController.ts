import * as vscode from 'vscode';
import type { WorkspaceStatus } from '../types/git';

/**
 * Controls the numeric badge on the GitCharm activity-bar icon.
 *
 * VSCode propagates TreeView.badge to the activity-bar container icon reliably,
 * whereas WebviewView.badge has timing issues. We register a hidden TreeView
 * (when: "false") in the same container and set its badge instead.
 */
export class BadgeController implements vscode.Disposable {
  private readonly treeView: vscode.TreeView<never>;
  private progressResolve: (() => void) | undefined;
  private hiddenRepoIds: string[] = [];
  private lastStatus: WorkspaceStatus | undefined;

  constructor() {
    const emptyProvider: vscode.TreeDataProvider<never> = {
      getTreeItem: () => { throw new Error('unreachable'); },
      getChildren: () => [],
    };
    this.treeView = vscode.window.createTreeView('gitcharm.commitBadge', {
      treeDataProvider: emptyProvider,
    });
  }

  /** Show a spinner in the status bar while the initial git status is loading. */
  startLoading(): void {
    if (this.progressResolve) return;
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'GitCharm: loading…' },
      () => new Promise<void>(resolve => { this.progressResolve = resolve; })
    );
  }

  stopLoading(): void {
    this.progressResolve?.();
    this.progressResolve = undefined;
  }

  setHiddenRepoIds(ids: string[]): void {
    this.hiddenRepoIds = ids;
    if (this.lastStatus) this.update(this.lastStatus);
  }

  update(status: WorkspaceStatus): void {
    this.stopLoading();
    this.lastStatus = status;
    const total = status.repos
      .filter(r => !this.hiddenRepoIds.includes(r.repoId))
      .reduce((sum, r) => sum + r.stagedFiles.length + r.unstagedFiles.length, 0);
    this.treeView.badge = total > 0
      ? { value: total, tooltip: `${total} changed file${total === 1 ? '' : 's'}` }
      : undefined;
  }

  dispose(): void {
    this.stopLoading();
    this.treeView.dispose();
  }
}
