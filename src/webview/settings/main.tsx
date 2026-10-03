import '../shared/l10n';
import * as l10n from '@vscode/l10n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Codicon } from '../shared/Codicon';
import { useMessageBridge } from '../shared/useMessageBridge';
import { getVsCodeApi, notifyHostReady } from '../shared/vscodeApi';
import type { HostToSettingsMsg, IntegrationsState, SettingsState, SettingsTarget, SettingsToHostMsg } from '../../host/types/messages';
import { IntegrationsSection, type IntegrationsActions } from './IntegrationsSection';
import { AiSection, PromptsSection } from './AiSection';
import { getCategories, settingLabel, type CategoryDef } from './layout';
import { Preview } from './previews';
import { GitCharmIcon } from '../shared/GitCharmIcon';
import { SettingRow, type RowContext } from './SettingRow';
import { SETTINGS_CSS } from './styles';

declare const window: Window & { __INITIAL_CONFIG__?: { section?: string } };

interface UiState { category?: string; target?: SettingsTarget; collapsed?: string[] }

function loadUiState(): UiState {
  return getVsCodeApi().getState<UiState>() ?? {};
}

function App() {
  const { send, request } = useMessageBridge<HostToSettingsMsg, SettingsToHostMsg>();
  const categories = useMemo(() => getCategories(), []);
  const [state, setState] = useState<SettingsState | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationsState | null>(null);
  const [category, setCategory] = useState(() => window.__INITIAL_CONFIG__?.section ?? loadUiState().category ?? categories[0].id);
  const [target, setTarget] = useState<SettingsTarget>(() => loadUiState().target ?? 'user');
  const [collapsed, setCollapsed] = useState<string[]>(() => loadUiState().collapsed ?? []);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToSettingsMsg>) => {
      const msg = event.data;
      if (msg?.type === 'SETTINGS_STATE') setState(msg.state);
      else if (msg?.type === 'SETTINGS_INTEGRATIONS') setIntegrations(msg.state);
      else if (msg?.type === 'SETTINGS_NAVIGATE') { setQuery(''); setCategory(msg.section); }
    };
    window.addEventListener('message', handler);
    notifyHostReady();
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => { getVsCodeApi().setState<UiState>({ category, target, collapsed }); }, [category, target, collapsed]);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [category]);
  // Read lazily: the host has to look at every repository's remotes. It then keeps the page up to date.
  useEffect(() => { if (category === 'integrations') send({ type: 'SETTINGS_INTEGRATIONS_GET' }); }, [category, send]);

  // Without a folder open there's no workspace to write to.
  const effectiveTarget: SettingsTarget = state && !state.hasWorkspace ? 'user' : target;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ctx: RowContext | null = useMemo(() => {
    if (!state) return null;
    const schemaByKey = new Map(state.schema.map(s => [s.key, s]));
    const categoryByKey = new Map(categories.flatMap(c => c.keys.map(k => [k, c.label] as const)));
    const userOnly = (key: string) => {
      const scope = schemaByKey.get(key)?.scope;
      return scope === 'application' || scope === 'machine';
    };
    return {
      schema: key => schemaByKey.get(key),
      get: <T,>(key: string): T => {
        const v = state.values[key];
        if (!v) return undefined as T;
        return (effectiveTarget === 'workspace' ? v.workspace ?? v.user ?? v.default : v.user ?? v.default) as T;
      },
      isModified: key => {
        const v = state.values[key];
        return effectiveTarget === 'workspace' ? v?.workspace !== undefined : v?.user !== undefined;
      },
      update: (key, value) => send({ type: 'SETTINGS_UPDATE', key, value, target: effectiveTarget }),
      reset: key => send({ type: 'SETTINGS_UPDATE', key, value: undefined, target: effectiveTarget }),
      // Same wording as VS Code's own "Also modified in:" indicator.
      scopeNote: key => {
        const v = state.values[key];
        if (effectiveTarget === 'user' && v?.workspace !== undefined && !userOnly(key)) return l10n.t('Also modified in: {0}', l10n.t('Workspace'));
        if (effectiveTarget === 'workspace' && v?.user !== undefined) return l10n.t('Also modified in: {0}', l10n.t('User'));
        return undefined;
      },
      writeBlockedReason: key => (effectiveTarget === 'workspace' && userOnly(key)
        ? l10n.t('This setting can only be applied in User settings.')
        : undefined),
      categoryOf: key => categoryByKey.get(key) ?? 'GitCharm',
      openNative: key => send({ type: 'SETTINGS_OPEN_NATIVE', key }),
      copy: text => send({ type: 'SETTINGS_COPY', text }),
      repos: state.repos,
    };
  }, [state, effectiveTarget, send, categories]);

  const listModels = useCallback(async (provider: string) => {
    const r = await request<Extract<HostToSettingsMsg, { type: 'SETTINGS_MODELS' }>>({ type: 'SETTINGS_LIST_MODELS', provider } as SettingsToHostMsg, 20_000);
    return { models: r.models, error: r.error };
  }, [request]);

  const testAi = useCallback(async () => {
    const r = await request<Extract<HostToSettingsMsg, { type: 'SETTINGS_TEST_RESULT' }>>({ type: 'SETTINGS_TEST_AI' } as SettingsToHostMsg, 60_000);
    return { ok: r.ok, message: r.message, elapsedMs: r.elapsedMs };
  }, [request]);

  const setApiKey = useCallback((provider: 'claude' | 'openai' | 'gemini', value: string) => {
    send({ type: 'SETTINGS_SET_API_KEY', provider, value });
  }, [send]);

  const integrationActions: IntegrationsActions = useMemo(() => ({
    add: async (integrationId, input) => {
      // Validating a token is a network call to the service: allow it more than the default timeout.
      const r = await request<Extract<HostToSettingsMsg, { type: 'SETTINGS_INTEGRATION_ADDED' }>>(
        { type: 'SETTINGS_INTEGRATION_ADD', integrationId, ...input } as SettingsToHostMsg, 60_000);
      return { ok: r.ok, error: r.error };
    },
    rename: (accountId, label) => send({ type: 'SETTINGS_INTEGRATION_RENAME', accountId, label }),
    remove: accountId => send({ type: 'SETTINGS_INTEGRATION_REMOVE', accountId }),
    addGitHub: () => send({ type: 'SETTINGS_INTEGRATION_GITHUB_ADD' }),
    assign: (repoId, value) => send({ type: 'SETTINGS_INTEGRATION_ASSIGN', repoId, value }),
    openUrl: url => send({ type: 'SETTINGS_OPEN_URL', url }),
  }), [send, request]);

  if (!state || !ctx) {
    return <div className="gc-loading"><Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t('Loading settings…')}</div>;
  }

  const q = query.trim().toLowerCase();
  const matches = (key: string) => {
    if (!q) return true;
    const s = ctx.schema(key);
    return [key, settingLabel(key), ctx.categoryOf(key), s?.description ?? '', ...(s?.enumDescriptions ?? [])].some(t => t.toLowerCase().includes(q));
  };
  const hitCount = q ? categories.reduce((n, c) => n + c.keys.filter(matches).length, 0) : 0;
  const current = categories.find(c => c.id === category) ?? categories[0];
  const groups = [...new Set(categories.map(c => c.group))];
  const toggleGroup = (g: string) => setCollapsed(cs => (cs.includes(g) ? cs.filter(x => x !== g) : [...cs, g]));

  return (
    <div className="gc-settings">
      <header className="gc-header">
        <div className="gc-search">
          <input
            ref={searchRef}
            value={query}
            placeholder={l10n.t('Search settings')}
            aria-label={l10n.t('Search settings')}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }}
          />
          {q && (
            <span className="gc-search-count">
              {hitCount === 1 ? l10n.t('1 Setting Found') : l10n.t('{0} Settings Found', hitCount)}
            </span>
          )}
          {query && (
            <button type="button" className="gc-icon-btn" title={l10n.t('Clear Settings Search Input')} aria-label={l10n.t('Clear Settings Search Input')} onClick={() => setQuery('')}>
              <Codicon name="clear-all" />
            </button>
          )}
        </div>
        <div className="gc-tabs-row" role="tablist" aria-label={l10n.t('Where changes are saved')}>
          <button type="button" role="tab" aria-selected={effectiveTarget === 'user'} className={`gc-tab${effectiveTarget === 'user' ? ' active' : ''}`} onClick={() => setTarget('user')}>
            {l10n.t('User')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTarget === 'workspace'}
            className={`gc-tab${effectiveTarget === 'workspace' ? ' active' : ''}`}
            disabled={!state.hasWorkspace}
            title={state.hasWorkspace ? undefined : l10n.t('Open a folder to save settings for its workspace.')}
            onClick={() => setTarget('workspace')}
          >
            {l10n.t('Workspace')}
          </button>
          <div className="gc-tabs-actions">
            <button type="button" className="gc-icon-btn" title={l10n.t('Open Settings (JSON)')} aria-label={l10n.t('Open Settings (JSON)')} onClick={() => send({ type: 'SETTINGS_OPEN_JSON' })}>
              <Codicon name="go-to-file" />
            </button>
            <button type="button" className="gc-icon-btn" title={l10n.t('Open in VS Code Settings')} aria-label={l10n.t('Open in VS Code Settings')} onClick={() => send({ type: 'SETTINGS_OPEN_NATIVE' })}>
              <Codicon name="settings" />
            </button>
          </div>
        </div>
      </header>

      <div className="gc-main">
        <nav className="gc-toc" aria-label={l10n.t('Setting categories')}>
          {groups.map(group => {
            const items = categories.filter(c => c.group === group && (!q || c.keys.some(matches)));
            if (items.length === 0) return null;
            const isCollapsed = !q && collapsed.includes(group);
            return (
              <div key={group} role="group">
                <button type="button" className="gc-toc-group" aria-expanded={!isCollapsed} onClick={() => toggleGroup(group)}>
                  <Codicon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
                  <span className="gc-toc-label">{group}</span>
                </button>
                {!isCollapsed && items.map(c => {
                  const active = !q && c.id === current.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`gc-toc-item${active ? ' active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => { setQuery(''); setCategory(c.id); }}
                    >
                      {c.icon.startsWith('gitcharm-') ? <GitCharmIcon name={c.icon.slice('gitcharm-'.length)} style={{ fontSize: 14 }} /> : <Codicon name={c.icon} />}
                      <span className="gc-toc-label">{c.label}</span>
                      {q && <span className="gc-toc-count">({c.keys.filter(matches).length})</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="gc-content" ref={contentRef}>
          {q ? (
            <SearchResults ctx={ctx} categories={categories} matches={matches} state={state} />
          ) : (
            <CategoryPage category={current} ctx={ctx} state={state} listModels={listModels} testAi={testAi} setApiKey={setApiKey} integrations={integrations} integrationActions={integrationActions} />
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryPage({ category, ctx, state, listModels, testAi, setApiKey, integrations, integrationActions }: {
  category: CategoryDef;
  ctx: RowContext;
  state: SettingsState;
  listModels: React.ComponentProps<typeof AiSection>['listModels'];
  testAi: React.ComponentProps<typeof AiSection>['testAi'];
  setApiKey: React.ComponentProps<typeof AiSection>['setApiKey'];
  integrations: IntegrationsState | null;
  integrationActions: IntegrationsActions;
}) {
  return (
    <>
      <h2 className="gc-group-title">{category.label}</h2>
      <p className="gc-group-desc">{category.description}</p>
      <div className={`gc-body${category.preview ? ' with-preview' : ''}`}>
        <div className="gc-body-main">
          {category.custom === 'ai' && <AiSection ctx={ctx} state={state} listModels={listModels} testAi={testAi} setApiKey={setApiKey} />}
          {category.custom === 'aiPrompts' && <PromptsSection ctx={ctx} keys={category.keys} defaults={state.defaultPrompts} />}
          {category.custom === 'integrations' && <IntegrationsSection ctx={ctx} state={integrations} actions={integrationActions} />}
          {!category.custom && category.keys.map(key => <SettingRow key={key} ctx={ctx} settingKey={key} />)}
        </div>
        {category.preview && (
          <aside className="gc-body-preview">
            <Preview id={category.preview} get={ctx.get} repos={state.repos} />
          </aside>
        )}
      </div>
    </>
  );
}

function SearchResults({ ctx, categories, matches, state }: { ctx: RowContext; categories: CategoryDef[]; matches(key: string): boolean; state: SettingsState }) {
  const sections = categories.map(c => ({ c, keys: c.keys.filter(matches) })).filter(s => s.keys.length > 0);
  if (sections.length === 0) {
    return <div className="gc-empty">{l10n.t('No Settings Found')}</div>;
  }
  return (
    <>
      {sections.map(({ c, keys }) => (
        <section key={c.id}>
          <h3 className="gc-subgroup-title">{c.label}</h3>
          {c.custom === 'aiPrompts'
            ? <PromptsSection ctx={ctx} keys={keys} defaults={state.defaultPrompts} />
            : keys.map(key => <SettingRow key={key} ctx={ctx} settingKey={key} />)}
        </section>
      ))}
    </>
  );
}

const style = document.createElement('style');
style.textContent = SETTINGS_CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
