import * as vscode from 'vscode';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { RepoMeta } from '../types/git';
import { isPrimaryBranch } from '../utils/branchUtils';

export class BranchStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private statusDisposable?: vscode.Disposable;
  private hasBehind = false;
  private hasUnpushed = false;
  private branchesDiverged = false;
  private hasUncommitted = false;

  constructor(
    private readonly manager: WorkspaceGitManager,
    private readonly commitPanelReveal: () => void
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'gitcharm.showBranchMenu';
    this.statusBarItem.tooltip = 'GitCharm: Git Menu';
    this.statusBarItem.show();

    this.statusDisposable = this.manager.onStatusChange(() => this.refresh());
    this.refresh();
  }

  async refresh(): Promise<void> {
    const metas = this.manager.getRepoMetas();
    if (metas.length === 0) {
      this.statusBarItem.text = '$(git-branch) No repo';
      this.statusBarItem.backgroundColor = undefined;
      this.hasBehind = false;
      this.branchesDiverged = false;
      this.hasUncommitted = false;
      return;
    }

    const [branchResults, statusResult] = await Promise.all([
      Promise.allSettled(metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? repo.getCurrentBranch() : null;
      })),
      this.manager.getAllStatuses(),
    ]);

    const branches = branchResults
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<NonNullable<ReturnType<WorkspaceGitManager['getRepo']>>['getCurrentBranch']>> | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(Boolean) as Awaited<ReturnType<NonNullable<ReturnType<WorkspaceGitManager['getRepo']>>['getCurrentBranch']>>[];

    const uniqueNames = [...new Set(branches.map(b => b.name))];
    this.branchesDiverged = uniqueNames.length > 1;
    this.hasBehind = branches.some(b => (b.aheadBehind?.behind ?? 0) > 0);
    this.hasUnpushed = branches.some(b => !b.upstream || (b.aheadBehind?.ahead ?? 0) > 0);
    this.hasUncommitted = statusResult.repos.some(
      r => r.stagedFiles.length > 0 || r.unstagedFiles.length > 0
    );

    const branchLabel = uniqueNames.length === 1
      ? uniqueNames[0]
      : `${uniqueNames[0]} +${uniqueNames.length - 1}`;

    const divergeIcon = this.branchesDiverged ? '$(warning) ' : '';
    const pullIcon = this.hasBehind ? ' $(arrow-down)' : '';
    const pushIcon = this.hasUnpushed ? ' $(arrow-up)' : '';
    const dirtyDot = this.hasUncommitted ? ' ●' : '';
    this.statusBarItem.text = `${divergeIcon}$(git-branch) ${branchLabel}${dirtyDot}${pushIcon}${pullIcon}`;

    const tooltipParts: string[] = [];
    if (this.branchesDiverged) tooltipParts.push('Branches have diverged across repositories');
    if (this.hasUncommitted) tooltipParts.push('Uncommitted changes present');
    if (this.hasUnpushed) tooltipParts.push('Unpushed commits or branch not on remote');
    if (this.hasBehind) tooltipParts.push('Incoming commits available');
    this.statusBarItem.tooltip = tooltipParts.length > 0
      ? `GitCharm: ${tooltipParts.join(' · ')}`
      : 'GitCharm: Git Menu';

    if (this.branchesDiverged) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.color = undefined;
    } else if (this.hasBehind) {
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = new vscode.ThemeColor('gitcharm.statusBarPullForeground');
    } else if (this.hasUnpushed) {
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = new vscode.ThemeColor('gitcharm.statusBarPushForeground');
    } else if (this.hasUncommitted) {
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = new vscode.ThemeColor('gitcharm.statusBarDirtyForeground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = undefined;
    }
  }

  async showMenu(repoId?: string): Promise<void> {
    const metas = this.manager.getRepoMetas();

    // If a specific repoId was requested and the repo exists, jump straight to its menu
    if (repoId) {
      const meta = metas.find(m => m.id === repoId);
      if (meta) { await this.showRepoBranchMenu(meta); return; }
    }

    type MenuItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const items: MenuItem[] = [];

    // Detect any repo in merge/rebase conflict state
    const conflictStates = await Promise.all(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        const state = repo ? await repo.getMergeRebaseState() : null;
        return state ? { meta: m, state } : null;
      })
    );
    const inConflict = conflictStates.filter(Boolean) as { meta: RepoMeta; state: 'merge' | 'rebase' }[];

    if (inConflict.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
      for (const { meta, state } of inConflict) {
        const label = state === 'merge'
          ? `$(error) Abort Merge in ${meta.name}`
          : `$(error) Abort Rebase in ${meta.name}`;
        const description = state === 'merge'
          ? 'Merge in progress — abort and restore previous state'
          : 'Rebase in progress — abort and restore previous state';
        items.push({
          label,
          description,
          action: () => this.abortOperation(meta, state),
        });
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
    }

    if (this.branchesDiverged) {
      items.push({
        label: '$(warning)  Branches have diverged',
        detail: '  Repositories are not on the same branch',
        alwaysShow: true,
        action: async () => {},
      } as unknown as MenuItem);
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
    }

    items.push(
      {
        label: `${this.hasBehind ? '$(arrow-down) ' : '$(cloud-download) '}Update Project…`,
        description: this.hasBehind ? 'Pull all repositories (incoming commits available)' : 'Pull all repositories',
        action: () => this.updateProject(),
      },
      {
        label: `${this.hasUnpushed ? '$(arrow-up) ' : '$(cloud-upload) '}Push…`,
        description: this.hasUnpushed ? 'Push commits to remote (unpushed commits present)' : 'Push current branch to remote',
        action: () => this.pushMenu(metas),
      },
      {
        label: '$(git-commit) Commit',
        description: 'Open Commit panel',
        action: () => this.commitPanelReveal(),
      },
      {
        label: '$(add) New Branch…',
        description: 'Create a new branch',
        action: () => this.newBranch(metas),
      },
      {
        label: '$(history) Log',
        description: 'Open Git Log panel',
        action: async () => { await vscode.commands.executeCommand('gitcharm.openLog'); },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
    );

    // Per-project section
    if (metas.length > 0) {
      items.push({
        label: 'PROJECTS',
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as MenuItem);

      for (const meta of metas) {
        const repo = this.manager.getRepo(meta.id);
        let branchName = 'HEAD';
        let repoHasUnpushed = false;
        if (repo) {
          try {
            const current = await repo.getCurrentBranch();
            branchName = current.name;
            repoHasUnpushed = !current.upstream || (current.aheadBehind?.ahead ?? 0) > 0;
          } catch { /* */ }
        }
        items.push({
          label: `$(root-folder) ${meta.name}`,
          description: `$(git-branch) ${branchName}${repoHasUnpushed ? '  $(arrow-up)' : ''}`,
          action: () => this.showRepoBranchMenu(meta),
        });
      }

      items.push({
        label: 'COMMON BRANCHES',
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as MenuItem);

      await this.appendCommonBranches(items, metas);
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: 'GitCharm — Git Menu',
      matchOnDescription: true,
    });

    if (pick) await pick.action();
  }

  private async appendCommonBranches(
    items: Array<vscode.QuickPickItem & { action: () => Promise<void> | void }>,
    metas: RepoMeta[]
  ): Promise<void> {
    // Gather all branches per repo
    const perRepo = await Promise.allSettled(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? repo.getBranches() : [];
      })
    );

    // Build name → count across repos (local + remote)
    const nameCount = new Map<string, number>();
    for (const r of perRepo) {
      if (r.status !== 'fulfilled') continue;
      const seen = new Set<string>();
      for (const b of r.value) {
        const key = b.isRemote
          ? b.name.replace(/^[^/]+\//, '') // strip remote prefix
          : b.name;
        if (!seen.has(key)) {
          seen.add(key);
          nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
        }
      }
    }

    // Only branches present in ALL repos, sorted alphabetically
    const sorted = [...nameCount.entries()]
      .filter(([, count]) => count === metas.length)
      .sort((a, b) => a[0].localeCompare(b[0]));

    // Collect current HEAD per repo for highlighting
    const heads = new Set<string>();
    for (const r of perRepo) {
      if (r.status !== 'fulfilled') continue;
      const head = r.value.find(b => b.isHead && !b.isRemote);
      if (head) heads.add(head.name);
    }

    for (const [name] of sorted) {
      const isCurrentSomewhere = heads.has(name);
      const primary = isPrimaryBranch(name);
      const icon = isCurrentSomewhere ? '$(check)' : primary ? '$(star)' : '$(git-branch)';
      items.push({
        label: `${icon} ${name}`,
        description: isCurrentSomewhere ? 'current' : '',
        action: () => this.showCommonBranchActionMenu(name, metas, isCurrentSomewhere, [...heads].join(', ')),
      });
    }
  }

  private async showCommonBranchActionMenu(
    branchName: string,
    metas: RepoMeta[],
    isCurrent: boolean,
    currentBranchName: string,
  ): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const items: ActionItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(arrow-right) Checkout',
        description: `Switch all repos to ${branchName}`,
        action: () => this.checkoutBranchAllRepos(branchName, metas),
      },
      {
        label: `$(add) New branch from '${branchName}'…`,
        action: () => this.newBranchFrom(branchName, metas),
      },
      {
        label: '$(cloud-download) Update (Pull)',
        description: `Pull ${branchName} in all repos`,
        action: () => this.pullBranchAllRepos(branchName, metas),
      },
      {
        label: '$(edit) Rename…',
        action: () => this.renameBranchAllRepos(branchName, metas),
      },
    ];

    if (!isCurrent) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(git-compare) Compare '${currentBranchName}' with '${branchName}'`,
          action: () => this.compareBranchAllRepos(branchName, metas),
        },
        {
          label: `$(repo-forked) Rebase '${currentBranchName}' onto '${branchName}'`,
          action: () => this.rebaseAllRepos(branchName, metas),
        },
        {
          label: `$(git-merge) Merge '${branchName}' into '${currentBranchName}'`,
          action: () => this.mergeBranchAllRepos(branchName, metas),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: '$(trash) Delete…',
          action: () => this.deleteBranchAllRepos(branchName, metas),
        },
      );
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: branchName,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async pushMenu(metas: RepoMeta[]): Promise<void> {
    type RepoRemoteItem = vscode.QuickPickItem & { repoId: string; remote: string };

    // Collect all repo+remote combinations
    const items: RepoRemoteItem[] = [];
    for (const meta of metas) {
      const repo = this.manager.getRepo(meta.id);
      if (!repo) continue;
      const remotes = await repo.getRemotes();
      for (const remote of remotes) {
        items.push({
          label: `$(cloud-upload) ${meta.name}`,
          description: `→ ${remote}`,
          repoId: meta.id,
          remote,
        });
      }
    }

    if (items.length === 0) {
      vscode.window.showWarningMessage('GitCharm: No remotes configured in any repository.');
      return;
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: 'GitCharm — Push: select repository and remote',
      matchOnDescription: true,
    }) as RepoRemoteItem | undefined;

    if (!pick) return;

    const repo = this.manager.getRepo(pick.repoId);
    if (!repo) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Pushing to ${pick.remote}…`, cancellable: false },
      async () => {
        try {
          await repo.push(false, pick.remote);
          vscode.window.showInformationMessage(`GitCharm [${pick.label.replace('$(cloud-upload) ', '')}]: pushed to "${pick.remote}" successfully.`);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(`GitCharm: Push failed — ${String(e)}`);
        }
      }
    );
    await this.refresh();
  }

  private async abortOperation(meta: RepoMeta, state: 'merge' | 'rebase'): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      if (state === 'merge') {
        await repo.abortMerge();
      } else {
        await repo.abortRebase();
      }
      vscode.window.showInformationMessage(
        `GitCharm [${meta.name}]: ${state} aborted successfully.`
      );
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  async updateProject(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(git-merge) Merge incoming changes into the current branch',
          rebase: false,
        },
        {
          label: '$(repo-forked) Rebase the current branch on top of incoming changes',
          rebase: true,
        },
      ],
      { title: 'Update Project — Strategy' }
    ) as { label: string; rebase: boolean } | undefined;

    if (!pick) return;

    const metas = this.manager.getRepoMetas();
    const metaById = new Map(metas.map(m => [m.id, m]));

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'GitCharm: Updating all projects…',
        cancellable: false,
      },
      async () => {
        const results = await this.manager.pullAll(pick.rebase);
        const failed = results.filter(r => !r.ok);
        const ok = results.filter(r => r.ok);
        if (failed.length === 0) {
          vscode.window.showInformationMessage(
            `GitCharm: ${ok.length} ${ok.length === 1 ? 'repository' : 'repositories'} updated.`
          );
        } else {
          const failedDesc = failed.map(r => {
            const name = metaById.get(r.repoId)?.name ?? r.repoId;
            return `${name}: ${r.message}`;
          }).join('; ');
          vscode.window.showWarningMessage(
            `GitCharm: ${ok.length} updated, ${failed.length} failed: ${failedDesc}`
          );
        }
        await vscode.commands.executeCommand('gitcharm.openLog');
      }
    );
  }

  private async newBranch(metas: RepoMeta[]): Promise<void> {
    // Step 1: branch name
    const branchName = await vscode.window.showInputBox({
      title: 'New Branch — Name',
      prompt: 'Enter the new branch name',
      validateInput: v => (v.trim() ? undefined : 'Branch name cannot be empty'),
    });
    if (!branchName) return;

    // Step 2: base branch (from any repo)
    const allBranches = await this.manager.getAllBranches();
    const localBranches = allBranches.filter(b => !b.isRemote);
    const uniqueBaseNames = [...new Set(localBranches.map(b => b.name))].sort();
    const currentHeads = [...new Set(localBranches.filter(b => b.isHead).map(b => b.name))];
    const currentLabel = currentHeads.length > 0 ? currentHeads.join(', ') : 'current branch';

    const BASE_CURRENT = '__current__';
    const baseItems: Array<vscode.QuickPickItem & { value: string }> = [
      { label: `$(git-branch) ${currentLabel}`, description: 'Current HEAD of each repo', value: BASE_CURRENT },
      ...uniqueBaseNames.map(n => ({ label: `$(git-branch) ${n}`, description: n, value: n })),
    ];
    const basePick = await vscode.window.showQuickPick(baseItems, {
      title: 'New Branch — Base',
      placeHolder: 'Select the base branch',
    }) as (typeof baseItems[number]) | undefined;
    if (!basePick) return;
    const baseFrom = basePick.value === BASE_CURRENT ? undefined : basePick.value;

    // Step 3: target repos
    const repoItems = metas.map(m => ({
      label: `$(root-folder) ${m.name}`,
      description: m.rootPath,
      picked: true,
      repoId: m.id,
    }));
    const pickedRepos = await vscode.window.showQuickPick(repoItems, {
      title: 'New Branch — Repositories',
      placeHolder: 'Select repos to create the branch in',
      canPickMany: true,
    });
    if (!pickedRepos || pickedRepos.length === 0) return;

    // Step 4: checkout?
    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Yes, checkout immediately', value: true },
        { label: '$(close) No, just create the branch', value: false },
      ],
      { title: 'New Branch — Checkout?' }
    );
    if (!checkoutPick) return;
    const doCheckout = (checkoutPick as { value: boolean }).value;

    // Execute
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Creating branch "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const item of pickedRepos) {
          const repo = this.manager.getRepo((item as typeof repoItems[number]).repoId);
          if (!repo) continue;
          try {
            if (doCheckout) {
              await repo.checkout(branchName, true, baseFrom);
            } else {
              await repo.createBranch(branchName, baseFrom);
            }
          } catch (e: unknown) {
            errors.push(`${item.label}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
        } else {
          vscode.window.showInformationMessage(
            `GitCharm: Branch "${branchName}" created in ${pickedRepos.length} ${pickedRepos.length === 1 ? 'repo' : 'repos'}.`
          );
        }
      }
    );
    await this.refresh();
  }

  private async showRepoBranchMenu(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const [branches, currentBranch] = await Promise.all([
      repo.getBranches(),
      repo.getCurrentBranch(),
    ]);
    const local = branches.filter(b => !b.isRemote);
    const remote = branches.filter(b => b.isRemote);

    type BranchItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const items: BranchItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(add) New Branch…',
        description: `Create a new branch in ${meta.name}`,
        action: () => this.newBranchSingleRepo(meta),
      },
      {
        label: '$(remote-explorer) Manage Remotes…',
        description: 'Add, remove, or edit remote repositories',
        action: () => this.showRepoRemotesMenu(meta),
      },
      { label: 'LOCAL', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...local.map(b => {
        const primary = isPrimaryBranch(b.name);
        const icon = b.isHead ? '$(check)' : primary ? '$(star)' : '$(git-branch)';
        const remoteNames = new Set(remote.map(r => r.name.replace(/^[^/]+\//, '')));
        const hasRemote = b.isHead ? !!currentBranch.upstream : remoteNames.has(b.name);
        const hasUnpushed = !hasRemote || (b.aheadBehind?.ahead ?? 0) > 0;
        return {
          label: `${icon} ${b.name}`,
          description: b.aheadBehind ? `↑${b.aheadBehind.ahead} ↓${b.aheadBehind.behind}` : '',
          action: () => this.showSingleBranchActionMenu(b.name, meta, b.isHead, false, hasUnpushed, currentBranch.name),
        };
      }),
      { label: 'REMOTE', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...remote.map(b => {
        const primary = isPrimaryBranch(b.name);
        const icon = primary ? '$(star)' : '$(cloud)';
        return {
          label: `${icon} ${b.name}`,
          description: '',
          action: () => this.showSingleBranchActionMenu(b.name, meta, false, true, false, currentBranch.name),
        };
      }),
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: `${meta.name} — Branches`,
      matchOnDescription: true,
    }) as BranchItem | undefined;

    if (pick) await pick.action();
  }

  private async showSingleBranchActionMenu(
    branchName: string,
    meta: RepoMeta,
    isCurrent: boolean,
    isRemote: boolean,
    hasUnpushed: boolean,
    currentBranchName: string,
  ): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const items: ActionItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(arrow-right) Checkout',
        action: () => this.checkoutSingleRepo(branchName, meta),
      },
      {
        label: `$(add) New branch from '${branchName}'…`,
        action: () => this.newBranchFromSingleRepo(branchName, meta),
      },
      {
        label: '$(cloud-download) Update (Pull)',
        action: () => this.pullSingleRepo(meta),
      },
      {
        label: '$(edit) Rename…',
        action: () => this.renameBranchSingleRepo(branchName, meta),
      },
    ];

    if (hasUnpushed) {
      items.push({
        label: '$(cloud-upload) Push',
        action: () => this.pushSingleRepo(meta),
      });
    }

    if (!isCurrent) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(git-compare) Compare '${currentBranchName}' with '${branchName}'`,
          action: () => this.compareSingleRepo(branchName, meta),
        },
        {
          label: `$(repo-forked) Rebase '${currentBranchName}' onto '${branchName}'`,
          action: () => this.rebaseSingleRepo(branchName, meta),
        },
        {
          label: `$(git-merge) Merge '${branchName}' into '${currentBranchName}'`,
          action: () => this.mergeSingleRepo(branchName, meta),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: '$(trash) Delete…',
          action: () => this.deleteSingleRepo(branchName, meta),
        },
      );
    }

    if (isRemote) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(repo-forked) Pull into '${currentBranchName}' using Rebase`,
          action: () => this.pullRemoteIntoCurrentSingleRepo(branchName, meta, true),
        },
        {
          label: `$(git-merge) Pull into '${currentBranchName}' using Merge`,
          action: () => this.pullRemoteIntoCurrentSingleRepo(branchName, meta, false),
        },
      );
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: `${branchName} — ${meta.name}`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async newBranchSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const branchName = await vscode.window.showInputBox({
      title: `New Branch in ${meta.name}`,
      prompt: 'Enter the new branch name',
      validateInput: v => (v.trim() ? undefined : 'Branch name cannot be empty'),
    });
    if (!branchName) return;

    const branches = await repo.getBranches();
    const localBranches = branches.filter(b => !b.isRemote);
    const localNames = localBranches.map(b => b.name);
    const currentHead = localBranches.find(b => b.isHead)?.name ?? 'current branch';

    const BASE_CURRENT = '__current__';
    const baseItems: Array<vscode.QuickPickItem & { value: string }> = [
      { label: `$(git-branch) ${currentHead}`, description: 'Current HEAD', value: BASE_CURRENT },
      ...localNames.map(n => ({ label: `$(git-branch) ${n}`, description: n, value: n })),
    ];
    const basePick = await vscode.window.showQuickPick(baseItems, {
      title: `New Branch in ${meta.name} — Base`,
      placeHolder: 'Select the base branch',
    }) as (typeof baseItems[number]) | undefined;
    if (!basePick) return;
    const baseFrom = basePick.value === BASE_CURRENT ? undefined : basePick.value;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Yes, checkout immediately', value: true },
        { label: '$(close) No, just create the branch', value: false },
      ],
      { title: `New Branch in ${meta.name} — Checkout?` }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    try {
      if (checkoutPick.value) {
        await repo.checkout(branchName, true, baseFrom);
      } else {
        await repo.createBranch(branchName, baseFrom);
      }
      vscode.window.showInformationMessage(
        `GitCharm [${meta.name}]: branch "${branchName}" ${checkoutPick.value ? 'created and checked out' : 'created'}.`
      );
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  private async checkoutSingleRepo(branchName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.checkout(branchName);
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: switched to "${branchName}"`);
    } catch (e: unknown) {
      const handled = await this.handleDirtyCheckout(repo, meta, branchName, e);
      if (!handled) vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  private async handleDirtyCheckout(
    repo: import('../git/GitService').GitService,
    meta: RepoMeta,
    branchName: string,
    originalError: unknown
  ): Promise<boolean> {
    const msg = String(originalError);
    // Only offer the menu for "dirty working tree" errors
    if (!msg.includes('Your local changes') && !msg.includes('local changes') && !msg.includes('overwritten by checkout')) {
      return false;
    }

    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> };
    const items: ActionItem[] = [
      {
        label: '$(archive) Stash and checkout',
        detail: 'Save changes to stash, then switch to the branch',
        action: async () => {
          await repo.stashPush(`WIP before checkout to ${branchName}`);
          await repo.checkout(branchName);
          vscode.window.showInformationMessage(
            `GitCharm [${meta.name}]: changes stashed, switched to "${branchName}"`
          );
        },
      },
      {
        label: '$(arrow-right) Bring changes to new branch',
        detail: 'Carry uncommitted changes into the new branch',
        action: async () => {
          await repo.stashPush(`WIP migrating to ${branchName}`);
          await repo.checkout(branchName);
          await repo.stashPop();
          vscode.window.showInformationMessage(
            `GitCharm [${meta.name}]: changes migrated to "${branchName}"`
          );
        },
      },
      {
        label: '$(warning) Force checkout',
        detail: 'Discard local changes and switch to the branch',
        action: async () => {
          await repo.checkoutForce(branchName);
          vscode.window.showInformationMessage(
            `GitCharm [${meta.name}]: force checkout to "${branchName}" (changes discarded)`
          );
        },
      },
      {
        label: '$(close) Cancel',
        detail: '',
        action: async () => { /* no-op */ },
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: `GitCharm [${meta.name}]: Uncommitted changes`,
      placeHolder: `Choose how to handle local changes before switching to "${branchName}"`,
      ignoreFocusOut: true,
    });

    if (pick) await pick.action();
    return true;
  }

  private async checkoutBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    // Find which repos have this branch
    const results = await Promise.allSettled(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        if (!repo) return { meta: m, hasBranch: false };
        const branches = await repo.getBranches();
        const found = branches.find(b => {
          const name = b.isRemote ? b.name.replace(/^[^/]+\//, '') : b.name;
          return name === branchName;
        });
        return { meta: m, hasBranch: !!found, isRemote: found?.isRemote ?? false, fullName: found?.name };
      })
    );

    const candidates = results
      .filter((r): r is PromiseFulfilledResult<{ meta: RepoMeta; hasBranch: boolean; isRemote: boolean; fullName?: string }> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(r => r.hasBranch);

    if (candidates.length === 0) {
      vscode.window.showWarningMessage(`GitCharm: Branch "${branchName}" not found in any repository.`);
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Checking out "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const { meta, fullName } of candidates) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.checkout(fullName ?? branchName);
          } catch (e: unknown) {
            const handled = await this.handleDirtyCheckout(repo, meta, fullName ?? branchName, e);
            if (!handled) errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
        } else {
          vscode.window.showInformationMessage(
            `GitCharm: Checked out "${branchName}" in ${candidates.length} ${candidates.length === 1 ? 'repo' : 'repos'}.`
          );
        }
      }
    );
    await this.refresh();
  }

  // ── Single-repo branch actions ──────────────────────────────────────────

  private async newBranchFromSingleRepo(fromBranch: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const branchName = await vscode.window.showInputBox({
      title: `New Branch from '${fromBranch}' in ${meta.name}`,
      prompt: 'Enter the new branch name',
      validateInput: v => (v.trim() ? undefined : 'Branch name cannot be empty'),
    });
    if (!branchName) return;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Yes, checkout immediately', value: true },
        { label: '$(close) No, just create the branch', value: false },
      ],
      { title: `New Branch — Checkout?` }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    try {
      if (checkoutPick.value) {
        await repo.checkout(branchName, true, fromBranch);
      } else {
        await repo.createBranch(branchName, fromBranch);
      }
      vscode.window.showInformationMessage(
        `GitCharm [${meta.name}]: branch "${branchName}" ${checkoutPick.value ? 'created and checked out' : 'created'}.`
      );
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  private async pullSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm [${meta.name}]: Pulling…`, cancellable: false },
      async () => {
        try {
          await repo.pull();
          vscode.window.showInformationMessage(`GitCharm [${meta.name}]: pulled successfully.`);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
        }
      }
    );
    await this.refresh();
  }

  private async renameBranchSingleRepo(oldName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const newName = await vscode.window.showInputBox({
      title: `Rename branch '${oldName}' in ${meta.name}`,
      value: oldName,
      validateInput: v => (v.trim() ? undefined : 'Branch name cannot be empty'),
    });
    if (!newName || newName === oldName) return;

    try {
      await repo.renameBranch(oldName, newName);
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: renamed "${oldName}" → "${newName}".`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  private async pushSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.push();
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: pushed successfully.`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  private async compareSingleRepo(branchName: string, meta: RepoMeta): Promise<void> {
    await vscode.commands.executeCommand(
      'git.compareWithBranch',
      vscode.Uri.file(meta.rootPath),
      branchName,
    );
  }

  private async rebaseSingleRepo(onto: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.rebase(onto);
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: rebased onto "${onto}".`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  private async mergeSingleRepo(from: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.merge(from);
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: merged "${from}".`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  private async deleteSingleRepo(branchName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const confirm = await vscode.window.showQuickPick(
      [
        { label: '$(trash) Delete', description: branchName, value: 'delete' },
        { label: '$(warning) Force delete', description: 'even if not merged', value: 'force' },
      ],
      { title: `Delete branch '${branchName}' in ${meta.name}?` }
    ) as { label: string; value: string } | undefined;
    if (!confirm) return;

    try {
      await repo.deleteBranch(branchName, confirm.value === 'force');
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: deleted "${branchName}".`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  private async pullRemoteIntoCurrentSingleRepo(remoteBranch: string, meta: RepoMeta, useRebase: boolean): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const parts = remoteBranch.split('/');
    const remote = parts[0];
    const branch = parts.slice(1).join('/');
    try {
      await repo.pullFromRemote(remote, branch, useRebase);
      vscode.window.showInformationMessage(
        `GitCharm [${meta.name}]: pulled "${remoteBranch}" using ${useRebase ? 'rebase' : 'merge'}.`
      );
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.refresh();
  }

  // ── Multi-repo branch actions ────────────────────────────────────────────

  private async newBranchFrom(fromBranch: string, metas: RepoMeta[]): Promise<void> {
    const branchName = await vscode.window.showInputBox({
      title: `New Branch from '${fromBranch}'`,
      prompt: 'Enter the new branch name',
      validateInput: v => (v.trim() ? undefined : 'Branch name cannot be empty'),
    });
    if (!branchName) return;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Yes, checkout immediately', value: true },
        { label: '$(close) No, just create the branch', value: false },
      ],
      { title: 'New Branch — Checkout?' }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Creating branch "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            if (checkoutPick.value) {
              await repo.checkout(branchName, true, fromBranch);
            } else {
              await repo.createBranch(branchName, fromBranch);
            }
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
        } else {
          vscode.window.showInformationMessage(`GitCharm: Branch "${branchName}" created in ${metas.length} repos.`);
        }
      }
    );
    await this.refresh();
  }

  private async pullBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Pulling "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.pull();
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
        } else {
          vscode.window.showInformationMessage(`GitCharm: Pulled in ${metas.length} repos.`);
        }
      }
    );
    await this.refresh();
  }

  private async renameBranchAllRepos(oldName: string, metas: RepoMeta[]): Promise<void> {
    const newName = await vscode.window.showInputBox({
      title: `Rename branch '${oldName}' in all repos`,
      value: oldName,
      validateInput: v => (v.trim() ? undefined : 'Branch name cannot be empty'),
    });
    if (!newName || newName === oldName) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Renaming "${oldName}" → "${newName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.renameBranch(oldName, newName);
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
        } else {
          vscode.window.showInformationMessage(`GitCharm: Renamed "${oldName}" → "${newName}" in ${metas.length} repos.`);
        }
      }
    );
    await this.refresh();
  }

  private async compareBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    for (const meta of metas) {
      await vscode.commands.executeCommand(
        'git.compareWithBranch',
        vscode.Uri.file(meta.rootPath),
        branchName,
      );
    }
  }

  private async rebaseAllRepos(onto: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Rebasing onto "${onto}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.rebase(onto);
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
        } else {
          vscode.window.showInformationMessage(`GitCharm: Rebased onto "${onto}" in ${metas.length} repos.`);
        }
      }
    );
    await this.refresh();
  }

  private async mergeBranchAllRepos(from: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Merging "${from}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.merge(from);
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
        } else {
          vscode.window.showInformationMessage(`GitCharm: Merged "${from}" in ${metas.length} repos.`);
        }
      }
    );
    await this.refresh();
  }

  private async deleteBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    const confirm = await vscode.window.showQuickPick(
      [
        { label: '$(trash) Delete', description: branchName, value: 'delete' },
        { label: '$(warning) Force delete', description: 'even if not merged', value: 'force' },
      ],
      { title: `Delete branch '${branchName}' in all repos?` }
    ) as { label: string; value: string } | undefined;
    if (!confirm) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitCharm: Deleting "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.deleteBranch(branchName, confirm.value === 'force');
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
        } else {
          vscode.window.showInformationMessage(`GitCharm: Deleted "${branchName}" in ${metas.length} repos.`);
        }
      }
    );
    await this.refresh();
  }

  // ── Remote management ────────────────────────────────────────────────────

  private async showManageRemotesMenu(metas: RepoMeta[]): Promise<void> {
    if (metas.length === 0) return;

    let meta: RepoMeta;
    if (metas.length === 1) {
      meta = metas[0];
    } else {
      type RepoItem = vscode.QuickPickItem & { meta: RepoMeta };
      const repoItems: RepoItem[] = metas.map(m => ({
        label: `$(root-folder) ${m.name}`,
        description: m.rootPath,
        meta: m,
      }));
      const pick = await vscode.window.showQuickPick(repoItems, {
        title: 'Manage Remotes — Select repository',
      }) as RepoItem | undefined;
      if (!pick) return;
      meta = pick.meta;
    }

    await this.showRepoRemotesMenu(meta);
  }

  private async showRepoRemotesMenu(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const remotes = await repo.getRemotesWithUrls();

    type RemoteItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const items: RemoteItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(add) Add Remote…',
        description: 'Configure a new remote',
        action: () => this.addRemote(meta),
      },
    ];

    if (remotes.length > 0) {
      items.push({ label: 'REMOTES', kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      for (const remote of remotes) {
        items.push({
          label: `$(cloud) ${remote.name}`,
          description: remote.fetchUrl,
          action: () => this.showSingleRemoteMenu(remote, meta),
        });
      }
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: `${meta.name} — Remotes`,
      matchOnDescription: true,
    }) as RemoteItem | undefined;

    if (pick) await pick.action();
  }

  private async showSingleRemoteMenu(
    remote: { name: string; fetchUrl: string; pushUrl: string },
    meta: RepoMeta
  ): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const items: ActionItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showRepoRemotesMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(edit) Rename…',
        description: `Rename "${remote.name}"`,
        action: () => this.renameRemote(remote, meta),
      },
      {
        label: '$(link) Change URL…',
        description: remote.fetchUrl,
        action: () => this.changeRemoteUrl(remote, meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(trash) Remove',
        description: `Remove remote "${remote.name}"`,
        action: () => this.removeRemote(remote, meta),
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: `Remote: ${remote.name} — ${meta.name}`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async addRemote(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const name = await vscode.window.showInputBox({
      title: `Add Remote in ${meta.name} — Name`,
      prompt: 'Enter the remote name (e.g. origin, upstream)',
      validateInput: v => (v.trim() ? undefined : 'Remote name cannot be empty'),
    });
    if (!name) return;

    const url = await vscode.window.showInputBox({
      title: `Add Remote in ${meta.name} — URL`,
      prompt: 'Enter the remote URL',
      validateInput: v => (v.trim() ? undefined : 'URL cannot be empty'),
    });
    if (!url) return;

    try {
      await repo.addRemote(name.trim(), url.trim());
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: remote "${name}" added.`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.showRepoRemotesMenu(meta);
  }

  private async renameRemote(
    remote: { name: string; fetchUrl: string; pushUrl: string },
    meta: RepoMeta
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const newName = await vscode.window.showInputBox({
      title: `Rename remote "${remote.name}" in ${meta.name}`,
      value: remote.name,
      validateInput: v => (v.trim() ? undefined : 'Remote name cannot be empty'),
    });
    if (!newName || newName === remote.name) return;

    try {
      await repo.renameRemote(remote.name, newName.trim());
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: remote renamed "${remote.name}" → "${newName}".`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.showRepoRemotesMenu(meta);
  }

  private async changeRemoteUrl(
    remote: { name: string; fetchUrl: string; pushUrl: string },
    meta: RepoMeta
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const newUrl = await vscode.window.showInputBox({
      title: `Change URL of "${remote.name}" in ${meta.name}`,
      value: remote.fetchUrl,
      validateInput: v => (v.trim() ? undefined : 'URL cannot be empty'),
    });
    if (!newUrl || newUrl === remote.fetchUrl) return;

    try {
      await repo.setRemoteUrl(remote.name, newUrl.trim());
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: URL of "${remote.name}" updated.`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.showRepoRemotesMenu(meta);
  }

  private async removeRemote(
    remote: { name: string; fetchUrl: string; pushUrl: string },
    meta: RepoMeta
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const confirm = await vscode.window.showQuickPick(
      [
        { label: `$(trash) Remove "${remote.name}"`, value: true },
        { label: '$(close) Cancel', value: false },
      ],
      { title: `Remove remote "${remote.name}" from ${meta.name}?` }
    ) as { label: string; value: boolean } | undefined;

    if (!confirm?.value) return;

    try {
      await repo.removeRemote(remote.name);
      vscode.window.showInformationMessage(`GitCharm [${meta.name}]: remote "${remote.name}" removed.`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
    }
    await this.showRepoRemotesMenu(meta);
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.statusDisposable?.dispose();
  }
}
