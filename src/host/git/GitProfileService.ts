import * as vscode from 'vscode';
import simpleGit from 'simple-git';

export interface GitProfile {
  id: string;
  name: string;       // display name for the profile (e.g. "Work", "Personal")
  gitName: string;    // git user.name
  gitEmail: string;   // git user.email
  isDefault?: boolean;
}

const CONFIG_KEY = 'gitcharm.gitProfiles';
const ACTIVE_KEY = 'gitcharm.activeGitProfileId';
const DEFAULT_SOURCE_KEY = 'gitcharm.defaultProfileSource';

export class GitProfileService implements vscode.Disposable {
  private _onProfileChange = new vscode.EventEmitter<void>();
  readonly onProfileChange = this._onProfileChange.event;

  private configWatcher?: vscode.Disposable;

  constructor() {
    this.configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration(CONFIG_KEY) ||
        e.affectsConfiguration(ACTIVE_KEY) ||
        e.affectsConfiguration(DEFAULT_SOURCE_KEY)
      ) {
        this._onProfileChange.fire();
      }
    });
  }

  getProfiles(): GitProfile[] {
    const cfg = vscode.workspace.getConfiguration();
    return cfg.get<GitProfile[]>(CONFIG_KEY, []);
  }

  getActiveProfileId(): string | undefined {
    const cfg = vscode.workspace.getConfiguration();
    return cfg.get<string>(ACTIVE_KEY, '');
  }

  getActiveProfile(): GitProfile | undefined {
    const id = this.getActiveProfileId();
    if (!id) return undefined;
    const profiles = this.getProfiles();
    return profiles.find(p => p.id === id);
  }

  getDefaultProfile(): GitProfile | undefined {
    const profiles = this.getProfiles();
    return profiles.find(p => p.isDefault) ?? profiles[0];
  }

  async setActiveProfile(id: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration();
    await cfg.update(ACTIVE_KEY, id, vscode.ConfigurationTarget.Workspace);
  }

  getDefaultSource(): 'local' | 'global' | undefined {
    const val = vscode.workspace.getConfiguration().get<string>(DEFAULT_SOURCE_KEY, '');
    if (val === 'local' || val === 'global') return val;
    return undefined;
  }

  async setDefaultSource(source: 'local' | 'global' | undefined): Promise<void> {
    await vscode.workspace.getConfiguration().update(
      DEFAULT_SOURCE_KEY,
      source ?? '',
      vscode.ConfigurationTarget.Workspace,
    );
  }

  async saveProfile(profile: GitProfile): Promise<void> {
    const profiles = this.getProfiles();
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      profiles[idx] = profile;
    } else {
      profiles.push(profile);
    }
    await vscode.workspace.getConfiguration().update(CONFIG_KEY, profiles, vscode.ConfigurationTarget.Global);
  }

  async deleteProfile(id: string): Promise<void> {
    const profiles = this.getProfiles().filter(p => p.id !== id);
    await vscode.workspace.getConfiguration().update(CONFIG_KEY, profiles, vscode.ConfigurationTarget.Global);
    // If the deleted profile was active, clear active
    if (this.getActiveProfileId() === id) {
      await vscode.workspace.getConfiguration().update(ACTIVE_KEY, '', vscode.ConfigurationTarget.Workspace);
    }
  }

  async setDefaultProfile(id: string): Promise<void> {
    const profiles = this.getProfiles().map(p => ({ ...p, isDefault: p.id === id }));
    await vscode.workspace.getConfiguration().update(CONFIG_KEY, profiles, vscode.ConfigurationTarget.Global);
  }

  /**
   * Tries to read user.name/user.email from a repo's local git config or from global git config.
   * Returns a profile if something is configured, undefined otherwise.
   */
  async detectFromRepo(repoPath: string): Promise<{ gitName: string; gitEmail: string } | undefined> {
    try {
      const git = simpleGit(repoPath);
      const [name, email] = await Promise.all([
        git.raw(['config', '--local', 'user.name']).catch(() => ''),
        git.raw(['config', '--local', 'user.email']).catch(() => ''),
      ]);
      if (name.trim() || email.trim()) {
        return { gitName: name.trim(), gitEmail: email.trim() };
      }
    } catch { /* ignore */ }
    return undefined;
  }

  async detectGlobal(): Promise<{ gitName: string; gitEmail: string } | undefined> {
    try {
      const git = simpleGit();
      const [name, email] = await Promise.all([
        git.raw(['config', '--global', 'user.name']).catch(() => ''),
        git.raw(['config', '--global', 'user.email']).catch(() => ''),
      ]);
      if (name.trim() || email.trim()) {
        return { gitName: name.trim(), gitEmail: email.trim() };
      }
    } catch { /* ignore */ }
    return undefined;
  }

  async autoInitIfEmpty(): Promise<void> {
    // Global git config is now always the implicit fallback — no need to create a profile from it.
  }

  /**
   * Returns the effective profile for a repo, with the source of resolution:
   * - 'gitcharm': an explicitly set active profile in GitCharm
   * - 'local': read from the repo's own .git/config
   * - 'global': read from git config --global
   *
   * Priority: active GitCharm profile → defaultSource (if set) → local → global
   */
  async getEffectiveProfile(repoPath: string): Promise<
    | { profile: GitProfile; source: 'gitcharm' }
    | { profile: { gitName: string; gitEmail: string }; source: 'local' | 'global' }
    | undefined
  > {
    const id = this.getActiveProfileId();
    if (id) {
      const profiles = this.getProfiles();
      const active = profiles.find(p => p.id === id);
      if (active) return { profile: active, source: 'gitcharm' };
    }

    const defaultSource = this.getDefaultSource();
    if (defaultSource === 'local') {
      const local = await this.detectFromRepo(repoPath);
      if (local) return { profile: local, source: 'local' };
    }
    if (defaultSource === 'global') {
      const global = await this.detectGlobal();
      if (global) return { profile: global, source: 'global' };
    }

    const local = await this.detectFromRepo(repoPath);
    if (local) return { profile: local, source: 'local' };

    const global = await this.detectGlobal();
    if (global) return { profile: global, source: 'global' };

    return undefined;
  }

  /**
   * Applies the effective profile credentials to a repo's local git config.
   * Skips writing if the source is already 'local' (repo has its own credentials).
   * For 'global' source, writes the global credentials locally so the commit uses them explicitly.
   */
  async applyToRepo(repoPath: string): Promise<void> {
    const result = await this.getEffectiveProfile(repoPath);
    if (!result || result.source === 'local') return;
    const git = simpleGit(repoPath);
    const ops: Promise<unknown>[] = [];
    if (result.profile.gitName) ops.push(git.raw(['config', 'user.name', result.profile.gitName]));
    if (result.profile.gitEmail) ops.push(git.raw(['config', 'user.email', result.profile.gitEmail]));
    if (ops.length) await Promise.all(ops);
  }

  dispose(): void {
    this.configWatcher?.dispose();
    this._onProfileChange.dispose();
  }
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
