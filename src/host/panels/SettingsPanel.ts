import * as vscode from 'vscode';
import * as fs from 'fs';
import { getWebviewHtml } from '../utils/webviewHtml';
import { panelIcon } from '../utils/panelIcon';
import { webviewReadyGate } from '../utils/webviewReadyGate';
import { getAiModelLabel } from '../utils/aiModelLabel';
import { logWarn } from '../utils/Logger';
import { generateWithAI } from '../ai/aiGenerate';
import { listAiModels } from '../ai/aiModels';
import { getAiApiKeyPresence, onDidChangeAiApiKeys, setAiApiKey } from '../ai/aiSecrets';
import { DEFAULT_PROMPTS } from '../ai/prompts';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { IntegrationsService } from '../integrations/IntegrationsService';
import type { HostToSettingsMsg, SettingSchema, SettingsState, SettingsToHostMsg, SettingValue } from '../types/messages';

const SECTION = 'gitcharm';
const TEST_TIMEOUT_MS = 45_000;
/** Shown and edited through SecretStorage instead (see aiSecrets.ts), never as plain settings. */
const HIDDEN_KEYS = new Set(['ai.claudeApiKey', 'ai.openaiApiKey', 'ai.geminiApiKey']);

interface RawProperty {
  type?: string | string[];
  description?: string;
  markdownDescription?: string;
  enum?: string[];
  enumDescriptions?: string[];
  markdownEnumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  scope?: string;
  editPresentation?: string;
}

