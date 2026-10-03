import * as l10n from '@vscode/l10n';
import React, { useEffect, useState } from 'react';
import { Codicon } from '../shared/Codicon';
import { INTEGRATIONS, type IntegrationCapability, type IntegrationDefinition } from '../../host/types/integrations';
import type { IntegrationAccountMsg, IntegrationsState } from '../../host/types/messages';
import type { RowContext } from './SettingRow';
import { SettingRow } from './SettingRow';

export interface IntegrationsActions {
  add(integrationId: string, input: { host?: string; label?: string; email?: string; token: string }): Promise<{ ok: boolean; error?: string }>;
  rename(accountId: string, label: string): void;
  remove(accountId: string): void;
  addGitHub(): void;
  assign(repoId: string, value: string): void;
  openUrl(url: string): void;
}

/** Monochrome marks, drawn like codicons (16×16, currentColor). GitHub has a codicon of its own. */
function ProviderIcon({ provider }: { provider: IntegrationDefinition['provider'] }) {
  if (provider === 'github') return <Codicon name="github" style={{ fontSize: 18 }} />;
  const paths: Record<string, React.ReactNode> = {
    gitlab: <path d="M8 14.6 1.1 9.5a.6.6 0 0 1-.2-.6L2.6 2.3a.3.3 0 0 1 .6 0l1.6 4.4h6.4l1.6-4.4a.3.3 0 0 1 .6 0l1.7 6.6a.6.6 0 0 1-.2.6Z" />,
    bitbucket: <path fillRule="evenodd" d="M1.2 1.8a.5.5 0 0 0-.5.6l2 12a.7.7 0 0 0 .7.6h9.3a.5.5 0 0 0 .5-.4l2.1-12.2a.5.5 0 0 0-.5-.6Zm8.4 8.6H6.4l-.8-4.6h4.8Z" />,
    gitea: <path fillRule="evenodd" d="M1 4.2h10.2v1.2h1.3a2.3 2.3 0 0 1 0 4.6h-1.5A4.6 4.6 0 0 1 6.6 13H5.6A4.6 4.6 0 0 1 1 8.4Zm10.2 2.4v2.2h1.3a1.1 1.1 0 0 0 0-2.2ZM5.1 6.4v4.2l3.7-2.1Z" />,
  };
  return <svg className="gc-provider-icon" viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">{paths[provider]}</svg>;
}

function capabilityLabel(c: IntegrationCapability): string {
  return c === 'pullRequests' ? l10n.t('pull requests') : l10n.t('issues');
}

