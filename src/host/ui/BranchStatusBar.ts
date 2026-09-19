import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import type { RepoMeta, BranchInfo } from '../types/git';
import { isPrimaryBranch } from '../utils/branchUtils';
import type { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { formatGitError, showGitError, getRawErrorDetail, isBranchAlreadyExistsError } from '../utils/gitErrorUtils';
import { logInfo, logWarn, logError, showLogChannel } from '../utils/Logger';
import { offerRenameBranchRemoteSync } from '../utils/renameBranchRemoteSync';
import { handleDirtyCheckout } from '../utils/dirtyCheckoutHandler';
import { promptBranchName } from '../utils/branchNamePrompt';
import { pickRefQuickPick } from '../utils/refPicker';

/** Formats a branch's last commit as "hash  •  author  •  message" for a QuickPick detail line. */
function formatCommitDetail(b: BranchInfo | undefined): string | undefined {
  if (!b) return undefined;
  const parts = [b.lastCommitHash?.slice(0, 8), b.lastCommitAuthor, b.lastCommitMessage].filter(Boolean);
  return parts.length > 0 ? parts.join('  •  ') : undefined;
}

export class BranchStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private statusDisposable?: vscode.Disposable;
  private branchDisposable?: vscode.Disposable;
  private configDisposable?: vscode.Disposable;
  private hasBehind = false;
  private hasUnpushed = false;
  private hasNoUpstream = false;
  private branchesDiverged = false;
  private hasUncommitted = false;
  private totalAhead = 0;
  private totalBehind = 0;

  private logPanel?: GitLogPanelProvider;

  setLogPanel(logPanel: GitLogPanelProvider): void { this.logPanel = logPanel; }

  constructor(
    private readonly manager: WorkspaceGitManager,
    private readonly commitPanelReveal: () => void
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'gitcharm.showBranchMenu';
    this.statusBarItem.tooltip = 'Git Menu';
    this.statusBarItem.show();

    this.statusDisposable = this.manager.onStatusChange(status => this.refresh(status));
    // Also refresh on branch change: the status change fires at 300ms and may catch
    // a transient HEAD state during checkout. The branch change fires at 400ms when
    // the VS Code Git API state is stable, ensuring the status bar corrects itself.
    this.branchDisposable = this.manager.onBranchChange(() => this.manager.getAllStatusesFresh().then(s => this.refresh(s)));
    this.configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('gitcharm.suppressDivergedBranchWarning')) {
        this.refresh();
      }
    });
    this.manager.getAllStatusesFresh().then(s => this.refresh(s));
  }

  async refresh(preloadedStatus?: import('../types/git').WorkspaceStatus): Promise<void> {
    const allMetas = this.manager.getRepoMetas();
    const nonWorktreeMetas = allMetas.filter(m => !m.isWorktree);
    const metas = nonWorktreeMetas.length > 0 ? nonWorktreeMetas : allMetas;
    if (allMetas.length === 0) {
      this.statusBarItem.text = '$(git-branch) No repo';
      this.statusBarItem.backgroundColor = undefined;
      this.hasBehind = false;
      this.branchesDiverged = false;
      this.hasUncommitted = false;
      return;
    }

    const worktreeMetas = nonWorktreeMetas.length > 0 ? allMetas.filter(m => m.isWorktree) : [];

    const [statusResult, worktreeBranchResults] = await Promise.all([
      preloadedStatus ?? this.manager.getAllStatusesFresh(),
      Promise.allSettled(worktreeMetas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? repo.getCurrentBranch() : null;
      })),
    ]);

    type BranchInfo = Awaited<ReturnType<NonNullable<ReturnType<WorkspaceGitManager['getRepo']>>['getCurrentBranch']>>;

    const nonWorktreeIds = new Set(metas.map(m => m.id));
    const branches = statusResult.repos
      .filter(r => nonWorktreeIds.has(r.repoId))
      .map(r => r.branch);

    const worktreeBranches = worktreeBranchResults
      .filter((r): r is PromiseFulfilledResult<BranchInfo | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(Boolean) as BranchInfo[];

    // Use effective name: detachedTag, detachedHash, or branch name
    const effectiveNames = [...new Set(branches.map(b => b.detachedTag ?? b.detachedHash ?? b.name))];
    this.branchesDiverged = effectiveNames.length > 1;
    this.totalBehind = branches.reduce((sum, b) => sum + (b.aheadBehind?.behind ?? 0), 0);
    this.totalAhead = branches.reduce((sum, b) => sum + (b.aheadBehind?.ahead ?? 0), 0);
    this.hasBehind = this.totalBehind > 0;
    this.hasUnpushed = branches.some(b => (b.aheadBehind?.ahead ?? 0) > 0);
    this.hasNoUpstream = branches.some(b => !b.upstream);
    this.hasUncommitted = statusResult.repos.some(
      r => r.stagedFiles.length > 0 || r.unstagedFiles.length > 0
    );

    const headLabel = effectiveNames.length === 1
      ? effectiveNames[0]
      : `${effectiveNames[0]} +${effectiveNames.length - 1}`;

    // Append worktree branch names after a separator
    const worktreeEffectiveNames = [...new Set(worktreeBranches.map(b => b.detachedTag ?? b.detachedHash ?? b.name))];
    const worktreeSuffix = worktreeEffectiveNames.length > 0
      ? '  |  ' + worktreeEffectiveNames.join('  |  ')
      : '';

    // Icon: git-branch on a named branch, tag on detached tag, git-commit on detached hash
    const anyOnNamedBranch = branches.some(b => !b.detachedTag && !b.detachedHash && b.name !== 'HEAD');
    const anyOnTag = !anyOnNamedBranch && branches.some(b => !!b.detachedTag);
    const headIcon = anyOnNamedBranch ? '$(git-branch)' : anyOnTag ? '$(tag)' : '$(git-commit)';

    const suppressDiverged = vscode.workspace.getConfiguration('gitcharm').get<boolean>('suppressDivergedBranchWarning') === true;
    const divergeIcon = this.branchesDiverged && !suppressDiverged ? '$(warning) ' : '';
    const dirtyDot = this.hasUncommitted ? ' ●' : '';
    const pullPart = this.totalBehind > 0 ? ` $(arrow-down)${this.totalBehind}` : '';
    const pushPart = this.totalAhead > 0 ? ` $(arrow-up)${this.totalAhead}` : '';
    this.statusBarItem.text = `${divergeIcon}${headIcon} ${headLabel}${worktreeSuffix}${dirtyDot}${pullPart}${pushPart}`;

    const tooltipParts: string[] = [];
    if (this.branchesDiverged && !suppressDiverged) tooltipParts.push('Branches have diverged across repositories');
    if (this.hasUncommitted) tooltipParts.push('Uncommitted changes present');
    if (this.hasUnpushed) tooltipParts.push('Unpushed commits or branch not on remote');
    if (this.hasBehind) tooltipParts.push('Incoming commits available');
    this.statusBarItem.tooltip = tooltipParts.length > 0
      ? `${tooltipParts.join(' · ')}`
      : 'Git Menu';

    if (this.branchesDiverged && !suppressDiverged) {
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

  async showBranchOptions(repoId: string, branchName: string): Promise<void> {
    const metas = this.manager.getRepoMetas();
    const meta = metas.find(m => m.id === repoId);
    if (!meta) return;
    const repo = this.manager.getRepo(repoId);
    if (!repo) return;
    const [branches, currentBranch] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
    const remote = branches.filter(b => b.isRemote);
    const remoteNames = new Set(remote.map(r => r.name.replace(/^[^/]+\//, '')));
    const branch = branches.find(b => !b.isRemote && b.name === branchName);
    const isCurrent = branch?.isHead ?? false;
    const hasRemote = isCurrent ? !!currentBranch.upstream : remoteNames.has(branchName);
    const hasUnpushed = !hasRemote || ((branch?.aheadBehind?.ahead ?? 0) > 0);
    const effectiveBranchName = currentBranch.detachedTag ?? currentBranch.detachedHash ?? currentBranch.name;
    await this.showSingleBranchActionMenu(branchName, meta, isCurrent, false, hasUnpushed, effectiveBranchName, false);
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

    const suppressDivergedMenu = vscode.workspace.getConfiguration('gitcharm').get<boolean>('suppressDivergedBranchWarning') === true;
    if (this.branchesDiverged && !suppressDivergedMenu) {
      items.push({
        label: '$(warning)  Branches have diverged',
        detail: '  Repositories are not on the same branch',
        alwaysShow: true,
        action: async () => {},
      } as unknown as MenuItem);
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
    }

    const isSingleRepo = metas.length === 1;

    items.push(
      {
        label: `$(repo-fetch) Fetch${isSingleRepo ? '' : ' All'}`,
        description: isSingleRepo ? 'Fetch from all remotes' : 'Fetch from all remotes in all repositories',
        action: () => this.fetchAll(),
      },
      {
        label: `${this.hasBehind ? '$(arrow-down) ' : '$(repo-pull) '}Pull${isSingleRepo ? '' : ' All'} (Update Project)…`,
        description: this.hasBehind
          ? `Pull ${isSingleRepo ? '' : 'all repositories '}(${this.totalBehind} incoming commit${this.totalBehind !== 1 ? 's' : ''})`
          : isSingleRepo ? 'Pull from remote' : 'Pull all repositories from remote',
        action: () => this.updateProject(),
      },
      {
        label: `${this.hasUnpushed ? '$(arrow-up) ' : '$(repo-push) '}Push${isSingleRepo ? '' : ' All'}…`,
        description: this.hasUnpushed
          ? `Push commits to remote (${this.totalAhead} commit${this.totalAhead !== 1 ? 's' : ''} to push${this.hasNoUpstream ? ', some branches have no upstream' : ''})`
          : this.hasNoUpstream ? 'Some branches have no upstream set' : `Push${isSingleRepo ? '' : ' all repositories'} to remote`,
        action: async () => { await vscode.commands.executeCommand('gitcharm.push'); },
      },
      {
        label: `$(repo-force-push) Force Push${isSingleRepo ? '' : ' All'}…`,
        description: isSingleRepo ? 'Force push to remote' : 'Force push all repositories to remote',
        action: async () => {
          const confirm = await vscode.window.showWarningMessage(
            isSingleRepo ? 'Force push? This will overwrite remote history.' : 'Force push all repositories? This will overwrite remote history.',
            { modal: true }, 'Force Push'
          );
          if (confirm !== 'Force Push') return;
          const metas = this.manager.getRepoMetas();
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: isSingleRepo ? 'Force pushing…' : 'Force pushing all repositories…', cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try { await repo.push(true); } catch (e: unknown) {
                  logError(`force-push:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
                  errors.push(`${meta.name}: ${formatGitError(e)}`);
                }
              }
              if (errors.length > 0) {
                void vscode.window.showWarningMessage(`${errors.length} force push(es) failed: ${errors.join('; ')}`, 'Show Log')
                  .then(choice => { if (choice === 'Show Log') showLogChannel(); });
              } else {
                const msg = `Force push complete for ${metas.length} ${metas.length === 1 ? 'repository' : 'repositories'}.`;
                vscode.window.showInformationMessage(msg);
                logInfo('force-push-all', msg);
              }
            }
          );
          await this.refresh();
        },
      },
      {
        label: `$(sync) Sync${isSingleRepo ? '' : ' All'}…`,
        description: isSingleRepo ? 'Pull then push' : 'Pull then push all repositories',
        action: async () => { await vscode.commands.executeCommand('gitcharm.syncAll'); },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(add) New Branch…',
        description: isSingleRepo ? 'Create a new branch' : 'Create a new branch in all repositories',
        action: () => this.newBranch(metas),
      },
      {
        label: '$(tag) New Tag…',
        description: isSingleRepo ? 'Create a new tag on HEAD' : 'Create a new tag on HEAD of all repositories',
        action: () => this.newTagAllRepos(metas),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(git-commit) Commit',
        description: 'Open Commit panel',
        action: () => this.commitPanelReveal(),
      },
      {
        label: '$(history) Log',
        description: 'Open Log panel',
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
        let repoAhead = 0;
        let repoBehind = 0;
        if (repo) {
          try {
            const current = await repo.getCurrentBranch();
            isDetachedOnTag = !!current.detachedTag;
            branchName = current.detachedTag ?? current.detachedHash ?? current.name;
            repoAhead = current.aheadBehind?.ahead ?? 0;
            repoBehind = current.aheadBehind?.behind ?? 0;
            repoHasUnpushed = repoAhead > 0;
          } catch { /* */ }
        }
        const refIcon = isDetachedOnTag ? '$(tag)' : '$(git-branch)';
        const repoIcon = meta.isSubmodule ? '$(package)' : '$(root-folder)';
        const repoPushLabel = repoHasUnpushed ? `  $(arrow-up)${repoAhead > 0 ? repoAhead : ''}` : '';
        const repoPullLabel = repoBehind > 0 ? `  $(arrow-down)${repoBehind}` : '';
        items.push({
          label: `${repoIcon} ${meta.name}`,
          description: `${refIcon} ${branchName}${repoPushLabel}${repoPullLabel}`,
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
    const isSingleRepo = metas.length === 1;
    // Only meaningful with exactly one repo — with several, a same-named branch
    // can point at different commits per repo, so per-commit info can't be shown as shared.
    const singleRepoBranches = isSingleRepo && perRepo[0]?.status === 'fulfilled' ? perRepo[0].value : [];
    const singleRepoService = isSingleRepo ? this.manager.getRepo(metas[0]!.id) : undefined;
    const singleRepoPrimaryRemote = singleRepoBranches.find(b => b.isRemote)?.remoteName;
    const actualDefaultBranch = singleRepoService && singleRepoPrimaryRemote
      ? await singleRepoService.getRemoteDefaultBranch(singleRepoPrimaryRemote)
      : undefined;

    // Count local branches present in ALL repositories
    const localCount = new Map<string, number>();
    // For remote branches: key = full "remote/branch" name, count per repo
    const remoteCount = new Map<string, number>();

    for (const r of perRepo) {
      if (r.status !== 'fulfilled') continue;
      const seenLocal = new Set<string>();
      const seenRemote = new Set<string>();
      for (const b of r.value) {
        if (b.isRemote) {
          // Keep full name (e.g. "upstream/main") so we preserve the remote name
          const fullName = b.name.startsWith('remotes/') ? b.name.slice('remotes/'.length) : b.name;
          if (!seenRemote.has(fullName)) {
            seenRemote.add(fullName);
            remoteCount.set(fullName, (remoteCount.get(fullName) ?? 0) + 1);
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

    // commonRemote entries are full "remote/branch" strings (e.g. "origin/main", "upstream/main")
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
    // With repositories on different branches, "current" is ambiguous for a shared branch
    // entry — only show the checkmark/"current" label when every repo agrees on one branch.
    const hasDivergence = heads.size > 1;

    if (commonLocal.length > 0) {
      items.push({
        label: metas.length === 1 ? 'LOCAL BRANCHES' : 'COMMON LOCAL BRANCHES',
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as typeof items[0]);
      for (const name of commonLocal) {
        const isCurrentSomewhere = heads.has(name);
        const showAsCurrent = isCurrentSomewhere && !hasDivergence;
        const icon = showAsCurrent ? '$(check)' : isPrimaryBranch(name, actualDefaultBranch) ? '$(star)' : '$(git-branch)';
        const b = singleRepoBranches.find(x => !x.isRemote && x.name === name);
        const aheadBehindLabel = b?.aheadBehind ? `↑${b.aheadBehind.ahead} ↓${b.aheadBehind.behind}` : '';
        items.push({
          label: `${icon} ${name}`,
          description: isSingleRepo
            ? [aheadBehindLabel, showAsCurrent ? 'current' : undefined, b?.lastCommitDateRelative].filter(Boolean).join('  ')
            : (showAsCurrent ? 'current' : ''),
          detail: isSingleRepo ? formatCommitDetail(b) : undefined,
          action: () => this.showCommonBranchActionMenu(name, metas, isCurrentSomewhere, headLabel, undefined, undefined, false, false, hasDivergence),
        });
      }
    }

    if (commonRemote.length > 0) {
      items.push({
        label: metas.length === 1 ? 'REMOTE BRANCHES' : 'COMMON REMOTE BRANCHES',
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as typeof items[0]);
      for (const fullName of commonRemote) {
        const baseName = fullName.includes('/') ? fullName.slice(fullName.indexOf('/') + 1) : fullName;
        const b = singleRepoBranches.find(x => x.isRemote && x.name === fullName);
        const primary = isPrimaryBranch(fullName, actualDefaultBranch);
        items.push({
          label: `$(cloud) ${fullName}`,
          description: isSingleRepo ? (b?.lastCommitDateRelative ?? '') : '',
          detail: isSingleRepo ? formatCommitDetail(b) : undefined,
          // Checkout/pull/rename work on the local branch, but merge, rebase and
          // compare must use the remote ref the user actually picked — merging the
          // same-named local branch instead is usually a silent no-op.
          action: () => this.showCommonBranchActionMenu(baseName, metas, false, headLabel, fullName, fullName, true, primary, hasDivergence),
        });
      }
    }
  }

  private async appendCommonTags(
    items: Array<vscode.QuickPickItem & { action: () => Promise<void> | void }>,
    metas: RepoMeta[]
  ): Promise<void> {
    // Fetch tags and current branch for all repositories in parallel
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

    // For multi-repo: only show tags present in ALL repositories that responded.
    // fulfilled count tells us how many repositories actually loaded tags.
    const fulfilledCount = perRepoTags.filter(r => r.status === 'fulfilled').length;
    const minCount = metas.length === 1 ? 1 : fulfilledCount;

    const tagNames = [...tagRepoIds.entries()]
      .filter(([, ids]) => ids.length >= minCount)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name]) => name);

    if (tagNames.length === 0) return;

    const isSingleRepo = metas.length === 1;
    // Per-commit tag info (hash/author/message) is only meaningful with a single repo —
    // with several, the "same" tag name can point at different commits per repo.
    const singleRepoTags = isSingleRepo && perRepoTags[0]?.status === 'fulfilled' ? perRepoTags[0].value.tags : [];

    const sectionLabel = metas.length === 1 ? 'TAGS' : 'COMMON TAGS';
    items.push({
      label: sectionLabel,
      kind: vscode.QuickPickItemKind.Separator,
      action: async () => {},
    } as unknown as typeof items[0]);

    for (const tagName of tagNames) {
      const isActive = activeDetachedTags.has(tagName);
      // Only pass the repositories that actually have this tag
      const tagMetas = metas.filter(m => tagRepoIds.get(tagName)?.includes(m.id));
      const icon = isActive ? '$(check)' : '$(tag)';
      const t = singleRepoTags.find(x => x.name === tagName);
      items.push({
        label: `${icon} ${tagName}`,
        description: isSingleRepo
          ? [isActive ? 'current' : undefined, t?.dateRelative].filter(Boolean).join('  ')
          : (isActive ? 'current' : ''),
        detail: isSingleRepo && t ? [t.author, t.hash, t.message].filter(Boolean).join('  •  ') : undefined,
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
          { location: vscode.ProgressLocation.Notification, title: `Pushing tag "${tagName}" to ${remote}…`, cancellable: false },
          async () => {
            const errors: string[] = [];
            for (const meta of metas) {
              const repo = this.manager.getRepo(meta.id);
              if (!repo) continue;
              try { await repo.pushTag(tagName, remote); } catch (e: unknown) {
                logError(`push-tag:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
                errors.push(`${meta.name}: ${formatGitError(e)}`);
              }
            }
            if (errors.length > 0) {
              void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
                .then(choice => { if (choice === 'Show Log') showLogChannel(); });
            } else {
              const msg = `tag "${tagName}" pushed to "${remote}" in ${metas.length} repositories.`;
              vscode.window.showInformationMessage(msg);
              logInfo('push-tag', msg);
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
        description: metas.length === 1 ? `Checkout tag "${tagName}" (detached HEAD)` : `Checkout tag "${tagName}" in all repositories (detached HEAD)`,
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Checking out tag "${tagName}"…`, cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try { await repo.checkoutTag(tagName); } catch (e: unknown) {
                  logError(`checkout-tag:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
                  errors.push(`${meta.name}: ${formatGitError(e)}`);
                }
              }
              if (errors.length > 0) {
                void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
                  .then(choice => { if (choice === 'Show Log') showLogChannel(); });
              } else {
                const msg = `checked out tag "${tagName}" in ${metas.length} repositories.`;
                vscode.window.showInformationMessage(msg);
                logInfo('checkout-tag', msg);
              }
            }
          );
          await this.refresh();
        },
      },
      {
        label: `$(git-merge) Merge "${tagName}" into "${branchLabel}"`,
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Merging tag "${tagName}"…`, cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try { await repo.mergeTag(tagName); } catch (e: unknown) {
                  logError(`merge-tag:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
                  errors.push(`${meta.name}: ${formatGitError(e)}`);
                }
              }
              if (errors.length > 0) {
                void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
                  .then(choice => { if (choice === 'Show Log') showLogChannel(); });
              } else {
                const msg = `merged tag "${tagName}" in ${metas.length} repositories.`;
                vscode.window.showInformationMessage(msg);
                logInfo('merge-tag', msg);
              }
            }
          );
          await this.refresh();
        },
      },
      ...pushItems,
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(trash) Delete tag',
        description: metas.length === 1 ? `Delete tag "${tagName}"` : `Delete tag "${tagName}" in all repositories`,
        action: async () => {
          const pick = await vscode.window.showWarningMessage(
            `Delete tag "${tagName}" in ${metas.length} ${metas.length === 1 ? 'repository' : 'repositories'}?`,
            { modal: true }, 'Delete Local', 'Delete on Remote', 'Delete Local and Remote'
          );
          if (!pick) return;
          const deleteLocal = pick !== 'Delete on Remote';
          const deleteRemote = pick === 'Delete on Remote' || pick === 'Delete Local and Remote';
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting tag "${tagName}"…`, cancellable: false },
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
                } catch (e: unknown) {
                  logError(`delete-tag:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
                  errors.push(`${meta.name}: ${formatGitError(e)}`);
                }
              }
              if (errors.length > 0) {
                void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
                  .then(choice => { if (choice === 'Show Log') showLogChannel(); });
              } else {
                const msg = `deleted tag "${tagName}" in ${metas.length} repositories.`;
                vscode.window.showInformationMessage(msg);
                logInfo('delete-tag', msg);
              }
              for (const meta of metas) void this.logPanel?.refreshTagsForRepo(meta.id);
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
    /** Ref to merge/rebase/compare against — the remote ref for remote entries. */
    ref: string = branchName,
    /** Name to show in labels — the full "remote/branch" for remote entries, else same as branchName. */
    displayName: string = branchName,
    isRemote: boolean = false,
    isPrimary: boolean = false,
    /** True when the target repositories aren't all on the same current branch. */
    hasDivergence: boolean = metas.length > 1,
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
        description: metas.length === 1 ? `Switch to ${displayName}` : `Switch all repositories to ${displayName}`,
        action: () => this.checkoutBranchAllRepos(branchName, metas),
      },
      {
        label: `$(add) New branch from '${displayName}'…`,
        description: metas.length === 1 ? '' : 'in all repositories',
        action: () => this.newBranchFrom(branchName, metas),
      },
      {
        label: '$(cloud-download) Update (Pull)',
        description: metas.length === 1 ? `Pull ${displayName}` : `Pull ${displayName} in all repositories`,
        action: () => this.pullBranchAllRepos(branchName, metas),
      },
      {
        label: '$(edit) Rename…',
        description: metas.length === 1 ? '' : 'in all repositories',
        action: () => this.renameBranchAllRepos(branchName, metas),
      },
      {
        label: `$(git-compare) Compare '${displayName}' with…`,
        description: metas.length === 1 ? '' : 'in all repositories',
        action: () => this.compareBranchAllReposWith(branchName, metas),
      },
    ];

    // These act against a single "current branch" ref, which is ambiguous across repositories
    // that aren't all on the same branch — only offer them when every repo agrees on one.
    if (!isCurrent && !hasDivergence) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(git-compare) Compare '${currentBranchName}' with '${ref}'`,
          description: metas.length === 1 ? '' : 'in all repositories',
          action: () => this.compareBranchAllRepos(ref, metas, currentBranchName),
        },
        {
          label: `$(repo-forked) Rebase '${currentBranchName}' onto '${ref}'`,
          description: metas.length === 1 ? '' : 'in all repositories',
          action: () => this.rebaseAllRepos(ref, metas),
        },
        {
          label: `$(git-merge) Merge '${ref}' into '${currentBranchName}'`,
          description: metas.length === 1 ? '' : 'in all repositories',
          action: () => this.mergeBranchAllRepos(ref, metas),
        },
        {
          label: `$(git-merge) Checkout '${ref}' and merge '${currentBranchName}' into it`,
          description: metas.length === 1 ? '' : 'in all repositories',
          action: () => this.checkoutAndMergeBranchAllRepos(ref, currentBranchName, metas),
        },
      );
    }

    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
    );
    // The remote's default branch (e.g. "origin/main") can't be deleted from the remote —
    // don't offer the action at all rather than let it fail.
    if (!(isRemote && isPrimary)) {
      items.push({
        label: '$(trash) Delete…',
        description: metas.length === 1 ? '' : 'in all repositories',
        action: () => this.deleteBranchAllRepos(branchName, metas),
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: displayName,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  async push(): Promise<void> {
    await this.pushMenu(this.manager.getRepoMetas());
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
      vscode.window.showWarningMessage('No remotes configured in any repository.');
      logWarn('push', 'No remotes configured in any repository.');
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
      { location: vscode.ProgressLocation.Notification, title: `Pushing to ${pick.remote}…`, cancellable: false },
      async () => {
        try {
          await repo.push(false, pick.remote);
          const msg = `[${pick.label.replace('$(cloud-upload) ', '')}]: pushed to "${pick.remote}" successfully.`;
          vscode.window.showInformationMessage(msg);
          logInfo('push', msg);
        } catch (e: unknown) {
          showGitError('push', e);
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
        `[${meta.name}]: ${state} aborted successfully.`
      );
      logInfo(`${state}:${meta.name}`, `${state} aborted successfully.`);
    } catch (e: unknown) {
      showGitError(`${state}-abort:${meta.name}`, e);
    }
    await this.refresh();
  }

  async fetchAll(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Fetching all remotes…',
        cancellable: false,
      },
      async () => {
        await this.manager.fetchAll();
      }
    );
    await this.refresh();
    vscode.window.showInformationMessage('Fetch complete.');
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
        title: 'Updating all projects…',
        cancellable: false,
      },
      async () => {
        const results = await this.manager.pullAll(pick.rebase);
        const failed = results.filter(r => !r.ok);
        const ok = results.filter(r => r.ok);
        if (failed.length === 0) {
          const msg = `${ok.length} ${ok.length === 1 ? 'repository' : 'repositories'} updated.`;
          vscode.window.showInformationMessage(msg);
          logInfo('update-project', msg);
        } else {
          const failedDesc = failed.map(r => {
            const name = metaById.get(r.repoId)?.name ?? r.repoId;
            return `${name}: ${r.message}`;
          }).join('; ');
          logWarn('update-project', `${ok.length} updated, ${failed.length} failed.`, failedDesc);
          void vscode.window.showWarningMessage(
            `${ok.length} updated, ${failed.length} failed: ${failedDesc}`,
            'Show Log'
          ).then(choice => { if (choice === 'Show Log') showLogChannel(); });
        }
        await vscode.commands.executeCommand('gitcharm.openLog');
      }
    );
  }

  private async newBranch(metas: RepoMeta[]): Promise<void> {
    // Step 1: branch name
    const branchName = await promptBranchName({
      title: 'New Branch — Name',
      prompt: 'Enter the new branch name',
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

    // Step 3: target repositories
    const repoItems = metas.map(m => ({
      label: `$(root-folder) ${m.name}`,
      description: m.rootPath,
      picked: true,
      repoId: m.id,
    }));
    const pickedRepos = await vscode.window.showQuickPick(repoItems, {
      title: 'New Branch — Repositories',
      placeHolder: 'Select repositories to create the branch in',
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
      { location: vscode.ProgressLocation.Notification, title: `Creating branch "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        const alreadyExisted: string[] = [];
        let succeeded = 0;
        for (const item of pickedRepos) {
          const repo = this.manager.getRepo((item as typeof repoItems[number]).repoId);
          if (!repo) continue;
          try {
            if (doCheckout) {
              await repo.checkout(branchName, true, baseFrom);
            } else {
              await repo.createBranch(branchName, baseFrom);
            }
            succeeded++;
          } catch (e: unknown) {
            if (isBranchAlreadyExistsError(e)) {
              alreadyExisted.push(item.label);
              if (doCheckout) {
                try {
                  await repo.checkout(branchName);
                  succeeded++;
                } catch (e2: unknown) {
                  const { matched, succeeded: recovered } = await handleDirtyCheckout(repo, item.label, branchName, e2, {
                    checkout: () => repo.checkout(branchName),
                    checkoutForce: () => repo.checkoutForce(branchName),
                  });
                  if (recovered) {
                    succeeded++;
                  } else if (!matched) {
                    logError(`new-branch:${item.label}`, formatGitError(e2), getRawErrorDetail(e2));
                    errors.push(`${item.label}: ${formatGitError(e2)}`);
                  }
                }
              } else {
                succeeded++;
              }
            } else if (doCheckout) {
              const { matched, succeeded: recovered } = await handleDirtyCheckout(repo, item.label, branchName, e, {
                checkout: () => repo.checkout(branchName, true, baseFrom),
                checkoutForce: async () => { await repo.createBranch(branchName, baseFrom); await repo.checkoutForce(branchName); },
              });
              if (recovered) {
                succeeded++;
              } else if (!matched) {
                logError(`new-branch:${item.label}`, formatGitError(e), getRawErrorDetail(e));
                errors.push(`${item.label}: ${formatGitError(e)}`);
              }
            } else {
              logError(`new-branch:${item.label}`, formatGitError(e), getRawErrorDetail(e));
              errors.push(`${item.label}: ${formatGitError(e)}`);
            }
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else if (alreadyExisted.length > 0) {
          const msg = `Branch "${branchName}" already existed in ${alreadyExisted.length} ${alreadyExisted.length === 1 ? 'repository' : 'repositories'}${doCheckout ? ' — checked out' : ''}; created in the rest.`;
          vscode.window.showInformationMessage(msg);
          logInfo('new-branch', msg);
        } else if (succeeded > 0) {
          const msg = `Branch "${branchName}" created in ${succeeded} ${succeeded === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(msg);
          logInfo('new-branch', msg);
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
    const primaryRemoteName = remote[0]?.remoteName;
    const actualDefaultBranch = primaryRemoteName ? await repo.getRemoteDefaultBranch(primaryRemoteName) : undefined;
    const effectiveBranchName = currentBranch.detachedTag ?? currentBranch.detachedHash ?? currentBranch.name;
    const isDetached = !!currentBranch.detachedTag || !!currentBranch.detachedHash || currentBranch.name === 'HEAD';

    type BranchItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const items: BranchItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(repo-fetch) Fetch',
        description: 'Fetch all remotes',
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `[${meta.name}]: Fetching…`, cancellable: false },
            async () => { await repo.fetchAll(); }
          );
          await this.refresh();
        },
      },
      {
        label: '$(repo-pull) Pull…',
        description: 'Pull from remote',
        action: async () => {
          const pick = await vscode.window.showQuickPick(
            [
              { label: '$(git-merge) Merge incoming changes', rebase: false },
              { label: '$(repo-forked) Rebase onto incoming changes', rebase: true },
            ],
            { title: `Pull — ${meta.name}` }
          ) as { label: string; rebase: boolean } | undefined;
          if (!pick) return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `[${meta.name}]: Pulling…`, cancellable: false },
            async () => {
              try {
                const msg = pick.rebase ? await repo.pullRebase() : await repo.pull();
                vscode.window.showInformationMessage(`[${meta.name}]: ${msg}`);
                logInfo(`pull:${meta.name}`, `[${meta.name}]: ${msg}`);
              } catch (e: unknown) {
                showGitError(`pull:${meta.name}`, e);
              }
            }
          );
          await this.refresh();
        },
      },
      {
        label: '$(repo-push) Push',
        description: 'Push to remote',
        action: async () => {
          const remotes = await repo.getRemotes().catch(() => [] as string[]);
          if (remotes.length === 0) {
            vscode.window.showWarningMessage(`[${meta.name}]: No remotes configured.`);
            logWarn(`push:${meta.name}`, 'No remotes configured.');
            return;
          }
          let targetRemote = remotes[0];
          if (remotes.length > 1) {
            const picked = await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: `Push ${meta.name} — select remote` }
            ) as { label: string; remote: string } | undefined;
            if (!picked) return;
            targetRemote = picked.remote;
          }
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `[${meta.name}]: Pushing to ${targetRemote}…`, cancellable: false },
            async () => {
              try {
                await repo.push(false, targetRemote);
                const msg = `[${meta.name}]: pushed to "${targetRemote}" successfully.`;
                vscode.window.showInformationMessage(msg);
                logInfo(`push:${meta.name}`, msg);
              } catch (e: unknown) {
                showGitError(`push:${meta.name}`, e);
              }
            }
          );
          await this.refresh();
        },
      },
      {
        label: '$(repo-force-push) Force Push',
        description: 'Force push to remote',
        action: async () => {
          const confirm = await vscode.window.showWarningMessage(
            `Force push ${meta.name}? This will overwrite remote history.`,
            { modal: true }, 'Force Push'
          );
          if (confirm !== 'Force Push') return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `[${meta.name}]: Force pushing…`, cancellable: false },
            async () => {
              try {
                await repo.push(true);
                const msg = `[${meta.name}]: force pushed successfully.`;
                vscode.window.showInformationMessage(msg);
                logInfo(`force-push:${meta.name}`, msg);
              } catch (e: unknown) {
                showGitError(`force-push:${meta.name}`, e);
              }
            }
          );
          await this.refresh();
        },
      },
      {
        label: '$(sync) Sync…',
        description: 'Pull then push',
        action: async () => {
          const pick = await vscode.window.showQuickPick(
            [
              { label: '$(git-merge) Merge incoming changes', rebase: false },
              { label: '$(repo-forked) Rebase onto incoming changes', rebase: true },
            ],
            { title: `Sync — ${meta.name}` }
          ) as { label: string; rebase: boolean } | undefined;
          if (!pick) return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `[${meta.name}]: Syncing…`, cancellable: false },
            async () => {
              try {
                const msg = pick.rebase ? await repo.pullRebase() : await repo.pull();
                vscode.window.showInformationMessage(`[${meta.name}]: Pull — ${msg}`);
                logInfo(`sync-pull:${meta.name}`, `[${meta.name}]: Pull — ${msg}`);
              } catch (e: unknown) {
                showGitError(`sync-pull:${meta.name}`, e);
                await this.refresh();
                return;
              }
              try {
                await repo.push();
                const msg = `[${meta.name}]: synced successfully.`;
                vscode.window.showInformationMessage(msg);
                logInfo(`sync-push:${meta.name}`, msg);
              } catch (e: unknown) {
                showGitError(`sync-push:${meta.name}`, e);
              }
            }
          );
          await this.refresh();
        },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(add) New Branch…',
        description: `Create a new branch`,
        action: () => this.newBranchSingleRepo(meta),
      },
      {
        label: '$(tag) New Tag…',
        description: `Create a new tag on HEAD`,
        action: () => this.newTagSingleRepo(meta),
      },
      {
        label: '$(git-commit) Checkout detached…',
        description: 'Checkout a branch without attaching HEAD',
        action: () => this.checkoutDetachedSingleRepo(meta),
      },
      {
        label: '$(remote-explorer) Manage Remotes…',
        description: 'Add, remove, or edit remotes',
        action: () => this.showRepoRemotesMenu(meta),
      },
      { label: 'LOCAL', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...local.map(b => {
        const primary = isPrimaryBranch(b.name, actualDefaultBranch);
        const icon = b.isHead ? '$(check)' : primary ? '$(star)' : '$(git-branch)';
        const remoteNames = new Set(remote.map(r => r.name.replace(/^[^/]+\//, '')));
        const hasRemote = b.isHead ? !!currentBranch.upstream : remoteNames.has(b.name);
        const hasUnpushed = !hasRemote || (b.aheadBehind?.ahead ?? 0) > 0;
        const aheadBehindLabel = b.aheadBehind ? `↑${b.aheadBehind.ahead} ↓${b.aheadBehind.behind}` : '';
        return {
          label: `${icon} ${b.name}`,
          description: [aheadBehindLabel, b.lastCommitDateRelative].filter(Boolean).join('  '),
          detail: formatCommitDetail(b),
          action: () => this.showSingleBranchActionMenu(b.name, meta, b.isHead, false, hasUnpushed, effectiveBranchName, primary),
        };
      }),
      { label: 'REMOTE', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...remote.map(b => {
        const primary = isPrimaryBranch(b.name, actualDefaultBranch);
        const icon = primary ? '$(star)' : '$(cloud)';
        return {
          label: `${icon} ${b.name}`,
          description: b.lastCommitDateRelative ?? '',
          detail: formatCommitDetail(b),
          action: () => this.showSingleBranchActionMenu(b.name, meta, false, true, false, effectiveBranchName, primary),
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
          description: [isActiveTag ? 'current' : undefined, tag.dateRelative].filter(Boolean).join('  '),
          detail: [tag.author, tag.hash, tag.message].filter(Boolean).join('  •  '),
          action: () => this.showSingleTagActionMenu(tag.name, meta, effectiveBranchName, isDetached),
        });
      }
    }

    if (meta.isSubmodule) {
      items.push({ label: 'SUBMODULE', kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      items.push({
        label: '$(repo-sync) Update',
        description: `git submodule update ${meta.submodulePath ?? ''}`,
        action: () => vscode.commands.executeCommand('gitcharm.submodule.update', meta.id),
      });
      items.push({
        label: '$(repo-sync) Update (recursive)',
        description: 'git submodule update --init --recursive',
        action: () => vscode.commands.executeCommand('gitcharm.submodule.updateRecursive', meta.id),
      });
      items.push({
        label: '$(add) Init',
        description: 'Initialize this submodule',
        action: () => vscode.commands.executeCommand('gitcharm.submodule.init', meta.id),
      });
      items.push({
        label: '$(trash) Deinit',
        description: 'Deinitialize this submodule',
        action: () => vscode.commands.executeCommand('gitcharm.submodule.deinit', meta.id),
      });
      items.push({
        label: '$(link-external) Open in New Window',
        description: 'Open submodule folder in a separate VS Code window',
        action: () => vscode.commands.executeCommand('gitcharm.submodule.openInNewWindow', meta.id),
      });
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
          { location: vscode.ProgressLocation.Notification, title: `Pushing tag "${tagName}" to ${r}…`, cancellable: false },
          async () => {
            try {
              await repo.pushTag(tagName, r);
              const msg = `[${meta.name}]: tag "${tagName}" pushed to "${r}".`;
              vscode.window.showInformationMessage(msg);
              logInfo(`push-tag:${meta.name}`, msg);
            } catch (e: unknown) {
              showGitError(`push-tag:${meta.name}`, e);
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
          const msg = `[${meta.name}]: merged tag "${tagName}".`;
          vscode.window.showInformationMessage(msg);
          logInfo(`merge-tag:${meta.name}`, msg);
        } catch (e: unknown) {
          showGitError(`merge-tag:${meta.name}`, e);
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
            const msg = `[${meta.name}]: checked out tag "${tagName}" (detached HEAD).`;
            vscode.window.showInformationMessage(msg);
            logInfo(`checkout-tag:${meta.name}`, msg);
          } catch (e: unknown) {
            showGitError(`checkout-tag:${meta.name}`, e);
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
                vscode.window.showWarningMessage(`[${meta.name}]: no remotes configured.`);
                logWarn(`delete-tag:${meta.name}`, 'No remotes configured.');
              } else {
                const remote = remotes.length === 1
                  ? remotes[0]
                  : (await vscode.window.showQuickPick(remotes, { title: `Delete "${tagName}" from remote` }));
                if (remote) await repo.deleteTagRemote(tagName, remote);
              }
            }
            const msg = `[${meta.name}]: tag "${tagName}" deleted.`;
            vscode.window.showInformationMessage(msg);
            logInfo(`delete-tag:${meta.name}`, msg);
            void this.logPanel?.refreshTagsForRepo(meta.id);
          } catch (e: unknown) {
            showGitError(`delete-tag:${meta.name}`, e);
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
    isPrimary: boolean = false,
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
      {
        label: `$(git-compare) Compare '${branchName}' with…`,
        action: () => this.compareSingleRepoWith(branchName, meta),
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
          action: () => this.compareSingleRepo(branchName, meta, currentBranchName),
        },
        {
          label: `$(repo-forked) Rebase '${currentBranchName}' onto '${branchName}'`,
          action: () => this.rebaseSingleRepo(branchName, meta),
        },
        {
          label: `$(git-merge) Merge '${branchName}' into '${currentBranchName}'`,
          action: () => this.mergeSingleRepo(branchName, meta),
        },
        {
          label: `$(git-merge) Checkout '${branchName}' and merge '${currentBranchName}' into it`,
          action: () => this.checkoutAndMergeSingleRepo(branchName, currentBranchName, meta),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      );
      // The remote's default branch (e.g. "origin/main") can't be deleted from the remote —
      // don't offer the action at all rather than let it fail. Deleting a local branch that
      // happens to share the primary name is still fine, since it doesn't touch the remote.
      if (!(isRemote && isPrimary)) {
        items.push({
          label: '$(trash) Delete…',
          action: () => this.deleteSingleRepo(branchName, meta),
        });
      }
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

    const branchName = await promptBranchName({
      title: `New Branch in ${meta.name}`,
      prompt: 'Enter the new branch name',
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
      const msg = `[${meta.name}]: branch "${branchName}" ${checkoutPick.value ? 'created and checked out' : 'created'}.`;
      vscode.window.showInformationMessage(msg);
      logInfo(`new-branch:${meta.name}`, msg);
    } catch (e: unknown) {
      if (isBranchAlreadyExistsError(e)) {
        if (checkoutPick.value) {
          try {
            await repo.checkout(branchName);
            const msg = `[${meta.name}]: branch "${branchName}" already exists — checked out.`;
            vscode.window.showInformationMessage(msg);
            logInfo(`new-branch:${meta.name}`, msg);
          } catch (e2: unknown) {
            const { matched } = await handleDirtyCheckout(repo, meta.name, branchName, e2, {
              checkout: () => repo.checkout(branchName),
              checkoutForce: () => repo.checkoutForce(branchName),
            });
            if (!matched) showGitError(`new-branch:${meta.name}`, e2);
          }
        } else {
          vscode.window.showInformationMessage(`[${meta.name}]: branch "${branchName}" already exists.`);
        }
      } else if (checkoutPick.value) {
        const { matched } = await handleDirtyCheckout(repo, meta.name, branchName, e, {
          checkout: () => repo.checkout(branchName, true, baseFrom),
          checkoutForce: async () => { await repo.createBranch(branchName, baseFrom); await repo.checkoutForce(branchName); },
        });
        if (!matched) showGitError(`new-branch:${meta.name}`, e);
      } else {
        showGitError(`new-branch:${meta.name}`, e);
      }
    }
    await this.refresh();
  }

  private async newTagSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const tagName = await vscode.window.showInputBox({
      title: `New Tag in ${meta.name}`,
      prompt: 'Enter the tag name (will be created on HEAD)',
      placeHolder: 'v1.0.0',
      validateInput: v => v.trim() ? undefined : 'Tag name cannot be empty',
    });
    if (!tagName) return;
    try {
      await repo.createTag(tagName.trim(), 'HEAD');
      void this.logPanel?.refreshTagsForRepo(meta.id);
      const createdMsg = `[${meta.name}]: tag "${tagName.trim()}" created on HEAD.`;
      logInfo(`new-tag:${meta.name}`, createdMsg);
      vscode.window.showInformationMessage(
        createdMsg,
        'Push'
      ).then(async pick => {
        if (pick !== 'Push') return;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) {
          vscode.window.showWarningMessage('No remotes configured.');
          logWarn(`push-tag:${meta.name}`, 'No remotes configured.');
          return;
        }
        const remote = remotes.length === 1
          ? remotes[0]
          : (await vscode.window.showQuickPick(remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })), { title: `Push tag "${tagName.trim()}" — Select remote` }) as { label: string; remote: string } | undefined)?.remote;
        if (!remote) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pushing tag "${tagName.trim()}" to ${remote}…`, cancellable: false },
          async () => {
            try {
              await repo.pushTag(tagName.trim(), remote);
              const msg = `Tag "${tagName.trim()}" pushed to "${remote}".`;
              vscode.window.showInformationMessage(msg);
              logInfo(`push-tag:${meta.name}`, msg);
            } catch (e: unknown) {
              showGitError(`push-tag:${meta.name}`, e);
            }
          }
        );
      });
    } catch (e: unknown) {
      showGitError(`new-tag:${meta.name}`, e);
    }
  }

  private async newTagAllRepos(metas: RepoMeta[]): Promise<void> {
    if (metas.length === 1) { await this.newTagSingleRepo(metas[0]!); return; }
    const tagName = await vscode.window.showInputBox({
      title: 'New Tag',
      prompt: 'Enter the tag name (will be created on HEAD of each repository)',
      placeHolder: 'v1.0.0',
      validateInput: v => v.trim() ? undefined : 'Tag name cannot be empty',
    });
    if (!tagName) return;
    const trimmed = tagName.trim();
    const errors: string[] = [];
    for (const meta of metas) {
      const repo = this.manager.getRepo(meta.id);
      if (!repo) continue;
      try {
        await repo.createTag(trimmed, 'HEAD');
        void this.logPanel?.refreshTagsForRepo(meta.id);
      } catch (e: unknown) {
        logError(`new-tag:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
        errors.push(`${meta.name}: ${formatGitError(e)}`);
      }
    }
    if (errors.length > 0) {
      void vscode.window.showWarningMessage(`Some tags failed:\n${errors.join('\n')}`, 'Show Log')
        .then(choice => { if (choice === 'Show Log') showLogChannel(); });
      return;
    }
    const createdMsg = `Tag "${trimmed}" created on HEAD in all repositories.`;
    logInfo('new-tag', createdMsg);
    vscode.window.showInformationMessage(createdMsg, 'Push').then(async pick => {
      if (pick !== 'Push') return;
      const repoWithRemotes = await Promise.all(metas.map(async meta => {
        const repo = this.manager.getRepo(meta.id);
        const remotes = repo ? await repo.getRemotes().catch(() => [] as string[]) : [];
        return { meta, repo, remotes };
      }));
      const allRemotes = [...new Set(repoWithRemotes.flatMap(r => r.remotes))];
      if (allRemotes.length === 0) {
        vscode.window.showWarningMessage('No remotes configured.');
        logWarn('push-tag', 'No remotes configured.');
        return;
      }
      const remote = allRemotes.length === 1
        ? allRemotes[0]!
        : (await vscode.window.showQuickPick(allRemotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })), { title: `Push tag "${trimmed}" — Select remote` }) as { label: string; remote: string } | undefined)?.remote;
      if (!remote) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pushing tag "${trimmed}" to ${remote}…`, cancellable: false },
        async () => {
          const pushErrors: string[] = [];
          for (const { meta, repo: r } of repoWithRemotes) {
            if (!r) continue;
            try { await r.pushTag(trimmed, remote); } catch (e: unknown) {
              logError(`push-tag:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
              pushErrors.push(`${meta.name}: ${formatGitError(e)}`);
            }
          }
          if (pushErrors.length > 0) {
            void vscode.window.showWarningMessage(`Some pushes failed:\n${pushErrors.join('\n')}`, 'Show Log')
              .then(choice => { if (choice === 'Show Log') showLogChannel(); });
          } else {
            const msg = `Tag "${trimmed}" pushed to "${remote}" in all repositories.`;
            vscode.window.showInformationMessage(msg);
            logInfo('push-tag', msg);
          }
        }
      );
    });
  }

  private async checkoutSingleRepo(branchName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.checkout(branchName);
      const msg = `[${meta.name}]: switched to "${branchName}"`;
      vscode.window.showInformationMessage(msg);
      logInfo(`checkout:${meta.name}`, msg);
    } catch (e: unknown) {
      const { matched } = await handleDirtyCheckout(repo, meta.name, branchName, e);
      if (!matched) showGitError(`checkout:${meta.name}`, e);
    }
    await this.refresh();
  }

  private async checkoutDetachedSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const branches = await repo.getBranches();
    type BranchPick = vscode.QuickPickItem & { ref: string };
    const local = branches.filter(b => !b.isRemote);
    const remote = branches.filter(b => b.isRemote);

    const items: BranchPick[] = [
      { label: 'LOCAL', kind: vscode.QuickPickItemKind.Separator, ref: '' },
      ...local.map(b => ({
        label: `${b.isHead ? '$(check)' : '$(git-branch)'} ${b.name}`,
        description: [b.isHead ? 'current' : undefined, b.lastCommitDateRelative].filter(Boolean).join('  '),
        detail: formatCommitDetail(b),
        ref: b.name,
      })),
      { label: 'REMOTE', kind: vscode.QuickPickItemKind.Separator, ref: '' },
      ...remote.map(b => ({
        label: `$(cloud) ${b.name}`,
        description: b.lastCommitDateRelative ?? '',
        detail: formatCommitDetail(b),
        ref: b.name,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: `Checkout detached — ${meta.name}`,
      placeHolder: 'Select a branch to checkout in detached HEAD mode',
      matchOnDescription: true,
    });
    if (!picked?.ref) return;

    try {
      await repo.checkoutDetached(picked.ref);
      const msg = `[${meta.name}]: checked out "${picked.ref}" (detached HEAD).`;
      vscode.window.showInformationMessage(msg);
      logInfo(`checkout-detached:${meta.name}`, msg);
    } catch (e: unknown) {
      const { matched } = await handleDirtyCheckout(repo, meta.name, picked.ref, e, {
        checkout: () => repo.checkoutDetached(picked.ref),
        checkoutForce: () => repo.checkoutDetachedForce(picked.ref),
      });
      if (!matched) showGitError(`checkout-detached:${meta.name}`, e);
    }
    await this.refresh();
  }

  private async checkoutBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    // Find which repositories have this branch
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
      // A remote match without a resolved fullName can't be checked out safely — the short
      // name alone is ambiguous (see GitService.checkout's remote-vs-local-slash handling).
      .filter(r => r.hasBranch && (!r.isRemote || !!r.fullName));

    if (candidates.length === 0) {
      vscode.window.showWarningMessage(`Branch "${branchName}" not found in any repository.`);
      logWarn('checkout', `Branch "${branchName}" not found in any repository.`);
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking out "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        let succeeded = 0;
        for (const { meta, fullName } of candidates) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.checkout(fullName ?? branchName);
            succeeded++;
          } catch (e: unknown) {
            const { matched, succeeded: recovered } = await handleDirtyCheckout(repo, meta.name, fullName ?? branchName, e);
            if (recovered) {
              succeeded++;
            } else if (!matched) {
              logError(`checkout:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
              errors.push(`${meta.name}: ${formatGitError(e)}`);
            }
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else if (succeeded > 0) {
          const msg = `Checked out "${branchName}" in ${succeeded} ${succeeded === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(msg);
          logInfo('checkout', msg);
        }
      }
    );
    await this.refresh();
  }

  // ── Single-repo branch actions ──────────────────────────────────────────

  private async newBranchFromSingleRepo(fromBranch: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const branchName = await promptBranchName({
      title: `New Branch from '${fromBranch}' in ${meta.name}`,
      prompt: 'Enter the new branch name',
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
      const msg = `[${meta.name}]: branch "${branchName}" ${checkoutPick.value ? 'created and checked out' : 'created'}.`;
      vscode.window.showInformationMessage(msg);
      logInfo(`new-branch:${meta.name}`, msg);
    } catch (e: unknown) {
      if (isBranchAlreadyExistsError(e)) {
        if (checkoutPick.value) {
          try {
            await repo.checkout(branchName);
            const msg = `[${meta.name}]: branch "${branchName}" already exists — checked out.`;
            vscode.window.showInformationMessage(msg);
            logInfo(`new-branch:${meta.name}`, msg);
          } catch (e2: unknown) {
            const { matched } = await handleDirtyCheckout(repo, meta.name, branchName, e2, {
              checkout: () => repo.checkout(branchName),
              checkoutForce: () => repo.checkoutForce(branchName),
            });
            if (!matched) showGitError(`new-branch:${meta.name}`, e2);
          }
        } else {
          vscode.window.showInformationMessage(`[${meta.name}]: branch "${branchName}" already exists.`);
        }
      } else if (checkoutPick.value) {
        const { matched } = await handleDirtyCheckout(repo, meta.name, branchName, e, {
          checkout: () => repo.checkout(branchName, true, fromBranch),
          checkoutForce: async () => { await repo.createBranch(branchName, fromBranch); await repo.checkoutForce(branchName); },
        });
        if (!matched) showGitError(`new-branch:${meta.name}`, e);
      } else {
        showGitError(`new-branch:${meta.name}`, e);
      }
    }
    await this.refresh();
  }

  private async pullSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `[${meta.name}]: Pulling…`, cancellable: false },
      async () => {
        try {
          await repo.pull();
          const msg = `[${meta.name}]: pulled successfully.`;
          vscode.window.showInformationMessage(msg);
          logInfo(`pull:${meta.name}`, msg);
        } catch (e: unknown) {
          showGitError(`pull:${meta.name}`, e);
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

    const oldUpstream = await repo.getBranchUpstream(oldName).catch(() => null);
    try {
      await repo.renameBranch(oldName, newName);
      const msg = `[${meta.name}]: renamed "${oldName}" → "${newName}".`;
      vscode.window.showInformationMessage(msg);
      logInfo(`rename-branch:${meta.name}`, msg);
      await offerRenameBranchRemoteSync(repo, meta.name, oldUpstream, newName);
    } catch (e: unknown) {
      showGitError(`rename-branch:${meta.name}`, e);
    }
    await this.refresh();
  }

  private async pushSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.push();
      const msg = `[${meta.name}]: pushed successfully.`;
      vscode.window.showInformationMessage(msg);
      logInfo(`push:${meta.name}`, msg);
    } catch (e: unknown) {
      showGitError(`push:${meta.name}`, e);
    }
    await this.refresh();
  }

  private async compareSingleRepo(
    branchName: string,
    meta: RepoMeta,
    currentBranchName: string,
    baseRef: string = 'HEAD',
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    let branchHash: string;
    let headHash: string;
    try {
      [branchHash, headHash] = await Promise.all([
        repo.resolveRef(branchName),
        repo.resolveRef(baseRef),
      ]);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Cannot resolve refs for comparison in "${meta.name}".`);
      logError(`compare:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
      return;
    }
    const files = await repo.getCombinedFiles([branchHash, headHash]);
    if (files.length === 0) {
      vscode.window.showInformationMessage(`[${meta.name}]: No differences between '${currentBranchName}' and '${branchName}'.`);
      return;
    }
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const rootPath = repo.rootPath;
    const gitUri = (ref: string, filePath: string): vscode.Uri => {
      const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
      return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
    };
    const resources = files
      .filter(f => f.status !== 'U')
      .map(f => {
        const label = vscode.Uri.file(path.join(rootPath, f.path));
        const original = gitUri(f.status === 'A' ? EMPTY_TREE : branchHash, f.path);
        const modified = gitUri(f.status === 'D' ? EMPTY_TREE : headHash, f.path);
        return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
      });
    await vscode.commands.executeCommand('vscode.changes', `${currentBranchName} vs ${branchName} [${meta.name}]`, resources);
  }

  private async compareSingleRepoWith(branchName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const otherRef = await pickRefQuickPick(repo, {
      title: `Compare '${branchName}' with…`,
      placeHolder: 'Select a branch or tag to compare against',
    });
    if (!otherRef || otherRef === branchName) return;
    await this.compareSingleRepo(branchName, meta, otherRef, otherRef);
  }

  private async rebaseSingleRepo(onto: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.rebase(onto);
      const msg = `[${meta.name}]: rebased onto "${onto}".`;
      vscode.window.showInformationMessage(msg);
      logInfo(`rebase:${meta.name}`, msg);
    } catch (e: unknown) {
      showGitError(`rebase:${meta.name}`, e);
    }
    await this.refresh();
  }

  private async mergeSingleRepo(from: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      const { upToDate } = await repo.merge(from);
      const msg = upToDate
        ? `[${meta.name}]: "${from}" is already up to date — nothing to merge.`
        : `[${meta.name}]: merged "${from}".`;
      vscode.window.showInformationMessage(msg);
      logInfo(`merge:${meta.name}`, msg);
    } catch (e: unknown) {
      showGitError(`merge:${meta.name}`, e);
    }
    await this.refresh();
  }

  private async checkoutAndMergeSingleRepo(targetBranch: string, sourceBranch: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.checkout(targetBranch);
    } catch (e: unknown) {
      const { matched, succeeded } = await handleDirtyCheckout(repo, meta.name, targetBranch, e);
      if (!matched) { showGitError(`checkout:${meta.name}`, e); await this.refresh(); return; }
      if (!succeeded) { await this.refresh(); return; }
    }
    try {
      const { upToDate } = await repo.merge(sourceBranch);
      const msg = upToDate
        ? `[${meta.name}]: checked out "${targetBranch}" — "${sourceBranch}" is already up to date, nothing to merge.`
        : `[${meta.name}]: checked out "${targetBranch}" and merged "${sourceBranch}" into it.`;
      vscode.window.showInformationMessage(msg);
      logInfo(`checkout-and-merge:${meta.name}`, msg);
    } catch (e: unknown) {
      showGitError(`checkout-and-merge:${meta.name}`, e);
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
      const msg = `[${meta.name}]: deleted "${branchName}".`;
      vscode.window.showInformationMessage(msg);
      logInfo(`delete-branch:${meta.name}`, msg);
    } catch (e: unknown) {
      showGitError(`delete-branch:${meta.name}`, e);
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
      const msg = `[${meta.name}]: pulled "${remoteBranch}" using ${useRebase ? 'rebase' : 'merge'}.`;
      vscode.window.showInformationMessage(msg);
      logInfo(`pull:${meta.name}`, msg);
    } catch (e: unknown) {
      showGitError(`pull:${meta.name}`, e);
    }
    await this.refresh();
  }

  // ── Multi-repo branch actions ────────────────────────────────────────────

  private async newBranchFrom(fromBranch: string, metas: RepoMeta[]): Promise<void> {
    const branchName = await promptBranchName({
      title: `New Branch from '${fromBranch}'`,
      prompt: 'Enter the new branch name',
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
      { location: vscode.ProgressLocation.Notification, title: `Creating branch "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        const alreadyExisted: string[] = [];
        let succeeded = 0;
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            if (checkoutPick.value) {
              await repo.checkout(branchName, true, fromBranch);
            } else {
              await repo.createBranch(branchName, fromBranch);
            }
            succeeded++;
          } catch (e: unknown) {
            if (isBranchAlreadyExistsError(e)) {
              alreadyExisted.push(meta.name);
              if (checkoutPick.value) {
                try {
                  await repo.checkout(branchName);
                  succeeded++;
                } catch (e2: unknown) {
                  const { matched, succeeded: recovered } = await handleDirtyCheckout(repo, meta.name, branchName, e2, {
                    checkout: () => repo.checkout(branchName),
                    checkoutForce: () => repo.checkoutForce(branchName),
                  });
                  if (recovered) {
                    succeeded++;
                  } else if (!matched) {
                    logError(`new-branch:${meta.name}`, formatGitError(e2), getRawErrorDetail(e2));
                    errors.push(`${meta.name}: ${formatGitError(e2)}`);
                  }
                }
              } else {
                succeeded++;
              }
            } else if (checkoutPick.value) {
              const { matched, succeeded: recovered } = await handleDirtyCheckout(repo, meta.name, branchName, e, {
                checkout: () => repo.checkout(branchName, true, fromBranch),
                checkoutForce: async () => { await repo.createBranch(branchName, fromBranch); await repo.checkoutForce(branchName); },
              });
              if (recovered) {
                succeeded++;
              } else if (!matched) {
                logError(`new-branch:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
                errors.push(`${meta.name}: ${formatGitError(e)}`);
              }
            } else {
              logError(`new-branch:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
              errors.push(`${meta.name}: ${formatGitError(e)}`);
            }
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else if (alreadyExisted.length > 0) {
          const msg = `Branch "${branchName}" already existed in ${alreadyExisted.length} ${alreadyExisted.length === 1 ? 'repository' : 'repositories'}${checkoutPick.value ? ' — checked out' : ''}; created in the rest.`;
          vscode.window.showInformationMessage(msg);
          logInfo('new-branch', msg);
        } else if (succeeded > 0) {
          const msg = `Branch "${branchName}" created in ${succeeded} ${succeeded === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(msg);
          logInfo('new-branch', msg);
        }
      }
    );
    await this.refresh();
  }

  private async pullBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pulling "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.pull();
          } catch (e: unknown) {
            logError(`pull:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta.name}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else {
          const msg = `Pulled in ${metas.length} repositories.`;
          vscode.window.showInformationMessage(msg);
          logInfo('pull', msg);
        }
      }
    );
    await this.refresh();
  }

  private async renameBranchAllRepos(oldName: string, metas: RepoMeta[]): Promise<void> {
    const newName = await vscode.window.showInputBox({
      title: metas.length === 1 ? `Rename branch '${oldName}'` : `Rename branch '${oldName}' in all repositories`,
      value: oldName,
      validateInput: v => (v.trim() ? undefined : 'Branch name cannot be empty'),
    });
    if (!newName || newName === oldName) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Renaming "${oldName}" → "${newName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        const renamed: Array<{ repo: GitService; label: string; oldUpstream: { remote: string; branchName: string } | null }> = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          const oldUpstream = await repo.getBranchUpstream(oldName).catch(() => null);
          try {
            await repo.renameBranch(oldName, newName);
            renamed.push({ repo, label: meta.name, oldUpstream });
          } catch (e: unknown) {
            logError(`rename-branch:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta.name}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else {
          const msg = `Renamed "${oldName}" → "${newName}" in ${metas.length} repositories.`;
          vscode.window.showInformationMessage(msg);
          logInfo('rename-branch', msg);
        }
        for (const { repo, label, oldUpstream } of renamed) {
          await offerRenameBranchRemoteSync(repo, label, oldUpstream, newName);
        }
      }
    );
    await this.refresh();
  }

  private async compareBranchAllRepos(branchName: string, metas: RepoMeta[], currentBranchName: string): Promise<void> {
    for (const meta of metas) {
      await this.compareSingleRepo(branchName, meta, currentBranchName);
    }
  }

  private async compareBranchAllReposWith(branchName: string, metas: RepoMeta[]): Promise<void> {
    if (metas.length === 1) { await this.compareSingleRepoWith(branchName, metas[0]!); return; }

    const firstRepo = metas.map(m => this.manager.getRepo(m.id)).find((r): r is GitService => !!r);
    if (!firstRepo) return;
    const otherRef = await pickRefQuickPick(firstRepo, {
      title: `Compare '${branchName}' with…`,
      placeHolder: 'Select a branch or tag to compare against',
    });
    if (!otherRef || otherRef === branchName) return;
    for (const meta of metas) {
      await this.compareSingleRepo(branchName, meta, otherRef, otherRef);
    }
  }

  private async checkoutAndMergeBranchAllRepos(branchName: string, currentBranchName: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking out "${branchName}" and merging "${currentBranchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        let succeeded = 0;
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.checkout(branchName);
          } catch (e: unknown) {
            const { matched, succeeded: recovered } = await handleDirtyCheckout(repo, meta.name, branchName, e);
            if (!recovered) {
              if (!matched) {
                logError(`checkout-and-merge:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
                errors.push(`${meta.name}: ${formatGitError(e)}`);
              }
              continue;
            }
          }
          try {
            await repo.merge(currentBranchName);
            succeeded++;
          } catch (e: unknown) {
            logError(`checkout-and-merge:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta.name}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else if (succeeded > 0) {
          const msg = `Checked out "${branchName}" and merged "${currentBranchName}" in ${succeeded} ${succeeded === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(msg);
          logInfo('checkout-and-merge', msg);
        }
      }
    );
    await this.refresh();
  }

  private async rebaseAllRepos(onto: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rebasing onto "${onto}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.rebase(onto);
          } catch (e: unknown) {
            logError(`rebase:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta.name}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else {
          const msg = `Rebased onto "${onto}" in ${metas.length} repositories.`;
          vscode.window.showInformationMessage(msg);
          logInfo('rebase', msg);
        }
      }
    );
    await this.refresh();
  }

  private async mergeBranchAllRepos(from: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Merging "${from}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        let merged = 0;
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            if (!(await repo.merge(from)).upToDate) merged++;
          } catch (e: unknown) {
            const errMsg = formatGitError(e);
            const isDirty = errMsg.includes('Your local changes') || errMsg.includes('overwritten by merge') || (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree';
            if (isDirty) {
              const pick = await vscode.window.showQuickPick(
                [
                  { label: '$(archive) Stash and merge', detail: 'Save local changes to stash, then merge', value: 'stash' },
                  { label: '$(close) Cancel', detail: '', value: 'cancel' },
                ],
                {
                  title: `[${meta.name}]: Uncommitted changes`,
                  placeHolder: `Local changes would be overwritten by merging "${from}"`,
                  ignoreFocusOut: true,
                }
              );
              if (pick?.value === 'stash') {
                try {
                  await repo.stashPush(`WIP before merge of ${from}`);
                  if (!(await repo.merge(from)).upToDate) merged++;
                } catch (e2: unknown) {
                  logError(`merge:${meta.name}`, formatGitError(e2), getRawErrorDetail(e2));
                  errors.push(`${meta.name}: ${String(e2)}`);
                }
              }
            } else {
              logError(`merge:${meta.name}`, errMsg, getRawErrorDetail(e));
              errors.push(`${meta.name}: ${errMsg}`);
            }
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else {
          const msg = merged === 0
            ? `"${from}" is already up to date — nothing to merge.`
            : `Merged "${from}" in ${merged} ${merged === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(msg);
          logInfo('merge', msg);
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
      { title: metas.length === 1 ? `Delete branch '${branchName}'?` : `Delete branch '${branchName}' in all repositories?` }
    ) as { label: string; value: string } | undefined;
    if (!confirm) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Deleting "${branchName}"…`, cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.deleteBranch(branchName, confirm.value === 'force');
          } catch (e: unknown) {
            logError(`delete-branch:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
            errors.push(`${meta.name}: ${formatGitError(e)}`);
          }
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(`${errors.length} error(s): ${errors.join('; ')}`, 'Show Log')
            .then(choice => { if (choice === 'Show Log') showLogChannel(); });
        } else {
          const msg = `Deleted "${branchName}" in ${metas.length} repositories.`;
          vscode.window.showInformationMessage(msg);
          logInfo('delete-branch', msg);
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

  async showRepoRemotesMenu(meta: RepoMeta): Promise<void> {
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
      vscode.window.showInformationMessage(`[${meta.name}]: remote "${name}" added.`);
    } catch (e: unknown) {
      showGitError(`add-remote:${meta.name}`, e);
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
      vscode.window.showInformationMessage(`[${meta.name}]: remote renamed "${remote.name}" → "${newName}".`);
    } catch (e: unknown) {
      showGitError(`rename-remote:${meta.name}`, e);
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
      vscode.window.showInformationMessage(`[${meta.name}]: URL of "${remote.name}" updated.`);
    } catch (e: unknown) {
      showGitError(`change-remote-url:${meta.name}`, e);
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
      vscode.window.showInformationMessage(`[${meta.name}]: remote "${remote.name}" removed.`);
    } catch (e: unknown) {
      showGitError(`remove-remote:${meta.name}`, e);
    }
    await this.showRepoRemotesMenu(meta);
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.statusDisposable?.dispose();
    this.branchDisposable?.dispose();
    this.configDisposable?.dispose();
  }
}