/** GitCharm's own settings page: a single editor tab, revealed again when already open. */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  private static schemaCache: SettingSchema[] | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly post: (msg: HostToSettingsMsg) => void;

  static show(extensionUri: vscode.Uri, manager: WorkspaceGitManager, integrations: IntegrationsService, section?: string): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      if (section) SettingsPanel.current.post({ type: 'SETTINGS_NAVIGATE', section });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'gitcharm.settings',
      vscode.l10n.t('GitCharm Settings'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, manager, integrations, section);
  }

  /**
   * Re-attaches a Settings tab VS Code kept across a restart (see the serializer in extension.ts). The webview's
   * saved state remembers the category it showed; the page itself restores the rest (target, collapsed groups).
   */
  static restore(panel: vscode.WebviewPanel, state: unknown, extensionUri: vscode.Uri, manager: WorkspaceGitManager, integrations: IntegrationsService): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
    const category = (state as { category?: unknown } | undefined)?.category;
    SettingsPanel.current?.panel.dispose();
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, manager, integrations, typeof category === 'string' ? category : undefined);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly integrations: IntegrationsService,
    section: string | undefined,
  ) {
    panel.iconPath = panelIcon(extensionUri, 'settings');
    panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'settings', panel.title, section ? { section } : undefined);
    const gate = webviewReadyGate<HostToSettingsMsg>(panel);
    this.post = m => gate.post(m);

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: SettingsToHostMsg) => void this.handle(msg)),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(SECTION)) void this.pushState(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.pushState(); if (this.integrationsWatch) void this.pushIntegrations(); }),
      onDidChangeAiApiKeys(() => void this.pushState()),
      manager.onStatusChange(() => this.pushStateIfReposChanged()),
    );
    panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
      this.disposables.forEach(d => d.dispose());
    });
    void this.pushState();
  }

  private lastRepoKey = '';
  /** Integrations are read (git remotes of every repository) only once their page has been opened. */
  private integrationsWatch: vscode.Disposable | undefined;

  private async pushIntegrations(): Promise<void> {
    if (!this.integrationsWatch) {
      this.integrationsWatch = this.integrations.onDidChange(() => void this.pushIntegrations());
      this.disposables.push(this.integrationsWatch);
    }
    try {
      this.post({ type: 'SETTINGS_INTEGRATIONS', state: await this.integrations.getState() });
    } catch (err) {
      logWarn('SettingsPanel', `Could not read cloud integrations: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The Pull Requests panel shows which account each repository uses: refresh it after a change here. */
  private refreshPullRequests(): void {
    void vscode.commands.executeCommand('gitcharm.pullRequests.refresh');
  }

  /** Repository names and colors feed the Project Colors editor; status changes are frequent, so only resend when they differ. */
  private pushStateIfReposChanged(): void {
    const key = this.repoList().map(r => `${r.name}=${r.color}`).join('|');
    if (key !== this.lastRepoKey) void this.pushState();
  }

  private repoList(): { name: string; color: string }[] {
    const seen = new Set<string>();
    return this.manager.getRepoMetas()
      .filter(m => !seen.has(m.name) && seen.add(m.name))
      .map(m => ({ name: m.name, color: m.color }));
  }

  private async pushState(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const schema = this.schema();
    const values: Record<string, SettingValue> = {};
    for (const s of schema) {
      const inspected = cfg.inspect(s.key);
      values[s.key] = { default: inspected?.defaultValue, user: inspected?.globalValue, workspace: inspected?.workspaceValue };
    }
    const repos = this.repoList();
    this.lastRepoKey = repos.map(r => `${r.name}=${r.color}`).join('|');
    const state: SettingsState = {
      schema,
      values,
      hasWorkspace: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
      apiKeys: await getAiApiKeyPresence(),
      repos,
      defaultPrompts: DEFAULT_PROMPTS,
      aiModelLabel: getAiModelLabel(cfg),
    };
    this.post({ type: 'SETTINGS_STATE', state });
  }

  private async handle(msg: SettingsToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'SETTINGS_UPDATE': {
        const target = msg.target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        try {
          await vscode.workspace.getConfiguration(SECTION).update(msg.key, msg.value, target);
        } catch (err) {
          void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
          void this.pushState(); // put the control back to the stored value
        }
        break;
      }
      case 'SETTINGS_SET_API_KEY':
        await setAiApiKey(msg.provider, msg.value);
        break;
      case 'SETTINGS_LIST_MODELS':
        try {
          const models = await listAiModels(msg.provider, vscode.workspace.getConfiguration(SECTION));
          this.post({ type: 'SETTINGS_MODELS', requestId: msg.requestId, models });
        } catch (err) {
          this.post({ type: 'SETTINGS_MODELS', requestId: msg.requestId, models: [], error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'SETTINGS_TEST_AI':
        await this.testAi(msg.requestId);
        break;
      case 'SETTINGS_OPEN_NATIVE':
        await vscode.commands.executeCommand('workbench.action.openSettings', msg.key ? `${SECTION}.${msg.key}` : '@ext:rionoir.gitcharm');
        break;
      case 'SETTINGS_OPEN_JSON':
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        break;
      case 'SETTINGS_COPY':
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'SETTINGS_OPEN_URL':
        if (/^https:\/\//.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'SETTINGS_INTEGRATIONS_GET':
        await this.pushIntegrations();
        break;
      case 'SETTINGS_INTEGRATION_ADD': {
        const result = await this.integrations.addAccount(msg.integrationId, {
          host: msg.host, label: msg.label, email: msg.email, organization: msg.organization, token: msg.token,
        });
        this.post({ type: 'SETTINGS_INTEGRATION_ADDED', requestId: msg.requestId, ok: result.ok, error: result.error });
        if (result.ok) this.refreshPullRequests();
        break;
      }
      case 'SETTINGS_INTEGRATION_RENAME':
        await this.integrations.renameAccount(msg.accountId, msg.label);
        this.refreshPullRequests();
        break;
      case 'SETTINGS_INTEGRATION_REMOVE':
        if (await this.integrations.removeAccount(msg.accountId)) this.refreshPullRequests();
        break;
      case 'SETTINGS_INTEGRATION_GITHUB_ADD':
        try {
          await this.integrations.addGitHubAccount();
          this.refreshPullRequests();
        } catch (err) {
          logWarn('SettingsPanel', `GitHub sign-in: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      case 'SETTINGS_INTEGRATION_MICROSOFT_ADD':
        try {
          await this.integrations.addMicrosoftAccount();
          this.refreshPullRequests();
        } catch (err) {
          logWarn('SettingsPanel', `Microsoft sign-in: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      case 'SETTINGS_INTEGRATION_ASSIGN':
        await this.integrations.assign(msg.repoId, msg.value);
        this.refreshPullRequests();
        break;
    }
  }

  /** Sends one tiny prompt with the saved configuration, the same path real generations take. */
  private async testAi(requestId: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        generateWithAI(cfg.get('ai.provider', 'vscode-lm'), 'Reply with the single word: OK', cfg),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(vscode.l10n.t('No answer within {0} seconds', TEST_TIMEOUT_MS / 1000))), TEST_TIMEOUT_MS);
        }),
      ]);
      this.post({ type: 'SETTINGS_TEST_RESULT', requestId, ok: true, message: answer.slice(0, 200), elapsedMs: Date.now() - started });
    } catch (err) {
      this.post({ type: 'SETTINGS_TEST_RESULT', requestId, ok: false, message: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - started });
    } finally {
      clearTimeout(timer);
    }
  }

  /** The `gitcharm.*` settings from package.json, with %placeholders% resolved in VS Code's display language. */
  private schema(): SettingSchema[] {
    if (SettingsPanel.schemaCache) return SettingsPanel.schemaCache;
    const root = this.extensionUri.fsPath;
    const readJson = (file: string): Record<string, unknown> | undefined => {
      try { return JSON.parse(fs.readFileSync(`${root}/${file}`, 'utf8')) as Record<string, unknown>; } catch { return undefined; }
    };
    const pkg = readJson('package.json') as { contributes?: { configuration?: unknown } } | undefined;
    const nls = { ...(readJson('package.nls.json') ?? {}), ...(readJson(`package.nls.${vscode.env.language}.json`) ?? {}) };
    const localize = (s: string | undefined): string => {
      if (!s) return '';
      const m = /^%(.+)%$/.exec(s);
      if (!m) return s;
      const v = nls[m[1]];
      return typeof v === 'string' ? v : (v as { message?: string } | undefined)?.message ?? s;
    };

    const sections = pkg?.contributes?.configuration;
    const list = (Array.isArray(sections) ? sections : [sections]) as Array<{ properties?: Record<string, RawProperty> } | undefined>;
    const schema: SettingSchema[] = [];
    for (const section of list) {
      for (const [fullKey, p] of Object.entries(section?.properties ?? {})) {
        const key = fullKey.replace(/^gitcharm\./, '');
        if (HIDDEN_KEYS.has(key)) continue;
        const type = (Array.isArray(p.type) ? p.type[0] : p.type) as SettingSchema['type'] | undefined;
        if (!type) { logWarn('SettingsPanel', `Setting ${fullKey} has no type; skipped`); continue; }
        schema.push({
          key,
          type,
          description: localize(p.markdownDescription ?? p.description),
          enum: p.enum,
          enumDescriptions: (p.markdownEnumDescriptions ?? p.enumDescriptions)?.map(localize),
          minimum: p.minimum,
          maximum: p.maximum,
          scope: p.scope,
          multiline: p.editPresentation === 'multilineText' || undefined,
        });
      }
    }
    SettingsPanel.schemaCache = schema;
    return schema;
  }
}
