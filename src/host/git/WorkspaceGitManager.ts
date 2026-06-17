import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from './GitService';
import type { WorktreeEntry } from './GitService';
import { getVscodeGitApi, getVscodeRepository } from './VscodeGitApi';
import type { BranchInfo, CommitNode, RepoMeta, WorkspaceStatus } from '../types/git';
import { PROJECT_COLORS } from '../types/workspace';

const MAX_SUBMODULE_DEPTH = 5;
const DEFAULT_REPOSITORY_SCAN_MAX_DEPTH = 1;
const DEFAULT_REPOSITORY_SCAN_IGNORED_FOLDERS = ['node_modules'];

type StatusListener = (status: WorkspaceStatus) => void;
type BranchListener = () => void;
type WorktreeListener = (repoId: string) => void;

export type { WorktreeEntry };

export class WorkspaceGitManager implements vscode.Disposable {
  private repos = new Map<string, GitService>();
  private repoMetas = new Map<string, RepoMeta>();
  /** Per-repo watchers — recreated on reinitialize(). */
  private watchers: vscode.Disposable[] = [];
  /** Global workspace listeners — created once in constructor, disposed in dispose(). */
  private globalListeners: vscode.Disposable[] = [];
  private statusListeners: StatusListener[] = [];
  private branchListeners: BranchListener[] = [];
  private reposListeners: BranchListener[] = [];
  private worktreeListeners: WorktreeListener[] = [];
  private refreshDebounce: NodeJS.Timeout | null = null;
  private refreshFollowUp: NodeJS.Timeout | null = null;
  private branchDebounce: NodeJS.Timeout | null = null;
  /** Watchers for .git creation under workspace folders — rebuilt when folders/settings change. */
  private gitInitWatchers: vscode.Disposable[] = [];
  private prevHeads = new Map<string, string>();      // repoId → branch name
  private prevCommits = new Map<string, string>();    // repoId → commit hash
  private prevUntracked = new Map<string, Set<string>>(); // repoId → known untracked paths
  private initialStatusDone = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.globalListeners.push(
      // Workspace folder changes → rebuild everything and push fresh status to listeners
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.reinitialize(); this.scheduleRefresh(); }),

      // File saved inside a repo → refresh status (immediate + follow-up for slow git index updates)
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const filePath = doc.uri.fsPath;
        const inRepo = Array.from(this.repoMetas.values()).some(m => filePath.startsWith(m.rootPath));
        if (inRepo) {
          this.scheduleRefresh();
          // Schedule a follow-up refresh in case git hasn't updated its index yet
          if (this.refreshFollowUp) clearTimeout(this.refreshFollowUp);
          this.refreshFollowUp = setTimeout(() => this.scheduleRefresh(), 1200);
        }
      }),

      // File-explorer operations (create/delete/rename via VSCode UI or extensions)
      vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),

      // Repository discovery settings affect the repo set, watcher patterns, and colors.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('gitcharm.repositoryScanMaxDepth') ||
          e.affectsConfiguration('gitcharm.repositoryScanIgnoredFolders') ||
          e.affectsConfiguration('gitcharm.projectColors')
        ) {
          this.reinitialize();
          this.setupGitInitWatchers();
          this.scheduleRefresh();
        }
      }),

      // A folder already in the workspace may become a git repo (via git init or clone).
      // Watch for .git creation under workspace folders to trigger reinitialize.
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.setupGitInitWatchers()),
    );

    this.reinitialize();
    this.setupGitInitWatchers();

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
          this.fetchOnStartupIfEnabled();
        }
      });
      this.globalListeners.push(d);
    } else if (!gitApi) {
      // vscode.git extension is not yet active (activates after us) — watch for it.
      // When it activates, reinitialize so proper vsRepo watchers replace the
      // FileSystemWatcher fallback.
      const d = vscode.extensions.onDidChange(() => {
        if (getVscodeGitApi()) {
          d.dispose();
          this.reinitialize();
          this.scheduleRefresh();
          this.fetchOnStartupIfEnabled();
        }
      });
      this.globalListeners.push(d);
    } else {
      // vscode.git is already initialized — fetch after repos are set up
      this.fetchOnStartupIfEnabled();
    }
  }

  private fetchOnStartupIfEnabled(): void {
    const enabled = vscode.workspace.getConfiguration('gitcharm').get<boolean>('fetchOnStartup', true);
    if (enabled) {
      this.fetchAll().catch(console.error);
    }
  }

  private reinitialize(): void {
    this.disposeWatchers();
    this.repos.clear();
    this.repoMetas.clear();
    this.prevHeads.clear();
    this.prevCommits.clear();
    this.prevUntracked.clear();
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
        const color = customColors[folder.name] ?? PROJECT_COLORS[colorIdx.value++ % PROJECT_COLORS.length];

        const { isWorktree, mainWorktreePath } = this.detectLinkedWorktree(folder.uri.fsPath);

        const meta: RepoMeta = { id: repoId, name: folder.name, rootPath: folder.uri.fsPath, color, depth: 0, isWorktree, mainWorktreePath };
        this.repoMetas.set(repoId, meta);
        this.repos.set(repoId, new GitService(repoId, folder.uri.fsPath));
        this.setupWatcher(folder.uri.fsPath, repoId);
        this.discoverSubmodules(folder.uri.fsPath, repoId, 1, colorIdx, customColors);
        this.setupRepositoryAuxWatchers(folder.uri.fsPath, repoId);
      }
    });

    const repositoryScanMaxDepth = this.getRepositoryScanMaxDepth();
    if (repositoryScanMaxDepth > 0) {
      folders.forEach((folder) => {
        this.discoverNestedRepositories(folder.uri.fsPath, repositoryScanMaxDepth, colorIdx, customColors);
      });
    }

    // Notify listeners that the set of known repos has changed (e.g. submodule added/removed)
    this.reposListeners.forEach(l => l());
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
    const onGitmodulesChanged = () => { this.reinitialize(); this.setupGitInitWatchers(); this.scheduleRefresh(); };
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

    const relPath = path.relative(workspaceRoot, normalizedRepoPath).split(path.sep).join('/');
    const displayName = relPath && !relPath.startsWith('..') ? relPath : path.basename(normalizedRepoPath);
    const basename = path.basename(normalizedRepoPath);
    const customColor = customColors[displayName] ?? customColors[basename];
    const color = customColor ?? PROJECT_COLORS[colorIdx.value++ % PROJECT_COLORS.length];
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
    this.discoverSubmodules(normalizedRepoPath, normalizedRepoPath, 1, colorIdx, customColors);
    this.setupRepositoryAuxWatchers(normalizedRepoPath, normalizedRepoPath);
  }

  private discoverSubmodules(
    parentPath: string,
    parentRepoId: string,
    depth: number,
    colorIdx: { value: number },
    customColors: Record<string, string>,
  ): void {
    if (depth > MAX_SUBMODULE_DEPTH) return;

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
      const subGitDir = path.join(subAbsPath, '.git');

      // Submodule may be uninitialized — .git may not exist yet
      if (!fs.existsSync(subAbsPath)) continue;

      // Avoid double-registering a path that's already a workspace folder
      if (this.repos.has(subAbsPath)) continue;

      // Guard against circular references
      if (subAbsPath === parentPath || parentPath.startsWith(subAbsPath + path.sep)) continue;

      const subName = path.basename(subRelPath);
      // Each submodule gets its own color slot — same as a regular workspace folder.
      const color = customColors[subName] ?? PROJECT_COLORS[colorIdx.value++ % PROJECT_COLORS.length];

      const meta: RepoMeta = {
        id: subAbsPath,
        name: subName,
        rootPath: subAbsPath,
        color,
        isSubmodule: true,
        parentRepoId,
        submodulePath: subRelPath,
        depth,
      };
      this.repoMetas.set(subAbsPath, meta);
      this.repos.set(subAbsPath, new GitService(subAbsPath, subAbsPath));

      // Only set up watcher if the submodule is initialized (has .git)
      if (fs.existsSync(subGitDir)) {
        this.setupWatcher(subAbsPath, subAbsPath);
      }

      // Recurse into nested submodules
      this.discoverSubmodules(subAbsPath, subAbsPath, depth + 1, colorIdx, customColors);
    }
  }

  private setupWatcher(repoPath: string, repoId: string): void {
    // Primary: VS Code Git API state changes — fired for all git operations
    // (built-in git, GitCharm, terminal, other extensions).
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
          this.scheduleRefresh();
          this.scheduleBranchRefresh();
        } else if (currentCommit !== prevCommit) {
          // New commit / pull / rebase — branch name unchanged but commit moved.
          // Fire branch listeners so the log panel refreshes.
          this.prevCommits.set(repoId, currentCommit);
          this.scheduleRefresh();
          this.scheduleBranchRefresh();
        } else {
          this.scheduleRefresh();
        }
      });
      this.watchers.push(d);
      // vsRepo.state.onDidChange covers git index changes but may miss rapid
      // working-tree edits that haven't been staged. Also watch saved documents
      // inside this repo — onDidSaveTextDocument is already set up in constructor.
      return;
    }

    // Fallback: FileSystemWatcher when vscode.git is unavailable.
    // Watch .git/index (stage changes), .git/HEAD + refs (branch changes),
    // and all working-tree file creates/changes/deletes.
    const onChanged = () => this.scheduleRefresh();
    const onBranchChanged = () => { this.scheduleRefresh(); this.scheduleBranchRefresh(); };

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

    this.watchers.push(w1, w2, w3, w4);
  }

  private scheduleRefresh(): void {
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(async () => {
      const status = await this.getAllStatusesFresh();
      this.detectNewUntrackedFiles(status);
      this.statusListeners.forEach(l => l(status));
    }, 300);
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
      ? `Do you want to add "${names[0]}" to Git?`
      : `Do you want to add ${names.length} new files to Git?`;

    const answer = await vscode.window.showInformationMessage(label, 'Add', 'Cancel');
    if (answer !== 'Add') return;

    for (const { repo, relPath } of files) {
      await repo.stageFiles([relPath]).catch(() => {});
    }
    this.scheduleRefresh();
  }

  private scheduleBranchRefresh(): void {
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
    if (this.refreshDebounce) { clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    if (this.refreshFollowUp) { clearTimeout(this.refreshFollowUp); this.refreshFollowUp = null; }
    if (this.branchDebounce) { clearTimeout(this.branchDebounce); this.branchDebounce = null; }
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
    const map = new Map<string, Set<string>>();
    for (const meta of this.repoMetas.values()) {
      if (!meta.isSubmodule || !meta.parentRepoId || !meta.submodulePath) continue;
      if (!map.has(meta.parentRepoId)) map.set(meta.parentRepoId, new Set());
      map.get(meta.parentRepoId)!.add(meta.submodulePath);
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

  /** Like getAllStatuses but forces VSCode's git extension to re-read from disk first. */
  async getAllStatusesFresh(): Promise<WorkspaceStatus> {
    const results = await Promise.allSettled(
      Array.from(this.repos.values()).map(r => r.getStatusFresh())
    );
    return {
      repos: this.applySubmoduleStatus(
        results
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<GitService['getStatus']>>> => r.status === 'fulfilled')
          .map(r => r.value)
      ),
    };
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

  async getInterleavedLog(repoIds: string[], limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string }): Promise<CommitNode[]> {
    const targets = repoIds.length > 0
      ? repoIds.map(id => this.repos.get(id)).filter(Boolean) as GitService[]
      : Array.from(this.repos.values());

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

    const results = await Promise.allSettled(
      targets.map(r => r.getLog(limit, skip, { ...opts, worktreeServices: worktreesByMainRepo.get(r.rootPath) ?? [] }))
    );
    const allCommits = results
      .filter((r): r is PromiseFulfilledResult<CommitNode[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);

    allCommits.sort((a, b) => new Date(b.committerDate).getTime() - new Date(a.committerDate).getTime());
    return allCommits.slice(0, limit);
  }

  async fetchAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.repos.values()).map(r => r.fetchAll()));
  }

  async pullAll(rebase = false): Promise<Array<{ repoId: string; ok: boolean; message: string }>> {
    const repos = Array.from(this.repos.values());
    const results: Array<{ repoId: string; ok: boolean; message: string }> = [];
    for (const r of repos) {
      try {
        const message = rebase ? await r.pullRebase() : await r.pull();
        results.push({ repoId: r.repoId, ok: true, message });
      } catch (e: any) {
        const detail = e?.stderr?.trim() || e?.gitErrorCode || e?.message || 'Unknown error';
        results.push({ repoId: r.repoId, ok: false, message: detail });
      }
    }
    return results;
  }

  async pushAll(): Promise<Array<{ repoId: string; ok: boolean; message: string }>> {
    const repos = Array.from(this.repos.values());
    const results: Array<{ repoId: string; ok: boolean; message: string }> = [];
    for (const r of repos) {
      try {
        await r.push();
        results.push({ repoId: r.repoId, ok: true, message: 'pushed' });
      } catch (e: any) {
        const detail = e?.stderr?.trim() || e?.gitErrorCode || e?.message || 'Unknown error';
        results.push({ repoId: r.repoId, ok: false, message: detail });
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
        this.reinitialize();
        this.setupGitInitWatchers();
        this.scheduleRefresh();
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
