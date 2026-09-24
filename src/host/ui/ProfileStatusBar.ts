import * as vscode from 'vscode';
import type { GitProfile } from '../git/GitProfileService';
import { GitProfileService, LOCAL_PROFILE_ID, GLOBAL_PROFILE_ID } from '../git/GitProfileService';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { resolveAvatarIconPath } from '../utils/avatarCache';

export class ProfileStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly profileService: GitProfileService,
    private readonly manager?: WorkspaceGitManager,
    private readonly avatarCacheDir?: string,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.statusBarItem.command = 'gitcharm.manageProfiles';
    this.statusBarItem.show();

    this.disposables.push(
      this.profileService.onProfileChange(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );

    this.refresh();
  }

  private async avatarIconPath(email: string): Promise<vscode.Uri | undefined> {
    if (!this.avatarCacheDir || !email.trim()) return undefined;
    return resolveAvatarIconPath(email, this.avatarCacheDir);
  }

  private getActiveRepoPath(): string | undefined {
    if (!this.manager) return undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return this.manager.getRepoMetas()[0]?.rootPath;
    return this.manager.getServiceForFile(editor.document.uri.fsPath)?.rootPath;
  }

  refresh(): void {
    const repoPath = this.getActiveRepoPath();
    if (repoPath) {
      this.refreshAsync(repoPath);
    } else {
      this.renderStatusBar(this.profileService.getActiveProfile(), 'active');
    }
  }

  private async refreshAsync(repoPath: string): Promise<void> {
    const result = await this.profileService.getEffectiveProfile(repoPath);
    if (result) {
      this.renderStatusBar(result.profile, result.source);
    } else {
      this.renderNoProfile();
    }
  }

  private renderStatusBar(
    profile: GitProfile | undefined,
    source: 'active' | 'local' | 'global',
  ): void {
    if (!profile) { this.renderNoProfile(); return; }

    let displayName: string;
    if (profile.builtIn === 'local') {
      displayName = vscode.l10n.t('Local');
    } else if (profile.builtIn === 'global') {
      displayName = vscode.l10n.t('Global');
    } else {
      displayName = profile.name;
    }

    const identity = `${profile.gitName} <${profile.gitEmail}>`;
    this.statusBarItem.text = `$(account) ${displayName}`;
    this.statusBarItem.tooltip = source === 'local'
      ? vscode.l10n.t('GitCharm Profile: {0} (local)\nClick to manage profiles', identity)
      : source === 'global'
        ? vscode.l10n.t('GitCharm Profile: {0} (global)\nClick to manage profiles', identity)
        : vscode.l10n.t('GitCharm Profile: {0}\nClick to manage profiles', identity);
  }

  private renderNoProfile(): void {
    this.statusBarItem.text = `$(account) ${vscode.l10n.t('No profile')}`;
    this.statusBarItem.tooltip = vscode.l10n.t('No Git identity configured — click to set one');
  }

  // ── Main menu ────────────────────────────────────────────────────────────────

  async showMenu(): Promise<void> {
    const profiles = this.profileService.getProfiles();
    const activeId = this.profileService.getActiveProfileId();
    const repoPath = this.getActiveRepoPath();

    type MenuItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const items: MenuItem[] = [];

    // ── Named profiles ────────────────────────────────────────────────────────
    const namedProfiles = profiles.filter(p => !p.builtIn);
    if (namedProfiles.length > 0) {
      items.push(sep(vscode.l10n.t('PROFILES')));
      const avatars = await Promise.all(namedProfiles.map(p => this.avatarIconPath(p.gitEmail)));
      namedProfiles.forEach((p, i) => {
        const isActive = p.id === activeId;
        const iconPath = avatars[i];
        items.push({
          label: iconPath ? p.name : `${isActive ? '$(check)' : '$(account)'} ${p.name}`,
          description: `${p.gitName} <${p.gitEmail}>${isActive ? `  ·  ${vscode.l10n.t('active')}` : ''}`,
          iconPath,
          action: () => this.showProfileActionMenu(p),
        });
      });
      items.push(sep());
    }

    // ── Local entry ───────────────────────────────────────────────────────────
    const localCreds = repoPath ? await this.profileService.readLocalCreds(repoPath) : undefined;
    const localIsActive = activeId === LOCAL_PROFILE_ID;
    {
      const icon = localIsActive ? '$(check)' : '$(home)';
      items.push({
        label: `${icon} ${vscode.l10n.t('Local')}${localIsActive ? `  ·  ${vscode.l10n.t('active')}` : ''}`,
        description: localCreds
          ? `${localCreds.gitName} <${localCreds.gitEmail}>  ·  ${vscode.l10n.t('from {0}', '.git/config')}`
          : repoPath ? vscode.l10n.t('No local git identity in this repo') : vscode.l10n.t('No repo open'),
        action: () => this.showBuiltInActionMenu('local', localCreds),
      });
    }

    // ── Global entry ──────────────────────────────────────────────────────────
    const globalCreds = await this.profileService.readGlobalCreds();
    const globalIsActive = activeId === GLOBAL_PROFILE_ID;
    {
      const icon = globalIsActive ? '$(check)' : '$(globe)';
      items.push({
        label: `${icon} ${vscode.l10n.t('Global')}${globalIsActive ? `  ·  ${vscode.l10n.t('active')}` : ''}`,
        description: globalCreds
          ? `${globalCreds.gitName} <${globalCreds.gitEmail}>  ·  ${vscode.l10n.t('from {0}', '~/.gitconfig')}`
          : vscode.l10n.t('No global git identity configured'),
        action: () => this.showBuiltInActionMenu('global', globalCreds),
      });
    }

    items.push(
      sep(),
      { label: `$(add) ${vscode.l10n.t('New Profile…')}`, description: vscode.l10n.t('Create a new Git identity profile'), action: () => this.createProfile() },
    );

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('GitCharm — Git Profiles'),
      matchOnDescription: true,
    }) as MenuItem | undefined;

    if (pick) await pick.action();
  }

  // ── Built-in (Local / Global) action menu ────────────────────────────────────

  private async showBuiltInActionMenu(
    type: 'local' | 'global',
    creds: { gitName: string; gitEmail: string } | undefined,
  ): Promise<void> {
    const id = type === 'local' ? LOCAL_PROFILE_ID : GLOBAL_PROFILE_ID;
    const isLocal = type === 'local';
    const label = isLocal ? vscode.l10n.t('Local') : vscode.l10n.t('Global');
    const activeId = this.profileService.getActiveProfileId();
    const isActive = activeId === id;

    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const items: ActionItem[] = [
      { label: `$(arrow-left) ${vscode.l10n.t('Back')}`, action: () => this.showMenu() },
      sep() as unknown as ActionItem,
    ];

    if (!isActive) {
      items.push({
        label: `$(check) ${vscode.l10n.t('Use for this workspace')}`,
        description: isLocal
          ? vscode.l10n.t('Set Local as active profile for this workspace')
          : vscode.l10n.t('Set Global as active profile for this workspace'),
        action: async () => {
          await this.profileService.setActiveProfile(id);
          this.refresh();
          vscode.window.showInformationMessage(isLocal
            ? vscode.l10n.t('Local set as active profile for this workspace.')
            : vscode.l10n.t('Global set as active profile for this workspace.'));
        },
      });
    } else {
      items.push({
        label: `$(check) ${vscode.l10n.t('Active (in use)')}`,
        description: isLocal
          ? vscode.l10n.t('Local is the active profile for this workspace')
          : vscode.l10n.t('Global is the active profile for this workspace'),
        action: async () => { await this.showMenu(); },
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: `${label}${creds ? ` — ${creds.gitName} <${creds.gitEmail}>` : ''}`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  // ── Named profile action menu ─────────────────────────────────────────────────

  private async showProfileActionMenu(profile: GitProfile, _repoPath?: string): Promise<void> {
    const activeId = this.profileService.getActiveProfileId();
    const isActive = profile.id === activeId;

    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const items: ActionItem[] = [
      { label: `$(arrow-left) ${vscode.l10n.t('Back')}`, action: () => this.showMenu() },
      sep() as unknown as ActionItem,
    ];

    if (!isActive) {
      items.push({
        label: `$(check) ${vscode.l10n.t('Use for this project/workspace')}`,
        description: vscode.l10n.t('Set "{0}" as active profile for this workspace', profile.name),
        action: () => this.activateProfile(profile),
      });
    } else {
      items.push({
        label: `$(check) ${vscode.l10n.t('Active (in use)')}`,
        description: vscode.l10n.t('This profile is active for this workspace'),
        action: async () => { await this.showMenu(); },
      });
    }

    items.push(
      sep() as unknown as ActionItem,
      { label: `$(edit) ${vscode.l10n.t('Edit…')}`, action: () => this.editProfile(profile) },
      { label: `$(trash) ${vscode.l10n.t('Delete')}`, description: vscode.l10n.t('Remove "{0}"', profile.name), action: () => this.deleteProfile(profile) },
    );

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Profile: {0}', profile.name),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  private async activateProfile(profile: GitProfile): Promise<void> {
    await this.profileService.setActiveProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(vscode.l10n.t('"{0}" is now active.', profile.name));
  }

  async createProfile(): Promise<void> {
    const displayName = await vscode.window.showInputBox({
      title: vscode.l10n.t('New Git Profile — Display Name'),
      prompt: vscode.l10n.t('A label for this profile (e.g. Work, Personal)'),
      placeHolder: vscode.l10n.t('Work'),
      validateInput: v => {
        if (!v.trim()) return vscode.l10n.t('Name cannot be empty');
        if (['local', 'global'].includes(v.trim().toLowerCase())) return vscode.l10n.t('"{0}" is a reserved name', v.trim());
        return undefined;
      },
    });
    if (!displayName) return;

    const gitName = await vscode.window.showInputBox({
      title: vscode.l10n.t('New Git Profile — Git Name'),
      prompt: vscode.l10n.t('Value for git {0}', 'user.name'),
      placeHolder: vscode.l10n.t('John Doe'),
    });
    if (gitName === undefined) return;

    const gitEmail = await vscode.window.showInputBox({
      title: vscode.l10n.t('New Git Profile — Git Email'),
      prompt: vscode.l10n.t('Value for git {0}', 'user.email'),
      placeHolder: 'john@example.com',
      validateInput: v => (v.trim() ? undefined : vscode.l10n.t('Email cannot be empty')),
    });
    if (!gitEmail) return;

    const profile: GitProfile = {
      id: generateId(),
      name: displayName.trim(),
      gitName: gitName.trim(),
      gitEmail: gitEmail.trim(),
    };

    await this.profileService.saveProfile(profile);

    const activatePick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${vscode.l10n.t('Yes, use it now')}`, value: true },
        { label: `$(close) ${vscode.l10n.t('No, just save it')}`, value: false },
      ],
      { title: vscode.l10n.t('Profile "{0}" created — activate for this workspace?', profile.name) }
    ) as { label: string; value: boolean } | undefined;

    if (activatePick?.value) {
      await this.profileService.setActiveProfile(profile.id);
    }

    this.refresh();
  }

  private async editProfile(profile: GitProfile): Promise<void> {
    const displayName = await vscode.window.showInputBox({
      title: vscode.l10n.t('Edit Profile — Display Name'),
      value: profile.name,
      validateInput: v => {
        if (!v.trim()) return vscode.l10n.t('Name cannot be empty');
        if (['local', 'global'].includes(v.trim().toLowerCase())) return vscode.l10n.t('"{0}" is a reserved name', v.trim());
        return undefined;
      },
    });
    if (!displayName) return;

    const gitName = await vscode.window.showInputBox({ title: vscode.l10n.t('Edit Profile — Git Name'), value: profile.gitName });
    if (gitName === undefined) return;

    const gitEmail = await vscode.window.showInputBox({
      title: vscode.l10n.t('Edit Profile — Git Email'),
      value: profile.gitEmail,
      validateInput: v => (v.trim() ? undefined : vscode.l10n.t('Email cannot be empty')),
    });
    if (!gitEmail) return;

    await this.profileService.saveProfile({ ...profile, name: displayName.trim(), gitName: gitName.trim(), gitEmail: gitEmail.trim() });
    this.refresh();
    vscode.window.showInformationMessage(vscode.l10n.t('Profile "{0}" updated.', displayName));
  }

  private async deleteProfile(profile: GitProfile): Promise<void> {
    const confirm = await vscode.window.showQuickPick(
      [{ label: `$(trash) ${vscode.l10n.t('Delete')}`, value: true }, { label: `$(close) ${vscode.l10n.t('Cancel')}`, value: false }],
      { title: vscode.l10n.t('Delete profile "{0}"?', profile.name) }
    ) as { label: string; value: boolean } | undefined;

    if (!confirm?.value) return;
    await this.profileService.deleteProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(vscode.l10n.t('Profile "{0}" deleted.', profile.name));
  }

  // ── Command palette: switch ───────────────────────────────────────────────────

  async switchProfile(): Promise<void> {
    const profiles = this.profileService.getProfiles().filter(p => !p.builtIn);
    if (profiles.length === 0) {
      const create = await vscode.window.showWarningMessage(vscode.l10n.t('No profiles configured.'), vscode.l10n.t('Create Profile'));
      if (create) await this.createProfile();
      return;
    }

    const activeId = this.profileService.getActiveProfileId();
    const avatars = await Promise.all(profiles.map(p => this.avatarIconPath(p.gitEmail)));
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = profiles.map((p, i) => {
      const iconPath = avatars[i];
      const isActive = p.id === activeId;
      return {
        label: iconPath ? p.name : `${isActive ? '$(check) ' : '$(account) '}${p.name}`,
        description: `${p.gitName} <${p.gitEmail}>${isActive ? `  ·  ${vscode.l10n.t('active')}` : ''}`,
        iconPath,
        id: p.id,
      };
    });

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('GitCharm — Switch Git Profile'),
      matchOnDescription: true,
    }) as Item | undefined;

    if (!pick) return;
    await this.profileService.setActiveProfile(pick.id);
    const selected = profiles.find(p => p.id === pick.id);
    if (selected) {
      this.refresh();
      vscode.window.showInformationMessage(vscode.l10n.t('"{0}" is now active.', selected.name));
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

function sep(label = ''): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
