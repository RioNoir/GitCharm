import * as l10n from '@vscode/l10n';
import React, { useCallback, useState } from 'react';
import { Codicon } from '../shared/Codicon';
import type { AiModelOptionMsg, SettingsState } from '../../host/types/messages';
import { ApiKeyField, ModelPicker } from './controls';
import { settingLabel } from './layout';
import type { RowContext } from './SettingRow';
import { RowHeader, SettingRow } from './SettingRow';

type SecretProvider = 'claude' | 'openai' | 'gemini';

interface ProviderDef {
  id: string;
  label: string;
  secret?: SecretProvider;
  secretLabel?: string;
  modelKey: string;
  /** What an empty model setting falls back to (see aiGenerate.ts). */
  defaultModel?: string;
  canList: boolean;
  pathKey?: string;
  urlKey?: string;
  modelPlaceholder?: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'vscode-lm', label: 'VS Code LM', modelKey: 'ai.modelId', canList: true },
  { id: 'claude-api', label: 'Claude API', secret: 'claude', secretLabel: 'Anthropic', modelKey: 'ai.claudeModel', defaultModel: 'claude-sonnet-4-6', canList: true },
  { id: 'openai-api', label: 'OpenAI API', secret: 'openai', secretLabel: 'OpenAI', modelKey: 'ai.openaiModel', defaultModel: 'gpt-4o', canList: true },
  { id: 'gemini-api', label: 'Gemini API', secret: 'gemini', secretLabel: 'Gemini', modelKey: 'ai.geminiModel', defaultModel: 'gemini-2.0-flash', canList: true },
  { id: 'claude-cli', label: 'Claude CLI', modelKey: 'ai.claudeModel', pathKey: 'ai.claudePath', canList: false, modelPlaceholder: 'sonnet, opus, haiku…' },
  { id: 'codex-cli', label: 'Codex CLI', modelKey: 'ai.codexModel', pathKey: 'ai.codexPath', canList: false, modelPlaceholder: 'gpt-5-codex…' },
  { id: 'gemini-cli', label: 'Gemini CLI', modelKey: 'ai.geminiModel', pathKey: 'ai.geminiPath', canList: false, modelPlaceholder: 'gemini-2.5-pro…' },
  { id: 'ollama', label: 'Ollama', modelKey: 'ai.ollamaModel', urlKey: 'ai.ollamaUrl', defaultModel: 'llama3', canList: true },
  { id: 'lmstudio', label: 'LM Studio', modelKey: 'ai.lmStudioModel', urlKey: 'ai.lmStudioUrl', canList: true },
];

export interface AiSectionProps {
  ctx: RowContext;
  state: SettingsState;
  listModels(provider: string): Promise<{ models: AiModelOptionMsg[]; error?: string }>;
  testAi(): Promise<{ ok: boolean; message: string; elapsedMs: number }>;
  setApiKey(provider: SecretProvider, value: string): void;
}

