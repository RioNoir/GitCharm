import * as l10n from '@vscode/l10n';
import React, { useCallback, useState } from 'react';
import { Codicon } from '../shared/Codicon';
import { AI_OPERATIONS, operationOverride, type AiOperation, type AiOperationTarget } from '../../host/types/aiOperations';
import type { AiModelOptionMsg, SettingsState } from '../../host/types/messages';
import { ModelPicker } from './controls';
import { enumLabel } from './layout';
import { aiProviderIcon } from './providerIcons';
import { RowHeader, type RowContext } from './SettingRow';

export interface ProviderInfo {
  id: string;
  label: string;
  secret?: 'claude' | 'openai' | 'gemini';
  defaultModel?: string;
  canList: boolean;
  modelPlaceholder?: string;
}

function operationLabel(op: AiOperation): string {
  switch (op) {
    case 'commitMessage': return l10n.t('Commit messages');
    case 'pullRequest': return l10n.t('Pull request titles and descriptions');
    case 'explain': return l10n.t('Explaining commits, pull requests and issues');
    case 'resolveConflicts': return l10n.t('Resolving conflicts');
    case 'issues': return l10n.t('Issue branch names and fixes');
  }
}

const OPERATION_ICON: Record<AiOperation, string> = {
  commitMessage: 'git-commit',
  pullRequest: 'git-pull-request',
  explain: 'comment-discussion',
  resolveConflicts: 'git-merge',
  issues: 'issues',
};

/**
 * gitcharm.ai.operationModels: one row per AI operation, showing the provider and model it uses — the default
 * ones unless it has its own — with "Switch" to give it its own, or to put it back on the default.
 */
export function OperationModels({ ctx, state, providers, listModels }: {
  ctx: RowContext;
  state: SettingsState;
  providers: ProviderInfo[];
  listModels(provider: string): Promise<{ models: AiModelOptionMsg[]; error?: string }>;
}) {
  const value = ctx.get<Record<string, AiOperationTarget>>('ai.operationModels') ?? {};
  const [editing, setEditing] = useState<AiOperation | null>(null);
  const blocked = !!ctx.writeBlockedReason('ai.operationModels');

  const save = (op: AiOperation, target: AiOperationTarget | undefined) => {
    const next: Record<string, AiOperationTarget> = { ...value };
    if (target) next[op] = target.model ? target : { provider: target.provider };
    else delete next[op];
    ctx.update('ai.operationModels', next);
    setEditing(null);
  };

  return (
    <div className={`gc-row${ctx.isModified('ai.operationModels') ? ' modified' : ''}`} data-setting="ai.operationModels">
      <RowHeader ctx={ctx} settingKey="ai.operationModels" />
      <div className="gc-row-desc">{l10n.t('Each operation uses the default provider and model unless you switch it to its own.')}</div>
      <div className="gc-row-control gc-operations">
        {AI_OPERATIONS.map(op => {
          const own = operationOverride(value, op);
          const providerLabel = own ? enumLabel('ai.provider', own.provider) : undefined;
          return (
            <div key={op} className={`gc-operation${own ? ' own' : ''}`}>
              <div className="gc-operation-head">
                <Codicon name={OPERATION_ICON[op]} style={{ fontSize: 16 }} />
                <span className="gc-operation-text">
                  <span className="gc-operation-name">{operationLabel(op)}</span>
                  <span className="gc-operation-model">
                    {own
                      ? `${providerLabel} — ${own.model ?? l10n.t('its default model')}`
                      : l10n.t('Default — {0}', state.aiModelLabel)}
                  </span>
                </span>
                {editing !== op && (
                  <button type="button" className="gc-btn gc-btn-secondary" disabled={blocked} onClick={() => setEditing(op)}>
                    <Codicon name="arrow-swap" /> {l10n.t('Switch')}
                  </button>
                )}
              </div>
              {editing === op && (
                <OperationEditor
                  initial={own}
                  providers={providers}
                  apiKeys={state.apiKeys}
                  listModels={listModels}
                  onSave={target => save(op, target)}
                  onCancel={() => setEditing(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OperationEditor({ initial, providers, apiKeys, listModels, onSave, onCancel }: {
  initial?: AiOperationTarget;
  providers: ProviderInfo[];
  apiKeys: SettingsState['apiKeys'];
  listModels(provider: string): Promise<{ models: AiModelOptionMsg[]; error?: string }>;
  onSave(target: AiOperationTarget | undefined): void;
  onCancel(): void;
}) {
  // '' = use the default provider and model.
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const info = providers.find(p => p.id === provider);
  const hasKey = !info?.secret || apiKeys[info.secret];
  const load = useCallback(() => listModels(provider), [provider, hasKey]);

  return (
    <div className="gc-operation-editor">
      <div className="gc-provider-chips" role="radiogroup" aria-label={l10n.t('Provider')}>
        <button type="button" role="radio" aria-checked={provider === ''} className={`gc-provider-chip${provider === '' ? ' selected' : ''}`} onClick={() => { setProvider(''); setModel(''); }}>
          <Codicon name="settings" /> {l10n.t('Default')}
        </button>
        {providers.map(p => (
          <button key={p.id} type="button" role="radio" aria-checked={provider === p.id} className={`gc-provider-chip${provider === p.id ? ' selected' : ''}`}
            onClick={() => { setProvider(p.id); setModel(''); }}>
            {aiProviderIcon(p.id)} {p.label}
          </button>
        ))}
      </div>
      {info && (
        <label className="gc-field">
          <span>{l10n.t('Model')}</span>
          <ModelPicker
            value={model}
            onCommit={setModel}
            load={load}
            canList={info.canList && hasKey}
            autoLabel={info.defaultModel ? l10n.t('Default ({0})', info.defaultModel) : l10n.t('Automatic (the provider picks)')}
            placeholder={info.modelPlaceholder}
          />
          {info.secret && !hasKey && <span className="gc-field-hint">{l10n.t('This provider needs an API key: add it above, under the provider configuration.')}</span>}
        </label>
      )}
      <div className="gc-inline">
        <button type="button" className="gc-btn gc-btn-primary" onClick={() => onSave(provider ? { provider, model: model.trim() || undefined } : undefined)}>
          {l10n.t('Save')}
        </button>
        <button type="button" className="gc-btn gc-btn-secondary" onClick={onCancel}>{l10n.t('Cancel')}</button>
      </div>
    </div>
  );
}
