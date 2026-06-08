import * as vscode from 'vscode';
import simpleGit from 'simple-git';

export interface GitProfile {
  id: string;
  name: string;
  gitName: string;
  gitEmail: string;
  /** 'local' and 'global' are built-in dynamic profiles — credentials read live from git config */
  builtIn?: 'local' | 'global';
}

export interface EffectiveProfile {
  profile: GitProfile;
  source: 'active' | 'local' | 'global';
}

const PROFILES_KEY = 'gitcharm.gitProfiles';
const ACTIVE_KEY = 'activeProfileId';

export const LOCAL_PROFILE_ID = '__local__';
export const GLOBAL_PROFILE_ID = '__global__';

export class GitProfileService implements vscode.Disposable {
  private _onProfileChange = new vscode.EventEmitter<void>();
  readonly onProfileChange = this._onProfileChange.event;
  private log: vscode.OutputChannel | undefined;

  constructor(private readonly context: vscode.ExtensionContext, log?: vscode.OutputChannel) {
    this.log = log;
  }

  trace(msg: string): void {
    this.log?.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  // ── Profiles ─────────────────────────────────────────────────────────────────

  getProfiles(): GitProfile[] {
    return this.context.globalState.get<GitProfile[]>(PROFILES_KEY, []);
  }

  async saveProfile(profile: GitProfile): Promise<void> {
    const profiles = this.getProfiles();
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      profiles[idx] = profile;
    } else {
      profiles.push(profile);
    }
    await this.context.globalState.update(PROFILES_KEY, profiles);
    this._onProfileChange.fire();
  }

  async deleteProfile(id: string): Promise<void> {
    if (id === LOCAL_PROFILE_ID || id === GLOBAL_PROFILE_ID) return;
    const profiles = this.getProfiles().filter(p => p.id !== id);
    await this.context.globalState.update(PROFILES_KEY, profiles);
    if (this.getActiveProfileId() === id) {
      await this.context.workspaceState.update(ACTIVE_KEY, '');
    }
    this._onProfileChange.fire();
  }

  // ── Active profile (per-workspace) ───────────────────────────────────────────

  getActiveProfileId(): string {
    const id = this.context.workspaceState.get<string>(ACTIVE_KEY, '');
    this.trace(`getActiveProfileId → "${id}"`);
    return id;
  }

  /** Returns the profile pointed to by activeId, or undefined if not set / not found. */
  getActiveProfile(): GitProfile | undefined {
    const id = this.getActiveProfileId();
    if (!id) return undefined;
    if (id === LOCAL_PROFILE_ID) return this.makeLocalPlaceholder();
    if (id === GLOBAL_PROFILE_ID) return this.makeGlobalPlaceholder();
    return this.getProfiles().find(p => p.id === id);
  }

  async setActiveProfile(id: string): Promise<void> {
    this.trace(`setActiveProfile → "${id}"`);
    await this.context.workspaceState.update(ACTIVE_KEY, id);
    const verify = this.context.workspaceState.get<string>(ACTIVE_KEY, '');
    this.trace(`setActiveProfile verify read-back → "${verify}"`);
    this._onProfileChange.fire();
  }

