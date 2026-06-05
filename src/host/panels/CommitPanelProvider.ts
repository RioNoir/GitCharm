import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { ShelveService } from '../git/ShelveService';
import { ChangelistService } from '../git/ChangelistService';
import { ShelveDocumentProvider, applyPatchToContent } from '../utils/ShelveDocumentProvider';
import type { CommitToHostMsg, HostToCommitMsg } from '../types/messages';
import type { WorkspaceStatus } from '../types/git';
import { CHANGELIST_UNVERSIONED_ID } from '../types/git';
import { parseConflictFile } from '../git/ConflictParser';
import { loadIconTheme } from '../utils/IconThemeService';
import type { MergeEditorProvider } from './MergeEditorProvider';
import type { GitLogPanelProvider } from './GitLogPanelProvider';
import type { GitProfileService } from '../git/GitProfileService';
import { LOCAL_PROFILE_ID, GLOBAL_PROFILE_ID } from '../git/GitProfileService';

export class CommitPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitcharm.commitPanel';
  private view?: vscode.WebviewView;
  private logProvider?: GitLogPanelProvider;
  private changelistService?: ChangelistService;

  setMergeEditorProvider(provider: MergeEditorProvider): void {
    this.mergeEditorProvider = provider;
  }

  setLogProvider(provider: GitLogPanelProvider): void {
    this.logProvider = provider;
  }

  prefillCommitMessage(message: string): void {
    this.post({ type: 'COMMIT_SET_MESSAGE', message });
  }
  private shelveServices = new Map<string, ShelveService>();

  private getShelveService(repoId: string): ShelveService | undefined {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return undefined;
    if (!this.shelveServices.has(repoId)) {
      this.shelveServices.set(repoId, new ShelveService(repo.rootPath, this.globalStoragePath));
    }
    return this.shelveServices.get(repoId);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly globalStoragePath: string,
    private readonly shelveDocProvider: ShelveDocumentProvider,
    private mergeEditorProvider?: MergeEditorProvider,
    private readonly profileService?: GitProfileService
  ) {
    this.manager.onStatusChange((status) => {
      this.postChangelistsUpdate(status);
      this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
    });

    this.manager.onBranchChange(async () => {
      for (const meta of this.manager.getRepoMetas()) {
        const repo = this.manager.getRepo(meta.id);
        if (!repo) continue;
        const branches = await repo.getBranches();
        this.post({ type: 'COMMIT_BRANCHES_UPDATE', repoId: meta.id, branches });
      }
    });
  }

  /**
   * Resolves the effective profile for the repo, writes its credentials into
   * .git/config (so all Git tools see them), and returns them for -c injection.
   * For implicit local/global fallback no injection is needed — git already
   * has the right config natively.
   */
  private async getCommitCredentials(repoPath: string): Promise<{ gitName: string; gitEmail: string } | undefined> {
    if (!this.profileService) return undefined;
    const result = await this.profileService.getEffectiveProfile(repoPath);
    if (!result) {
      vscode.window.showWarningMessage('GitCharm: No Git identity configured. Set a profile before committing.');
      return undefined;
    }
    if (result.source === 'local' || result.source === 'global') return undefined;
    const { gitName, gitEmail } = result.profile;
    if (!gitName && !gitEmail) return undefined;
    // Persist into .git/config so the identity is visible to all Git tools
    await this.profileService.writeLocalCreds(repoPath, gitName, gitEmail).catch(() => {});
    return { gitName, gitEmail };
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.file(vscode.env.appRoot),
        ...vscode.extensions.all.map(e => vscode.Uri.file(e.extensionPath)),
      ],
    };

    webviewView.webview.html = getWebviewHtml(
      webviewView.webview,
      this.extensionUri,
      'commitPanel',
      'GitCharm Commit'
    );

    webviewView.webview.onDidReceiveMessage((msg: CommitToHostMsg) =>
      this.handleMessage(msg, webviewView.webview)
    );

    // Refresh status whenever the panel becomes visible (e.g. user switches to it)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.manager.getAllStatuses().then(status => {
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        });
      }
    });

    // Sync current state — send changelists first so setStatus can read the correct viewMode
    this.manager.getAllStatuses().then(status => {
      this.postChangelistsUpdate(status);
      this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
      loadIconTheme(webviewView.webview).then(iconTheme => {
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status, iconTheme });
      }).catch(() => { /* icon theme optional */ });
    });

    // Re-send icon theme when the user changes icon or color theme
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
        if (this.view) {
          loadIconTheme(this.view.webview).then(iconTheme => {
            this.manager.getAllStatuses().then(status => {
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status, iconTheme });
            });
          }).catch(() => { /* icon theme optional */ });
        }
      }
      if (e.affectsConfiguration('gitcharm.changesViewMode')) {
        this.manager.getAllStatuses().then(status => {
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        });
      }
    });

    webviewView.onDidDispose(() => configWatcher.dispose());
  }

  private post(msg: HostToCommitMsg): void {
    this.view?.webview.postMessage(msg);
  }

  private getChangesViewMode(): 'simplified' | 'changelists' {
    return vscode.workspace.getConfiguration('gitcharm').get<'simplified' | 'changelists'>('changesViewMode', 'simplified');
  }

  private getOrCreateChangelistService(): ChangelistService | undefined {
    if (this.changelistService) return this.changelistService;
    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folderPath) return undefined;
    const workspaceFilePath = vscode.workspace.workspaceFile?.scheme === 'file'
      ? vscode.workspace.workspaceFile.fsPath
      : undefined;
    this.changelistService = new ChangelistService(folderPath, workspaceFilePath);
    return this.changelistService;
  }

  private postChangelistsUpdate(status?: WorkspaceStatus): void {
    const svc = this.getOrCreateChangelistService();
    if (!svc) return;
    if (status) svc.reconcile(status.repos);
    this.post({
      type: 'CHANGELISTS_UPDATE',
      changelists: svc.getAll(),
      viewMode: this.getChangesViewMode(),
    });
  }

  private buildChangelistAssignments(
    svc: ChangelistService,
    repoId: string,
    paths?: string[],
  ): Array<{ path: string; changelistId: string; changelistName: string }> | undefined {
    const result: Array<{ path: string; changelistId: string; changelistName: string }> = [];
    for (const cl of svc.getAll()) {
      const clPaths = cl.fileAssignments[repoId] ?? [];
      for (const p of clPaths) {
        if (!paths || paths.includes(p)) {
          result.push({ path: p, changelistId: cl.id, changelistName: cl.name });
        }
      }
    }
    return result.length > 0 ? result : undefined;
  }

  private async restoreChangelistAssignments(
    repoId: string,
    assignments: Array<{ path: string; changelistId: string; changelistName: string }>,
  ): Promise<void> {
    const svc = this.getOrCreateChangelistService();
    if (!svc) return;
    // Ensure all target changelists exist (recreate if deleted)
    const existing = svc.getAll();
    const neededIds = [...new Set(assignments.map(a => a.changelistId))];
    for (const id of neededIds) {
      const { CHANGELIST_DEFAULT_ID: DEF, CHANGELIST_UNVERSIONED_ID: UNV } = await import('../types/git');
      if (id === DEF || id === UNV) continue;
      if (!existing.find(c => c.id === id)) {
        const name = assignments.find(a => a.changelistId === id)?.changelistName ?? id;
        const newCl = svc.create(name);
        // Override the auto-generated id to match the original (so assignments work)
        // We can't do that easily, so instead remap to the new id
        const newId = newCl.id;
        for (const a of assignments) {
          if (a.changelistId === id) a.changelistId = newId;
        }
      }
    }
    svc.moveFiles(assignments.map(a => ({ repoId, path: a.path, changelistId: a.changelistId })));
  }

  private async stageUnversionedFiles(
    svc: ChangelistService,
    assignments: Array<{ repoId: string; path: string; changelistId: string }>,
  ): Promise<void> {
    const unversionedCl = svc.getAll().find(c => c.id === CHANGELIST_UNVERSIONED_ID);
    if (!unversionedCl) return;
    const byRepo = new Map<string, string[]>();
    for (const { repoId, path: filePath, changelistId } of assignments) {
      if (changelistId === CHANGELIST_UNVERSIONED_ID) continue;
      const unvPaths = unversionedCl.fileAssignments[repoId] ?? [];
      if (!unvPaths.includes(filePath)) continue;
      if (!byRepo.has(repoId)) byRepo.set(repoId, []);
      byRepo.get(repoId)!.push(filePath);
    }
    for (const [repoId, paths] of byRepo) {
      const repo = this.manager.getRepo(repoId);
      if (repo) await repo.stageFiles(paths).catch(() => {});
    }
  }

  private async handleMessage(msg: CommitToHostMsg, webview: vscode.Webview): Promise<void> {
    switch (msg.type) {
      case 'COMMIT_REQUEST_STATUS': {
        const [repos, status, iconTheme] = await Promise.all([
          Promise.resolve(this.manager.getRepoMetas()),
          this.manager.getAllStatuses(),
          this.view ? loadIconTheme(this.view.webview) : Promise.resolve(undefined),
        ]);
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos, status, iconTheme });
        this.postChangelistsUpdate(status);
        break;
      }

      case 'COMMIT_REQUEST_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff: null, error: 'Repo not found' });
          return;
        }
        try {
          const diff = msg.staged
            ? await repo.getStagedDiff(msg.repoId, msg.filePath)
            : await repo.getUnstagedDiff(msg.repoId, msg.filePath);
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff: null, error: String(e) });
        }
        break;
      }

      case 'COMMIT_STAGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.stageFiles(msg.paths);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_UNSTAGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.unstageFiles(msg.paths);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_STAGE_ALL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.stageAll();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_UNSTAGE_ALL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          await repo.unstageAll();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_DO_COMMIT': {
        this.profileService?.trace(`COMMIT_DO_COMMIT received repoId=${msg.repoId}`);
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const creds = await this.getCommitCredentials(repo.rootPath);
          const output = await repo.commit(msg.message, msg.amend, creds, s => this.profileService?.trace(s));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, output });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_DO_COMMIT_PUSH': {
        this.profileService?.trace(`COMMIT_DO_COMMIT_PUSH received repoId=${msg.repoId}`);
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Commit & Push', cancellable: false },
          async () => {
            try {
              const creds = await this.getCommitCredentials(repo.rootPath);
              await repo.commit(msg.message, msg.amend, creds, s => this.profileService?.trace(s));
              await repo.push();
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
              this.logProvider?.refresh();
              const status = await this.manager.getAllStatusesFresh();
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            } catch (e: unknown) {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
            }
          }
        );
        break;
      }

      case 'COMMIT_DO_COMMIT_MULTI': {
        this.profileService?.trace(`COMMIT_DO_COMMIT_MULTI received repos=${msg.repos.map(r=>r.repoId).join(',')}`);
        // Check for missing remotes before pushing
        if (msg.andPush) {
          const noRemoteRepos: string[] = [];
          for (const r of msg.repos) {
            const repo = this.manager.getRepo(r.repoId);
            if (!repo) continue;
            const remotes = await repo.getRemotes().catch(() => []);
            if (remotes.length === 0) noRemoteRepos.push(r.repoId.split('/').pop() ?? r.repoId);
          }
          if (noRemoteRepos.length > 0) {
            vscode.window.showInformationMessage(
              `GitCharm: Cannot push — no remote configured for: ${noRemoteRepos.join(', ')}. Add a remote first (git remote add origin <url>).`
            );
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'No remote configured' });
            return;
          }
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `GitCharm: Committing ${msg.repos.length} ${msg.repos.length === 1 ? 'repository' : 'repositories'}`, cancellable: false },
          async () => {
            const errors: string[] = [];
            for (const r of msg.repos) {
              const repo = this.manager.getRepo(r.repoId);
              if (!repo) { errors.push(`${r.repoId}: not found`); continue; }
              try {
                // Stage/unstage according to user selection before committing
                if (r.filesToUnstage.length > 0) await repo.unstageFiles(r.filesToUnstage);
                if (r.filesToStage.length > 0) await repo.stageFiles(r.filesToStage);
                const creds = await this.getCommitCredentials(repo.rootPath);
                await repo.commit(r.message, r.amend, creds, s => this.profileService?.trace(s));
                if (msg.andPush) await repo.push();
              } catch (e: unknown) {
                errors.push(`${r.repoId.split('/').pop()}: ${String(e)}`);
              }
            }
            if (errors.length > 0) {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
            } else {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
              this.logProvider?.refresh();
            }
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
          }
        );
        break;
      }

      case 'COMMIT_PULL_ALL': {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Pulling all repositories', cancellable: false },
          async (progress) => {
            const results = await this.manager.pullAll();
            const failed = results.filter(r => !r.ok);
            if (failed.length > 0) {
              vscode.window.showWarningMessage(`GitCharm: ${failed.length} pull(s) failed`);
            }
          }
        );
        break;
      }

      case 'COMMIT_PULL_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        try {
          const output = await repo.pull();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, output });
          const pullStatus = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: pullStatus });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_GET_REMOTES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: 'Repo not found' }); return; }
        try {
          const remotes = await repo.getRemotes();
          this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: String(e) });
        }
        break;
      }

      case 'COMMIT_PUSH_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Pushing', cancellable: false },
          async () => {
            try {
              await repo.push(false, msg.remote);
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
              this.logProvider?.refresh();
              const status = await this.manager.getAllStatusesFresh();
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            } catch (e: unknown) {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
            }
          }
        );
        break;
      }

      case 'COMMIT_DISCARD_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Discard changes to ${msg.path}? This cannot be undone.`,
          { modal: true }, 'Discard'
        );
        if (confirm !== 'Discard') { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.discardFile(msg.path);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_DISCARD_FILES': {
        const n = msg.files.length;
        const confirm = await vscode.window.showWarningMessage(
          `Discard changes to ${n} file${n === 1 ? '' : 's'}? This cannot be undone.`,
          { modal: true }, 'Discard'
        );
        if (confirm !== 'Discard') {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          break;
        }
        const errors: string[] = [];
        for (const f of msg.files) {
          const repo = this.manager.getRepo(f.repoId);
          if (!repo) { errors.push(`${f.path}: repo not found`); continue; }
          try { await repo.discardFile(f.path); }
          catch (e: unknown) { errors.push(`${f.path}: ${String(e)}`); }
        }
        if (errors.length > 0) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
        } else {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        const status = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        break;
      }

      case 'COMMIT_OPEN_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const path = require('path') as typeof import('path');
        const absUri = vscode.Uri.file(path.join(repo.rootPath, msg.filePath));
        // git.openChange opens the native VS Code diff (index↔worktree or HEAD↔index)
        // depending on which group the file is in. Passing the file URI is enough.
        try {
          await vscode.commands.executeCommand('git.openChange', absUri);
        } catch {
          // Fallback: manual vscode.diff with git: URI scheme
          const ref = msg.staged ? '' : '~';
          const gitUri = absUri.with({
            scheme: 'git',
            query: JSON.stringify({ path: absUri.fsPath, ref }),
          });
          const title = msg.staged
            ? `${msg.filePath} (Index ↔ HEAD)`
            : `${msg.filePath} (Working Tree)`;
          await vscode.commands.executeCommand('vscode.diff', gitUri, absUri, title);
        }
        break;
      }

      case 'COMMIT_SHOW_DIFF_TAB': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absPath = vscode.Uri.file(require('path').join(repo.rootPath, msg.filePath));
        await vscode.commands.executeCommand('git.openChange', absPath).then(
          undefined,
          // fallback: open as diff with HEAD
          () => vscode.commands.executeCommand('vscode.diff',
            absPath.with({ scheme: 'git', query: JSON.stringify({ path: absPath.fsPath, ref: 'HEAD' }) }),
            absPath,
            `${msg.filePath} (Working Tree)`
          )
        );
        break;
      }

      case 'COMMIT_OPEN_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absPath = vscode.Uri.file(require('path').join(repo.rootPath, msg.filePath));
        await vscode.window.showTextDocument(absPath, { preview: false });
        break;
      }

      case 'COMMIT_DELETE_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${msg.filePath}? This cannot be undone.`,
          { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          const absPath = vscode.Uri.file(require('path').join(repo.rootPath, msg.filePath));
          await vscode.workspace.fs.delete(absPath, { useTrash: true });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_DELETE_FOLDER': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          `Delete folder "${msg.folderPath}" and all its contents? This cannot be undone.`,
          { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          const path = require('path') as typeof import('path');
          const absPath = vscode.Uri.file(path.join(repo.rootPath, msg.folderPath));
          await vscode.workspace.fs.delete(absPath, { recursive: true, useTrash: true });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_ADD_TO_GITIGNORE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const path = require('path') as typeof import('path');
        const fs = require('fs') as typeof import('fs');

        // Find all .gitignore files in the repo
        const rootUri = vscode.Uri.file(repo.rootPath);
        const gitignoreFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(rootUri, '**/.gitignore'),
          new vscode.RelativePattern(rootUri, '**/node_modules/**'),
          20
        );

        // Sort: root .gitignore first, then alphabetical
        gitignoreFiles.sort((a, b) => {
          const aRel = path.relative(repo.rootPath, a.fsPath);
          const bRel = path.relative(repo.rootPath, b.fsPath);
          if (aRel === '.gitignore') return -1;
          if (bRel === '.gitignore') return 1;
          return aRel.localeCompare(bRel);
        });

        // If no .gitignore exists, create one at the root
        let targetPath: string;
        if (gitignoreFiles.length === 0) {
          targetPath = path.join(repo.rootPath, '.gitignore');
        } else if (gitignoreFiles.length === 1) {
          targetPath = gitignoreFiles[0].fsPath;
        } else {
          // Let user pick
          const picks = gitignoreFiles.map(f => ({
            label: path.relative(repo.rootPath, f.fsPath),
            fsPath: f.fsPath,
          }));
          const picked = await vscode.window.showQuickPick(picks, {
            title: 'Add to .gitignore',
            placeHolder: 'Select which .gitignore to update',
          });
          if (!picked) return;
          targetPath = picked.fsPath;
        }

        // Determine the entry to add (relative to the .gitignore's directory)
        const gitignoreDir = path.dirname(targetPath);
        let entry = path.relative(gitignoreDir, path.join(repo.rootPath, msg.entryPath));
        // Normalise to forward slashes
        entry = entry.split(path.sep).join('/');

        // Append to .gitignore if not already present
        let existing = '';
        try { existing = fs.readFileSync(targetPath, 'utf8'); } catch { /* new file */ }
        const lines = existing.split('\n').map(l => l.trim());
        if (lines.includes(entry) || lines.includes('/' + entry)) {
          vscode.window.showInformationMessage(`"${entry}" is already in ${path.relative(repo.rootPath, targetPath)}`);
          return;
        }
        const newContent = existing.endsWith('\n') || existing === ''
          ? existing + entry + '\n'
          : existing + '\n' + entry + '\n';
        fs.writeFileSync(targetPath, newContent, 'utf8');
        vscode.window.showInformationMessage(`Added "${entry}" to ${path.relative(repo.rootPath, targetPath)}`);

        // Refresh status so the newly-ignored file disappears
        const status = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        break;
      }

      case 'COMMIT_SHOW_BRANCH_MENU': {
        await vscode.commands.executeCommand('gitcharm.showBranchMenu', msg.repoId);
        break;
      }

      case 'COMMIT_OPEN_MERGE_EDITOR': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absPath = vscode.Uri.file(require('path').join(repo.rootPath, msg.filePath));
        await vscode.commands.executeCommand('git.openMergeEditor', absPath)
          .then(undefined, () => vscode.window.showTextDocument(absPath));
        break;
      }

      case 'COMMIT_GENERATE_MESSAGE': {
        try {
          // Collect changed file paths across all repos for context
          const ws = await this.manager.getAllStatuses();
          const lines: string[] = [];
          for (const repo of ws.repos) {
            const repoName = require('path').basename(repo.repoId);
            const files = [...repo.unstagedFiles, ...repo.stagedFiles];
            if (files.length === 0) continue;
            if (ws.repos.length > 1) lines.push(`[${repoName}]`);
            for (const f of files.slice(0, 30)) lines.push(`${f.status[0].toUpperCase()} ${f.path}`);
          }

          // Try VS Code LM API (Copilot) — prefer gpt-4o but fall back to any available Copilot model
          let model: vscode.LanguageModelChat | undefined;
          try {
            const preferred = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
            model = preferred[0];
            if (!model) {
              const any = await vscode.lm.selectChatModels({ vendor: 'copilot' });
              model = any[0];
            }
          } catch {
            model = undefined;
          }

          if (!model) {
            this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, error: 'No AI model available. Install GitHub Copilot to use this feature.' });
            return;
          }

          const prompt = `Generate a concise git commit message in imperative mood (max 72 chars). Only output the message, nothing else.\n\nChanged files:\n${lines.join('\n')}`;
          const response = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User(prompt)],
            {},
            new vscode.CancellationTokenSource().token
          );

          let result = '';
          for await (const chunk of response.text) result += chunk;
          this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, message: result.trim() });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, error: String(e) });
        }
        break;
      }

      case 'SHELVE_LIST': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves: [], error: 'Repo not found' }); return; }
        try {
          const shelves = await svc.list();
          this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves });
        } catch (e: unknown) {
          this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves: [], error: String(e) });
        }
        break;
      }

      case 'SHELVE_PUSH': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: 'Repo not found' }); return; }
        try {
          // Capture changelist assignments for the shelved files, if in changelists mode
          const clSvc = this.getOrCreateChangelistService();
          const clAssignments = clSvc ? this.buildChangelistAssignments(clSvc, msg.repoId, msg.paths) : undefined;
          await svc.push(msg.name, msg.paths, clAssignments);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.postChangelistsUpdate(status);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: String(e) });
        }
        break;
      }

      case 'SHELVE_APPLY': {
        const svc = this.getShelveService(msg.repoId);
        const repo = this.manager.getRepo(msg.repoId);
        if (!svc || !repo) { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: 'Repo not found' }); return; }
        try {
          const clAssignments = await svc.apply(msg.shelveId, msg.paths);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          // Restore changelist assignments if present
          if (clAssignments?.length) {
            await this.restoreChangelistAssignments(msg.repoId, clAssignments);
          }
          this.postChangelistsUpdate(status);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: true });
        } catch (e: unknown) {
          const err = e as { code?: string; conflictFiles?: string[] };
          if (err.code === 'SHELVE_CONFLICT' && err.conflictFiles?.length) {
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
            this.post({
              type: 'SHELVE_OP_RESULT',
              requestId: msg.requestId,
              repoId: msg.repoId,
              op: 'apply',
              ok: true,
              hasConflicts: true,
              conflictFiles: err.conflictFiles,
            });
            const path = require('path') as typeof import('path');
            for (const filePath of err.conflictFiles) {
              const absUri = vscode.Uri.file(path.join(repo.rootPath, filePath));
              try {
                await vscode.commands.executeCommand('git.openMergeEditor', absUri);
              } catch {
                await vscode.window.showTextDocument(absUri, { preview: false });
              }
            }
          } else {
            this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: String(e) });
          }
        }
        break;
      }

      case 'SHELVE_DROP': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Repo not found' }); return; }
        const confirmDrop = await vscode.window.showWarningMessage(
          'Delete this shelved changelist? This cannot be undone.',
          { modal: true }, 'Delete'
        );
        if (confirmDrop !== 'Delete') { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Cancelled' }); return; }
        try {
          svc.drop(msg.shelveId);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: String(e) });
        }
        break;
      }

      case 'SHELVE_GET_FILE_DIFF': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: msg.filePath, diff: '', error: 'Repo not found' }); return; }
        try {
          const diff = svc.getFileDiff(msg.shelveId, msg.filePath);
          this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: msg.filePath, diff });
        } catch (e: unknown) {
          this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: msg.filePath, diff: '', error: String(e) });
        }
        break;
      }

      case 'SHELVE_OPEN_FILE_DIFF': {
        const svc = this.getShelveService(msg.repoId);
        const repo = this.manager.getRepo(msg.repoId);
        if (!svc || !repo) return;
        try {
          const fs = require('fs') as typeof import('fs');
          const path = require('path') as typeof import('path');

          const diffChunk = svc.getFileDiff(msg.shelveId, msg.filePath);
          const absFilePath = path.join(repo.rootPath, msg.filePath);
          const fileName = msg.filePath.split('/').pop() ?? msg.filePath;

          // Read current working tree content (empty string if file doesn't exist)
          let currentContent = '';
          const fileExists = fs.existsSync(absFilePath);
          if (fileExists) {
            try { currentContent = fs.readFileSync(absFilePath, 'utf8'); } catch { /* unreadable */ }
          }

          // Apply the patch to get what the file would look like after unshelving
          const afterContent = applyPatchToContent(diffChunk, currentContent);

          // Right side: virtual doc showing post-unshelve content
          const afterUri = ShelveDocumentProvider.buildUri(msg.repoId, msg.shelveId, msg.filePath);
          this.shelveDocProvider.set(afterUri, afterContent);

          // Left side: actual current working tree file, or virtual empty doc if file doesn't exist
          let leftUri: vscode.Uri;
          if (fileExists) {
            leftUri = vscode.Uri.file(absFilePath);
          } else {
            leftUri = ShelveDocumentProvider.buildUri(msg.repoId, `${msg.shelveId}-before`, msg.filePath);
            this.shelveDocProvider.set(leftUri, '');
          }

          await vscode.commands.executeCommand(
            'vscode.diff',
            leftUri,    // left = current file (or empty if deleted)
            afterUri,   // right = after applying shelf
            `${fileName} (Working Tree ↔ After Unshelve)`
          );
        } catch { /* silently ignore if file cannot be diffed */ }
        break;
      }

      case 'STASH_OPEN_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const path = require('path') as typeof import('path');
          const fs = require('fs') as typeof import('fs');
          const fileName = msg.filePath.split('/').pop() ?? msg.filePath;
          const absPath = path.join(repo.rootPath, msg.filePath);
          const safeRef = msg.stashRef.replace(/[{}]/g, '_');

          // Left: current working tree content (virtual doc to avoid VSCode git extension interference)
          let currentContent = '';
          try {
            if (fs.existsSync(absPath)) currentContent = fs.readFileSync(absPath, 'utf8');
          } catch { /* unreadable, keep empty */ }
          const currentUri = ShelveDocumentProvider.buildUri(msg.repoId, `${safeRef}-current`, msg.filePath);
          this.shelveDocProvider.set(currentUri, currentContent);

          // Right: stashed version — tracked path first, then untracked (stash@{N}^3)
          const stashedContent = await repo.getStashFileContent(msg.stashRef, msg.filePath);
          const stashUri = ShelveDocumentProvider.buildUri(msg.repoId, safeRef, msg.filePath);
          this.shelveDocProvider.set(stashUri, stashedContent);

          await vscode.commands.executeCommand(
            'vscode.diff',
            currentUri,
            stashUri,
            `${fileName} (Working Tree ↔ ${msg.stashRef})`
          );
        } catch (e) {
          vscode.window.showErrorMessage(`GitCharm: Cannot open stash diff — ${String(e)}`);
        }
        break;
      }

      case 'STASH_LIST': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes: [], error: 'Repo not found' });
          return;
        }
        try {
          const stashes = await repo.stashList();
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes });
        } catch (e: unknown) {
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes: [], error: String(e) });
        }
        break;
      }

      case 'STASH_SHOW': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff: '', error: 'Repo not found' });
          return;
        }
        try {
          const diff = await repo.stashShow(msg.stashRef, msg.filePath);
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff });
        } catch (e: unknown) {
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff: '', error: String(e) });
        }
        break;
      }

      case 'STASH_APPLY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repo.stashApply(msg.stashRef);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: String(e) });
        }
        break;
      }

      case 'STASH_POP': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repo.stashPop(msg.stashRef);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: false, error: String(e) });
        }
        break;
      }

      case 'STASH_DROP': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Repo not found' });
          return;
        }
        const confirmDrop = await vscode.window.showWarningMessage(
          'Drop this stash? This cannot be undone.',
          { modal: true }, 'Drop'
        );
        if (confirmDrop !== 'Drop') {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.stashDrop(msg.stashRef);
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: String(e) });
        }
        break;
      }

      case 'PUSH_GET_UNPUSHED': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: 'Repo not found' });
          return;
        }
        try {
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
        } catch (e: unknown) {
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: String(e) });
        }
        break;
      }

      case 'STASH_PUSH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: 'Repo not found' });
          return;
        }
        try {
          await repo.stashPush(msg.message, msg.paths);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_OPEN_LOG': {
        this.logProvider?.selectCommit(msg.hash, msg.repoId);
        break;
      }

      case 'COMMIT_UNDO_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Repo not found' }); return; }
        const confirm = await vscode.window.showWarningMessage(
          'Undo last commit? Changes will be kept as unstaged (git reset --soft HEAD~1).',
          { modal: true }, 'Undo Commit'
        );
        if (confirm !== 'Undo Commit') { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.undoCommit();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'CHANGELISTS_CREATE': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          svc.create(msg.name);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_CREATE_PROMPT': {
        const name = await vscode.window.showInputBox({
          title: 'New Changelist',
          prompt: 'Enter a name for the new changelist',
          placeHolder: 'Changelist name…',
          validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!name) break;
        const svcCreate = this.getOrCreateChangelistService();
        if (svcCreate) {
          svcCreate.create(name.trim());
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_RENAME': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          svc.rename(msg.id, msg.name);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_RENAME_PROMPT': {
        const newName = await vscode.window.showInputBox({
          title: 'Rename Changelist',
          prompt: `Rename "${msg.currentName}"`,
          value: msg.currentName,
          validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!newName) break;
        const svcRename = this.getOrCreateChangelistService();
        if (svcRename) {
          svcRename.rename(msg.id, newName.trim());
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_DELETE': {
        const svcDel = this.getOrCreateChangelistService();
        if (!svcDel) break;
        const clToDelete = svcDel.getAll().find(c => c.id === msg.id);
        const clName = clToDelete?.name ?? 'this changelist';
        const confirmed = await vscode.window.showWarningMessage(
          `Delete "${clName}"? Its files will be moved to Changes.`,
          { modal: true }, 'Delete'
        );
        if (confirmed !== 'Delete') break;
        svcDel.delete(msg.id);
        this.postChangelistsUpdate();
        break;
      }

      case 'CHANGELISTS_MOVE_FILES': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          await this.stageUnversionedFiles(svc, msg.assignments);
          svc.moveFiles(msg.assignments);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_MOVE_FILES_PROMPT': {
        const svcMove = this.getOrCreateChangelistService();
        if (!svcMove) break;
        const allCls = svcMove.getAll().filter(cl => cl.id !== CHANGELIST_UNVERSIONED_ID);
        const picks = allCls.map(cl => ({ label: cl.name, description: cl.id }));
        const picked = await vscode.window.showQuickPick(picks, {
          title: 'Move to Changelist',
          placeHolder: 'Select a changelist…',
        });
        if (!picked) break;
        const assignments = msg.files.map(f => ({ ...f, changelistId: picked.description! }));
        await this.stageUnversionedFiles(svcMove, assignments);
        svcMove.moveFiles(assignments);
        this.postChangelistsUpdate();
        break;
      }

      case 'CHANGELISTS_SHELVE': {
        const clSvc = this.getOrCreateChangelistService();
        if (!clSvc) break;
        const clForShelve = clSvc.getAll().find(c => c.id === msg.changelistId);
        if (!clForShelve) break;
        // Gather files per repo for this changelist
        const filesByRepo = new Map<string, string[]>();
        for (const [repoId, paths] of Object.entries(clForShelve.fileAssignments)) {
          if (paths.length > 0) filesByRepo.set(repoId, paths);
        }
        if (filesByRepo.size === 0) { vscode.window.showInformationMessage('No files in this changelist to shelve.'); break; }
        const shelveName = await vscode.window.showInputBox({
          title: `Shelve "${clForShelve.name}"`,
          value: clForShelve.name,
          placeHolder: 'Shelve name…',
          validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!shelveName) break;
        for (const [repoId, paths] of filesByRepo) {
          const shelveSvc = this.getShelveService(repoId);
          if (!shelveSvc) continue;
          const clAssignments = this.buildChangelistAssignments(clSvc, repoId, paths);
          try {
            await shelveSvc.push(shelveName.trim(), paths, clAssignments);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(`Shelve failed for repo ${repoId}: ${String(e)}`);
          }
        }
        const shelveStatus = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: shelveStatus });
        this.postChangelistsUpdate(shelveStatus);
        this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: [...filesByRepo.keys()][0], op: 'push', ok: true });
        break;
      }

      case 'CHANGELISTS_STASH': {
        const clSvcStash = this.getOrCreateChangelistService();
        if (!clSvcStash) break;
        const clForStash = clSvcStash.getAll().find(c => c.id === msg.changelistId);
        if (!clForStash) break;
        const stashName = await vscode.window.showInputBox({
          title: `Stash "${clForStash.name}"`,
          value: clForStash.name,
          placeHolder: 'Stash message…',
          validateInput: v => v.trim() ? undefined : 'Message cannot be empty',
        });
        if (!stashName) break;
        for (const [repoId, paths] of Object.entries(clForStash.fileAssignments)) {
          if (paths.length === 0) continue;
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            const git = require('simple-git').default(repo.rootPath);
            await git.stash(['push', '--message', stashName.trim(), '--', ...paths]);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(`Stash failed for repo ${repoId}: ${String(e)}`);
          }
        }
        const stashStatus = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: stashStatus });
        this.postChangelistsUpdate(stashStatus);
        break;
      }

      case 'COMMIT_OPEN_ALL_CHANGES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const repoUri = vscode.Uri.file(repo.rootPath);
          const status = await repo.getStatus();

          const hasUnstaged  = status.unstagedFiles.filter((f: { status: string }) => f.status !== 'untracked').length > 0;
          const hasUntracked = status.unstagedFiles.filter((f: { status: string }) => f.status === 'untracked').length > 0;
          const hasStaged    = status.stagedFiles.length > 0;

          const options: vscode.QuickPickItem[] = [];
          if (hasUnstaged)  options.push({ label: '$(diff) Unstaged Changes',  description: 'git.viewChanges' });
          if (hasUntracked) options.push({ label: '$(new-file) Untracked Files', description: 'git.viewUntrackedChanges' });
          if (hasStaged)    options.push({ label: '$(diff-added) Staged Changes', description: 'git.viewStagedChanges' });

          if (options.length === 0) return;

          if (options.length === 1) {
            await vscode.commands.executeCommand(options[0].description!, repoUri);
            return;
          }

          const picked = await vscode.window.showQuickPick(options, { placeHolder: 'Open changes…' });
          if (picked) {
            await vscode.commands.executeCommand(picked.description!, repoUri);
          }
        } catch { /* command unavailable */ }
        break;
      }
    }
  }

  refresh(): void {
    this.manager.getAllStatuses().then(status => {
      this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
      this.postChangelistsUpdate(status);
    });
  }
}
