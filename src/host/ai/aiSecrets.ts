import * as vscode from 'vscode';
import { logInfo, logWarn } from '../utils/Logger';

/** The API-key providers. Their keys live in SecretStorage (the OS keychain), never in settings.json. */
export type AiSecretProvider = 'claude' | 'openai' | 'gemini';

export const AI_SECRET_PROVIDERS: readonly AiSecretProvider[] = ['claude', 'openai', 'gemini'];

/** The settings the keys used to be stored in, still declared (deprecated) so a key typed there is picked up
 * and moved into SecretStorage, and so older keys keep working until they are. */
const LEGACY_SETTING: Record<AiSecretProvider, string> = {
  claude: 'ai.claudeApiKey',
  openai: 'ai.openaiApiKey',
  gemini: 'ai.geminiApiKey',
};

const LABEL: Record<AiSecretProvider, string> = { claude: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' };

let secrets: vscode.SecretStorage | undefined;
const changeEmitter = new vscode.EventEmitter<void>();

/** Fires when any AI API key is stored or removed. */
export const onDidChangeAiApiKeys = changeEmitter.event;

function secretKey(provider: AiSecretProvider): string {
  return `gitcharm.ai.apiKey.${provider}`;
}

/** Must run at activation, before anything generates with AI: moves plain-text keys out of settings.json. */
export function initAiSecrets(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
  context.subscriptions.push(
    changeEmitter,
    context.secrets.onDidChange(e => {
      if (AI_SECRET_PROVIDERS.some(p => e.key === secretKey(p))) changeEmitter.fire();
    }),
    // A key pasted into settings.json later is moved too, as soon as it's saved.
    vscode.workspace.onDidChangeConfiguration(e => {
      const changed = AI_SECRET_PROVIDERS.filter(p => e.affectsConfiguration(`gitcharm.${LEGACY_SETTING[p]}`));
      if (changed.length > 0) void migrateLegacyKeys(changed);
    }),
  );
  void migrateLegacyKeys(AI_SECRET_PROVIDERS);
}

async function migrateLegacyKeys(providers: readonly AiSecretProvider[]): Promise<void> {
  if (!secrets) return;
  const cfg = vscode.workspace.getConfiguration('gitcharm');
  const moved: string[] = [];
  for (const provider of providers) {
    const inspected = cfg.inspect<string>(LEGACY_SETTING[provider]);
    // The most specific value is the one in effect, so it's the one worth keeping.
    const value = inspected?.workspaceFolderValue || inspected?.workspaceValue || inspected?.globalValue;
    if (!value) continue;
    try {
      await secrets.store(secretKey(provider), value);
      if (inspected?.workspaceFolderValue !== undefined) await cfg.update(LEGACY_SETTING[provider], undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      if (inspected?.workspaceValue !== undefined) await cfg.update(LEGACY_SETTING[provider], undefined, vscode.ConfigurationTarget.Workspace);
      if (inspected?.globalValue !== undefined) await cfg.update(LEGACY_SETTING[provider], undefined, vscode.ConfigurationTarget.Global);
      moved.push(LABEL[provider]);
    } catch (err) {
      // The key stays in settings.json, where getAiApiKey() still finds it.
      logWarn('aiSecrets:migrate', `Could not move the ${LABEL[provider]} API key to secure storage: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (moved.length === 0) return;
  logInfo('aiSecrets:migrate', `Moved AI API keys to secure storage: ${moved.join(', ')}`);
  void vscode.window.showInformationMessage(
    vscode.l10n.t('GitCharm moved your {0} API key out of settings.json into secure storage.', moved.join(', ')),
  );
}

/** The provider's API key: from SecretStorage, else from the legacy setting (a key not migrated yet). */
export async function getAiApiKey(provider: AiSecretProvider): Promise<string> {
  const stored = await secrets?.get(secretKey(provider));
  return stored || vscode.workspace.getConfiguration('gitcharm').get<string>(LEGACY_SETTING[provider], '');
}

/** Stores the key, or removes it when `value` is empty. */
export async function setAiApiKey(provider: AiSecretProvider, value: string): Promise<void> {
  if (!secrets) throw new Error('AI secrets not initialized');
  const trimmed = value.trim();
  if (trimmed) await secrets.store(secretKey(provider), trimmed);
  else await secrets.delete(secretKey(provider));
}

/** Which providers have a key, without ever handing the keys themselves to a webview. */
export async function getAiApiKeyPresence(): Promise<Record<AiSecretProvider, boolean>> {
  const entries = await Promise.all(AI_SECRET_PROVIDERS.map(async p => [p, !!(await getAiApiKey(p))] as const));
  return Object.fromEntries(entries) as Record<AiSecretProvider, boolean>;
}

/** The secret provider an AI provider id needs, if it needs one. */
export function secretProviderFor(aiProvider: string): AiSecretProvider | undefined {
  switch (aiProvider) {
    case 'claude-api': return 'claude';
    case 'openai-api': return 'openai';
    case 'gemini-api': return 'gemini';
    default: return undefined;
  }
}