  async clearActiveProfile(): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_KEY, '');
    this._onProfileChange.fire();
  }

  // ── Built-in Local / Global ───────────────────────────────────────────────────

  private makeLocalPlaceholder(): GitProfile {
    return { id: LOCAL_PROFILE_ID, name: 'Local', gitName: '', gitEmail: '', builtIn: 'local' };
  }

  private makeGlobalPlaceholder(): GitProfile {
    return { id: GLOBAL_PROFILE_ID, name: 'Global', gitName: '', gitEmail: '', builtIn: 'global' };
  }

  async readLocalCreds(repoPath: string): Promise<{ gitName: string; gitEmail: string } | undefined> {
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

  async readGlobalCreds(): Promise<{ gitName: string; gitEmail: string } | undefined> {
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

  // ── Effective profile resolution ──────────────────────────────────────────────
  //
  // Priority: active (per-workspace) → local .git/config → global ~/.gitconfig
  // Returns undefined only when nothing is configured anywhere.

  async getEffectiveProfile(repoPath: string): Promise<EffectiveProfile | undefined> {
    this.trace(`getEffectiveProfile — profiles: ${JSON.stringify(this.getProfiles().map(p => p.id + ':' + p.name))}`);

    // 1. Explicit active for this workspace
    const activeId = this.getActiveProfileId();
    if (activeId) {
      if (activeId === LOCAL_PROFILE_ID) {
        const creds = await this.readLocalCreds(repoPath);
        if (creds) return { profile: { ...this.makeLocalPlaceholder(), ...creds }, source: 'active' };
      } else if (activeId === GLOBAL_PROFILE_ID) {
        const creds = await this.readGlobalCreds();
        if (creds) return { profile: { ...this.makeGlobalPlaceholder(), ...creds }, source: 'active' };
      } else {
        const profile = this.getProfiles().find(p => p.id === activeId);
        this.trace(`getEffectiveProfile — active named profile found: ${profile ? profile.name : 'NOT FOUND'}`);
        if (profile) {
          this.trace(`getEffectiveProfile — returning source=active gitName="${profile.gitName}" gitEmail="${profile.gitEmail}"`);
          return { profile, source: 'active' };
        }
      }
      // Active id is stale (profile was deleted) — fall through
      this.trace(`getEffectiveProfile — active id "${activeId}" not resolved, falling through`);
    }

    // 2. Local .git/config
    const local = await this.readLocalCreds(repoPath);
    if (local) return { profile: { ...this.makeLocalPlaceholder(), ...local }, source: 'local' };

    // 3. Global ~/.gitconfig
    const global = await this.readGlobalCreds();
    if (global) return { profile: { ...this.makeGlobalPlaceholder(), ...global }, source: 'global' };

    return undefined;
  }

  // ── Migration from old configuration API ─────────────────────────────────────

  async autoInitIfEmpty(): Promise<void> {
    const hasProfiles = this.getProfiles().length > 0;
    const hasActive = !!this.context.workspaceState.get<string>(ACTIVE_KEY, '');

    // Migrate legacy profiles from vscode configuration into globalState (runs once)
    if (!hasProfiles) {
      const cfg = vscode.workspace.getConfiguration();
      const fromNew = cfg.get<GitProfile[]>('gitcharm.gitProfiles');
      const fromOld = cfg.get<GitProfile[]>('gitstorm.gitProfiles');
      const profiles = (fromNew?.length ? fromNew : fromOld?.length ? fromOld : [])
        .filter(p => p.id !== LOCAL_PROFILE_ID && p.id !== GLOBAL_PROFILE_ID);

      if (profiles.length > 0) {
        await this.context.globalState.update(PROFILES_KEY, profiles);
      }

      if (!hasActive) {
        const activeNew = cfg.get<string>('gitcharm.activeGitProfileId', '');
        const activeOld = cfg.get<string>('gitstorm.activeGitProfileId', '');
        const migratedId = activeNew || activeOld;
        if (migratedId && profiles.find(p => p.id === migratedId)) {
          await this.context.workspaceState.update(ACTIVE_KEY, migratedId);
        }
      }

      if (profiles.length > 0) {
        this._onProfileChange.fire();
      }
    }

    // Clean up legacy keys from vscode configuration so they no longer appear in
    // settings.json or .code-workspace files
    await this.cleanLegacyConfigKeys();
  }

  private async cleanLegacyConfigKeys(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration();
    const legacyKeys = [
      'gitcharm.activeGitProfileId',
      'gitstorm.activeGitProfileId',
      'gitcharm.gitProfiles',
      'gitstorm.gitProfiles',
    ];
    for (const key of legacyKeys) {
      // Remove from workspace scope (writes to .code-workspace or .vscode/settings.json)
      if (cfg.inspect(key)?.workspaceValue !== undefined) {
        await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
      }
      // Remove from workspace folder scope
      if (cfg.inspect(key)?.workspaceFolderValue !== undefined) {
        await cfg.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
  }

  dispose(): void {
    this._onProfileChange.dispose();
  }
}
