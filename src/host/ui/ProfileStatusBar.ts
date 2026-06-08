import * as vscode from 'vscode';
import type { GitProfile } from '../git/GitProfileService';
import { GitProfileService, LOCAL_PROFILE_ID, GLOBAL_PROFILE_ID } from '../git/GitProfileService';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';

export class ProfileStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly profileService: GitProfileService,
    private readonly manager?: WorkspaceGitManager,
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
      displayName = 'Local';
    } else if (profile.builtIn === 'global') {
      displayName = 'Global';
    } else {
      displayName = profile.name;
    }

    const sourceBadge = source === 'local' ? ' (local)' : source === 'global' ? ' (global)' : '';
    this.statusBarItem.text = `$(account) ${displayName}`;
    this.statusBarItem.tooltip =
      `GitCharm Profile: ${profile.gitName} <${profile.gitEmail}>${sourceBadge}\nClick to manage profiles`;
  }

  private renderNoProfile(): void {
    this.statusBarItem.text = `$(account) No profile`;
    this.statusBarItem.tooltip = 'GitCharm: No Git identity configured — click to set one';
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
      items.push(sep('PROFILES'));
      for (const p of namedProfiles) {
        const isActive = p.id === activeId;
        items.push({
          label: `${isActive ? '$(check)' : '$(account)'} ${p.name}`,
          description: `${p.gitName} <${p.gitEmail}>${isActive ? '  ·  active' : ''}`,
          action: () => this.showProfileActionMenu(p),
        });
      }
      items.push(sep());
    }

    // ── Local entry ───────────────────────────────────────────────────────────
    const localCreds = repoPath ? await this.profileService.readLocalCreds(repoPath) : undefined;
    const localIsActive = activeId === LOCAL_PROFILE_ID;
    {
      const icon = localIsActive ? '$(check)' : '$(home)';
      items.push({
        label: `${icon} Local${localIsActive ? '  ·  active' : ''}`,
        description: localCreds
          ? `${localCreds.gitName} <${localCreds.gitEmail}>  ·  from .git/config`
          : repoPath ? 'No local git identity in this repo' : 'No repo open',
        action: () => this.showBuiltInActionMenu('local', localCreds),
      });
    }

    // ── Global entry ──────────────────────────────────────────────────────────
    const globalCreds = await this.profileService.readGlobalCreds();
    const globalIsActive = activeId === GLOBAL_PROFILE_ID;
    {
      const icon = globalIsActive ? '$(check)' : '$(globe)';
      items.push({
        label: `${icon} Global${globalIsActive ? '  ·  active' : ''}`,
        description: globalCreds
          ? `${globalCreds.gitName} <${globalCreds.gitEmail}>  ·  from ~/.gitconfig`
          : 'No global git identity configured',
        action: () => this.showBuiltInActionMenu('global', globalCreds),
      });
    }

    items.push(
      sep(),
      { label: '$(add) New Profile…', description: 'Create a new Git identity profile', action: () => this.createProfile() },
    );

    const pick = await vscode.window.showQuickPick(items, {
      title: 'GitCharm — Git Profiles',
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
    const label = type === 'local' ? 'Local' : 'Global';
    const activeId = this.profileService.getActiveProfileId();
    const isActive = activeId === id;

    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const items: ActionItem[] = [
      { label: '$(arrow-left) Back', action: () => this.showMenu() },
      sep() as unknown as ActionItem,
    ];

    if (!isActive) {
      items.push({
        label: '$(check) Use for this workspace',
        description: `Set ${label} as active profile for this workspace`,
        action: async () => {
          await this.profileService.setActiveProfile(id);
          this.refresh();
          vscode.window.showInformationMessage(`GitCharm: ${label} set as active profile for this workspace.`);
        },
      });
    } else {
      items.push({
        label: '$(check) Active (in use)',
        description: `${label} is the active profile for this workspace`,
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

  private async showProfileActionMenu(profile: GitProfile, repoPath?: string): Promise<void> {
    const activeId = this.profileService.getActiveProfileId();
    const isActive = profile.id === activeId;

    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const items: ActionItem[] = [
      { label: '$(arrow-left) Back', action: () => this.showMenu() },
      sep() as unknown as ActionItem,
    ];

    if (!isActive) {
      items.push({
        label: '$(check) Use for this project/workspace',
        description: `Set "${profile.name}" as active profile for this workspace`,
        action: () => this.activateProfile(profile),
      });
    } else {
      items.push({
        label: '$(check) Active (in use)',
        description: 'This profile is active for this workspace',
        action: async () => { await this.showMenu(); },
      });
    }

    items.push(
      sep() as unknown as ActionItem,
      { label: '$(edit) Edit…', action: () => this.editProfile(profile) },
      { label: '$(trash) Delete', description: `Remove "${profile.name}"`, action: () => this.deleteProfile(profile) },
    );

    const pick = await vscode.window.showQuickPick(items, {
      title: `Profile: ${profile.name}`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  private async activateProfile(profile: GitProfile): Promise<void> {
    await this.profileService.setActiveProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(`GitCharm: "${profile.name}" is now active.`);
  }

  async createProfile(): Promise<void> {
    const displayName = await vscode.window.showInputBox({
      title: 'New Git Profile — Display Name',
      prompt: 'A label for this profile (e.g. Work, Personal)',
      placeHolder: 'Work',
      validateInput: v => {
        if (!v.trim()) return 'Name cannot be empty';
        if (['local', 'global'].includes(v.trim().toLowerCase())) return `"${v.trim()}" is a reserved name`;
        return undefined;
      },
    });
    if (!displayName) return;

    const gitName = await vscode.window.showInputBox({
      title: 'New Git Profile — Git Name',
      prompt: 'Value for git user.name',
      placeHolder: 'John Doe',
    });
    if (gitName === undefined) return;

    const gitEmail = await vscode.window.showInputBox({
      title: 'New Git Profile — Git Email',
      prompt: 'Value for git user.email',
      placeHolder: 'john@example.com',
      validateInput: v => (v.trim() ? undefined : 'Email cannot be empty'),
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
        { label: '$(check) Yes, use it now', value: true },
        { label: '$(close) No, just save it', value: false },
      ],
      { title: `Profile "${profile.name}" created — activate for this workspace?` }
    ) as { label: string; value: boolean } | undefined;

    if (activatePick?.value) {
      await this.profileService.setActiveProfile(profile.id);
    }

    this.refresh();
  }

  private async editProfile(profile: GitProfile): Promise<void> {
    const displayName = await vscode.window.showInputBox({
      title: `Edit Profile — Display Name`,
      value: profile.name,
      validateInput: v => {
        if (!v.trim()) return 'Name cannot be empty';
        if (['local', 'global'].includes(v.trim().toLowerCase())) return `"${v.trim()}" is a reserved name`;
        return undefined;
      },
    });
    if (!displayName) return;

    const gitName = await vscode.window.showInputBox({ title: `Edit Profile — Git Name`, value: profile.gitName });
    if (gitName === undefined) return;

    const gitEmail = await vscode.window.showInputBox({
      title: `Edit Profile — Git Email`,
      value: profile.gitEmail,
      validateInput: v => (v.trim() ? undefined : 'Email cannot be empty'),
    });
    if (!gitEmail) return;

    await this.profileService.saveProfile({ ...profile, name: displayName.trim(), gitName: gitName.trim(), gitEmail: gitEmail.trim() });
    this.refresh();
    vscode.window.showInformationMessage(`GitCharm: Profile "${displayName}" updated.`);
  }

  private async deleteProfile(profile: GitProfile): Promise<void> {
    const confirm = await vscode.window.showQuickPick(
      [{ label: '$(trash) Delete', value: true }, { label: '$(close) Cancel', value: false }],
      { title: `Delete profile "${profile.name}"?` }
    ) as { label: string; value: boolean } | undefined;

    if (!confirm?.value) return;
    await this.profileService.deleteProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(`GitCharm: Profile "${profile.name}" deleted.`);
  }

  // ── Command palette: switch ───────────────────────────────────────────────────

  async switchProfile(): Promise<void> {
    const profiles = this.profileService.getProfiles().filter(p => !p.builtIn);
    if (profiles.length === 0) {
      const create = await vscode.window.showWarningMessage('GitCharm: No profiles configured.', 'Create Profile');
      if (create) await this.createProfile();
      return;
    }

    const activeId = this.profileService.getActiveProfileId();
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = profiles.map(p => ({
      label: `${p.id === activeId ? '$(check) ' : '$(account) '}${p.name}`,
      description: `${p.gitName} <${p.gitEmail}>`,
      id: p.id,
    }));

    const pick = await vscode.window.showQuickPick(items, {
      title: 'GitCharm — Switch Git Profile',
      matchOnDescription: true,
    }) as Item | undefined;

    if (!pick) return;
    await this.profileService.setActiveProfile(pick.id);
    const selected = profiles.find(p => p.id === pick.id);
    if (selected) {
      this.refresh();
      vscode.window.showInformationMessage(`GitCharm: "${selected.name}" is now active.`);
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
