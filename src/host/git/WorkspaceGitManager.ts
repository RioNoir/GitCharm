import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from './GitService';
import type { WorktreeEntry } from './GitService';
import { getVscodeGitApi, getVscodeRepository } from './VscodeGitApi';
import type { Repository } from './git.d';
import type { BranchInfo, CommitNode, RepoMeta, RepoStatus, WorkspaceStatus } from '../types/git';
import type { CompareRange } from '../types/messages';
import { projectColor } from '../types/workspace';
import { formatGitError } from '../utils/gitErrorUtils';
import { mergeCommitLists } from '../utils/mergeCommitLists';

const DEFAULT_SUBMODULE_MAX_DEPTH = 5;
/**
 * Above this many submodules they aren't shown until the user asks: each one is a repo
 * that is watched and queried on every refresh, and dozens of them make the extension
 * crawl. The choice is kept per workspace under SHOW_SUBMODULES_KEY.
 */
const AUTO_SHOW_SUBMODULES_MAX = 5;
const SHOW_SUBMODULES_KEY = 'gitcharm.showSubmodules';
/**
 * Debounce for ref changes that affect the commit graph (HEAD, refs, reflog).
 * Deliberately short: a single git operation writes a handful of these files
 * within a few milliseconds, so this only needs to be long enough to collapse
 * one operation's burst — not long enough to be felt as lag. This is the whole
 * latency budget between a terminal `git commit` and the log view updating.
 */
const GRAPH_REFRESH_DEBOUNCE_MS = 120;
/**
 * Floor on the gap between two graph refreshes, so a run of closely spaced
 * bursts (a rebase applying commits one at a time) doesn't trigger a `git log`
 * per burst. Doesn't delay the first refresh after a quiet period.
 */
const GRAPH_REFRESH_MIN_INTERVAL_MS = 400;
/**
 * Ceiling on how long a pending refresh can be deferred by continuing events.
 * A trailing debounce alone would never fire while ref writes keep arriving, so
 * a long interactive rebase would leave the graph stale until it finished. This
 * makes the view keep up with an operation in progress.
 */
const GRAPH_REFRESH_MAX_WAIT_MS = 1000;
/**
 * Coalesces events that change the set of repositories (.gitmodules edits, new .git dirs,
 * settings). A full reinitialize rebuilds every watcher and makes the log reload, so a
 * burst of them — VS Code opening submodules one by one — must not run it once per event.
 */
const REINITIALIZE_DEBOUNCE_MS = 250;
const DEFAULT_REPOSITORY_SCAN_MAX_DEPTH = 1;
const DEFAULT_REPOSITORY_SCAN_IGNORED_FOLDERS = ['node_modules'];

type StatusListener = (status: WorkspaceStatus) => void;
/** A submodule found while scanning .gitmodules, registered as a repo only if submodules are shown. */
interface DiscoveredSubmodule { absPath: string; relPath: string; parentRepoId: string; depth: number }
type BranchListener = () => void;
type WorktreeListener = (repoId: string) => void;
type OrphanListener = (newlyOrphaned: Array<{ repoId: string; branchName: string }>) => void;

export type { WorktreeEntry };

