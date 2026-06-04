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

    // Use effective name: detachedTag if detached, otherwise branch name
    const effectiveNames = [...new Set(branches.map(b => b.detachedTag ?? b.name))];
    this.branchesDiverged = effectiveNames.length > 1;
    this.hasBehind = branches.some(b => (b.aheadBehind?.behind ?? 0) > 0);
    this.hasUnpushed = branches.some(b => !b.upstream || (b.aheadBehind?.ahead ?? 0) > 0);
    this.hasUncommitted = statusResult.repos.some(
      r => r.stagedFiles.length > 0 || r.unstagedFiles.length > 0
    );

    const headLabel = effectiveNames.length === 1
      ? effectiveNames[0]
      : `${effectiveNames[0]} +${effectiveNames.length - 1}`;

    // Icon: tag if every repo that has a current ref is either detached on a tag
    // or has no branch name (pure detached HEAD). Fall back to git-branch only when
    // at least one repo is actually on a named branch.
    const anyOnNamedBranch = branches.some(b => !b.detachedTag && b.name !== 'HEAD');
    const headIcon = anyOnNamedBranch ? '$(git-branch)' : '$(tag)';

    const divergeIcon = this.branchesDiverged ? '$(warning) ' : '';
    const pullIcon = this.hasBehind ? ' $(arrow-down)' : '';
    const pushIcon = this.hasUnpushed ? ' $(arrow-up)' : '';
    const dirtyDot = this.hasUncommitted ? ' ●' : '';
    this.statusBarItem.text = `${divergeIcon}${headIcon} ${headLabel}${dirtyDot}${pushIcon}${pullIcon}`;

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
        let isDetachedOnTag = false;
        if (repo) {
          try {
            const current = await repo.getCurrentBranch();
            isDetachedOnTag = !!current.detachedTag;
            branchName = current.detachedTag ?? current.name;
            repoHasUnpushed = !current.upstream || (current.aheadBehind?.ahead ?? 0) > 0;
          } catch { /* */ }
        }
        const refIcon = isDetachedOnTag ? '$(tag)' : '$(git-branch)';
        items.push({
          label: `$(root-folder) ${meta.name}`,
          description: `${refIcon} ${branchName}${repoHasUnpushed ? '  $(arrow-up)' : ''}`,
          action: () => this.showRepoBranchMenu(meta),
        });
      }

      await this.appendCommonBranches(items, metas);
      await this.appendCommonTags(items, metas);
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
    const perRepo = await Promise.allSettled(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? repo.getBranches() : [];
      })
    );

    // Count local branches present in ALL repos
    const localCount = new Map<string, number>();
    const remoteCount = new Map<string, number>();

    for (const r of perRepo) {
      if (r.status !== 'fulfilled') continue;
      const seenLocal = new Set<string>();
      const seenRemote = new Set<string>();
      for (const b of r.value) {
        if (b.isRemote) {
          const name = b.name.replace(/^[^/]+\//, '');
          if (!seenRemote.has(name)) {
            seenRemote.add(name);
            remoteCount.set(name, (remoteCount.get(name) ?? 0) + 1);
          }
        } else {
          if (!seenLocal.has(b.name)) {
            seenLocal.add(b.name);
            localCount.set(b.name, (localCount.get(b.name) ?? 0) + 1);
          }
        }
      }
    }

    const commonLocal = [...localCount.entries()]
      .filter(([, c]) => c === metas.length)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name]) => name);

    const commonRemote = [...remoteCount.entries()]
      .filter(([, c]) => c === metas.length)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name]) => name);

    // Collect current HEAD names for highlighting
    const heads = new Set<string>();
    for (const r of perRepo) {
      if (r.status !== 'fulfilled') continue;
      const head = r.value.find(b => b.isHead && !b.isRemote);
      if (head) heads.add(head.name);
    }
    const headLabel = [...heads].join(', ');

    if (commonLocal.length > 0) {
      items.push({
        label: 'COMMON LOCAL BRANCHES',
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as typeof items[0]);
      for (const name of commonLocal) {
        const isCurrentSomewhere = heads.has(name);
        const icon = isCurrentSomewhere ? '$(check)' : isPrimaryBranch(name) ? '$(star)' : '$(git-branch)';
        items.push({
          label: `${icon} ${name}`,
          description: isCurrentSomewhere ? 'current' : '',
          action: () => this.showCommonBranchActionMenu(name, metas, isCurrentSomewhere, headLabel),
        });
      }
    }

    if (commonRemote.length > 0) {
      items.push({
        label: 'COMMON REMOTE BRANCHES',
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as typeof items[0]);
      for (const name of commonRemote) {
        items.push({
          label: `$(cloud) ${name}`,
          description: '',
          action: () => this.showCommonBranchActionMenu(name, metas, false, headLabel),
        });
      }
    }
  }

  private async appendCommonTags(
    items: Array<vscode.QuickPickItem & { action: () => Promise<void> | void }>,
    metas: RepoMeta[]
  ): Promise<void> {
    // Fetch tags and current branch for all repos in parallel
    const [perRepoTags, perRepoCurrent] = await Promise.all([
      Promise.allSettled(metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return { metaId: m.id, tags: repo ? await repo.getTags() : [] };
      })),
      Promise.allSettled(metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? repo.getCurrentBranch() : null;
      })),
    ]);

    // Active detached tags for highlighting
    const activeDetachedTags = new Set<string>();
    for (const r of perRepoCurrent) {
      if (r.status === 'fulfilled' && r.value?.detachedTag) {
        activeDetachedTags.add(r.value.detachedTag);
      }
    }

    // Build tag → set of repoIds that have it
    const tagRepoIds = new Map<string, string[]>();
    for (const r of perRepoTags) {
      if (r.status !== 'fulfilled') continue;
      const { metaId, tags } = r.value;
      const seen = new Set<string>();
      for (const t of tags) {
        if (!seen.has(t.name)) {
          seen.add(t.name);
          if (!tagRepoIds.has(t.name)) tagRepoIds.set(t.name, []);
          tagRepoIds.get(t.name)!.push(metaId);
        }
      }
    }

    // For multi-repo: only show tags present in ALL repos that responded.
    // fulfilled count tells us how many repos actually loaded tags.
    const fulfilledCount = perRepoTags.filter(r => r.status === 'fulfilled').length;
    const minCount = metas.length === 1 ? 1 : fulfilledCount;

    const tagNames = [...tagRepoIds.entries()]
      .filter(([, ids]) => ids.length >= minCount)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name]) => name);

    if (tagNames.length === 0) return;

    const sectionLabel = metas.length === 1 ? 'TAGS' : 'COMMON TAGS';
    items.push({
      label: sectionLabel,
      kind: vscode.QuickPickItemKind.Separator,
      action: async () => {},
    } as unknown as typeof items[0]);

    for (const tagName of tagNames) {
      const isActive = activeDetachedTags.has(tagName);
      // Only pass the repos that actually have this tag
      const tagMetas = metas.filter(m => tagRepoIds.get(tagName)?.includes(m.id));
      const icon = isActive ? '$(check)' : '$(tag)';
      items.push({
        label: `${icon} ${tagName}`,
        description: isActive ? 'current' : '',
        action: () => this.showCommonTagActionMenu(tagName, tagMetas),
      });
    }
  }

  private async showCommonTagActionMenu(
    tagName: string,
    metas: RepoMeta[],
  ): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    // Get current branch names for label
    const currentBranchNames = await Promise.allSettled(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? (await repo.getCurrentBranch()).name : '';
      })
    );
    const branchLabel = [...new Set(
      currentBranchNames
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map(r => r.value)
        .filter(Boolean)
    )].join(', ') || 'current branch';

    const remotes = await Promise.allSettled(metas.map(async m => {
      const repo = this.manager.getRepo(m.id);
      return repo ? repo.getRemotes() : [];
    }));
    const allRemotes = [...new Set(
      remotes
        .filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
        .flatMap(r => r.value)
    )];

    const pushItems: ActionItem[] = allRemotes.map(remote => ({
      label: `$(cloud-upload) Push to "${remote}"`,
      action: async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `GitCharm: Pushing tag "${tagName}" to ${remote}…`, cancellable: false },
          async () => {
            const errors: string[] = [];
            for (const meta of metas) {
              const repo = this.manager.getRepo(meta.id);
              if (!repo) continue;
              try { await repo.pushTag(tagName, remote); } catch (e: unknown) { errors.push(`${meta.name}: ${String(e)}`); }
            }
            if (errors.length > 0) {
              vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
            } else {
              vscode.window.showInformationMessage(`GitCharm: tag "${tagName}" pushed to "${remote}" in ${metas.length} repos.`);
            }
          }
        );
      },
    }));

    const items: ActionItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(arrow-right) Checkout',
        description: `Checkout tag "${tagName}" in all repos (detached HEAD)`,
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GitCharm: Checking out tag "${tagName}"…`, cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try { await repo.checkoutTag(tagName); } catch (e: unknown) { errors.push(`${meta.name}: ${String(e)}`); }
              }
              if (errors.length > 0) vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
              else vscode.window.showInformationMessage(`GitCharm: checked out tag "${tagName}" in ${metas.length} repos.`);
            }
          );
          await this.refresh();
        },
      },
      {
        label: `$(git-merge) Merge "${tagName}" into "${branchLabel}"`,
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GitCharm: Merging tag "${tagName}"…`, cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try { await repo.mergeTag(tagName); } catch (e: unknown) { errors.push(`${meta.name}: ${String(e)}`); }
              }
              if (errors.length > 0) vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
              else vscode.window.showInformationMessage(`GitCharm: merged tag "${tagName}" in ${metas.length} repos.`);
            }
          );
          await this.refresh();
        },
      },
      ...pushItems,
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(trash) Delete tag',
        description: `Delete tag "${tagName}" in all repos`,
        action: async () => {
          const pick = await vscode.window.showWarningMessage(
            `Delete tag "${tagName}" in ${metas.length} ${metas.length === 1 ? 'repository' : 'repositories'}?`,
            { modal: true }, 'Delete Local', 'Delete on Remote', 'Delete Local and Remote'
          );
          if (!pick) return;
          const deleteLocal = pick !== 'Delete on Remote';
          const deleteRemote = pick === 'Delete on Remote' || pick === 'Delete Local and Remote';
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `GitCharm: Deleting tag "${tagName}"…`, cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try {
                  if (deleteLocal) await repo.deleteTag(tagName);
                  if (deleteRemote) {
                    const remotes = await repo.getRemotes().catch(() => [] as string[]);
                    for (const remote of remotes) {
                      await repo.deleteTagRemote(tagName, remote).catch(() => {});
                    }
                  }
                } catch (e: unknown) { errors.push(`${meta.name}: ${String(e)}`); }
              }
              if (errors.length > 0) vscode.window.showWarningMessage(`GitCharm: ${errors.length} error(s): ${errors.join('; ')}`);
              else vscode.window.showInformationMessage(`GitCharm: deleted tag "${tagName}" in ${metas.length} repos.`);
            }
          );
          await this.refresh();
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: `Tag: ${tagName}`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
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
      );
    }

    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(trash) Delete…',
        action: () => this.deleteBranchAllRepos(branchName, metas),
      },
    );

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

    const [branches, currentBranch, tags] = await Promise.all([
      repo.getBranches(),
      repo.getCurrentBranch(),
      repo.getTags(),
    ]);
    const local = branches.filter(b => !b.isRemote);
    const remote = branches.filter(b => b.isRemote);
    const effectiveBranchName = currentBranch.detachedTag ?? currentBranch.name;
    const isDetached = !!currentBranch.detachedTag || currentBranch.name === 'HEAD';

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
          action: () => this.showSingleBranchActionMenu(b.name, meta, b.isHead, false, hasUnpushed, effectiveBranchName),
        };
      }),
      { label: 'REMOTE', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...remote.map(b => {
        const primary = isPrimaryBranch(b.name);
        const icon = primary ? '$(star)' : '$(cloud)';
        return {
          label: `${icon} ${b.name}`,
          description: '',
          action: () => this.showSingleBranchActionMenu(b.name, meta, false, true, false, effectiveBranchName),
        };
      }),
    ];

    if (tags.length > 0) {
      items.push({ label: 'TAGS', kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      for (const tag of tags) {
        const isActiveTag = currentBranch.detachedTag === tag.name;
        const icon = isActiveTag ? '$(check)' : '$(tag)';
        items.push({
          label: `${icon} ${tag.name}`,
          description: isActiveTag ? 'current' : tag.hash,
          action: () => this.showSingleTagActionMenu(tag.name, meta, effectiveBranchName, isDetached),
        });
      }
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: `${meta.name} — Branches`,
      matchOnDescription: true,
    }) as BranchItem | undefined;

    if (pick) await pick.action();
  }

  private async showSingleTagActionMenu(
    tagName: string,
    meta: RepoMeta,
    currentBranchName: string,
    isDetached = false,
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const remotes = await repo.getRemotes().catch(() => [] as string[]);
    const pushItems: ActionItem[] = remotes.map(r => ({
      label: `$(cloud-upload) Push to "${r}"`,
      action: async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `GitCharm: Pushing tag "${tagName}" to ${r}…`, cancellable: false },
          async () => {
            try {
              await repo.pushTag(tagName, r);
              vscode.window.showInformationMessage(`GitCharm [${meta.name}]: tag "${tagName}" pushed to "${r}".`);
            } catch (e: unknown) {
              vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
            }
          }
        );
      },
    }));

    const mergeItem: ActionItem = {
      label: `$(git-merge) Merge "${tagName}" into "${currentBranchName}"`,
      action: async () => {
        try {
          await repo.mergeTag(tagName);
          vscode.window.showInformationMessage(`GitCharm [${meta.name}]: merged tag "${tagName}".`);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
        }
        await this.refresh();
      },
    };

    const items: ActionItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(arrow-right) Checkout',
        description: `Checkout tag "${tagName}" (detached HEAD)`,
        action: async () => {
          try {
            await repo.checkoutTag(tagName);
            vscode.window.showInformationMessage(`GitCharm [${meta.name}]: checked out tag "${tagName}" (detached HEAD).`);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
          }
          await this.refresh();
        },
      },
      ...(isDetached ? [] : [mergeItem]),
      ...pushItems,
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(trash) Delete tag',
        description: `Delete tag "${tagName}"`,
        action: async () => {
          const pick = await vscode.window.showWarningMessage(
            `Delete tag "${tagName}" in ${meta.name}?`,
            { modal: true }, 'Delete Local', 'Delete on Remote', 'Delete Local and Remote'
          );
          if (!pick) return;
          const deleteLocal = pick !== 'Delete on Remote';
          const deleteRemote = pick === 'Delete on Remote' || pick === 'Delete Local and Remote';
          try {
            if (deleteLocal) await repo.deleteTag(tagName);
            if (deleteRemote) {
              const remotes = await repo.getRemotes().catch(() => [] as string[]);
              if (remotes.length === 0) {
                vscode.window.showWarningMessage(`GitCharm [${meta.name}]: no remotes configured.`);
              } else {
                const remote = remotes.length === 1
                  ? remotes[0]
                  : (await vscode.window.showQuickPick(remotes, { title: `Delete "${tagName}" from remote` }));
                if (remote) await repo.deleteTagRemote(tagName, remote);
              }
            }
            vscode.window.showInformationMessage(`GitCharm [${meta.name}]: tag "${tagName}" deleted.`);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(`GitCharm [${meta.name}]: ${String(e)}`);
          }
          await this.refresh();
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: `Tag: ${tagName} — ${meta.name}`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

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