function initials(label: string): string {
  const parts = label.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function IntegrationsSection({ ctx, state, actions }: { ctx: RowContext; state: IntegrationsState | null; actions: IntegrationsActions }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  if (!state) {
    return <div className="gc-row gc-muted"><Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t('Loading integrations…')}</div>;
  }

  return (
    <>
      <div className="gc-integrations">
        {INTEGRATIONS.map(integration => (
          <IntegrationRow
            key={integration.id}
            integration={integration}
            accounts={state.accounts[integration.id] ?? []}
            expanded={expanded === integration.id}
            adding={adding === integration.id}
            onToggle={() => { setExpanded(e => (e === integration.id ? null : integration.id)); setAdding(null); }}
            onConnect={() => {
              if (integration.auth === 'vscode') { actions.addGitHub(); return; }
              setExpanded(integration.id);
              setAdding(integration.id);
            }}
            onAdding={on => setAdding(on ? integration.id : null)}
            actions={actions}
          />
        ))}
      </div>

      <h3 className="gc-subgroup-title">{l10n.t('Repositories')}</h3>
      <p className="gc-group-desc">{l10n.t('The account each repository of this workspace uses for pull requests.')}</p>
      {state.repos.length === 0 && <div className="gc-row gc-muted">{l10n.t('No repositories in this workspace.')}</div>}
      {state.repos.map(repo => (
        <div key={repo.repoId} className="gc-row gc-repo-binding">
          <div className="gc-row-title">
            <span><span className="gc-repo-dot" style={{ background: repo.color }} /><span className="label">{repo.name}</span></span>
            {repo.providerLabel && <span className="gc-row-misc">{repo.providerLabel} · {repo.host}</span>}
          </div>
          {repo.detectionFailed ? (
            <div className="gc-row-desc">
              {repo.host
                ? l10n.t('No forge recognized for {0}. Add it under Self-hosted forges below.', repo.host)
                : l10n.t('No remote with a recognized forge.')}
            </div>
          ) : (
            <div className="gc-row-control gc-inline">
              <select className="gc-select" value={repo.value ?? ''} aria-label={l10n.t('Account for {0}', repo.name)} onChange={e => actions.assign(repo.repoId, e.target.value)}>
                {repo.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {repo.connected
                ? <span className="gc-status-ok"><Codicon name="check" /> {l10n.t('Connected')}</span>
                : <span className="gc-muted">{l10n.t('Not connected')}</span>}
            </div>
          )}
        </div>
      ))}

      <h3 className="gc-subgroup-title">{l10n.t('Self-hosted forges')}</h3>
      <SettingRow ctx={ctx} settingKey="pullRequests.hostProviderOverrides" />
    </>
  );
}

function IntegrationRow({ integration, accounts, expanded, adding, onToggle, onConnect, onAdding, actions }: {
  integration: IntegrationDefinition;
  accounts: IntegrationAccountMsg[];
  expanded: boolean;
  adding: boolean;
  onToggle(): void;
  onConnect(): void;
  onAdding(on: boolean): void;
  actions: IntegrationsActions;
}) {
  const connected = accounts.length > 0;
  const supports = l10n.t('Supports {0}', integration.capabilities.map(capabilityLabel).join(', '));
  return (
    <div className={`gc-integration${connected ? ' connected' : ''}${expanded ? ' expanded' : ''}`}>
      <div className="gc-integration-head">
        <button type="button" className="gc-integration-toggle" aria-expanded={expanded} onClick={onToggle}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
          <ProviderIcon provider={integration.provider} />
          <span className="gc-integration-text">
            <span className="gc-integration-name">{integration.label}</span>
            <span className="gc-integration-desc">{supports}</span>
          </span>
        </button>
        {connected && (
          <span className="gc-status-ok">
            <Codicon name="check" /> {accounts.length === 1 ? l10n.t('Connected') : l10n.t('{0} accounts', accounts.length)}
          </span>
        )}
        <button type="button" className={`gc-btn ${connected ? 'gc-btn-secondary' : 'gc-btn-primary'}`} onClick={connected ? onToggle : onConnect}>
          <Codicon name={connected ? 'gear' : 'plug'} /> {connected ? l10n.t('Manage') : l10n.t('Connect')}
        </button>
      </div>

      {expanded && (
        <div className="gc-integration-body">
          {integration.auth === 'vscode' && (
            <div className="gc-row-desc">{l10n.t('Uses the GitHub accounts signed into VS Code. Sign out from the Accounts menu in the Activity Bar.')}</div>
          )}
          <div className="gc-list-widget gc-accounts">
            {accounts.length === 0 && !adding && <div className="gc-muted gc-accounts-empty">{l10n.t('No accounts yet.')}</div>}
            {accounts.map(account => (
              <AccountRow key={account.id} account={account} editable={integration.auth !== 'vscode'} actions={actions} />
            ))}
          </div>
          {adding ? (
            <AddAccountForm integration={integration} onDone={() => onAdding(false)} actions={actions} />
          ) : (
            <button
              type="button"
              className="gc-btn gc-btn-secondary gc-list-add"
              onClick={() => (integration.auth === 'vscode' ? actions.addGitHub() : onAdding(true))}
            >
              <Codicon name="add" /> {l10n.t('Add Account')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AccountRow({ account, editable, actions }: { account: IntegrationAccountMsg; editable: boolean; actions: IntegrationsActions }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(account.label);
  useEffect(() => setDraft(account.label), [account.label]);
  const save = () => { if (draft.trim() && draft.trim() !== account.label) actions.rename(account.id, draft.trim()); setRenaming(false); };

  if (renaming) {
    return (
      <div className="gc-list-edit" onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setRenaming(false); }}>
        <input className="gc-input" autoFocus value={draft} aria-label={l10n.t('Account label')} onChange={e => setDraft(e.target.value)} />
        <button type="button" className="gc-btn gc-btn-primary" disabled={!draft.trim()} onClick={save}>{l10n.t('OK')}</button>
        <button type="button" className="gc-btn gc-btn-secondary" onClick={() => setRenaming(false)}>{l10n.t('Cancel')}</button>
      </div>
    );
  }
  return (
    <div className="gc-list-row gc-account">
      <span className="gc-account-avatar" aria-hidden="true">{initials(account.label)}</span>
      <span className="gc-account-text">
        <span className="gc-account-label">{account.label} <span className="gc-muted">{account.host}</span></span>
        <span className="gc-muted gc-account-repos">
          {account.repoNames.length > 0 ? l10n.t('Used by {0}', account.repoNames.join(', ')) : l10n.t('Not used by any repository of this workspace')}
        </span>
      </span>
      {/* Always visible, unlike the hover-only actions of setting lists: these are the main things to do with an account. */}
      {editable && (
        <span className="gc-account-actions">
          <button type="button" className="gc-btn gc-btn-secondary" aria-label={l10n.t('Rename {0}', account.label)} onClick={() => setRenaming(true)}>
            <Codicon name="edit" /> {l10n.t('Rename')}
          </button>
          <button type="button" className="gc-btn gc-btn-secondary" aria-label={l10n.t('Remove {0}', account.label)} onClick={() => actions.remove(account.id)}>
            <Codicon name="trash" /> {l10n.t('Remove')}
          </button>
        </span>
      )}
    </div>
  );
}

function AddAccountForm({ integration, onDone, actions }: { integration: IntegrationDefinition; onDone(): void; actions: IntegrationsActions }) {
  const [host, setHost] = useState(integration.host ?? '');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const effectiveHost = (integration.host ?? host.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')) || '';
  const tokenUrl = integration.tokenUrl && effectiveHost ? integration.tokenUrl.replace('{host}', effectiveHost) : undefined;
  const ready = !!token.trim() && !!effectiveHost && (integration.auth !== 'emailToken' || !!email.trim());

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    actions.add(integration.id, { host: integration.host ? undefined : host, email: email || undefined, token, label: label || undefined }).then(
      r => { setBusy(false); if (r.ok) onDone(); else setError(r.error ?? l10n.t('Failed to validate token')); },
      (e: unknown) => { setBusy(false); setError(e instanceof Error ? e.message : String(e)); },
    );
  };

  return (
    <form className="gc-add-account" onSubmit={e => { e.preventDefault(); submit(); }}>
      <div className="gc-add-account-title">{l10n.t('New {0} account', integration.label)}</div>
      {!integration.host && (
        <label className="gc-field">
          <span>{l10n.t('Host')}</span>
          <input className="gc-input mono" autoFocus value={host} placeholder={integration.hostPlaceholder} onChange={e => setHost(e.target.value)} />
        </label>
      )}
      {integration.auth === 'emailToken' && (
        <label className="gc-field">
          <span>{l10n.t('Account email')}</span>
          <input className="gc-input" type="email" autoFocus={!!integration.host} value={email} placeholder="you@example.com" onChange={e => setEmail(e.target.value)} />
        </label>
      )}
      <label className="gc-field">
        <span>{integration.auth === 'emailToken' ? l10n.t('API token') : l10n.t('Personal access token')}</span>
        <input
          className="gc-input mono"
          type="password"
          autoComplete="off"
          autoFocus={!!integration.host && integration.auth !== 'emailToken'}
          value={token}
          onChange={e => setToken(e.target.value)}
        />
        <span className="gc-field-hint">
          {l10n.t('Stored in VS Code secure storage.')}
          {integration.tokenScopes && <> {l10n.t('Required scope: {0}', integration.tokenScopes)}</>}
          {tokenUrl && <> <button type="button" className="gc-link" onClick={() => actions.openUrl(tokenUrl)}>{l10n.t('Create a token')}</button></>}
        </span>
      </label>
      <label className="gc-field">
        <span>{l10n.t('Label (optional)')}</span>
        <input className="gc-input" value={label} placeholder={l10n.t('e.g. Work or Personal')} onChange={e => setLabel(e.target.value)} />
      </label>
      {error && <div className="gc-validation gc-add-error" role="alert">{error}</div>}
      <div className="gc-inline">
        <button type="submit" className="gc-btn gc-btn-primary" disabled={!ready || busy}>
          {busy && <Codicon name="loading" className="codicon-modifier-spin" />}
          {busy ? l10n.t('Verifying…') : l10n.t('Add Account')}
        </button>
        <button type="button" className="gc-btn gc-btn-secondary" disabled={busy} onClick={onDone}>{l10n.t('Cancel')}</button>
      </div>
    </form>
  );
}
