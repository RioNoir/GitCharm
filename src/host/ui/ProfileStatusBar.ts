import * as vscode from 'vscode';
import type { GitProfile } from '../git/GitProfileService';
import { GitProfileService } from '../git/GitProfileService';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';

export class ProfileStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private profileChangeDisposable?: vscode.Disposable;
  private editorChangeDisposable?: vscode.Disposable;

  constructor(
    private readonly profileService: GitProfileService,
    private readonly manager?: WorkspaceGitManager,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99   // just below BranchStatusBar (100)
    );
    this.statusBarItem.command = 'gitstorm.manageProfiles';
    this.statusBarItem.show();

    this.profileChangeDisposable = this.profileService.onProfileChange(() => this.refresh());

    if (this.manager) {
      this.editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(() => this.refresh());
    }

    this.refresh();
  }

  private getActiveRepoPath(): string | undefined {
    if (!this.manager) return undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      const metas = this.manager.getRepoMetas();
      return metas[0]?.rootPath;
    }
    const result = this.manager.getServiceForFile(editor.document.uri.fsPath);
    return result?.rootPath;
  }

  refresh(): void {
    const repoPath = this.getActiveRepoPath();
    if (repoPath) {
      this.refreshAsync(repoPath);
    } else {
      // No repo context: show active GitStorm profile only
      const active = this.profileService.getActiveProfile();
      this.renderProfile(active, 'gitstorm');
    }
  }

  private async refreshAsync(repoPath: string): Promise<void> {
    const result = await this.profileService.getEffectiveProfile(repoPath);
    if (result) {
      this.renderProfile(result.profile, result.source);
    } else {
      this.renderProfile(undefined, 'gitstorm');
    }
  }

  private renderProfile(
    profile: GitProfile | { gitName: string; gitEmail: string } | undefined,
    source: 'gitstorm' | 'local' | 'global',
  ): void {
    if (!profile) {
      this.statusBarItem.text = `$(account) No profile`;
      this.statusBarItem.tooltip = 'GitStorm: No Git profile selected — click to set one';
      return;
    }

    const displayName =
      source === 'local' ? 'Local' :
      source === 'global' ? 'Global' :
      (profile as GitProfile).name ?? 'Profile';

    this.statusBarItem.text = `$(account) ${displayName}`;
    this.statusBarItem.tooltip =
      `GitStorm Profile: ${profile.gitName} <${profile.gitEmail}>\n` +
      (source === 'local'
        ? 'Source: local .git/config of this repo\n'
        : source === 'global'
          ? 'Source: global git config (~/.gitconfig)\n'
          : '') +
      'Click to manage profiles';
  }

  // ── Main menu ────────────────────────────────────────────────────────────────

  async showMenu(): Promise<void> {
    const profiles = this.profileService.getProfiles();
    const activeId = this.profileService.getActiveProfileId();
    const defaultSource = this.profileService.getDefaultSource();
    const repoPath = this.getActiveRepoPath();

    type MenuItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const items: MenuItem[] = [];

    if (profiles.length > 0) {
      items.push({
        label: 'PROFILES',
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as MenuItem);

      for (const p of profiles) {
        const isActive = p.id === activeId;
        const icon = isActive ? '$(check)' : '$(account)';
        const badges = [isActive ? 'active' : '', p.isDefault ? 'default' : ''].filter(Boolean).join(', ');
        items.push({
          label: `${icon} ${p.name}`,
          description: `${p.gitName} <${p.gitEmail}>${badges ? `  ·  ${badges}` : ''}`,
          action: () => this.showProfileActionMenu(p, profiles),
        });
      }

      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
    }

    // Show Local entry only if the current repo has local git config credentials
    if (repoPath) {
      const localCreds = await this.profileService.detectFromRepo(repoPath);
      if (localCreds) {
        const isDefault = defaultSource === 'local';
        const icon = isDefault ? '$(check)' : '$(home)';
        items.push({
          label: `${icon} Local${isDefault ? '  ·  default' : ''}`,
          description: `${localCreds.gitName} <${localCreds.gitEmail}>  ·  from .git/config of this repo`,
          action: () => this.showLocalActionMenu(localCreds),
        });
      }
    }

    // Show Global entry
    const globalCreds = await this.profileService.detectGlobal();
    if (globalCreds) {
      const isDefault = defaultSource === 'global';
      const icon = isDefault ? '$(check)' : '$(globe)';
      items.push({
        label: `${icon} Global${isDefault ? '  ·  default' : ''}`,
        description: `${globalCreds.gitName} <${globalCreds.gitEmail}>  ·  from ~/.gitconfig`,
        action: () => this.showGlobalActionMenu(globalCreds),
      });
    }

    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem,
      {
        label: '$(add) New Profile…',
        description: 'Create a new Git identity profile',
        action: () => this.createProfile(),
      },
      {
        label: '$(settings-gear) Open Settings',
        description: 'Edit profiles directly in settings.json',
        action: () => vscode.commands.executeCommand('workbench.action.openSettings', 'gitstorm.gitProfiles'),
      },
    );

    if (profiles.length === 0) {
      items.push({
        label: '$(cloud-download) Import from git config',
        description: 'Auto-detect profile from global git config',
        action: () => this.importFromGitConfig(),
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: 'GitStorm — Git Profiles',
      matchOnDescription: true,
    });

    if (pick) await (pick as MenuItem).action();
  }

  // ── Local action menu ────────────────────────────────────────────────────────

  private async showLocalActionMenu(creds: { gitName: string; gitEmail: string }): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const isDefault = this.profileService.getDefaultSource() === 'local';

    const items: ActionItem[] = [
      { label: '$(arrow-left) Back', action: () => this.showMenu() },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
    ];

    if (!isDefault) {
      items.push({
        label: '$(check) Set as default for this workspace',
        description: 'Use local .git/config when no profile is active',
        action: async () => {
          await this.profileService.setDefaultSource('local');
          this.refresh();
          vscode.window.showInformationMessage('GitStorm: Local set as default source for this workspace.');
        },
      });
    } else {
      items.push(
        {
          label: '$(check) Default (in use)',
          description: 'Local .git/config is the default source for this workspace',
          action: async () => { await this.showMenu(); },
        },
        {
          label: '$(circle-slash) Remove as default',
          description: 'Revert to automatic fallback (local → global)',
          action: async () => {
            await this.profileService.setDefaultSource(undefined);
            this.refresh();
            vscode.window.showInformationMessage('GitStorm: Default source cleared.');
          },
        },
      );
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: `Local — ${creds.gitName} <${creds.gitEmail}>`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  // ── Global action menu ───────────────────────────────────────────────────────

  private async showGlobalActionMenu(creds: { gitName: string; gitEmail: string }): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const isDefault = this.profileService.getDefaultSource() === 'global';

    const items: ActionItem[] = [
      { label: '$(arrow-left) Back', action: () => this.showMenu() },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
    ];

    if (!isDefault) {
      items.push({
        label: '$(check) Set as default for this workspace',
        description: 'Use ~/.gitconfig when no profile is active',
        action: async () => {
          await this.profileService.setDefaultSource('global');
          this.refresh();
          vscode.window.showInformationMessage('GitStorm: Global set as default source for this workspace.');
        },
      });
    } else {
      items.push(
        {
          label: '$(check) Default (in use)',
          description: 'Global ~/.gitconfig is the default source for this workspace',
          action: async () => { await this.showMenu(); },
        },
        {
          label: '$(circle-slash) Remove as default',
          description: 'Revert to automatic fallback (local → global)',
          action: async () => {
            await this.profileService.setDefaultSource(undefined);
            this.refresh();
            vscode.window.showInformationMessage('GitStorm: Default source cleared.');
          },
        },
      );
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: `Global — ${creds.gitName} <${creds.gitEmail}>`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  // ── Per-profile action menu ──────────────────────────────────────────────────

  private async showProfileActionMenu(profile: GitProfile, allProfiles: GitProfile[]): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };

    const activeId = this.profileService.getActiveProfileId();
    const isActive = profile.id === activeId;

    const items: ActionItem[] = [
      {
        label: '$(arrow-left) Back',
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
    ];

    if (!isActive) {
      items.push({
        label: '$(check) Use this profile',
        description: `Set "${profile.name}" as active for this workspace`,
        action: () => this.activateProfile(profile),
      });
    } else {
      items.push({
        label: '$(check) Active (in use)',
        description: 'This profile is currently active',
        action: async () => { await this.showMenu(); },
      });
    }

    if (!profile.isDefault) {
      items.push({
        label: '$(star) Set as default',
        description: 'Use this profile when no workspace profile is set',
        action: () => this.setDefault(profile),
      });
    }

    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: '$(edit) Edit…',
        description: `Edit name, git name and email`,
        action: () => this.editProfile(profile),
      },
      {
        label: '$(trash) Delete',
        description: `Remove "${profile.name}"`,
        action: () => this.deleteProfile(profile),
      },
    );

    const pick = await vscode.window.showQuickPick(items, {
      title: `Profile: ${profile.name}`,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  private async activateProfile(profile: GitProfile): Promise<void> {
    await this.profileService.setActiveProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(`GitStorm: Profile "${profile.name}" (${profile.gitEmail}) is now active.`);
  }

  private async setDefault(profile: GitProfile): Promise<void> {
    await this.profileService.setDefaultProfile(profile.id);
    vscode.window.showInformationMessage(`GitStorm: "${profile.name}" set as default profile.`);
  }

  async createProfile(): Promise<void> {
    const displayName = await vscode.window.showInputBox({
      title: 'New Git Profile — Display Name',
      prompt: 'A label for this profile (e.g. Work, Personal)',
      placeHolder: 'Work',
      validateInput: v => {
        if (!v.trim()) return 'Name cannot be empty';
        if (RESERVED_PROFILE_NAMES.includes(v.trim().toLowerCase())) return `"${v.trim()}" is a reserved name`;
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

    const profiles = this.profileService.getProfiles();
    const profile: GitProfile = {
      id: generateId(),
      name: displayName.trim(),
      gitName: gitName.trim(),
      gitEmail: gitEmail.trim(),
      isDefault: profiles.length === 0,
    };

    await this.profileService.saveProfile(profile);

    const activatePick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Yes, use it now', value: true },
        { label: '$(close) No, just save it', value: false },
      ],
      { title: `Profile "${profile.name}" created — activate it?` }
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
        if (RESERVED_PROFILE_NAMES.includes(v.trim().toLowerCase())) return `"${v.trim()}" is a reserved name`;
        return undefined;
      },
    });
    if (!displayName) return;

    const gitName = await vscode.window.showInputBox({
      title: `Edit Profile — Git Name`,
      value: profile.gitName,
    });
    if (gitName === undefined) return;

    const gitEmail = await vscode.window.showInputBox({
      title: `Edit Profile — Git Email`,
      value: profile.gitEmail,
      validateInput: v => (v.trim() ? undefined : 'Email cannot be empty'),
    });
    if (!gitEmail) return;

    await this.profileService.saveProfile({
      ...profile,
      name: displayName.trim(),
      gitName: gitName.trim(),
      gitEmail: gitEmail.trim(),
    });
    this.refresh();
    vscode.window.showInformationMessage(`GitStorm: Profile "${displayName}" updated.`);
  }

  private async deleteProfile(profile: GitProfile): Promise<void> {
    const confirm = await vscode.window.showQuickPick(
      [
        { label: '$(trash) Delete', value: true },
        { label: '$(close) Cancel', value: false },
      ],
      { title: `Delete profile "${profile.name}"?` }
    ) as { label: string; value: boolean } | undefined;

    if (!confirm?.value) return;

    await this.profileService.deleteProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(`GitStorm: Profile "${profile.name}" deleted.`);
  }

  private async importFromGitConfig(): Promise<void> {
    const detected = await this.profileService.detectGlobal();
    if (!detected || (!detected.gitName && !detected.gitEmail)) {
      vscode.window.showWarningMessage('GitStorm: No global git config (user.name / user.email) found.');
      return;
    }
    const profile: GitProfile = {
      id: generateId(),
      name: detected.gitName || 'Imported',
      gitName: detected.gitName,
      gitEmail: detected.gitEmail,
    };
    await this.profileService.saveProfile(profile);
    await this.profileService.setActiveProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(`GitStorm: Profile imported — ${detected.gitName} <${detected.gitEmail}>`);
  }

  // ── Switch profile (command palette shortcut) ────────────────────────────────

  async switchProfile(): Promise<void> {
    const profiles = this.profileService.getProfiles();
    if (profiles.length === 0) {
      const create = await vscode.window.showWarningMessage(
        'GitStorm: No profiles configured.',
        'Create Profile'
      );
      if (create) await this.createProfile();
      return;
    }

    const activeId = this.profileService.getActiveProfileId();
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = profiles.map(p => ({
      label: `${p.id === activeId ? '$(check) ' : '$(account) '}${p.name}`,
      description: `${p.gitName} <${p.gitEmail}>${p.isDefault ? '  · default' : ''}`,
      id: p.id,
    }));

    const pick = await vscode.window.showQuickPick(items, {
      title: 'GitStorm — Switch Git Profile',
      matchOnDescription: true,
    }) as Item | undefined;

    if (!pick) return;
    await this.profileService.setActiveProfile(pick.id);
    const selected = profiles.find(p => p.id === pick.id);
    if (selected) {
      this.refresh();
      vscode.window.showInformationMessage(`GitStorm: Profile "${selected.name}" is now active.`);
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.profileChangeDisposable?.dispose();
    this.editorChangeDisposable?.dispose();
  }
}

const RESERVED_PROFILE_NAMES = ['local', 'default'];

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
