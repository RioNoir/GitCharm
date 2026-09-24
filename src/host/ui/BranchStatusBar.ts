import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import type { RepoMeta, BranchInfo } from '../types/git';
import { isPrimaryBranch } from '../utils/branchUtils';
import type { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { formatGitError, showGitError, getRawErrorDetail, isBranchAlreadyExistsError } from '../utils/gitErrorUtils';
import { logInfo, logWarn, logError, notifyWithLogAction } from '../utils/Logger';
import { plural } from '../utils/plural';
import { offerRenameBranchRemoteSync } from '../utils/renameBranchRemoteSync';
import { handleDirtyCheckout } from '../utils/dirtyCheckoutHandler';
import { promptBranchName } from '../utils/branchNamePrompt';
import { pickRefQuickPick } from '../utils/refPicker';

/** Whether the "gitcharm.showLastCommitInBranchMenu" setting is enabled (off by default). */
function showLastCommitInBranchMenu(): boolean {
  return vscode.workspace.getConfiguration('gitcharm').get<boolean>('showLastCommitInBranchMenu') === true;
}

/** Formats a branch's last commit as "hash  •  author  •  message" for a QuickPick detail line. */
function formatCommitDetail(b: BranchInfo | undefined): string | undefined {
  if (!showLastCommitInBranchMenu() || !b) return undefined;
  const parts = [b.lastCommitHash?.slice(0, 8), b.lastCommitAuthor, b.lastCommitMessage].filter(Boolean);
  return parts.length > 0 ? parts.join('  •  ') : undefined;
}

/** Returns the branch's relative last-commit date, or '' when the setting is disabled. */
function lastCommitDateLabel(b: BranchInfo | undefined): string {
  return showLastCommitInBranchMenu() ? (b?.lastCommitDateRelative ?? '') : '';
}

/** "N error(s): a; b" summary for a multi-repo operation's failures. */
function errorSummary(errors: string[]): string {
  const joined = errors.join('; ');
  return plural(errors.length, vscode.l10n.t('1 error: {0}', joined), vscode.l10n.t('{0} errors: {1}', errors.length, joined));
}

/** Badge shown in a quick-pick item's description for the checked-out branch/tag. */
function currentBadge(): string {
  return vscode.l10n.t({ message: 'current', comment: ['Badge marking the currently checked-out branch or tag in a list'] });
}

function branchAlreadyExistedMessage(branchName: string, count: number, checkedOut: boolean): string {
  return checkedOut
    ? plural(count,
      vscode.l10n.t('Branch "{0}" already existed in 1 repository — checked out; created in the rest.', branchName),
      vscode.l10n.t('Branch "{0}" already existed in {1} repositories — checked out; created in the rest.', branchName, count))
    : plural(count,
      vscode.l10n.t('Branch "{0}" already existed in 1 repository; created in the rest.', branchName),
      vscode.l10n.t('Branch "{0}" already existed in {1} repositories; created in the rest.', branchName, count));
}

function branchCreatedMessage(branchName: string, count: number): string {
  return plural(count,
    vscode.l10n.t('Branch "{0}" created in 1 repository.', branchName),
    vscode.l10n.t('Branch "{0}" created in {1} repositories.', branchName, count));
}

type TagCommitInfo = { author?: string; hash?: string; message?: string } | undefined;

/** Formats a tag's commit as "hash  •  author  •  message" for a QuickPick detail line. */
function formatTagDetail(t: TagCommitInfo): string | undefined {
  if (!showLastCommitInBranchMenu() || !t) return undefined;
  const parts = [t.hash?.slice(0, 8), t.author, t.message].filter(Boolean);
  return parts.length > 0 ? parts.join('  •  ') : undefined;
}

/** Returns the tag's relative date, or '' when the setting is disabled. */
function tagDateLabel(t: { dateRelative?: string } | undefined): string {
  return showLastCommitInBranchMenu() ? (t?.dateRelative ?? '') : '';
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
    this.statusBarItem.tooltip = vscode.l10n.t('Git Menu');
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
      this.statusBarItem.text = `$(git-branch) ${vscode.l10n.t('No repo')}`;
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
    if (this.branchesDiverged && !suppressDiverged) tooltipParts.push(vscode.l10n.t('Branches have diverged across repositories'));
    if (this.hasUncommitted) tooltipParts.push(vscode.l10n.t('Uncommitted changes present'));
    if (this.hasUnpushed) tooltipParts.push(vscode.l10n.t('Unpushed commits or branch not on remote'));
    if (this.hasBehind) tooltipParts.push(vscode.l10n.t('Incoming commits available'));
    this.statusBarItem.tooltip = tooltipParts.length > 0
      ? `${tooltipParts.join(' · ')}`
      : vscode.l10n.t('Git Menu');

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
          ? `$(error) ${vscode.l10n.t('Abort Merge in {0}', meta.name)}`
          : `$(error) ${vscode.l10n.t('Abort Rebase in {0}', meta.name)}`;
        const description = state === 'merge'
          ? vscode.l10n.t('Merge in progress — abort and restore previous state')
          : vscode.l10n.t('Rebase in progress — abort and restore previous state');
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
        label: `$(warning)  ${vscode.l10n.t('Branches have diverged')}`,
        detail: `  ${vscode.l10n.t('Repositories are not on the same branch')}`,
        alwaysShow: true,
        action: async () => {},
      } as unknown as MenuItem);
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
    }

    const isSingleRepo = metas.length === 1;

    items.push(
      {
        label: `$(repo-fetch) ${isSingleRepo ? vscode.l10n.t('Fetch') : vscode.l10n.t('Fetch All')}`,
        description: isSingleRepo ? vscode.l10n.t('Fetch from all remotes') : vscode.l10n.t('Fetch from all remotes in all repositories'),
        action: () => this.fetchAll(),
      },
      {
        label: `${this.hasBehind ? '$(arrow-down) ' : '$(repo-pull) '}${isSingleRepo ? vscode.l10n.t('Pull (Update Project)…') : vscode.l10n.t('Pull All (Update Project)…')}`,
        description: this.hasBehind
          ? (isSingleRepo
            ? plural(this.totalBehind, vscode.l10n.t('Pull (1 incoming commit)'), vscode.l10n.t('Pull ({0} incoming commits)', this.totalBehind))
            : plural(this.totalBehind, vscode.l10n.t('Pull all repositories (1 incoming commit)'), vscode.l10n.t('Pull all repositories ({0} incoming commits)', this.totalBehind)))
          : isSingleRepo ? vscode.l10n.t('Pull from remote') : vscode.l10n.t('Pull all repositories from remote'),
        action: () => this.updateProject(),
      },
      {
        label: `${this.hasUnpushed ? '$(arrow-up) ' : '$(repo-push) '}${isSingleRepo ? vscode.l10n.t('Push…') : vscode.l10n.t('Push All…')}`,
        description: this.hasUnpushed
          ? (this.hasNoUpstream
            ? plural(this.totalAhead, vscode.l10n.t('Push commits to remote (1 commit to push, some branches have no upstream)'), vscode.l10n.t('Push commits to remote ({0} commits to push, some branches have no upstream)', this.totalAhead))
            : plural(this.totalAhead, vscode.l10n.t('Push commits to remote (1 commit to push)'), vscode.l10n.t('Push commits to remote ({0} commits to push)', this.totalAhead)))
          : this.hasNoUpstream ? vscode.l10n.t('Some branches have no upstream set') : isSingleRepo ? vscode.l10n.t('Push to remote') : vscode.l10n.t('Push all repositories to remote'),
        action: async () => { await vscode.commands.executeCommand('gitcharm.push'); },
      },
      {
        label: `$(repo-force-push) ${isSingleRepo ? vscode.l10n.t('Force Push…') : vscode.l10n.t('Force Push All…')}`,
        description: isSingleRepo ? vscode.l10n.t('Force push to remote') : vscode.l10n.t('Force push all repositories to remote'),
        action: async () => {
          const forcePush = vscode.l10n.t('Force Push');
          const confirm = await vscode.window.showWarningMessage(
            isSingleRepo ? vscode.l10n.t('Force push? This will overwrite remote history.') : vscode.l10n.t('Force push all repositories? This will overwrite remote history.'),
            { modal: true }, forcePush
          );
          if (confirm !== forcePush) return;
          const metas = this.manager.getRepoMetas();
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: isSingleRepo ? vscode.l10n.t('Force pushing…') : vscode.l10n.t('Force pushing all repositories…'), cancellable: false },
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
                const joined = errors.join('; ');
                notifyWithLogAction('warning', plural(errors.length,
                  vscode.l10n.t('1 force push failed: {0}', joined),
                  vscode.l10n.t('{0} force pushes failed: {1}', errors.length, joined)));
              } else {
                vscode.window.showInformationMessage(plural(metas.length,
                  vscode.l10n.t('Force push complete for 1 repository.'),
                  vscode.l10n.t('Force push complete for {0} repositories.', metas.length)));
                logInfo('force-push-all', `Force push complete for ${metas.length} ${metas.length === 1 ? 'repository' : 'repositories'}.`);
              }
            }
          );
          await this.refresh();
        },
      },
      {
        label: `$(sync) ${isSingleRepo ? vscode.l10n.t('Sync…') : vscode.l10n.t('Sync All…')}`,
        description: isSingleRepo ? vscode.l10n.t('Pull then push') : vscode.l10n.t('Pull then push all repositories'),
        action: async () => { await vscode.commands.executeCommand('gitcharm.syncAll'); },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(add) ${vscode.l10n.t('New Branch…')}`,
        description: isSingleRepo ? vscode.l10n.t('Create a new branch') : vscode.l10n.t('Create a new branch in all repositories'),
        action: () => this.newBranch(metas),
      },
      {
        label: `$(tag) ${vscode.l10n.t('New Tag…')}`,
        description: isSingleRepo ? vscode.l10n.t('Create a new tag on HEAD') : vscode.l10n.t('Create a new tag on HEAD of all repositories'),
        action: () => this.newTagAllRepos(metas),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(git-commit) ${vscode.l10n.t({ message: 'Commit', comment: ['Git menu item that opens the Commit panel'] })}`,
        description: vscode.l10n.t('Open Commit panel'),
        action: () => this.commitPanelReveal(),
      },
      {
        label: `$(history) ${vscode.l10n.t({ message: 'Log', comment: ['Git menu item that opens the Log panel (commit history)'] })}`,
        description: vscode.l10n.t('Open Log panel'),
        action: async () => { await vscode.commands.executeCommand('gitcharm.openLog'); },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
    );

    // Per-project section
    if (metas.length > 0) {
      items.push({
        label: vscode.l10n.t('PROJECTS'),
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
      title: vscode.l10n.t('GitCharm — Git Menu'),
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
        label: metas.length === 1 ? vscode.l10n.t('LOCAL BRANCHES') : vscode.l10n.t('COMMON LOCAL BRANCHES'),
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
            ? [aheadBehindLabel, showAsCurrent ? currentBadge() : undefined, lastCommitDateLabel(b)].filter(Boolean).join('  ')
            : (showAsCurrent ? currentBadge() : ''),
          detail: isSingleRepo ? formatCommitDetail(b) : undefined,
          action: () => this.showCommonBranchActionMenu(name, metas, isCurrentSomewhere, headLabel, undefined, undefined, false, false, hasDivergence),
        });
      }
    }

    if (commonRemote.length > 0) {
      items.push({
        label: metas.length === 1 ? vscode.l10n.t('REMOTE BRANCHES') : vscode.l10n.t('COMMON REMOTE BRANCHES'),
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as typeof items[0]);
      for (const fullName of commonRemote) {
        const baseName = fullName.includes('/') ? fullName.slice(fullName.indexOf('/') + 1) : fullName;
        const b = singleRepoBranches.find(x => x.isRemote && x.name === fullName);
        const primary = isPrimaryBranch(fullName, actualDefaultBranch);
        items.push({
          label: `$(cloud) ${fullName}`,
          description: isSingleRepo ? lastCommitDateLabel(b) : '',
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

    const sectionLabel = metas.length === 1 ? vscode.l10n.t('TAGS') : vscode.l10n.t('COMMON TAGS');
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
          ? [isActive ? currentBadge() : undefined, tagDateLabel(t)].filter(Boolean).join('  ')
          : (isActive ? currentBadge() : ''),
        detail: isSingleRepo ? formatTagDetail(t) : undefined,
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
    )].join(', ') || vscode.l10n.t('current branch');

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
      label: `$(cloud-upload) ${vscode.l10n.t('Push to "{0}"', remote)}`,
      action: async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing tag "{0}" to {1}…', tagName, remote), cancellable: false },
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
              notifyWithLogAction('warning', errorSummary(errors));
            } else {
              const msg = `tag "${tagName}" pushed to "${remote}" in ${metas.length} repositories.`;
              vscode.window.showInformationMessage(plural(metas.length,
                vscode.l10n.t('Tag "{0}" pushed to "{1}" in 1 repository.', tagName, remote),
                vscode.l10n.t('Tag "{0}" pushed to "{1}" in {2} repositories.', tagName, remote, metas.length)));
              logInfo('push-tag', msg);
            }
          }
        );
      },
    }));

    const items: ActionItem[] = [
      {
        label: `$(arrow-left) ${vscode.l10n.t('Back')}`,
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(arrow-right) ${vscode.l10n.t('Checkout')}`,
        description: metas.length === 1 ? vscode.l10n.t('Checkout tag "{0}" (detached HEAD)', tagName) : vscode.l10n.t('Checkout tag "{0}" in all repositories (detached HEAD)', tagName),
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking out tag "{0}"…', tagName), cancellable: false },
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
                notifyWithLogAction('warning', errorSummary(errors));
              } else {
                const msg = `checked out tag "${tagName}" in ${metas.length} repositories.`;
                vscode.window.showInformationMessage(plural(metas.length,
                  vscode.l10n.t('Checked out tag "{0}" in 1 repository.', tagName),
                  vscode.l10n.t('Checked out tag "{0}" in {1} repositories.', tagName, metas.length)));
                logInfo('checkout-tag', msg);
              }
            }
          );
          await this.refresh();
        },
      },
      {
        label: `$(git-merge) ${vscode.l10n.t('Merge "{0}" into "{1}"', tagName, branchLabel)}`,
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Merging tag "{0}"…', tagName), cancellable: false },
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
                notifyWithLogAction('warning', errorSummary(errors));
              } else {
                const msg = `merged tag "${tagName}" in ${metas.length} repositories.`;
                vscode.window.showInformationMessage(plural(metas.length,
                  vscode.l10n.t('Merged tag "{0}" in 1 repository.', tagName),
                  vscode.l10n.t('Merged tag "{0}" in {1} repositories.', tagName, metas.length)));
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
        label: `$(trash) ${vscode.l10n.t('Delete tag')}`,
        description: metas.length === 1 ? vscode.l10n.t('Delete tag "{0}"', tagName) : vscode.l10n.t('Delete tag "{0}" in all repositories', tagName),
        action: async () => {
          const deleteLocalLabel = vscode.l10n.t('Delete Local');
          const deleteRemoteLabel = vscode.l10n.t('Delete on Remote');
          const deleteBothLabel = vscode.l10n.t('Delete Local and Remote');
          const pick = await vscode.window.showWarningMessage(
            plural(metas.length,
              vscode.l10n.t('Delete tag "{0}" in 1 repository?', tagName),
              vscode.l10n.t('Delete tag "{0}" in {1} repositories?', tagName, metas.length)),
            { modal: true }, deleteLocalLabel, deleteRemoteLabel, deleteBothLabel
          );
          if (!pick) return;
          const deleteLocal = pick !== deleteRemoteLabel;
          const deleteRemote = pick === deleteRemoteLabel || pick === deleteBothLabel;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Deleting tag "{0}"…', tagName), cancellable: false },
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
                notifyWithLogAction('warning', errorSummary(errors));
              } else {
                const msg = `deleted tag "${tagName}" in ${metas.length} repositories.`;
                vscode.window.showInformationMessage(plural(metas.length,
                  vscode.l10n.t('Deleted tag "{0}" in 1 repository.', tagName),
                  vscode.l10n.t('Deleted tag "{0}" in {1} repositories.', tagName, metas.length)));
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
      title: vscode.l10n.t('Tag: {0}', tagName),
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
    const inAllRepos = metas.length === 1 ? '' : vscode.l10n.t('in all repositories');

    const items: ActionItem[] = [
      {
        label: `$(arrow-left) ${vscode.l10n.t('Back')}`,
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(arrow-right) ${vscode.l10n.t('Checkout')}`,
        description: metas.length === 1 ? vscode.l10n.t('Switch to {0}', displayName) : vscode.l10n.t('Switch all repositories to {0}', displayName),
        action: () => this.checkoutBranchAllRepos(branchName, metas),
      },
      {
        label: `$(add) ${vscode.l10n.t("New branch from '{0}'…", displayName)}`,
        description: inAllRepos,
        action: () => this.newBranchFrom(branchName, metas),
      },
      {
        label: `$(cloud-download) ${vscode.l10n.t('Update (Pull)')}`,
        description: metas.length === 1 ? vscode.l10n.t('Pull {0}', displayName) : vscode.l10n.t('Pull {0} in all repositories', displayName),
        action: () => this.pullBranchAllRepos(branchName, metas),
      },
      {
        label: `$(edit) ${vscode.l10n.t('Rename…')}`,
        description: inAllRepos,
        action: () => this.renameBranchAllRepos(branchName, metas),
      },
      {
        label: `$(git-compare) ${vscode.l10n.t("Compare '{0}' with…", displayName)}`,
        description: inAllRepos,
        action: () => this.compareBranchAllReposWith(branchName, metas),
      },
    ];

    // These act against a single "current branch" ref, which is ambiguous across repositories
    // that aren't all on the same branch — only offer them when every repo agrees on one.
    if (!isCurrent && !hasDivergence) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(git-compare) ${vscode.l10n.t("Compare '{0}' with '{1}'", currentBranchName, ref)}`,
          description: inAllRepos,
          action: () => this.compareBranchAllRepos(ref, metas, currentBranchName),
        },
        {
          label: `$(repo-forked) ${vscode.l10n.t("Rebase '{0}' onto '{1}'", currentBranchName, ref)}`,
          description: inAllRepos,
          action: () => this.rebaseAllRepos(ref, metas),
        },
        {
          label: `$(git-merge) ${vscode.l10n.t("Merge '{0}' into '{1}'", ref, currentBranchName)}`,
          description: inAllRepos,
          action: () => this.mergeBranchAllRepos(ref, metas),
        },
        {
          label: `$(git-merge) ${vscode.l10n.t("Checkout '{0}' and merge '{1}' into it", ref, currentBranchName)}`,
          description: inAllRepos,
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
        label: `$(trash) ${vscode.l10n.t('Delete…')}`,
        description: inAllRepos,
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
      vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured in any repository.'));
      logWarn('push', 'No remotes configured in any repository.');
      return;
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('GitCharm — Push: select repository and remote'),
      matchOnDescription: true,
    }) as RepoRemoteItem | undefined;

    if (!pick) return;

    const repo = this.manager.getRepo(pick.repoId);
    if (!repo) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing to {0}…', pick.remote), cancellable: false },
      async () => {
        try {
          await repo.push(false, pick.remote);
          const repoName = pick.label.replace('$(cloud-upload) ', '');
          const msg = `[${repoName}]: pushed to "${pick.remote}" successfully.`;
          vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: pushed to "{1}" successfully.', repoName, pick.remote));
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
      vscode.window.showInformationMessage(state === 'merge'
        ? vscode.l10n.t('[{0}]: merge aborted successfully.', meta.name)
        : vscode.l10n.t('[{0}]: rebase aborted successfully.', meta.name));
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
        title: vscode.l10n.t('Fetching all remotes…'),
        cancellable: false,
      },
      async () => {
        await this.manager.fetchAll();
      }
    );
    await this.refresh();
    vscode.window.showInformationMessage(vscode.l10n.t('Fetch complete.'));
  }

  async updateProject(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: `$(git-merge) ${vscode.l10n.t('Merge incoming changes into the current branch')}`,
          rebase: false,
        },
        {
          label: `$(repo-forked) ${vscode.l10n.t('Rebase the current branch on top of incoming changes')}`,
          rebase: true,
        },
      ],
      { title: vscode.l10n.t('Update Project — Strategy') }
    ) as { label: string; rebase: boolean } | undefined;

    if (!pick) return;

    const metas = this.manager.getRepoMetas();
    const metaById = new Map(metas.map(m => [m.id, m]));

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Updating all projects…'),
        cancellable: false,
      },
      async () => {
        const results = await this.manager.pullAll(pick.rebase);
        const failed = results.filter(r => !r.ok);
        const ok = results.filter(r => r.ok);
        if (failed.length === 0) {
          const msg = `${ok.length} ${ok.length === 1 ? 'repository' : 'repositories'} updated.`;
          vscode.window.showInformationMessage(plural(ok.length,
            vscode.l10n.t('1 repository updated.'),
            vscode.l10n.t('{0} repositories updated.', ok.length)));
          logInfo('update-project', msg);
        } else {
          const failedDesc = failed.map(r => {
            const name = metaById.get(r.repoId)?.name ?? r.repoId;
            return `${name}: ${r.message}`;
          }).join('; ');
          logWarn('update-project', `${ok.length} updated, ${failed.length} failed.`, failedDesc);
          notifyWithLogAction('warning', vscode.l10n.t('{0} updated, {1} failed: {2}', ok.length, failed.length, failedDesc));
        }
        await vscode.commands.executeCommand('gitcharm.openLog');
      }
    );
  }

  private async newBranch(metas: RepoMeta[]): Promise<void> {
    // Step 1: branch name
    const branchName = await promptBranchName({
      title: vscode.l10n.t('New Branch — Name'),
      prompt: vscode.l10n.t('Enter the new branch name'),
    });
    if (!branchName) return;

    // Step 2: base branch (from any repo)
    const allBranches = await this.manager.getAllBranches();
    const localBranches = allBranches.filter(b => !b.isRemote);
    const uniqueBaseNames = [...new Set(localBranches.map(b => b.name))].sort();
    const currentHeads = [...new Set(localBranches.filter(b => b.isHead).map(b => b.name))];
    const currentLabel = currentHeads.length > 0 ? currentHeads.join(', ') : vscode.l10n.t('current branch');

    const BASE_CURRENT = '__current__';
    const baseItems: Array<vscode.QuickPickItem & { value: string }> = [
      { label: `$(git-branch) ${currentLabel}`, description: vscode.l10n.t('Current HEAD of each repo'), value: BASE_CURRENT },
      ...uniqueBaseNames.map(n => ({ label: `$(git-branch) ${n}`, description: n, value: n })),
    ];
    const basePick = await vscode.window.showQuickPick(baseItems, {
      title: vscode.l10n.t('New Branch — Base'),
      placeHolder: vscode.l10n.t('Select the base branch'),
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
      title: vscode.l10n.t('New Branch — Repositories'),
      placeHolder: vscode.l10n.t('Select repositories to create the branch in'),
      canPickMany: true,
    });
    if (!pickedRepos || pickedRepos.length === 0) return;

    // Step 4: checkout?
    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${vscode.l10n.t('Yes, checkout immediately')}`, value: true },
        { label: `$(close) ${vscode.l10n.t('No, just create the branch')}`, value: false },
      ],
      { title: vscode.l10n.t('New Branch — Checkout?') }
    );
    if (!checkoutPick) return;
    const doCheckout = (checkoutPick as { value: boolean }).value;

    // Execute
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating branch "{0}"…', branchName), cancellable: false },
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else if (alreadyExisted.length > 0) {
          const msg = `Branch "${branchName}" already existed in ${alreadyExisted.length} ${alreadyExisted.length === 1 ? 'repository' : 'repositories'}${doCheckout ? ' — checked out' : ''}; created in the rest.`;
          vscode.window.showInformationMessage(branchAlreadyExistedMessage(branchName, alreadyExisted.length, doCheckout));
          logInfo('new-branch', msg);
        } else if (succeeded > 0) {
          const msg = `Branch "${branchName}" created in ${succeeded} ${succeeded === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(branchCreatedMessage(branchName, succeeded));
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
        label: `$(arrow-left) ${vscode.l10n.t('Back')}`,
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(repo-fetch) ${vscode.l10n.t('Fetch')}`,
        description: vscode.l10n.t('Fetch all remotes'),
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('[{0}]: Fetching…', meta.name), cancellable: false },
            async () => { await repo.fetchAll(); }
          );
          await this.refresh();
        },
      },
      {
        label: `$(repo-pull) ${vscode.l10n.t('Pull…')}`,
        description: vscode.l10n.t('Pull from remote'),
        action: async () => {
          const pick = await vscode.window.showQuickPick(
            [
              { label: `$(git-merge) ${vscode.l10n.t('Merge incoming changes')}`, rebase: false },
              { label: `$(repo-forked) ${vscode.l10n.t('Rebase onto incoming changes')}`, rebase: true },
            ],
            { title: vscode.l10n.t('Pull — {0}', meta.name) }
          ) as { label: string; rebase: boolean } | undefined;
          if (!pick) return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('[{0}]: Pulling…', meta.name), cancellable: false },
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
        label: `$(repo-push) ${vscode.l10n.t('Push')}`,
        description: vscode.l10n.t('Push to remote'),
        action: async () => {
          const remotes = await repo.getRemotes().catch(() => [] as string[]);
          if (remotes.length === 0) {
            vscode.window.showWarningMessage(vscode.l10n.t('[{0}]: No remotes configured.', meta.name));
            logWarn(`push:${meta.name}`, 'No remotes configured.');
            return;
          }
          let targetRemote = remotes[0];
          if (remotes.length > 1) {
            const picked = await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: vscode.l10n.t('Push {0} — select remote', meta.name) }
            ) as { label: string; remote: string } | undefined;
            if (!picked) return;
            targetRemote = picked.remote;
          }
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('[{0}]: Pushing to {1}…', meta.name, targetRemote), cancellable: false },
            async () => {
              try {
                await repo.push(false, targetRemote);
                const msg = `[${meta.name}]: pushed to "${targetRemote}" successfully.`;
                vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: pushed to "{1}" successfully.', meta.name, targetRemote));
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
        label: `$(repo-force-push) ${vscode.l10n.t('Force Push')}`,
        description: vscode.l10n.t('Force push to remote'),
        action: async () => {
          const forcePush = vscode.l10n.t('Force Push');
          const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('Force push {0}? This will overwrite remote history.', meta.name),
            { modal: true }, forcePush
          );
          if (confirm !== forcePush) return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('[{0}]: Force pushing…', meta.name), cancellable: false },
            async () => {
              try {
                await repo.push(true);
                const msg = `[${meta.name}]: force pushed successfully.`;
                vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: force pushed successfully.', meta.name));
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
        label: `$(sync) ${vscode.l10n.t('Sync…')}`,
        description: vscode.l10n.t('Pull then push'),
        action: async () => {
          const pick = await vscode.window.showQuickPick(
            [
              { label: `$(git-merge) ${vscode.l10n.t('Merge incoming changes')}`, rebase: false },
              { label: `$(repo-forked) ${vscode.l10n.t('Rebase onto incoming changes')}`, rebase: true },
            ],
            { title: vscode.l10n.t('Sync — {0}', meta.name) }
          ) as { label: string; rebase: boolean } | undefined;
          if (!pick) return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('[{0}]: Syncing…', meta.name), cancellable: false },
            async () => {
              try {
                const msg = pick.rebase ? await repo.pullRebase() : await repo.pull();
                vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: Pull — {1}', meta.name, msg));
                logInfo(`sync-pull:${meta.name}`, `[${meta.name}]: Pull — ${msg}`);
              } catch (e: unknown) {
                showGitError(`sync-pull:${meta.name}`, e);
                await this.refresh();
                return;
              }
              try {
                await repo.push();
                const msg = `[${meta.name}]: synced successfully.`;
                vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: synced successfully.', meta.name));
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
        label: `$(add) ${vscode.l10n.t('New Branch…')}`,
        description: vscode.l10n.t('Create a new branch'),
        action: () => this.newBranchSingleRepo(meta),
      },
      {
        label: `$(tag) ${vscode.l10n.t('New Tag…')}`,
        description: vscode.l10n.t('Create a new tag on HEAD'),
        action: () => this.newTagSingleRepo(meta),
      },
      {
        label: `$(git-commit) ${vscode.l10n.t('Checkout detached…')}`,
        description: vscode.l10n.t('Checkout a branch without attaching HEAD'),
        action: () => this.checkoutDetachedSingleRepo(meta),
      },
      {
        label: `$(remote-explorer) ${vscode.l10n.t('Manage Remotes…')}`,
        description: vscode.l10n.t('Add, remove, or edit remotes'),
        action: () => this.showRepoRemotesMenu(meta),
      },
      { label: vscode.l10n.t({ message: 'LOCAL', comment: ['Quick pick section header for local branches'] }), kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...local.map(b => {
        const primary = isPrimaryBranch(b.name, actualDefaultBranch);
        const icon = b.isHead ? '$(check)' : primary ? '$(star)' : '$(git-branch)';
        const remoteNames = new Set(remote.map(r => r.name.replace(/^[^/]+\//, '')));
        const hasRemote = b.isHead ? !!currentBranch.upstream : remoteNames.has(b.name);
        const hasUnpushed = !hasRemote || (b.aheadBehind?.ahead ?? 0) > 0;
        const aheadBehindLabel = b.aheadBehind ? `↑${b.aheadBehind.ahead} ↓${b.aheadBehind.behind}` : '';
        return {
          label: `${icon} ${b.name}`,
          description: [aheadBehindLabel, lastCommitDateLabel(b)].filter(Boolean).join('  '),
          detail: formatCommitDetail(b),
          action: () => this.showSingleBranchActionMenu(b.name, meta, b.isHead, false, hasUnpushed, effectiveBranchName, primary),
        };
      }),
      { label: vscode.l10n.t({ message: 'REMOTE', comment: ['Quick pick section header for remote branches'] }), kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...remote.map(b => {
        const primary = isPrimaryBranch(b.name, actualDefaultBranch);
        const icon = primary ? '$(star)' : '$(cloud)';
        return {
          label: `${icon} ${b.name}`,
          description: lastCommitDateLabel(b),
          detail: formatCommitDetail(b),
          action: () => this.showSingleBranchActionMenu(b.name, meta, false, true, false, effectiveBranchName, primary),
        };
      }),
    ];

    if (tags.length > 0) {
      items.push({ label: vscode.l10n.t('TAGS'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      for (const tag of tags) {
        const isActiveTag = currentBranch.detachedTag === tag.name;
        const icon = isActiveTag ? '$(check)' : '$(tag)';
        items.push({
          label: `${icon} ${tag.name}`,
          description: [isActiveTag ? currentBadge() : undefined, tagDateLabel(tag)].filter(Boolean).join('  '),
          detail: formatTagDetail(tag),
          action: () => this.showSingleTagActionMenu(tag.name, meta, effectiveBranchName, isDetached),
        });
      }
    }

    if (meta.isSubmodule) {
      items.push({ label: vscode.l10n.t('SUBMODULE'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      items.push({
        label: `$(repo-sync) ${vscode.l10n.t({ message: 'Update', comment: ['Submodule action: git submodule update'] })}`,
        description: `git submodule update ${meta.submodulePath ?? ''}`,
        action: async () => { await vscode.commands.executeCommand('gitcharm.submodule.update', meta.id); },
      });
      items.push({
        label: `$(repo-sync) ${vscode.l10n.t('Update (recursive)')}`,
        description: 'git submodule update --init --recursive',
        action: async () => { await vscode.commands.executeCommand('gitcharm.submodule.updateRecursive', meta.id); },
      });
      items.push({
        label: `$(add) ${vscode.l10n.t({ message: 'Init', comment: ['Submodule action: git submodule init'] })}`,
        description: vscode.l10n.t('Initialize this submodule'),
        action: async () => { await vscode.commands.executeCommand('gitcharm.submodule.init', meta.id); },
      });
      items.push({
        label: `$(trash) ${vscode.l10n.t({ message: 'Deinit', comment: ['Submodule action: git submodule deinit'] })}`,
        description: vscode.l10n.t('Deinitialize this submodule'),
        action: async () => { await vscode.commands.executeCommand('gitcharm.submodule.deinit', meta.id); },
      });
      items.push({
        label: `$(link-external) ${vscode.l10n.t('Open in New Window')}`,
        description: vscode.l10n.t('Open submodule folder in a separate VS Code window'),
        action: async () => { await vscode.commands.executeCommand('gitcharm.submodule.openInNewWindow', meta.id); },
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('{0} — Branches', meta.name),
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
      label: `$(cloud-upload) ${vscode.l10n.t('Push to "{0}"', r)}`,
      action: async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing tag "{0}" to {1}…', tagName, r), cancellable: false },
          async () => {
            try {
              await repo.pushTag(tagName, r);
              const msg = `[${meta.name}]: tag "${tagName}" pushed to "${r}".`;
              vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: tag "{1}" pushed to "{2}".', meta.name, tagName, r));
              logInfo(`push-tag:${meta.name}`, msg);
            } catch (e: unknown) {
              showGitError(`push-tag:${meta.name}`, e);
            }
          }
        );
      },
    }));

    const mergeItem: ActionItem = {
      label: `$(git-merge) ${vscode.l10n.t('Merge "{0}" into "{1}"', tagName, currentBranchName)}`,
      action: async () => {
        try {
          await repo.mergeTag(tagName);
          const msg = `[${meta.name}]: merged tag "${tagName}".`;
          vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: merged tag "{1}".', meta.name, tagName));
          logInfo(`merge-tag:${meta.name}`, msg);
        } catch (e: unknown) {
          showGitError(`merge-tag:${meta.name}`, e);
        }
        await this.refresh();
      },
    };

    const items: ActionItem[] = [
      {
        label: `$(arrow-left) ${vscode.l10n.t('Back')}`,
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(arrow-right) ${vscode.l10n.t('Checkout')}`,
        description: vscode.l10n.t('Checkout tag "{0}" (detached HEAD)', tagName),
        action: async () => {
          try {
            await repo.checkoutTag(tagName);
            const msg = `[${meta.name}]: checked out tag "${tagName}" (detached HEAD).`;
            vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: checked out tag "{1}" (detached HEAD).', meta.name, tagName));
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
        label: `$(trash) ${vscode.l10n.t('Delete tag')}`,
        description: vscode.l10n.t('Delete tag "{0}"', tagName),
        action: async () => {
          const deleteLocalLabel = vscode.l10n.t('Delete Local');
          const deleteRemoteLabel = vscode.l10n.t('Delete on Remote');
          const deleteBothLabel = vscode.l10n.t('Delete Local and Remote');
          const pick = await vscode.window.showWarningMessage(
            vscode.l10n.t('Delete tag "{0}" in {1}?', tagName, meta.name),
            { modal: true }, deleteLocalLabel, deleteRemoteLabel, deleteBothLabel
          );
          if (!pick) return;
          const deleteLocal = pick !== deleteRemoteLabel;
          const deleteRemote = pick === deleteRemoteLabel || pick === deleteBothLabel;
          try {
            if (deleteLocal) await repo.deleteTag(tagName);
            if (deleteRemote) {
              const remotes = await repo.getRemotes().catch(() => [] as string[]);
              if (remotes.length === 0) {
                vscode.window.showWarningMessage(vscode.l10n.t('[{0}]: no remotes configured.', meta.name));
                logWarn(`delete-tag:${meta.name}`, 'No remotes configured.');
              } else {
                const remote = remotes.length === 1
                  ? remotes[0]
                  : (await vscode.window.showQuickPick(remotes, { title: vscode.l10n.t('Delete "{0}" from remote', tagName) }));
                if (remote) await repo.deleteTagRemote(tagName, remote);
              }
            }
            const msg = `[${meta.name}]: tag "${tagName}" deleted.`;
            vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: tag "{1}" deleted.', meta.name, tagName));
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
      title: vscode.l10n.t('Tag: {0} — {1}', tagName, meta.name),
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
        label: `$(arrow-left) ${vscode.l10n.t('Back')}`,
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(arrow-right) ${vscode.l10n.t('Checkout')}`,
        action: () => this.checkoutSingleRepo(branchName, meta),
      },
      {
        label: `$(add) ${vscode.l10n.t("New branch from '{0}'…", branchName)}`,
        action: () => this.newBranchFromSingleRepo(branchName, meta),
      },
      {
        label: `$(cloud-download) ${vscode.l10n.t('Update (Pull)')}`,
        action: () => this.pullSingleRepo(meta),
      },
      {
        label: `$(edit) ${vscode.l10n.t('Rename…')}`,
        action: () => this.renameBranchSingleRepo(branchName, meta),
      },
      {
        label: `$(git-compare) ${vscode.l10n.t("Compare '{0}' with…", branchName)}`,
        action: () => this.compareSingleRepoWith(branchName, meta),
      },
    ];

    if (hasUnpushed) {
      items.push({
        label: `$(cloud-upload) ${vscode.l10n.t('Push')}`,
        action: () => this.pushSingleRepo(meta),
      });
    }

    if (!isCurrent) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(git-compare) ${vscode.l10n.t("Compare '{0}' with '{1}'", currentBranchName, branchName)}`,
          action: () => this.compareSingleRepo(branchName, meta, currentBranchName),
        },
        {
          label: `$(repo-forked) ${vscode.l10n.t("Rebase '{0}' onto '{1}'", currentBranchName, branchName)}`,
          action: () => this.rebaseSingleRepo(branchName, meta),
        },
        {
          label: `$(git-merge) ${vscode.l10n.t("Merge '{0}' into '{1}'", branchName, currentBranchName)}`,
          action: () => this.mergeSingleRepo(branchName, meta),
        },
        {
          label: `$(git-merge) ${vscode.l10n.t("Checkout '{0}' and merge '{1}' into it", branchName, currentBranchName)}`,
          action: () => this.checkoutAndMergeSingleRepo(branchName, currentBranchName, meta),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      );
      // The remote's default branch (e.g. "origin/main") can't be deleted from the remote —
      // don't offer the action at all rather than let it fail. Deleting a local branch that
      // happens to share the primary name is still fine, since it doesn't touch the remote.
      if (!(isRemote && isPrimary)) {
        items.push({
          label: `$(trash) ${vscode.l10n.t('Delete…')}`,
          action: () => this.deleteSingleRepo(branchName, meta),
        });
      }
    }

    if (isRemote) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(repo-forked) ${vscode.l10n.t("Pull into '{0}' using Rebase", currentBranchName)}`,
          action: () => this.pullRemoteIntoCurrentSingleRepo(branchName, meta, true),
        },
        {
          label: `$(git-merge) ${vscode.l10n.t("Pull into '{0}' using Merge", currentBranchName)}`,
          action: () => this.pullRemoteIntoCurrentSingleRepo(branchName, meta, false),
        },
      );
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('{0} — {1}', branchName, meta.name),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async newBranchSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const branchName = await promptBranchName({
      title: vscode.l10n.t('New Branch in {0}', meta.name),
      prompt: vscode.l10n.t('Enter the new branch name'),
    });
    if (!branchName) return;

    const branches = await repo.getBranches();
    const localBranches = branches.filter(b => !b.isRemote);
    const localNames = localBranches.map(b => b.name);
    const currentHead = localBranches.find(b => b.isHead)?.name ?? vscode.l10n.t('current branch');

    const BASE_CURRENT = '__current__';
    const baseItems: Array<vscode.QuickPickItem & { value: string }> = [
      { label: `$(git-branch) ${currentHead}`, description: vscode.l10n.t('Current HEAD'), value: BASE_CURRENT },
      ...localNames.map(n => ({ label: `$(git-branch) ${n}`, description: n, value: n })),
    ];
    const basePick = await vscode.window.showQuickPick(baseItems, {
      title: vscode.l10n.t('New Branch in {0} — Base', meta.name),
      placeHolder: vscode.l10n.t('Select the base branch'),
    }) as (typeof baseItems[number]) | undefined;
    if (!basePick) return;
    const baseFrom = basePick.value === BASE_CURRENT ? undefined : basePick.value;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${vscode.l10n.t('Yes, checkout immediately')}`, value: true },
        { label: `$(close) ${vscode.l10n.t('No, just create the branch')}`, value: false },
      ],
      { title: vscode.l10n.t('New Branch in {0} — Checkout?', meta.name) }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    try {
      if (checkoutPick.value) {
        await repo.checkout(branchName, true, baseFrom);
      } else {
        await repo.createBranch(branchName, baseFrom);
      }
      const msg = `[${meta.name}]: branch "${branchName}" ${checkoutPick.value ? 'created and checked out' : 'created'}.`;
      vscode.window.showInformationMessage(checkoutPick.value
        ? vscode.l10n.t('[{0}]: branch "{1}" created and checked out.', meta.name, branchName)
        : vscode.l10n.t('[{0}]: branch "{1}" created.', meta.name, branchName));
      logInfo(`new-branch:${meta.name}`, msg);
    } catch (e: unknown) {
      if (isBranchAlreadyExistsError(e)) {
        if (checkoutPick.value) {
          try {
            await repo.checkout(branchName);
            const msg = `[${meta.name}]: branch "${branchName}" already exists — checked out.`;
            vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: branch "{1}" already exists — checked out.', meta.name, branchName));
            logInfo(`new-branch:${meta.name}`, msg);
          } catch (e2: unknown) {
            const { matched } = await handleDirtyCheckout(repo, meta.name, branchName, e2, {
              checkout: () => repo.checkout(branchName),
              checkoutForce: () => repo.checkoutForce(branchName),
            });
            if (!matched) showGitError(`new-branch:${meta.name}`, e2);
          }
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: branch "{1}" already exists.', meta.name, branchName));
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
      title: vscode.l10n.t('New Tag in {0}', meta.name),
      prompt: vscode.l10n.t('Enter the tag name (will be created on HEAD)'),
      placeHolder: 'v1.0.0',
      validateInput: v => v.trim() ? undefined : vscode.l10n.t('Tag name cannot be empty'),
    });
    if (!tagName) return;
    try {
      await repo.createTag(tagName.trim(), 'HEAD');
      void this.logPanel?.refreshTagsForRepo(meta.id);
      const createdMsg = `[${meta.name}]: tag "${tagName.trim()}" created on HEAD.`;
      logInfo(`new-tag:${meta.name}`, createdMsg);
      const pushLabel = vscode.l10n.t('Push');
      vscode.window.showInformationMessage(
        vscode.l10n.t('[{0}]: tag "{1}" created on HEAD.', meta.name, tagName.trim()),
        pushLabel
      ).then(async pick => {
        if (pick !== pushLabel) return;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured.'));
          logWarn(`push-tag:${meta.name}`, 'No remotes configured.');
          return;
        }
        const remote = remotes.length === 1
          ? remotes[0]
          : (await vscode.window.showQuickPick(remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })), { title: vscode.l10n.t('Push tag "{0}" — Select remote', tagName.trim()) }) as { label: string; remote: string } | undefined)?.remote;
        if (!remote) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing tag "{0}" to {1}…', tagName.trim(), remote), cancellable: false },
          async () => {
            try {
              await repo.pushTag(tagName.trim(), remote);
              const msg = `Tag "${tagName.trim()}" pushed to "${remote}".`;
              vscode.window.showInformationMessage(vscode.l10n.t('Tag "{0}" pushed to "{1}".', tagName.trim(), remote));
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
      title: vscode.l10n.t('New Tag'),
      prompt: vscode.l10n.t('Enter the tag name (will be created on HEAD of each repository)'),
      placeHolder: 'v1.0.0',
      validateInput: v => v.trim() ? undefined : vscode.l10n.t('Tag name cannot be empty'),
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
      notifyWithLogAction('warning', vscode.l10n.t('Some tags failed:\n{0}', errors.join('\n')));
      return;
    }
    const createdMsg = `Tag "${trimmed}" created on HEAD in all repositories.`;
    logInfo('new-tag', createdMsg);
    const pushLabel = vscode.l10n.t('Push');
    vscode.window.showInformationMessage(vscode.l10n.t('Tag "{0}" created on HEAD in all repositories.', trimmed), pushLabel).then(async pick => {
      if (pick !== pushLabel) return;
      const repoWithRemotes = await Promise.all(metas.map(async meta => {
        const repo = this.manager.getRepo(meta.id);
        const remotes = repo ? await repo.getRemotes().catch(() => [] as string[]) : [];
        return { meta, repo, remotes };
      }));
      const allRemotes = [...new Set(repoWithRemotes.flatMap(r => r.remotes))];
      if (allRemotes.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured.'));
        logWarn('push-tag', 'No remotes configured.');
        return;
      }
      const remote = allRemotes.length === 1
        ? allRemotes[0]!
        : (await vscode.window.showQuickPick(allRemotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })), { title: vscode.l10n.t('Push tag "{0}" — Select remote', trimmed) }) as { label: string; remote: string } | undefined)?.remote;
      if (!remote) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing tag "{0}" to {1}…', trimmed, remote), cancellable: false },
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
            notifyWithLogAction('warning', vscode.l10n.t('Some pushes failed:\n{0}', pushErrors.join('\n')));
          } else {
            const msg = `Tag "${trimmed}" pushed to "${remote}" in all repositories.`;
            vscode.window.showInformationMessage(vscode.l10n.t('Tag "{0}" pushed to "{1}" in all repositories.', trimmed, remote));
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
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: switched to "{1}"', meta.name, branchName));
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
      { label: vscode.l10n.t({ message: 'LOCAL', comment: ['Quick pick section header for local branches'] }), kind: vscode.QuickPickItemKind.Separator, ref: '' },
      ...local.map(b => ({
        label: `${b.isHead ? '$(check)' : '$(git-branch)'} ${b.name}`,
        description: [b.isHead ? currentBadge() : undefined, lastCommitDateLabel(b)].filter(Boolean).join('  '),
        detail: formatCommitDetail(b),
        ref: b.name,
      })),
      { label: vscode.l10n.t({ message: 'REMOTE', comment: ['Quick pick section header for remote branches'] }), kind: vscode.QuickPickItemKind.Separator, ref: '' },
      ...remote.map(b => ({
        label: `$(cloud) ${b.name}`,
        description: lastCommitDateLabel(b),
        detail: formatCommitDetail(b),
        ref: b.name,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Checkout detached — {0}', meta.name),
      placeHolder: vscode.l10n.t('Select a branch to checkout in detached HEAD mode'),
      matchOnDescription: true,
    });
    if (!picked?.ref) return;

    try {
      await repo.checkoutDetached(picked.ref);
      const msg = `[${meta.name}]: checked out "${picked.ref}" (detached HEAD).`;
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: checked out "{1}" (detached HEAD).', meta.name, picked.ref));
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
      vscode.window.showWarningMessage(vscode.l10n.t('Branch "{0}" not found in any repository.', branchName));
      logWarn('checkout', `Branch "${branchName}" not found in any repository.`);
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking out "{0}"…', branchName), cancellable: false },
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else if (succeeded > 0) {
          const msg = `Checked out "${branchName}" in ${succeeded} ${succeeded === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(plural(succeeded,
            vscode.l10n.t('Checked out "{0}" in 1 repository.', branchName),
            vscode.l10n.t('Checked out "{0}" in {1} repositories.', branchName, succeeded)));
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
      title: vscode.l10n.t("New Branch from '{0}' in {1}", fromBranch, meta.name),
      prompt: vscode.l10n.t('Enter the new branch name'),
    });
    if (!branchName) return;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${vscode.l10n.t('Yes, checkout immediately')}`, value: true },
        { label: `$(close) ${vscode.l10n.t('No, just create the branch')}`, value: false },
      ],
      { title: vscode.l10n.t('New Branch — Checkout?') }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    try {
      if (checkoutPick.value) {
        await repo.checkout(branchName, true, fromBranch);
      } else {
        await repo.createBranch(branchName, fromBranch);
      }
      const msg = `[${meta.name}]: branch "${branchName}" ${checkoutPick.value ? 'created and checked out' : 'created'}.`;
      vscode.window.showInformationMessage(checkoutPick.value
        ? vscode.l10n.t('[{0}]: branch "{1}" created and checked out.', meta.name, branchName)
        : vscode.l10n.t('[{0}]: branch "{1}" created.', meta.name, branchName));
      logInfo(`new-branch:${meta.name}`, msg);
    } catch (e: unknown) {
      if (isBranchAlreadyExistsError(e)) {
        if (checkoutPick.value) {
          try {
            await repo.checkout(branchName);
            const msg = `[${meta.name}]: branch "${branchName}" already exists — checked out.`;
            vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: branch "{1}" already exists — checked out.', meta.name, branchName));
            logInfo(`new-branch:${meta.name}`, msg);
          } catch (e2: unknown) {
            const { matched } = await handleDirtyCheckout(repo, meta.name, branchName, e2, {
              checkout: () => repo.checkout(branchName),
              checkoutForce: () => repo.checkoutForce(branchName),
            });
            if (!matched) showGitError(`new-branch:${meta.name}`, e2);
          }
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: branch "{1}" already exists.', meta.name, branchName));
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
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('[{0}]: Pulling…', meta.name), cancellable: false },
      async () => {
        try {
          await repo.pull();
          const msg = `[${meta.name}]: pulled successfully.`;
          vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: pulled successfully.', meta.name));
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
      title: vscode.l10n.t("Rename branch '{0}' in {1}", oldName, meta.name),
      value: oldName,
      validateInput: v => (v.trim() ? undefined : vscode.l10n.t('Branch name cannot be empty')),
    });
    if (!newName || newName === oldName) return;

    const oldUpstream = await repo.getBranchUpstream(oldName).catch(() => null);
    try {
      await repo.renameBranch(oldName, newName);
      const msg = `[${meta.name}]: renamed "${oldName}" → "${newName}".`;
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: renamed "{1}" → "{2}".', meta.name, oldName, newName));
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
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: pushed successfully.', meta.name));
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
      vscode.window.showErrorMessage(vscode.l10n.t('Cannot resolve refs for comparison in "{0}".', meta.name));
      logError(`compare:${meta.name}`, formatGitError(e), getRawErrorDetail(e));
      return;
    }
    const files = await repo.getCombinedFiles([branchHash, headHash]);
    if (files.length === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t("[{0}]: No differences between '{1}' and '{2}'.", meta.name, currentBranchName, branchName));
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
    await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('{0} vs {1} [{2}]', currentBranchName, branchName, meta.name), resources);
  }

  private async compareSingleRepoWith(branchName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const otherRef = await pickRefQuickPick(repo, {
      title: vscode.l10n.t("Compare '{0}' with…", branchName),
      placeHolder: vscode.l10n.t('Select a branch or tag to compare against'),
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
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: rebased onto "{1}".', meta.name, onto));
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
      vscode.window.showInformationMessage(upToDate
        ? vscode.l10n.t('[{0}]: "{1}" is already up to date — nothing to merge.', meta.name, from)
        : vscode.l10n.t('[{0}]: merged "{1}".', meta.name, from));
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
      vscode.window.showInformationMessage(upToDate
        ? vscode.l10n.t('[{0}]: checked out "{1}" — "{2}" is already up to date, nothing to merge.', meta.name, targetBranch, sourceBranch)
        : vscode.l10n.t('[{0}]: checked out "{1}" and merged "{2}" into it.', meta.name, targetBranch, sourceBranch));
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
        { label: `$(trash) ${vscode.l10n.t('Delete')}`, description: branchName, value: 'delete' },
        { label: `$(warning) ${vscode.l10n.t('Force delete')}`, description: vscode.l10n.t('even if not merged'), value: 'force' },
      ],
      { title: vscode.l10n.t("Delete branch '{0}' in {1}?", branchName, meta.name) }
    ) as { label: string; value: string } | undefined;
    if (!confirm) return;

    try {
      await repo.deleteBranch(branchName, confirm.value === 'force');
      const msg = `[${meta.name}]: deleted "${branchName}".`;
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: deleted "{1}".', meta.name, branchName));
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
      vscode.window.showInformationMessage(useRebase
        ? vscode.l10n.t('[{0}]: pulled "{1}" using rebase.', meta.name, remoteBranch)
        : vscode.l10n.t('[{0}]: pulled "{1}" using merge.', meta.name, remoteBranch));
      logInfo(`pull:${meta.name}`, msg);
    } catch (e: unknown) {
      showGitError(`pull:${meta.name}`, e);
    }
    await this.refresh();
  }

  // ── Multi-repo branch actions ────────────────────────────────────────────

  private async newBranchFrom(fromBranch: string, metas: RepoMeta[]): Promise<void> {
    const branchName = await promptBranchName({
      title: vscode.l10n.t("New Branch from '{0}'", fromBranch),
      prompt: vscode.l10n.t('Enter the new branch name'),
    });
    if (!branchName) return;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${vscode.l10n.t('Yes, checkout immediately')}`, value: true },
        { label: `$(close) ${vscode.l10n.t('No, just create the branch')}`, value: false },
      ],
      { title: vscode.l10n.t('New Branch — Checkout?') }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating branch "{0}"…', branchName), cancellable: false },
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else if (alreadyExisted.length > 0) {
          const msg = `Branch "${branchName}" already existed in ${alreadyExisted.length} ${alreadyExisted.length === 1 ? 'repository' : 'repositories'}${checkoutPick.value ? ' — checked out' : ''}; created in the rest.`;
          vscode.window.showInformationMessage(branchAlreadyExistedMessage(branchName, alreadyExisted.length, checkoutPick.value));
          logInfo('new-branch', msg);
        } else if (succeeded > 0) {
          const msg = `Branch "${branchName}" created in ${succeeded} ${succeeded === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(branchCreatedMessage(branchName, succeeded));
          logInfo('new-branch', msg);
        }
      }
    );
    await this.refresh();
  }

  private async pullBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pulling "{0}"…', branchName), cancellable: false },
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else {
          const msg = `Pulled in ${metas.length} repositories.`;
          vscode.window.showInformationMessage(plural(metas.length,
            vscode.l10n.t('Pulled in 1 repository.'),
            vscode.l10n.t('Pulled in {0} repositories.', metas.length)));
          logInfo('pull', msg);
        }
      }
    );
    await this.refresh();
  }

  private async renameBranchAllRepos(oldName: string, metas: RepoMeta[]): Promise<void> {
    const newName = await vscode.window.showInputBox({
      title: metas.length === 1 ? vscode.l10n.t("Rename branch '{0}'", oldName) : vscode.l10n.t("Rename branch '{0}' in all repositories", oldName),
      value: oldName,
      validateInput: v => (v.trim() ? undefined : vscode.l10n.t('Branch name cannot be empty')),
    });
    if (!newName || newName === oldName) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Renaming "{0}" → "{1}"…', oldName, newName), cancellable: false },
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else {
          const msg = `Renamed "${oldName}" → "${newName}" in ${metas.length} repositories.`;
          vscode.window.showInformationMessage(plural(metas.length,
            vscode.l10n.t('Renamed "{0}" → "{1}" in 1 repository.', oldName, newName),
            vscode.l10n.t('Renamed "{0}" → "{1}" in {2} repositories.', oldName, newName, metas.length)));
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
      title: vscode.l10n.t("Compare '{0}' with…", branchName),
      placeHolder: vscode.l10n.t('Select a branch or tag to compare against'),
    });
    if (!otherRef || otherRef === branchName) return;
    for (const meta of metas) {
      await this.compareSingleRepo(branchName, meta, otherRef, otherRef);
    }
  }

  private async checkoutAndMergeBranchAllRepos(branchName: string, currentBranchName: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking out "{0}" and merging "{1}"…', branchName, currentBranchName), cancellable: false },
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else if (succeeded > 0) {
          const msg = `Checked out "${branchName}" and merged "${currentBranchName}" in ${succeeded} ${succeeded === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(plural(succeeded,
            vscode.l10n.t('Checked out "{0}" and merged "{1}" in 1 repository.', branchName, currentBranchName),
            vscode.l10n.t('Checked out "{0}" and merged "{1}" in {2} repositories.', branchName, currentBranchName, succeeded)));
          logInfo('checkout-and-merge', msg);
        }
      }
    );
    await this.refresh();
  }

  private async rebaseAllRepos(onto: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Rebasing onto "{0}"…', onto), cancellable: false },
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else {
          const msg = `Rebased onto "${onto}" in ${metas.length} repositories.`;
          vscode.window.showInformationMessage(plural(metas.length,
            vscode.l10n.t('Rebased onto "{0}" in 1 repository.', onto),
            vscode.l10n.t('Rebased onto "{0}" in {1} repositories.', onto, metas.length)));
          logInfo('rebase', msg);
        }
      }
    );
    await this.refresh();
  }

  private async mergeBranchAllRepos(from: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Merging "{0}"…', from), cancellable: false },
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
                  { label: `$(archive) ${vscode.l10n.t('Stash and merge')}`, detail: vscode.l10n.t('Save local changes to stash, then merge'), value: 'stash' },
                  { label: `$(close) ${vscode.l10n.t('Cancel')}`, detail: '', value: 'cancel' },
                ],
                {
                  title: vscode.l10n.t('[{0}]: Uncommitted changes', meta.name),
                  placeHolder: vscode.l10n.t('Local changes would be overwritten by merging "{0}"', from),
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else {
          const msg = merged === 0
            ? `"${from}" is already up to date — nothing to merge.`
            : `Merged "${from}" in ${merged} ${merged === 1 ? 'repository' : 'repositories'}.`;
          vscode.window.showInformationMessage(merged === 0
            ? vscode.l10n.t('"{0}" is already up to date — nothing to merge.', from)
            : plural(merged,
              vscode.l10n.t('Merged "{0}" in 1 repository.', from),
              vscode.l10n.t('Merged "{0}" in {1} repositories.', from, merged)));
          logInfo('merge', msg);
        }
      }
    );
    await this.refresh();
  }

  private async deleteBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    const confirm = await vscode.window.showQuickPick(
      [
        { label: `$(trash) ${vscode.l10n.t('Delete')}`, description: branchName, value: 'delete' },
        { label: `$(warning) ${vscode.l10n.t('Force delete')}`, description: vscode.l10n.t('even if not merged'), value: 'force' },
      ],
      { title: metas.length === 1 ? vscode.l10n.t("Delete branch '{0}'?", branchName) : vscode.l10n.t("Delete branch '{0}' in all repositories?", branchName) }
    ) as { label: string; value: string } | undefined;
    if (!confirm) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Deleting "{0}"…', branchName), cancellable: false },
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
          notifyWithLogAction('warning', errorSummary(errors));
        } else {
          const msg = `Deleted "${branchName}" in ${metas.length} repositories.`;
          vscode.window.showInformationMessage(plural(metas.length,
            vscode.l10n.t('Deleted "{0}" in 1 repository.', branchName),
            vscode.l10n.t('Deleted "{0}" in {1} repositories.', branchName, metas.length)));
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
        title: vscode.l10n.t('Manage Remotes — Select repository'),
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
        label: `$(arrow-left) ${vscode.l10n.t('Back')}`,
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(add) ${vscode.l10n.t('Add Remote…')}`,
        description: vscode.l10n.t('Configure a new remote'),
        action: () => this.addRemote(meta),
      },
    ];

    if (remotes.length > 0) {
      items.push({ label: vscode.l10n.t('REMOTES'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      for (const remote of remotes) {
        items.push({
          label: `$(cloud) ${remote.name}`,
          description: remote.fetchUrl,
          action: () => this.showSingleRemoteMenu(remote, meta),
        });
      }
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('{0} — Remotes', meta.name),
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
        label: `$(arrow-left) ${vscode.l10n.t('Back')}`,
        action: () => this.showRepoRemotesMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(edit) ${vscode.l10n.t('Rename…')}`,
        description: vscode.l10n.t('Rename "{0}"', remote.name),
        action: () => this.renameRemote(remote, meta),
      },
      {
        label: `$(link) ${vscode.l10n.t('Change URL…')}`,
        description: remote.fetchUrl,
        action: () => this.changeRemoteUrl(remote, meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(trash) ${vscode.l10n.t('Remove')}`,
        description: vscode.l10n.t('Remove remote "{0}"', remote.name),
        action: () => this.removeRemote(remote, meta),
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Remote: {0} — {1}', remote.name, meta.name),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async addRemote(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const name = await vscode.window.showInputBox({
      title: vscode.l10n.t('Add Remote in {0} — Name', meta.name),
      prompt: vscode.l10n.t('Enter the remote name (e.g. origin, upstream)'),
      validateInput: v => (v.trim() ? undefined : vscode.l10n.t('Remote name cannot be empty')),
    });
    if (!name) return;

    const url = await vscode.window.showInputBox({
      title: vscode.l10n.t('Add Remote in {0} — URL', meta.name),
      prompt: vscode.l10n.t('Enter the remote URL'),
      validateInput: v => (v.trim() ? undefined : vscode.l10n.t('URL cannot be empty')),
    });
    if (!url) return;

    try {
      await repo.addRemote(name.trim(), url.trim());
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: remote "{1}" added.', meta.name, name));
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
      title: vscode.l10n.t('Rename remote "{0}" in {1}', remote.name, meta.name),
      value: remote.name,
      validateInput: v => (v.trim() ? undefined : vscode.l10n.t('Remote name cannot be empty')),
    });
    if (!newName || newName === remote.name) return;

    try {
      await repo.renameRemote(remote.name, newName.trim());
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: remote renamed "{1}" → "{2}".', meta.name, remote.name, newName));
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
      title: vscode.l10n.t('Change URL of "{0}" in {1}', remote.name, meta.name),
      value: remote.fetchUrl,
      validateInput: v => (v.trim() ? undefined : vscode.l10n.t('URL cannot be empty')),
    });
    if (!newUrl || newUrl === remote.fetchUrl) return;

    try {
      await repo.setRemoteUrl(remote.name, newUrl.trim());
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: URL of "{1}" updated.', meta.name, remote.name));
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
        { label: `$(trash) ${vscode.l10n.t('Remove "{0}"', remote.name)}`, value: true },
        { label: `$(close) ${vscode.l10n.t('Cancel')}`, value: false },
      ],
      { title: vscode.l10n.t('Remove remote "{0}" from {1}?', remote.name, meta.name) }
    ) as { label: string; value: boolean } | undefined;

    if (!confirm?.value) return;

    try {
      await repo.removeRemote(remote.name);
      vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: remote "{1}" removed.', meta.name, remote.name));
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