export function AiSection({ ctx, state, listModels, testAi, setApiKey }: AiSectionProps) {
  const enabled = ctx.get<boolean>('ai.enabled');
  const providerId = ctx.get<string>('ai.provider');
  const provider = PROVIDERS.find(p => p.id === providerId) ?? PROVIDERS[0];
  const hasKey = provider.secret ? state.apiKeys[provider.secret] : true;
  const url = provider.urlKey ? ctx.get<string>(provider.urlKey) : '';

  // A new identity whenever what the listing depends on changes, so the picker reloads by itself.
  const load = useCallback(() => listModels(provider.id), [provider.id, hasKey, url]);

  const [test, setTest] = useState<{ running: boolean; result?: { ok: boolean; message: string; elapsedMs: number } }>({ running: false });
  const runTest = () => {
    setTest({ running: true });
    testAi().then(
      result => setTest({ running: false, result }),
      (e: unknown) => setTest({ running: false, result: { ok: false, message: e instanceof Error ? e.message : String(e), elapsedMs: 0 } }),
    );
  };

  const sharedModelNote = provider.id === 'claude-api' || provider.id === 'claude-cli'
    ? l10n.t('Claude API and Claude CLI share the same model setting.')
    : provider.id === 'gemini-api' || provider.id === 'gemini-cli'
      ? l10n.t('Gemini API and Gemini CLI share the same model setting.')
      : undefined;

  return (
    <>
      <SettingRow ctx={ctx} settingKey="ai.enabled" />

      <div className={`gc-ai-body${enabled ? '' : ' dimmed'}`}>
        <SettingRow ctx={ctx} settingKey="ai.provider" />

        <h3 className="gc-subgroup-title">{provider.label}</h3>
        {provider.secret && (
          <div className={`gc-row${state.apiKeys[provider.secret] ? ' modified' : ''}`}>
            <div className="gc-row-title">
              <span><span className="category">{ctx.categoryOf('ai.provider')}: </span><span className="label">{l10n.t('API key')}</span></span>
            </div>
            <div className="gc-row-desc">
              {l10n.t('Kept in your system keychain through VS Code secure storage — never in settings.json, and not synced.')}
            </div>
            <div className="gc-row-control">
              <ApiKeyField stored={state.apiKeys[provider.secret]} providerLabel={provider.secretLabel ?? provider.label} onSave={v => setApiKey(provider.secret!, v)} />
            </div>
          </div>
        )}
        {provider.urlKey && <SettingRow ctx={ctx} settingKey={provider.urlKey} />}
        {provider.pathKey && <SettingRow ctx={ctx} settingKey={provider.pathKey} />}
        <SettingRow ctx={ctx} settingKey={provider.modelKey}>
          <ModelPicker
            value={ctx.get<string>(provider.modelKey) ?? ''}
            onCommit={v => ctx.update(provider.modelKey, v)}
            load={load}
            canList={provider.canList && hasKey}
            autoLabel={provider.defaultModel
              ? l10n.t('Default ({0})', provider.defaultModel)
              : l10n.t('Automatic (the provider picks)')}
            placeholder={provider.modelPlaceholder}
            disabled={!!ctx.writeBlockedReason(provider.modelKey)}
          />
          {sharedModelNote && <div className="gc-row-note">{sharedModelNote}</div>}
        </SettingRow>

        <div className="gc-row">
          <div className="gc-row-title">
            <span><span className="category">{ctx.categoryOf('ai.provider')}: </span><span className="label">{l10n.t('Test connection')}</span></span>
          </div>
          <div className="gc-row-desc">
            {l10n.t('Sends a one-word prompt with the saved settings. Current model: {0}', state.aiModelLabel)}
          </div>
          <div className="gc-row-control">
            <div className="gc-test-line">
              <button type="button" className="gc-btn gc-btn-secondary" disabled={test.running || !enabled || !hasKey} onClick={runTest}>
                {test.running && <Codicon name="loading" className="codicon-modifier-spin" />}
                {test.running ? l10n.t('Testing…') : l10n.t('Test connection')}
              </button>
              {!hasKey && <span className="gc-muted">{l10n.t('Add the API key to test the connection.')}</span>}
            </div>
            {test.result && (
              <div className={`gc-test-result ${test.result.ok ? 'ok' : 'error'}`} role="status">
                <Codicon name={test.result.ok ? 'pass' : 'error'} />
                <span>
                  {test.result.ok
                    ? l10n.t('Answered in {0} s: “{1}”', (test.result.elapsedMs / 1000).toFixed(1), test.result.message)
                    : test.result.message}
                </span>
              </div>
            )}
          </div>
        </div>

        <h3 className="gc-subgroup-title">{l10n.t('Output')}</h3>
        <SettingRow ctx={ctx} settingKey="ai.language" />
        <SettingRow ctx={ctx} settingKey="ai.maxDiffChars" />
      </div>
    </>
  );
}

export function PromptsSection({ ctx, keys, defaults }: { ctx: RowContext; keys: string[]; defaults: Record<string, string> }) {
  return (
    <>
      <div className="gc-row-note">{l10n.t('Use {0} where the configured language should go.', '{language}')}</div>
      {keys.map(key => <PromptRow key={key} ctx={ctx} settingKey={key} defaultText={defaults[key.replace('ai.prompts.', '')] ?? ''} />)}
    </>
  );
}

function PromptRow({ ctx, settingKey, defaultText }: { ctx: RowContext; settingKey: string; defaultText: string }) {
  const value = ctx.get<string>(settingKey) ?? '';
  const customized = value.trim() !== '';
  const blocked = ctx.writeBlockedReason(settingKey);
  const [draft, setDraft] = useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const shown = customized ? draft : defaultText;

  return (
    <div className={`gc-row${ctx.isModified(settingKey) ? ' modified' : ''}`} data-setting={settingKey}>
      <RowHeader ctx={ctx} settingKey={settingKey} />
      <div className="gc-row-desc">
        {customized ? l10n.t('Custom prompt.') : l10n.t('Built-in prompt.')}{' '}
        {customized ? (
          <button type="button" className="gc-link" disabled={!!blocked} onClick={() => ctx.reset(settingKey)}>{l10n.t('Reset to Default')}</button>
        ) : (
          // Start from the built-in text rather than an empty box — editing a prompt is far easier than writing one.
          <button type="button" className="gc-link" disabled={!!blocked} onClick={() => ctx.update(settingKey, defaultText)}>{l10n.t('Customize')}</button>
        )}
      </div>
      <div className="gc-row-control">
        <textarea
          className="gc-textarea mono"
          value={shown}
          readOnly={!customized || !!blocked}
          rows={Math.min(14, Math.max(4, shown.split('\n').length + 1))}
          aria-label={settingLabel(settingKey)}
          spellCheck={false}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => { if (customized && draft !== value) ctx.update(settingKey, draft); }}
        />
      </div>
      {blocked && <div className="gc-row-note">{blocked}</div>}
    </div>
  );
}
