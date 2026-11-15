import * as l10n from '@vscode/l10n';
import React from 'react';
import { Codicon } from '../shared/Codicon';
import type { McpState } from '../../host/types/messages';
import type { AgentId, AgentStatus } from '../../host/mcp/installers';
import type { RowContext } from './SettingRow';
import { SettingRow } from './SettingRow';

export interface McpActions {
  install(agent: AgentId): void;
  uninstall(agent: AgentId): void;
  openConfig(agent: AgentId): void;
}

/** GitCharm's MCP server: on or off, what asks for confirmation, and the agents it is installed in. */
export function McpSection({ ctx, state, actions }: { ctx: RowContext; state: McpState | null; actions: McpActions }) {
  return (
    <>
      <SettingRow ctx={ctx} settingKey="mcp.enabled" />
      {state?.enabled && (
        <div className="gc-row">
          {state.running
            ? <span className="gc-status-ok"><Codicon name="pass" /> {l10n.t('Running: agents reach this window\'s repositories.')}</span>
            : state.error
              ? <span className="gc-status-error"><Codicon name="error" /> {l10n.t('Not running: {0}', state.error)}</span>
              : <span className="gc-muted"><Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t('Starting…')}</span>}
        </div>
      )}
      <SettingRow ctx={ctx} settingKey="mcp.confirmation" />

      <h3 className="gc-subgroup-title">{l10n.t('Agents')}</h3>
      <p className="gc-group-desc">
        {l10n.t('Installs GitCharm\'s server in each agent\'s own configuration, for every project. The agent runs it with VS Code\'s Node runtime: it needs nothing else installed. Restart the agent afterwards.')}
      </p>
      {!state && <div className="gc-row gc-muted"><Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t('Loading…')}</div>}
      {state && !state.enabled && <div className="gc-row gc-muted">{l10n.t('Turn the server on to install it in agents.')}</div>}
      {state?.enabled && state.agents.map(agent => <AgentRow key={agent.id} agent={agent} actions={actions} />)}
      {state?.enabled && (
        <div className="gc-row">
          <div className="gc-row-title"><span className="label">GitHub Copilot (VS Code)</span></div>
          <div className="gc-row-desc">
            {state.vscodeAgent
              ? l10n.t('Available in Copilot\'s agent mode with no installation: GitCharm registers its server with VS Code.')
              : l10n.t('Needs VS Code 1.101 or later, where GitCharm registers its server with VS Code itself.')}
          </div>
        </div>
      )}
    </>
  );
}

function AgentRow({ agent, actions }: { agent: AgentStatus; actions: McpActions }) {
  const installed = agent.status === 'installed' || agent.status === 'outdated';
  return (
    <div className="gc-row">
      <div className="gc-row-title">
        <span className="label">{agent.label}</span>
        <span className="gc-row-misc">{statusText(agent)}</span>
      </div>
      <div className="gc-row-desc">
        <button type="button" className="gc-link gc-path" title={l10n.t('Open the configuration file')} onClick={() => actions.openConfig(agent.id)} disabled={!installed}>
          {agent.configPath}
        </button>
        {agent.error && <div className="gc-status-error">{agent.error}</div>}
      </div>
      <div className="gc-row-control gc-inline">
        {installed
          ? <button type="button" className="gc-btn gc-btn-secondary" onClick={() => actions.uninstall(agent.id)}>{l10n.t('Remove')}</button>
          : <button type="button" className="gc-btn gc-btn-primary" disabled={agent.status === 'unreadable'} onClick={() => actions.install(agent.id)}>{l10n.t('Install')}</button>}
        {agent.status === 'outdated' && (
          <button type="button" className="gc-btn gc-btn-secondary" onClick={() => actions.install(agent.id)}>{l10n.t('Update')}</button>
        )}
      </div>
    </div>
  );
}

function statusText(agent: AgentStatus): string {
  switch (agent.status) {
    case 'installed': return l10n.t('Installed');
    case 'outdated': return l10n.t('Installed, with an older command');
    case 'unreadable': return l10n.t('Configuration unreadable');
    default: return agent.detected ? l10n.t('Not installed') : l10n.t('Not found on this machine');
  }
}