export class WorkspaceGitManager implements vscode.Disposable {
  private repos = new Map<string, GitService>();
  private repoMetas = new Map<string, RepoMeta>();
  /** Per-repo watchers — recreated on reinitialize(). */
  private watchers: vscode.Disposable[] = [];
  /**
   * Working-tree status watchers per repo, kept apart from `watchers` so one repo's can be
   * swapped (filesystem fallback → VS Code Git API) when VS Code opens it, without
   * rebuilding the rest. `vsRepo` is the API repository listened to, if any.
   */
  private statusWatchers = new Map<string, { vsRepo?: Repository; disposables: vscode.Disposable[] }>();
  private reinitDebounce: NodeJS.Timeout | null = null;
  /** Submodules found by the current reinitialize(), in discovery order. */
  private discoveredSubmodules: DiscoveredSubmodule[] = [];
  /** How many discovered submodules are left unregistered because submodules are hidden. */
  private hiddenSubmoduleCount = 0;
  private submoduleNoticeShown = false;
  /** Repos whose ref files setupGraphWatcher watches, so their branch changes reach the graph on their own. */
  private graphWatchedRepos = new Set<string>();
  /** Global workspace listeners — created once in constructor, disposed in dispose(). */
  private globalListeners: vscode.Disposable[] = [];
  private statusListeners: StatusListener[] = [];
  private branchListeners: BranchListener[] = [];
  private graphListeners: BranchListener[] = [];
  private reposListeners: BranchListener[] = [];
  private worktreeListeners: WorktreeListener[] = [];
  private orphanListeners: OrphanListener[] = [];
  /** Local branches already known to be missing their upstream, so re-fetching doesn't re-notify for the same branch every time. Cleared per-repo when the branch disappears or regains an upstream. */
  private knownOrphanBranches = new Map<string, Set<string>>();
  /**
   * Repos whose gone-upstream branches haven't been baselined yet. `[gone]` also fires for a
   * branch whose upstream config never pointed at a real remote branch (e.g. a rename or
   * push -u that didn't complete) — indistinguishable from a real "merged, then deleted
   * upstream" by git's own tracking status alone. So the first fetchAll() per repo only
   * records the current gone set as the baseline instead of notifying; only a branch that
   * transitions from tracked-and-not-gone to gone (a state we actually observed) is reported.
   */
  private orphanBaselineDone = new Set<string>();
  private refreshDebounce: NodeJS.Timeout | null = null;
  private refreshFollowUp: NodeJS.Timeout | null = null;
  /** Repos whose status the next sweep must re-read; 'all' for every repo. */
  private pendingRefresh: Set<string> | 'all' | null = null;
  /** A status sweep is running; requests arriving meanwhile wait for the next one. */
  private refreshInFlight = false;
  /**
   * Last status read per repo, before applySubmoduleStatus. A sweep re-reads only the
   * repos something happened in and takes the rest from here.
   */
  private statusCache = new Map<string, RepoStatus>();
  /** Bumped by reinitialize(), so a sweep started on the old repo set can't fill the cache. */
  private repoGeneration = 0;
  private branchDebounce: NodeJS.Timeout | null = null;
  private graphDebounce: NodeJS.Timeout | null = null;
  private lastGraphRefresh = 0;
  private graphPendingSince = 0;
  /** Watchers for .git creation under workspace folders — rebuilt when folders/settings change. */
  private gitInitWatchers: vscode.Disposable[] = [];
  private prevHeads = new Map<string, string>();      // repoId → branch name
  private prevCommits = new Map<string, string>();    // repoId → commit hash
  private prevUntracked = new Map<string, Set<string>>(); // repoId → known untracked paths
  private initialStatusDone = false;
  /** Resolves when the startup fetch (if enabled) has completed, or immediately if disabled. */
  readonly startupFetchPromise: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {
    let resolveStartupFetch!: () => void;
    this.startupFetchPromise = new Promise<void>(r => { resolveStartupFetch = r; });
    this.globalListeners.push(
      // Workspace folder changes → rebuild everything and push fresh status to listeners
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleReinitialize()),

      // File saved inside a repo → refresh status (immediate + follow-up for slow git index updates)
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const repoIds = this.reposContaining([doc.uri]);
        if (repoIds.length > 0) {
          this.scheduleRefresh(repoIds);
          // Schedule a follow-up refresh in case git hasn't updated its index yet
          if (this.refreshFollowUp) clearTimeout(this.refreshFollowUp);
          this.refreshFollowUp = setTimeout(() => this.scheduleRefresh(repoIds), 1200);
        }
      }),

      // File-explorer operations (create/delete/rename via VSCode UI or extensions)
      vscode.workspace.onDidCreateFiles(e => this.scheduleRefreshFor(e.files)),
      vscode.workspace.onDidDeleteFiles(e => this.scheduleRefreshFor(e.files)),
      vscode.workspace.onDidRenameFiles(e => this.scheduleRefreshFor(e.files.flatMap(f => [f.oldUri, f.newUri]))),

      // Repository discovery settings affect the repo set, watcher patterns, and colors.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('gitcharm.repositoryScanMaxDepth') ||
          e.affectsConfiguration('gitcharm.repositoryScanIgnoredFolders') ||
          e.affectsConfiguration('gitcharm.submoduleMaxDepth') ||
          e.affectsConfiguration('gitcharm.projectColors')
        ) {
          this.scheduleReinitialize();
        }
      }),
    );

    // VS Code's git extension can discover a repo (e.g. a parent-folder repo found via
    // git.openRepositoryInParentFolders) asynchronously, after its API already reports
    // 'initialized'. Pick those up as soon as they appear.
    const gitApiForOpenEvent = getVscodeGitApi();
    if (gitApiForOpenEvent) {
      this.globalListeners.push(
        gitApiForOpenEvent.onDidOpenRepository(vsRepo => this.onRepositoryOpened(vsRepo))
      );
    }

    this.reinitialize();
    this.setupGitInitWatchers();
    this.scheduleRefresh();

    // If vscode.git is not yet initialized at startup, re-run setup once it is.
    // This ensures watchers use the VS Code git API rather than the filesystem fallback,
    // and that the initial status is fetched after git repos are fully loaded.
    const gitApi = getVscodeGitApi();
    if (gitApi && gitApi.state === 'uninitialized') {
      const d = gitApi.onDidChangeState((state) => {
        if (state === 'initialized') {
          d.dispose();
          this.reinitialize();
          this.scheduleRefresh();
          this.fetchOnStartupIfEnabled(resolveStartupFetch);
        }
      });
      this.globalListeners.push(d);
    } else if (!gitApi) {
      // vscode.git is not yet active — poll until the API becomes available.
      // onDidChange does not fire for startup extensions, so polling is required.
      const poll = setInterval(() => {
        const api = getVscodeGitApi();
        if (!api) return;
        clearInterval(poll);
        if (api.state === 'initialized') {
          this.reinitialize();
          this.scheduleRefresh();
          this.fetchOnStartupIfEnabled(resolveStartupFetch);
        } else {
          const d = api.onDidChangeState((state) => {
            if (state === 'initialized') {
              d.dispose();
              this.reinitialize();
              this.scheduleRefresh();
              this.fetchOnStartupIfEnabled(resolveStartupFetch);
            }
          });
          this.globalListeners.push(d);
        }
      }, 500);
    } else {
      // vscode.git is already initialized — fetch after repos are set up
      this.fetchOnStartupIfEnabled(resolveStartupFetch);
    }
  }

  private fetchOnStartupIfEnabled(onDone: () => void): void {
    const enabled = vscode.workspace.getConfiguration('gitcharm').get<boolean>('fetchOnStartup', true);
    if (enabled) {
      this.fetchAll().catch(console.error).finally(onDone);
    } else {
      onDone();
    }
  }

  private reinitialize(): void {
    this.disposeWatchers();
    this.repos.clear();
    this.repoMetas.clear();
    this.prevHeads.clear();
    this.prevCommits.clear();
    this.prevUntracked.clear();
    this.statusCache.clear();
    this.discoveredSubmodules = [];
    this.repoGeneration++;
    this.initialStatusDone = false;

    const folders = vscode.workspace.workspaceFolders ?? [];
    const customColors = vscode.workspace.getConfiguration('gitcharm').get<Record<string, string>>('projectColors', {});

    // Shared counter so every repo (workspace folder, scanned repo, or submodule)
    // gets its own palette slot — submodules are visually distinct, just like multi-repo.
    const colorIdx = { value: 0 };
    folders.forEach((folder) => {
      const gitDir = path.join(folder.uri.fsPath, '.git');
      if (fs.existsSync(gitDir)) {
        const repoId = folder.uri.fsPath;
        const color = customColors[folder.name] ?? projectColor(colorIdx.value++);

        const { isWorktree, mainWorktreePath } = this.detectLinkedWorktree(folder.uri.fsPath);

        const meta: RepoMeta = { id: repoId, name: folder.name, rootPath: folder.uri.fsPath, color, depth: 0, isWorktree, mainWorktreePath };
        this.repoMetas.set(repoId, meta);
        this.repos.set(repoId, new GitService(repoId, folder.uri.fsPath));
        this.setupWatcher(folder.uri.fsPath, repoId);
        this.discoverSubmodules(folder.uri.fsPath, repoId, 1);
        this.setupRepositoryAuxWatchers(folder.uri.fsPath, repoId);
      }
    });

    const repositoryScanMaxDepth = this.getRepositoryScanMaxDepth();
    if (repositoryScanMaxDepth > 0) {
      folders.forEach((folder) => {
        this.discoverNestedRepositories(folder.uri.fsPath, repositoryScanMaxDepth, colorIdx, customColors);
      });
    }

    // Pick up repositories VS Code's built-in Git extension already discovered but that
    // this scan missed — most notably a parent-folder repo found via
    // git.openRepositoryInParentFolders when the workspace root is a subfolder of the repo
    // (so no workspace folder path sits inside it, and the downward scans above never reach it).
    this.registerVscodeDiscoveredRepositories(colorIdx, customColors);

    this.registerSubmodules(colorIdx, customColors);

    // Notify listeners that the set of known repos has changed (e.g. submodule added/removed)
    this.reposListeners.forEach(l => l());
  }

  private registerVscodeDiscoveredRepositories(
    colorIdx: { value: number },
    customColors: Record<string, string>,
  ): void {
    const gitApi = getVscodeGitApi();
    if (!gitApi) return;

    // vscode.git doesn't necessarily drop a repo from `repositories` the instant its
    // workspace folder is removed, so only accept repos still relevant to the *current*
    // workspace: this is meant to pick up a parent-folder repo (workspace root sits inside
    // it) that our downward scans can't reach — not to resurrect an unrelated repo that
    // vscode.git simply hasn't pruned from its own list yet.
    for (const vsRepo of gitApi.repositories) {
      const repoPath = path.normalize(vsRepo.rootUri.fsPath);
      if (this.repos.has(repoPath)) continue;
      if (!this.containsWorkspaceFolder(repoPath)) continue;

      const color = customColors[path.basename(repoPath)] ?? projectColor(colorIdx.value++);
      const { isWorktree, mainWorktreePath } = this.detectLinkedWorktree(repoPath);

      const meta: RepoMeta = {
        id: repoPath,
        name: path.basename(repoPath),
        rootPath: repoPath,
        color,
        depth: 0,
        isWorktree,
        mainWorktreePath,
      };
      this.repoMetas.set(repoPath, meta);
      this.repos.set(repoPath, new GitService(repoPath, repoPath));
      this.setupWatcher(repoPath, repoPath);
      this.discoverSubmodules(repoPath, repoPath, 1);
      this.setupRepositoryAuxWatchers(repoPath, repoPath);
    }
  }

  /** Whether `repoPath` is a workspace folder or one of its ancestors — the parent-folder repos registerVscodeDiscoveredRepositories accepts. */
  private containsWorkspaceFolder(repoPath: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some(f => {
      const rel = path.relative(repoPath, f.uri.fsPath);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  /**
   * VS Code's git extension opened a repository. For one we already track — the usual
   * case, as VS Code opens submodules one by one after startup — only its status watcher
   * changes (its API now covers it), so swap that alone instead of rebuilding every repo.
   * An untracked repo can only be new to us if it is a parent-folder repo; anything else
   * VS Code finds (e.g. a nested repo past our scan depth) wouldn't be picked up anyway.
   */
  private onRepositoryOpened(vsRepo: Repository): void {
    const repoId = path.normalize(vsRepo.rootUri.fsPath);
    const meta = this.repoMetas.get(repoId);
    if (!meta) {
      if (this.containsWorkspaceFolder(repoId)) this.scheduleReinitialize();
      return;
    }

    const current = this.statusWatchers.get(repoId);
    // Already listening to this very instance. A repo VS Code closed and reopened is a
    // new instance, so it falls through and the listener moves to it.
    if (current?.vsRepo === vsRepo) return;
    if (current) {
      this.setupStatusWatcher(meta.rootPath, repoId);
    } else {
      // A submodule that wasn't initialized when discovered has no watchers at all yet.
      this.setupWatcher(meta.rootPath, repoId);
      this.reposListeners.forEach(l => l());
    }
    this.scheduleRefresh([repoId]);
  }

  private scheduleReinitialize(): void {
    if (this.reinitDebounce) clearTimeout(this.reinitDebounce);
    this.reinitDebounce = setTimeout(() => {
      this.reinitDebounce = null;
      this.reinitializeAndRefresh();
    }, REINITIALIZE_DEBOUNCE_MS);
  }

  private getRepositoryScanMaxDepth(): number {
    const value = vscode.workspace
      .getConfiguration('gitcharm')
      .get<number>('repositoryScanMaxDepth', DEFAULT_REPOSITORY_SCAN_MAX_DEPTH);

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_REPOSITORY_SCAN_MAX_DEPTH;
    }
    return Math.min(10, Math.max(0, Math.floor(value)));
  }

  private getSubmoduleMaxDepth(): number {
    const value = vscode.workspace
      .getConfiguration('gitcharm')
      .get<number>('submoduleMaxDepth', DEFAULT_SUBMODULE_MAX_DEPTH);

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_SUBMODULE_MAX_DEPTH;
    }
    return Math.min(10, Math.max(0, Math.floor(value)));
  }

  private getRepositoryScanIgnoredFolders(): string[] {
    const value = vscode.workspace
      .getConfiguration('gitcharm')
      .get<string[]>('repositoryScanIgnoredFolders', DEFAULT_REPOSITORY_SCAN_IGNORED_FOLDERS);

    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : DEFAULT_REPOSITORY_SCAN_IGNORED_FOLDERS;
  }

  private detectLinkedWorktree(rootPath: string): { isWorktree: boolean; mainWorktreePath?: string } {
    const gitDir = path.join(rootPath, '.git');
    let mainWorktreePath: string | undefined;

    try {
      if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isFile()) {
        return { isWorktree: false };
      }

      const content = fs.readFileSync(gitDir, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        // e.g. /abs/path/main/.git/worktrees/foo → strip /.git/worktrees/foo
        const gitdirPath = match[1].trim();
        const worktreesIdx = gitdirPath.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
        if (worktreesIdx !== -1) {
          mainWorktreePath = gitdirPath.slice(0, worktreesIdx);
        }
      }
    } catch {
      return { isWorktree: false };
    }

    // Only treat as worktree if the main repo is also known/open in this workspace.
    // If opened standalone, behave as a normal repo.
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const isWorktree = !!mainWorktreePath && (workspacePaths.includes(mainWorktreePath) || this.repos.has(mainWorktreePath));
    return { isWorktree, mainWorktreePath };
  }

  private setupRepositoryAuxWatchers(repoPath: string, repoId: string): void {
    // Always watch .gitmodules regardless of whether VS Code Git API is available —
    // setupWatcher() returns early when vsRepo is found and skips the FileSystemWatcher fallback.
    const gitmodulesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoPath, '.gitmodules')
    );
    const onGitmodulesChanged = () => this.scheduleReinitialize();
    gitmodulesWatcher.onDidChange(onGitmodulesChanged);
    gitmodulesWatcher.onDidCreate(onGitmodulesChanged);
    gitmodulesWatcher.onDidDelete(onGitmodulesChanged);
    this.watchers.push(gitmodulesWatcher);

    // Watch .git/worktrees/ so the panel updates when worktrees are added/removed.
    // Linked worktrees have .git as a file; their main repo owns .git/worktrees/.
    const gitDir = path.join(repoPath, '.git');
    try {
      if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;
    } catch {
      return;
    }

    const worktreesDir = path.join(gitDir, 'worktrees');
    const worktreeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(worktreesDir, '**')
    );
    const onWorktreesChanged = () => { this.worktreeListeners.forEach(l => l(repoId)); };
    worktreeWatcher.onDidChange(onWorktreesChanged);
    worktreeWatcher.onDidCreate(onWorktreesChanged);
    worktreeWatcher.onDidDelete(onWorktreesChanged);
    this.watchers.push(worktreeWatcher);
  }

  private repositoryScanDepth(workspaceRoot: string, candidatePath: string): number {
    const rel = path.relative(workspaceRoot, candidatePath);
    if (!rel) return 0;
    if (rel.startsWith('..') || path.isAbsolute(rel)) return -1;
    return rel.split(path.sep).filter(Boolean).length;
  }

  private isRepositoryScanIgnored(candidatePath: string, workspaceRoot: string): boolean {
    const rel = path.relative(workspaceRoot, candidatePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;

    const normalizedRel = rel.split(path.sep).join('/');
    const parts = normalizedRel.split('/').filter(Boolean);
    if (parts.includes('.git')) return true;

    return this.getRepositoryScanIgnoredFolders().some(rawPattern => {
      const pattern = rawPattern.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!pattern) return false;
      if (!pattern.includes('/')) return parts.includes(pattern);
      return normalizedRel === pattern || normalizedRel.startsWith(`${pattern}/`);
    });
  }

  private discoverNestedRepositories(
    workspaceRoot: string,
    maxDepth: number,
    colorIdx: { value: number },
    customColors: Record<string, string>,
  ): void {
    const visit = (parentPath: string, parentDepth: number) => {
      if (parentDepth >= maxDepth) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(parentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

        const childPath = path.join(parentPath, entry.name);
        if (this.isRepositoryScanIgnored(childPath, workspaceRoot)) continue;

        const childDepth = parentDepth + 1;
        const gitDir = path.join(childPath, '.git');
        if (fs.existsSync(gitDir)) {
          this.registerScannedRepository(childPath, workspaceRoot, colorIdx, customColors);
          continue;
        }

        if (childDepth < maxDepth) {
          visit(childPath, childDepth);
        }
      }
    };

    visit(workspaceRoot, 0);
  }

  private registerScannedRepository(
    repoPath: string,
    workspaceRoot: string,
    colorIdx: { value: number },
    customColors: Record<string, string>,
  ): void {
    const normalizedRepoPath = path.normalize(repoPath);
    if (this.repos.has(normalizedRepoPath)) return;
    // A submodule is registered as one (or left out while submodules are hidden), never as a plain nested repo.
    if (this.discoveredSubmodules.some(s => s.absPath === normalizedRepoPath)) return;

    const relPath = path.relative(workspaceRoot, normalizedRepoPath).split(path.sep).join('/');
    const displayName = relPath && !relPath.startsWith('..') ? relPath : path.basename(normalizedRepoPath);
    const basename = path.basename(normalizedRepoPath);
    const customColor = customColors[displayName] ?? customColors[basename];
    const color = customColor ?? projectColor(colorIdx.value++);
    const { isWorktree, mainWorktreePath } = this.detectLinkedWorktree(normalizedRepoPath);

    const meta: RepoMeta = {
      id: normalizedRepoPath,
      name: displayName,
      rootPath: normalizedRepoPath,
      color,
      depth: 0,
      isWorktree,
      mainWorktreePath,
    };
    this.repoMetas.set(normalizedRepoPath, meta);
    this.repos.set(normalizedRepoPath, new GitService(normalizedRepoPath, normalizedRepoPath));
    this.setupWatcher(normalizedRepoPath, normalizedRepoPath);
    this.discoverSubmodules(normalizedRepoPath, normalizedRepoPath, 1);
    this.setupRepositoryAuxWatchers(normalizedRepoPath, normalizedRepoPath);
  }

  /** Collect the submodules under `parentPath` (recursively, up to submoduleMaxDepth) into discoveredSubmodules. */
  private discoverSubmodules(parentPath: string, parentRepoId: string, depth: number): void {
    if (depth > this.getSubmoduleMaxDepth()) return;

    const gitmodulesPath = path.join(parentPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return;

    let raw: string;
    try { raw = fs.readFileSync(gitmodulesPath, 'utf8'); } catch { return; }

    // Parse submodule paths from .gitmodules
    const subPaths: string[] = [];
    let pendingPath = '';
    for (const line of raw.split('\n')) {
      if (line.match(/^\[submodule/)) { pendingPath = ''; continue; }
      const kvMatch = line.match(/^\s+path\s*=\s*(.+)/);
      if (kvMatch) pendingPath = kvMatch[1].trim();
      const urlMatch = line.match(/^\s+url\s*=\s*(.+)/);
      if (urlMatch && pendingPath) { subPaths.push(pendingPath); pendingPath = ''; }
    }

    for (const subRelPath of subPaths) {
      const subAbsPath = path.join(parentPath, subRelPath);

      // Submodule may be uninitialized — .git may not exist yet
      if (!fs.existsSync(subAbsPath)) continue;

      // Avoid double-registering a path that's already a workspace folder
      if (this.repos.has(subAbsPath) || this.discoveredSubmodules.some(s => s.absPath === subAbsPath)) continue;

      // Guard against circular references
      if (subAbsPath === parentPath || parentPath.startsWith(subAbsPath + path.sep)) continue;

      this.discoveredSubmodules.push({ absPath: subAbsPath, relPath: subRelPath, parentRepoId, depth });

      // Recurse into nested submodules
      this.discoverSubmodules(subAbsPath, subAbsPath, depth + 1);
    }
  }

  /**
   * Register the discovered submodules as repos — or none of them, while submodules are
   * hidden: by the user's choice for this workspace, or by default when there are more
   * than AUTO_SHOW_SUBMODULES_MAX, in which case a notification offers to show them.
   */
  private registerSubmodules(colorIdx: { value: number }, customColors: Record<string, string>): void {
    const count = this.discoveredSubmodules.length;
    const choice = this.context.workspaceState.get<boolean>(SHOW_SUBMODULES_KEY);
    const shown = choice ?? count <= AUTO_SHOW_SUBMODULES_MAX;
    this.hiddenSubmoduleCount = shown ? 0 : count;
    void vscode.commands.executeCommand('setContext', 'gitcharm.hasHiddenSubmodules', !shown && count > 0);
    void vscode.commands.executeCommand('setContext', 'gitcharm.hasShownSubmodules', shown && count > 0);

    if (!shown) {
      if (choice === undefined && count > 0 && !this.submoduleNoticeShown) {
        this.submoduleNoticeShown = true;
        void this.offerToShowSubmodules(count);
      }
      return;
    }

    for (const sub of this.discoveredSubmodules) {
      if (this.repos.has(sub.absPath)) continue;
      const subName = path.basename(sub.relPath);
      // Each submodule gets its own color slot — same as a regular workspace folder.
      const color = customColors[subName] ?? projectColor(colorIdx.value++);

      const meta: RepoMeta = {
        id: sub.absPath,
        name: subName,
        rootPath: sub.absPath,
        color,
        isSubmodule: true,
        parentRepoId: sub.parentRepoId,
        submodulePath: sub.relPath,
        depth: sub.depth,
      };
      this.repoMetas.set(sub.absPath, meta);
      this.repos.set(sub.absPath, new GitService(sub.absPath, sub.absPath));

      // Only set up watcher if the submodule is initialized (has .git)
      if (fs.existsSync(path.join(sub.absPath, '.git'))) {
        this.setupWatcher(sub.absPath, sub.absPath);
      }
    }
  }

  private async offerToShowSubmodules(count: number): Promise<void> {
    const show = vscode.l10n.t('Show Submodules');
    const keepHidden = vscode.l10n.t('Keep Hidden');
    const picked = await vscode.window.showInformationMessage(
      vscode.l10n.t('This workspace has {0} Git submodules. GitCharm doesn\'t show them, so that it stays fast: each one is a repository to watch and query on every refresh.', count),
      show,
      keepHidden,
    );
    if (picked === show) await this.setSubmodulesShown(true);
    else if (picked === keepHidden) await this.context.workspaceState.update(SHOW_SUBMODULES_KEY, false);
  }

  /** Show or hide the submodules of this workspace, remembering the choice. */
  async setSubmodulesShown(shown: boolean): Promise<void> {
    await this.context.workspaceState.update(SHOW_SUBMODULES_KEY, shown);
    this.reinitializeAndRefresh();
  }

  /** Submodules of this workspace not shown because submodules are hidden. */
  getHiddenSubmoduleCount(): number {
    return this.hiddenSubmoduleCount;
  }

  /**
   * Resolve a repository's real git directory. Normally `<repo>/.git`, but for
   * linked worktrees and submodules `.git` is a file containing a `gitdir:`
   * pointer. Returns the git dir plus the common dir, which is where a linked
   * worktree's shared refs actually live (its own git dir holds only HEAD and
   * its reflog).
   */
  private resolveGitDirs(repoPath: string): { gitDir: string; commonDir: string } | null {
    try {
      const dotGit = path.join(repoPath, '.git');
      const st = fs.statSync(dotGit);
      let gitDir = dotGit;
      if (st.isFile()) {
        const match = fs.readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/m);
        if (!match) return null;
        gitDir = path.resolve(repoPath, match[1].trim());
      }
      let commonDir = gitDir;
      const commonDirFile = path.join(gitDir, 'commondir');
      if (fs.existsSync(commonDirFile)) {
        commonDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim());
      }
      return { gitDir, commonDir };
    } catch {
      return null;
    }
  }

  /**
   * Watch the ref files that determine what the commit graph shows, and report
   * changes on their own fast path.
   *
   * This exists because the VS Code Git API is too slow to be the only source
   * of graph updates: the built-in git extension debounces its own file events
   * by a second, then runs a full status before firing onDidChange, so a commit
   * made in a terminal took seconds to appear. Watching the refs directly cuts
   * that to the debounce below. The API listener is still used for working-tree
   * status, where its extra work is the point.
   */
  private setupGraphWatcher(repoPath: string, repoId: string): void {
    const dirs = this.resolveGitDirs(repoPath);
    if (!dirs) return;
    const { gitDir, commonDir } = dirs;
    this.graphWatchedRepos.add(repoId);

    const onGraphChanged = () => this.scheduleGraphRefresh();
    const watch = (base: string, pattern: string) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      w.onDidChange(onGraphChanged);
      w.onDidCreate(onGraphChanged);
      w.onDidDelete(onGraphChanged);
      this.watchers.push(w);
    };

    // HEAD and the reflog live in the worktree's own git dir; a commit, reset,
    // checkout or rebase always touches at least one of them.
    watch(gitDir, 'HEAD');
    watch(gitDir, 'logs/HEAD');
    // Refs are shared with the main repo when this is a linked worktree.
    watch(commonDir, 'refs/**');
    watch(commonDir, 'packed-refs');
    if (commonDir !== gitDir) {
      watch(gitDir, 'refs/**');
    }
  }

  private setupWatcher(repoPath: string, repoId: string): void {
    // Fast path for graph-affecting changes, independent of the VS Code Git API.
    this.setupGraphWatcher(repoPath, repoId);
    this.setupStatusWatcher(repoPath, repoId);
  }

  /** (Re)create the working-tree status watcher of one repo, replacing any it already has. */
  private setupStatusWatcher(repoPath: string, repoId: string): void {
    this.statusWatchers.get(repoId)?.disposables.forEach(d => d.dispose());
    const disposables: vscode.Disposable[] = [];

    // Primary source for working-tree status: VS Code Git API state changes —
    // fired for all git operations (built-in git, GitCharm, terminal, other
    // extensions), but only after its own debounce and a full status run.
    const vsRepo = getVscodeRepository(repoPath);
    if (vsRepo) {
      this.prevHeads.set(repoId, vsRepo.state.HEAD?.name ?? '');
      this.prevCommits.set(repoId, vsRepo.state.HEAD?.commit ?? '');
      const d = vsRepo.state.onDidChange(() => {
        const currentHead = vsRepo.state.HEAD?.name ?? '';
        const currentCommit = vsRepo.state.HEAD?.commit ?? '';
        const prevHead = this.prevHeads.get(repoId) ?? '';
        const prevCommit = this.prevCommits.get(repoId) ?? '';
        if (currentHead !== prevHead) {
          // Branch checkout — fire both refresh and branch listeners.
          this.prevHeads.set(repoId, currentHead);
          this.prevCommits.set(repoId, currentCommit);
          this.scheduleRefresh([repoId]);
          this.scheduleBranchRefresh(repoId);
        } else if (currentCommit !== prevCommit) {
          // New commit / pull / rebase — branch name unchanged but commit moved.
          // Fire branch listeners so the log panel refreshes.
          this.prevCommits.set(repoId, currentCommit);
          this.scheduleRefresh([repoId]);
          this.scheduleBranchRefresh(repoId);
        } else {
          this.scheduleRefresh([repoId]);
        }
      });
      disposables.push(d);
      this.statusWatchers.set(repoId, { vsRepo, disposables });
      // vsRepo.state.onDidChange covers git index changes but may miss rapid
      // working-tree edits that haven't been staged. Also watch saved documents
      // inside this repo — onDidSaveTextDocument is already set up in constructor.
      return;
    }

    // Fallback: FileSystemWatcher when vscode.git is unavailable.
    // Watch .git/index (stage changes), .git/HEAD + refs (branch changes),
    // and all working-tree file creates/changes/deletes.
    const onChanged = () => this.scheduleRefresh([repoId]);
    const onBranchChanged = () => { this.scheduleRefresh([repoId]); this.scheduleBranchRefresh(repoId); };

    // .git internals
    const w1 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.git/index'));
    const w2 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.git/HEAD'));
    const w3 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.git/refs/**'));
    // Working-tree: all three events (create, change, delete) — excludes .git itself
    const w4 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '**/*'));
    // .gitmodules watcher is already created in reinitialize() for all workspace folders

    w1.onDidChange(onChanged); w1.onDidCreate(onChanged); w1.onDidDelete(onChanged);
    w2.onDidChange(onBranchChanged); w2.onDidCreate(onBranchChanged);
    w3.onDidChange(onBranchChanged); w3.onDidCreate(onBranchChanged); w3.onDidDelete(onBranchChanged);
    w4.onDidCreate(onChanged); w4.onDidChange(onChanged); w4.onDidDelete(onChanged);

    disposables.push(w1, w2, w3, w4);
    this.statusWatchers.set(repoId, { disposables });
  }

  /**
   * Debounced status sweep. `repoIds` names the repos something happened in; the sweep
   * re-reads those plus the repos their status depends on (see statusDependents) and reuses
   * the cached status of the rest. Omitted, every repo is re-read.
   */
  private scheduleRefresh(repoIds?: Iterable<string>): void {
    if (this.pendingRefresh !== 'all') {
      if (!repoIds) {
        this.pendingRefresh = 'all';
      } else {
        const pending = this.pendingRefresh ?? new Set<string>();
        for (const id of repoIds) this.statusDependents(id).forEach(d => pending.add(d));
        this.pendingRefresh = pending;
      }
    }
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null;
      void this.runPendingRefresh();
    }, 300);
  }

  private scheduleRefreshFor(uris: readonly vscode.Uri[]): void {
    const repoIds = this.reposContaining(uris);
    if (repoIds.length > 0) this.scheduleRefresh(repoIds);
  }

  /** The innermost tracked repo of each uri, without duplicates; uris outside every repo are dropped. */
  private reposContaining(uris: readonly vscode.Uri[]): string[] {
    const ids = new Set<string>();
    for (const uri of uris) {
      const repo = this.getServiceForFile(uri.fsPath);
      if (repo) ids.add(repo.repoId);
    }
    return Array.from(ids);
  }

  /**
   * The repos whose status can change along with `repoId`'s: the repo itself, its
   * superprojects (a submodule moving its HEAD or getting dirty shows up as a modified
   * gitlink in each one above it), and the other worktrees of the same repository
   * (they share refs, so a fetch or a commit in one moves the others' ahead/behind).
   */
  private statusDependents(repoId: string): string[] {
    const ids = new Set<string>([repoId]);
    let meta = this.repoMetas.get(repoId);
    while (meta?.parentRepoId && !ids.has(meta.parentRepoId)) {
      ids.add(meta.parentRepoId);
      meta = this.repoMetas.get(meta.parentRepoId);
    }
    const self = this.repoMetas.get(repoId);
    const mainPath = self?.isWorktree ? self.mainWorktreePath : repoId;
    if (mainPath) {
      for (const m of this.repoMetas.values()) {
        if (m.id === mainPath || (m.isWorktree && m.mainWorktreePath === mainPath)) ids.add(m.id);
      }
    }
    return Array.from(ids);
  }

  /**
   * Run the pending sweep unless one is already running. Requests that arrive during a
   * sweep accumulate in pendingRefresh and are served by one follow-up sweep, so a slow
   * sweep never has another started alongside it, nor delivers its result after a newer one.
   */
  private async runPendingRefresh(): Promise<void> {
    if (this.refreshInFlight || !this.pendingRefresh) return;
    const pending = this.pendingRefresh;
    this.pendingRefresh = null;
    this.refreshInFlight = true;
    try {
      const generation = this.repoGeneration;
      const status = await this.refreshStatuses(pending === 'all' ? undefined : pending);
      // The repo set changed while the sweep ran; the rebuild schedules its own sweep.
      if (generation !== this.repoGeneration) return;
      this.detectNewUntrackedFiles(status);
      this.statusListeners.forEach(l => l(status));
    } finally {
      this.refreshInFlight = false;
      // Requests left over from the run; ones still debouncing will start it themselves.
      if (this.pendingRefresh && !this.refreshDebounce) void this.runPendingRefresh();
    }
  }

  /**
   * Re-read the status of the `stale` repos (every repo when omitted) straight from git
   * and combine it with the cached status of the others. A repo with nothing cached yet
   * is always read. A repo whose status fails is left out, as before caching.
   */
  private async refreshStatuses(stale?: ReadonlySet<string>): Promise<WorkspaceStatus> {
    const generation = this.repoGeneration;
    const targets = Array.from(this.repos.values())
      .filter(r => !stale || stale.has(r.repoId) || !this.statusCache.has(r.repoId));
    const results = await Promise.allSettled(targets.map(r => r.getStatusFresh()));

    if (generation !== this.repoGeneration) {
      // Read against a repo set that no longer exists — return it as is, don't cache it.
      return {
        repos: this.applySubmoduleStatus(
          results.filter((r): r is PromiseFulfilledResult<RepoStatus> => r.status === 'fulfilled').map(r => r.value)
        ),
      };
    }

    results.forEach((result, i) => {
      const repoId = targets[i].repoId;
      if (result.status === 'fulfilled') this.statusCache.set(repoId, result.value);
      else this.statusCache.delete(repoId);
    });
    const repos = Array.from(this.repos.keys())
      .map(id => this.statusCache.get(id))
      .filter((s): s is RepoStatus => !!s);
    return { repos: this.applySubmoduleStatus(repos) };
  }

  reinitializeAndRefresh(): void {
    this.reinitialize();
    this.setupGitInitWatchers();
    this.scheduleRefresh();
  }

  private detectNewUntrackedFiles(status: WorkspaceStatus): void {
    const newlyUntracked: Array<{ repo: GitService; relPath: string }> = [];

    for (const repoStatus of status.repos) {
      const repoId = repoStatus.repoId;
      const repo = this.repos.get(repoId);
      if (!repo) continue;

      const currentUntracked = new Set(
        repoStatus.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path)
      );
      const prev = this.prevUntracked.get(repoId);

      if (prev && this.initialStatusDone) {
        for (const p of currentUntracked) {
          if (!prev.has(p)) newlyUntracked.push({ repo, relPath: p });
        }
      }

      this.prevUntracked.set(repoId, currentUntracked);
    }

    this.initialStatusDone = true;

    if (newlyUntracked.length > 0) {
      const cfg = vscode.workspace.getConfiguration('gitcharm');
      const enabled = cfg.get<boolean>('promptAddUntrackedToGit', true);
      const viewMode = cfg.get<string>('changesViewMode', 'simplified');
      if (enabled && viewMode !== 'simplified') {
        void this.promptAddToGit(newlyUntracked);
      }
    }
  }

  private async promptAddToGit(
    files: Array<{ repo: GitService; relPath: string }>,
  ): Promise<void> {
    const names = files.map(f => f.relPath);
    const label = names.length === 1
      ? vscode.l10n.t('Do you want to add "{0}" to Git?', names[0])
      : vscode.l10n.t('Do you want to add {0} new files to Git?', names.length);

    const add = vscode.l10n.t('Add');
    const answer = await vscode.window.showInformationMessage(label, add, vscode.l10n.t('Cancel'));
    if (answer !== add) return;

    for (const { repo, relPath } of files) {
      await repo.stageFiles([relPath]).catch(() => {});
    }
    this.scheduleRefresh(files.map(f => f.repo.repoId));
  }

  /**
   * Coalesce a burst of ref-file events into one graph refresh. Kept separate
   * from scheduleRefresh (working-tree status) and scheduleBranchRefresh
   * (branch metadata) so that graph updates aren't held up by their longer
   * debounces, which exist to absorb working-tree churn.
   */
  private scheduleGraphRefresh(): void {
    const now = Date.now();
    if (this.graphPendingSince === 0) this.graphPendingSince = now;
    if (this.graphDebounce) clearTimeout(this.graphDebounce);
    // Wait out the burst, but not sooner than the rate floor allows...
    const debounced = Math.max(GRAPH_REFRESH_DEBOUNCE_MS, GRAPH_REFRESH_MIN_INTERVAL_MS - (now - this.lastGraphRefresh));
    // ...and never longer than the ceiling on a single pending refresh.
    const capped = Math.max(0, GRAPH_REFRESH_MAX_WAIT_MS - (now - this.graphPendingSince));
    this.graphDebounce = setTimeout(() => {
      this.graphDebounce = null;
      this.graphPendingSince = 0;
      this.lastGraphRefresh = Date.now();
      this.graphListeners.forEach(l => l());
    }, Math.min(debounced, capped));
  }

  onGraphChange(listener: BranchListener): vscode.Disposable {
    this.graphListeners.push(listener);
    return new vscode.Disposable(() => {
      this.graphListeners = this.graphListeners.filter(l => l !== listener);
    });
  }

  private scheduleBranchRefresh(repoId: string): void {
    // Graph listeners rely on the ref watcher for commit changes; a repo without one
    // (its git dir couldn't be resolved) only reports them through here.
    if (!this.graphWatchedRepos.has(repoId)) this.scheduleGraphRefresh();
    if (this.branchDebounce) clearTimeout(this.branchDebounce);
    this.branchDebounce = setTimeout(() => {
      this.branchListeners.forEach(l => l());
    }, 400);
  }

  onBranchChange(listener: BranchListener): vscode.Disposable {
    this.branchListeners.push(listener);
    return new vscode.Disposable(() => {
      this.branchListeners = this.branchListeners.filter(l => l !== listener);
    });
  }

  onReposChange(listener: BranchListener): vscode.Disposable {
    this.reposListeners.push(listener);
    return new vscode.Disposable(() => {
      this.reposListeners = this.reposListeners.filter(l => l !== listener);
    });
  }

  onWorktreeChange(listener: WorktreeListener): vscode.Disposable {
    this.worktreeListeners.push(listener);
    return new vscode.Disposable(() => {
      this.worktreeListeners = this.worktreeListeners.filter(l => l !== listener);
    });
  }

  /** Fires with only the branches that just became orphaned (upstream gone) by the most recent fetchAll(), not ones already known. */
  onOrphanBranches(listener: OrphanListener): vscode.Disposable {
    this.orphanListeners.push(listener);
    return new vscode.Disposable(() => {
      this.orphanListeners = this.orphanListeners.filter(l => l !== listener);
    });
  }

  async getWorktrees(repoId: string): Promise<WorktreeEntry[]> {
    const repo = this.repos.get(repoId);
    if (!repo) return [];
    try { return await repo.getWorktrees(); } catch { return []; }
  }

  async getAllWorktrees(): Promise<Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }>> {
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const results: Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }> = [];
    for (const [repoId, repo] of this.repos) {
      const meta = this.repoMetas.get(repoId);
      if (!meta) continue;
      // Only include top-level non-worktree repos — linked worktrees appear under their main repo
      if ((meta.depth ?? 0) > 0) continue;
      if (meta.isWorktree) continue;
      // Detect standalone linked worktree: .git is a file even though isWorktree is false
      // (isWorktree is false when the main repo is not in the same workspace)
      const gitDir = path.join(repoId, '.git');
      const isLinkedWorktree = fs.existsSync(gitDir) && fs.statSync(gitDir).isFile();
      try {
        const worktrees = (await repo.getWorktrees()).map(w => ({
          ...w,
          isInWorkspace: workspacePaths.some(wp => w.path === wp || w.path.startsWith(wp + path.sep)),
        }));
        results.push({ repoId, repoName: meta.name, repoColor: meta.color, worktrees, isLinkedWorktree });
      } catch {
        results.push({ repoId, repoName: meta.name, repoColor: meta.color, worktrees: [], isLinkedWorktree });
      }
    }
    return results;
  }

  private disposeWatchers(): void {
    this.watchers.forEach(d => d.dispose());
    this.watchers = [];
    this.statusWatchers.forEach(w => w.disposables.forEach(d => d.dispose()));
    this.statusWatchers.clear();
    this.graphWatchedRepos.clear();
    // A rebuild about to run (or being disposed) supersedes one still pending.
    if (this.reinitDebounce) { clearTimeout(this.reinitDebounce); this.reinitDebounce = null; }
    if (this.refreshDebounce) { clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    if (this.refreshFollowUp) { clearTimeout(this.refreshFollowUp); this.refreshFollowUp = null; }
    if (this.branchDebounce) { clearTimeout(this.branchDebounce); this.branchDebounce = null; }
    if (this.graphDebounce) { clearTimeout(this.graphDebounce); this.graphDebounce = null; }
    this.graphPendingSince = 0;
  }

  onStatusChange(listener: StatusListener): vscode.Disposable {
    this.statusListeners.push(listener);
    return new vscode.Disposable(() => {
      this.statusListeners = this.statusListeners.filter(l => l !== listener);
    });
  }

  getRepoMetas(): RepoMeta[] {
    return Array.from(this.repoMetas.values());
  }

  getRepo(repoId: string): GitService | undefined {
    return this.repos.get(repoId);
  }

  getServiceForFile(filePath: string): { repoId: string; rootPath: string } | undefined {
    let best: { repoId: string; rootPath: string } | undefined;
    for (const [repoId, meta] of this.repoMetas) {
      const prefix = meta.rootPath + path.sep;
      if (filePath.startsWith(prefix) || filePath === meta.rootPath) {
        if (!best || meta.rootPath.length > best.rootPath.length) {
          best = { repoId, rootPath: meta.rootPath };
        }
      }
    }
    return best;
  }

  /**
   * Build a map of repoId → Set of submodule relative paths registered under it.
   * Used to reclassify those entries in the parent's file list as 'submodule'
   * instead of 'modified', so the UI can display them with the correct letter.
   */
  private buildSubmodulePaths(): Map<string, Set<string>> {
    // From every discovered submodule, not only registered ones: a hidden submodule's
    // gitlink still shows up in its superproject's changes.
    const map = new Map<string, Set<string>>();
    for (const sub of this.discoveredSubmodules) {
      if (!map.has(sub.parentRepoId)) map.set(sub.parentRepoId, new Set());
      map.get(sub.parentRepoId)!.add(sub.relPath);
    }
    return map;
  }

  private applySubmoduleStatus(repos: import('../types/git').RepoStatus[]): import('../types/git').RepoStatus[] {
    const submodulePaths = this.buildSubmodulePaths();
    return repos.map(r => {
      const subPaths = submodulePaths.get(r.repoId);

      const reclassify = (f: import('../types/git').FileStatus) =>
        subPaths?.has(f.path) ? { ...f, status: 'submodule' as const } : f;

      // Hide any file/directory whose absolute path sits inside a nested git
      // repository — i.e. absolutePath/.git exists (or absolutePath is itself
      // inside such a directory). This matches VS Code's built-in behaviour of
      // not surfacing files from foreign repos in the parent's status panel.
      // We check the first path component so "deep/nested-repo/foo.ts" is also
      // caught even though git reports only "deep/nested-repo/" as untracked.
      const isInsideNestedRepo = (f: import('../types/git').FileStatus): boolean => {
        // Walk from the file's absolute path (inclusive) up to the repo root.
        // git status reports nested repo directories as the directory itself
        // (e.g. "deep/nested-repo/"), so absolutePath IS the nested repo root —
        // we must check it first, then its ancestors.
        const repoRoot = r.repoId;
        let dir = f.absolutePath;
        while (dir.startsWith(repoRoot + path.sep)) {
          if (fs.existsSync(path.join(dir, '.git'))) return true;
          dir = path.dirname(dir);
        }
        return false;
      };

      return {
        ...r,
        stagedFiles: r.stagedFiles.map(reclassify).filter(f => !isInsideNestedRepo(f)),
        unstagedFiles: r.unstagedFiles.map(reclassify).filter(f => !isInsideNestedRepo(f)),
      };
    });
  }

  async getAllStatuses(): Promise<WorkspaceStatus> {
    const results = await Promise.allSettled(
      Array.from(this.repos.values()).map(r => r.getStatus())
    );
    return {
      repos: this.applySubmoduleStatus(
        results
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<GitService['getStatus']>>> => r.status === 'fulfilled')
          .map(r => r.value)
      ),
    };
  }

  /**
   * The status of every repo as the last sweep read it, reading only repos it hasn't seen
   * yet. Sweeps follow every working-tree event, so this is as current as what listeners
   * were last sent — for views that show the status, like the Git Log's uncommitted row,
   * and would otherwise run a status in each repo on every load.
   */
  async getLatestStatuses(): Promise<WorkspaceStatus> {
    const missing = new Set(Array.from(this.repos.keys()).filter(id => !this.statusCache.has(id)));
    if (missing.size === 0) {
      const repos = Array.from(this.repos.keys())
        .map(id => this.statusCache.get(id))
        .filter((st): st is RepoStatus => !!st);
      return { repos: this.applySubmoduleStatus(repos) };
    }
    return this.refreshStatuses(missing);
  }

  /** Like getAllStatuses but forces VSCode's git extension to re-read from disk first. */
  async getAllStatusesFresh(): Promise<WorkspaceStatus> {
    return this.refreshStatuses();
  }

  async getAllBranches(): Promise<BranchInfo[]> {
    const [allBranches, currentBranches] = await Promise.all([
      Promise.allSettled(Array.from(this.repos.values()).map(r => r.getBranches())),
      Promise.allSettled(Array.from(this.repos.values()).map(r => r.getCurrentBranch())),
    ]);

    const branches = allBranches
      .filter((r): r is PromiseFulfilledResult<BranchInfo[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);

    // Merge in getCurrentBranch results: they carry isHead:true and detachedTag.
    // In normal HEAD, getBranches() already marks the right branch isHead:true so
    // the current branch entry is a duplicate — skip it. In detached HEAD on a tag,
    // getBranches() has no isHead:true entry, so we append the HEAD entry so the
    // sidebar knows which tag is active.
    for (const r of currentBranches) {
      if (r.status !== 'fulfilled') continue;
      const cur = r.value;
      if (!cur.detachedTag && !cur.detachedHash) continue; // normal branch — already handled by getBranches()
      // Remove any existing entry for this repoId that might have isHead:true (safety)
      const idx = branches.findIndex(b => b.repoId === cur.repoId && b.isHead);
      if (idx >= 0) branches.splice(idx, 1);
      branches.push(cur);
    }

    // For worktree repos, duplicate their isHead branch entry under the main repo's repoId.
    // The Log Panel shows commits with repoId=mainRepo (since worktrees are filtered out),
    // so headHashByRepo in the webview must be keyed by mainRepo to correctly identify HEAD.
    for (const [repoId, meta] of this.repoMetas) {
      if (!meta.isWorktree || !meta.mainWorktreePath) continue;
      const headBranch = branches.find(b => b.repoId === repoId && b.isHead);
      if (!headBranch) continue;
      // Only add if the main repo doesn't already have an isHead entry with the same hash
      const mainAlreadyHasThisHead = branches.some(
        b => b.repoId === meta.mainWorktreePath && b.isHead && b.lastCommitHash === headBranch.lastCommitHash
      );
      if (!mainAlreadyHasThisHead) {
        branches.push({ ...headBranch, repoId: meta.mainWorktreePath });
      }
    }

    return branches;
  }

  async getInterleavedLog(repoIds: string[], limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; compareByRepo?: Record<string, CompareRange> }): Promise<CommitNode[]> {
    const { compareByRepo, ...logOpts }: NonNullable<typeof opts> = opts ?? {};
    const requested = repoIds.length > 0
      ? repoIds.map(id => this.repos.get(id)).filter(Boolean) as GitService[]
      : Array.from(this.repos.values());
    // In compare mode a repo without a resolved range has nothing to show
    const targets = compareByRepo ? requested.filter(r => compareByRepo[r.repoId]) : requested;

    // Build a map from main repo path → worktree GitServices, so getLog can collect
    // unpushed hashes from worktree branches (which appear in the log via --all)
    const worktreesByMainRepo = new Map<string, GitService[]>();
    for (const [repoId, meta] of this.repoMetas) {
      if (meta.isWorktree && meta.mainWorktreePath) {
        const wtService = this.repos.get(repoId);
        if (!wtService) continue;
        const list = worktreesByMainRepo.get(meta.mainWorktreePath) ?? [];
        list.push(wtService);
        worktreesByMainRepo.set(meta.mainWorktreePath, list);
      }
    }

    const isInterleaved = targets.length > 1;
    const fetchLimit = isInterleaved ? limit + skip : limit;
    const fetchSkip = isInterleaved ? 0 : skip;
    const results = await Promise.allSettled(
      targets.map(r => r.getLog(fetchLimit, fetchSkip, { ...logOpts, compare: compareByRepo?.[r.repoId], worktreeServices: worktreesByMainRepo.get(r.rootPath) ?? [] }))
    );
    const allCommits = mergeCommitLists(results
      .filter((r): r is PromiseFulfilledResult<CommitNode[]> => r.status === 'fulfilled')
      .map(r => r.value));

    const pageStart = isInterleaved ? skip : 0;
    return allCommits.slice(pageStart, pageStart + limit);
  }

  async fetchAll(): Promise<void> {
    const repos = Array.from(this.repos.values());
    await Promise.allSettled(repos.map(r => r.fetchAll()));
    if (this.orphanListeners.length > 0) await this.detectNewlyOrphanedBranches(repos);
  }

  /** Diffs each repo's gone-upstream branches against knownOrphanBranches so listeners only hear about branches that just became orphaned, not ones already surfaced on a previous fetch. */
  private async detectNewlyOrphanedBranches(repos: GitService[]): Promise<void> {
    const newlyOrphaned: Array<{ repoId: string; branchName: string }> = [];
    const results = await Promise.allSettled(repos.map(r => r.getBranches()));
    results.forEach((result, i) => {
      if (result.status !== 'fulfilled') return;
      const repo = repos[i];
      const currentlyGone = new Set(result.value.filter(b => !b.isRemote && b.upstreamGone).map(b => b.name));
      if (!this.orphanBaselineDone.has(repo.repoId)) {
        // First observation for this repo: we don't know whether these branches just lost
        // a real upstream or never had one, so seed the baseline silently rather than guess.
        this.orphanBaselineDone.add(repo.repoId);
        this.knownOrphanBranches.set(repo.repoId, currentlyGone);
        return;
      }
      const known = this.knownOrphanBranches.get(repo.repoId) ?? new Set<string>();
      for (const name of currentlyGone) {
        if (!known.has(name)) newlyOrphaned.push({ repoId: repo.repoId, branchName: name });
      }
      this.knownOrphanBranches.set(repo.repoId, currentlyGone);
    });
    if (newlyOrphaned.length > 0) this.orphanListeners.forEach(l => l(newlyOrphaned));
  }

  async pullAll(rebase = false): Promise<Array<{ repoId: string; ok: boolean; message: string }>> {
    const repos = Array.from(this.repos.values());
    const results: Array<{ repoId: string; ok: boolean; message: string }> = [];
    for (const r of repos) {
      try {
        const message = rebase ? await r.pullRebase() : await r.pull();
        results.push({ repoId: r.repoId, ok: true, message });
      } catch (e: unknown) {
        results.push({ repoId: r.repoId, ok: false, message: formatGitError(e) });
      }
    }
    return results;
  }

  async pushAll(): Promise<Array<{ repoId: string; ok: boolean; message: string }>> {
    const repos = Array.from(this.repos.values());
    const results: Array<{ repoId: string; ok: boolean; message: string }> = [];
    for (const r of repos) {
      try {
        const message = await r.push();
        results.push({ repoId: r.repoId, ok: true, message });
      } catch (e: unknown) {
        results.push({ repoId: r.repoId, ok: false, message: formatGitError(e) });
      }
    }
    return results;
  }

  private setupGitInitWatchers(): void {
    this.gitInitWatchers.forEach(d => d.dispose());
    this.gitInitWatchers = [];

    const maxDepth = this.getRepositoryScanMaxDepth();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // At depth 0 only the workspace root can become a repo; if it already is
      // one, its normal repo watcher is enough. At depth > 0, still watch known
      // roots so newly cloned/git-init'ed child repositories are detected.
      if (maxDepth === 0 && this.repos.has(folder.uri.fsPath)) continue;

      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder.uri, maxDepth > 0 ? '**/.git' : '.git')
      );
      const onGitCreated = (gitUri: vscode.Uri) => {
        const repoPath = path.dirname(gitUri.fsPath);
        const depth = this.repositoryScanDepth(folder.uri.fsPath, repoPath);
        if (depth < 0 || depth > maxDepth) return;
        if (this.isRepositoryScanIgnored(repoPath, folder.uri.fsPath)) return;
        this.scheduleReinitialize();
      };
      w.onDidCreate(onGitCreated);
      this.gitInitWatchers.push(w);
    }
  }

  dispose(): void {
    this.disposeWatchers();
    this.gitInitWatchers.forEach(d => d.dispose());
    this.globalListeners.forEach(d => d.dispose());
    this.globalListeners = [];
  }
}
