import * as l10n from '@vscode/l10n';
import React, { useEffect, useRef, useState } from 'react';
import { Codicon } from '../shared/Codicon';
import type { AiModelOptionMsg, SettingSchema } from '../../host/types/messages';
import { enumLabel } from './layout';

// The controls of VS Code's Settings editor: checkbox, text/number box, dropdown, and the list and
// key/value widgets of array and object settings. Text-like controls keep a local draft and only save on
// Enter or blur: saving on each keystroke would rewrite settings.json for every character.

export function Checkbox({ checked, onChange, disabled, label }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; label: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onClick={e => e.stopPropagation()}
      onChange={e => onChange(e.target.checked)}
    />
  );
}

export function TextInput({ value, onCommit, placeholder, disabled, monospace, type = 'text', label }: {
  value: string; onCommit(v: string): void; placeholder?: string; disabled?: boolean; monospace?: boolean; type?: 'text' | 'url'; label: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <input
      className={`gc-input${monospace ? ' mono' : ''}`}
      type={type}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      spellCheck={false}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

export function NumberInput({ value, schema, onCommit, disabled, label }: {
  value: number; schema: SettingSchema; onCommit(v: number): void; disabled?: boolean; label: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = Number(draft);
  const error = draft.trim() === '' || !Number.isFinite(parsed)
    ? l10n.t('Enter a number.')
    : schema.minimum !== undefined && parsed < schema.minimum
      ? l10n.t('The minimum is {0}.', schema.minimum)
      : schema.maximum !== undefined && parsed > schema.maximum
        ? l10n.t('The maximum is {0}.', schema.maximum)
        : undefined;
  const commit = () => { if (!error && parsed !== value) onCommit(parsed); };
  return (
    <div>
      <input
        className={`gc-input gc-input-number${error ? ' invalid' : ''}`}
        type="number"
        value={draft}
        min={schema.minimum}
        max={schema.maximum}
        disabled={disabled}
        aria-label={label}
        aria-invalid={!!error}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(String(value));
        }}
      />
      {error && <div className="gc-validation" style={{ width: 200 }}>{error}</div>}
    </div>
  );
}

/** A dropdown, with the selected option's description under it (VS Code shows it in the open list only). */
export function EnumSelect({ settingKey, schema, value, onChange, disabled, label }: {
  settingKey: string; schema: SettingSchema; value: string; onChange(v: string): void; disabled?: boolean; label: string;
}) {
  const options = schema.enum ?? [];
  const index = options.indexOf(value);
  const description = index >= 0 ? schema.enumDescriptions?.[index] : undefined;
  return (
    <div>
      <select className="gc-select" value={value} disabled={disabled} aria-label={label} onChange={e => onChange(e.target.value)}>
        {index < 0 && <option value={value}>{value}</option>}
        {options.map(opt => <option key={opt} value={opt}>{enumLabel(settingKey, opt)}</option>)}
      </select>
      {description && <div className="gc-select-desc">{description}</div>}
    </div>
  );
}

/** Every option at once, each with its explanation: for enums whose choice is easier to make side by side. */
export function EnumCards({ settingKey, schema, value, onChange, disabled, label, icon }: {
  settingKey: string; schema: SettingSchema; value: string; onChange(v: string): void; disabled?: boolean; label: string;
  /** Optional icon per option, shown between the radio and the text. */
  icon?: (option: string) => React.ReactNode;
}) {
  const options = schema.enum ?? [];
  return (
    <div className="gc-enum-cards" role="radiogroup" aria-label={label}>
      {options.map((opt, i) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          className={`gc-enum-card${value === opt ? ' selected' : ''}`}
          disabled={disabled}
          onClick={() => onChange(opt)}
        >
          <span className="gc-radio" aria-hidden="true" />
          {icon?.(opt)}
          <span className="gc-enum-text">
            <span className="gc-enum-title">{enumLabel(settingKey, opt)}</span>
            {schema.enumDescriptions?.[i] && <span className="gc-enum-desc">{schema.enumDescriptions[i]}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** One inline editor row of a list/object widget: input(s) plus OK / Cancel, like VS Code's. */
function EditRow({ children, onOk, onCancel, okDisabled }: { children: React.ReactNode; onOk(): void; onCancel(): void; okDisabled?: boolean }) {
  return (
    <div
      className="gc-list-edit"
      onKeyDown={e => {
        if (e.key === 'Enter' && !okDisabled) { e.preventDefault(); onOk(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
    >
      {children}
      <button type="button" className="gc-btn gc-btn-primary" disabled={okDisabled} onClick={onOk}>{l10n.t('OK')}</button>
      <button type="button" className="gc-btn gc-btn-secondary" onClick={onCancel}>{l10n.t('Cancel')}</button>
    </div>
  );
}

function RowActions({ onEdit, onRemove, disabled, itemLabel }: { onEdit?(): void; onRemove?(): void; disabled?: boolean; itemLabel: string }) {
  return (
    <span className="gc-list-actions">
      {onEdit && (
        <button type="button" className="gc-icon-btn" title={l10n.t('Edit Item')} aria-label={l10n.t('Edit {0}', itemLabel)} disabled={disabled} onClick={onEdit}>
          <Codicon name="edit" />
        </button>
      )}
      {onRemove && (
        <button type="button" className="gc-icon-btn" title={l10n.t('Remove Item')} aria-label={l10n.t('Remove {0}', itemLabel)} disabled={disabled} onClick={onRemove}>
          <Codicon name="close" />
        </button>
      )}
    </span>
  );
}

/** Array of strings: VS Code's list widget. */
export function StringList({ value, onChange, placeholder, disabled, label, format }: {
  value: string[]; onChange(v: string[]): void; placeholder?: string; disabled?: boolean; label: string;
  /** Normalizes an entry before it's saved (e.g. a trailing wildcard). */
  format?: (v: string) => string;
}) {
  // null: not editing; -1: adding; otherwise the index being edited.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const start = (index: number) => { setEditing(index); setDraft(index >= 0 ? value[index] : ''); };
  const ok = () => {
    const entry = format ? format(draft.trim()) : draft.trim();
    if (entry) {
      const next = [...value];
      if (editing === -1) { if (!next.includes(entry)) next.push(entry); } else if (editing !== null) next[editing] = entry;
      onChange(next);
    }
    setEditing(null);
  };
  const editor = (
    <EditRow onOk={ok} onCancel={() => setEditing(null)} okDisabled={!draft.trim()}>
      <input className="gc-input" autoFocus value={draft} placeholder={placeholder} aria-label={label} spellCheck={false} onChange={e => setDraft(e.target.value)} />
    </EditRow>
  );
  return (
    <div className="gc-list-widget">
      {value.map((item, i) => (editing === i ? <React.Fragment key={item}>{editor}</React.Fragment> : (
        <div key={item} className="gc-list-row" onDoubleClick={() => !disabled && start(i)}>
          <span className="gc-list-value">{item}</span>
          <RowActions itemLabel={item} disabled={disabled} onEdit={() => start(i)} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      )))}
      {editing === -1 ? editor : (
        <button type="button" className="gc-btn gc-btn-primary gc-list-add" disabled={disabled} onClick={() => start(-1)}>{l10n.t('Add Item')}</button>
      )}
    </div>
  );
}

/**
 * An array setting that is a fixed set of items in a chosen order: every item listed once, moved with up/down
 * buttons. `value` may leave items out or hold unknown ones: unknown ones are dropped, missing ones go last.
 */
export function OrderedList({ value, items, itemLabel, itemNote, onChange, disabled }: {
  value: string[]; items: string[]; itemLabel(id: string): string; itemNote?(id: string): string | undefined;
  onChange(v: string[]): void; disabled?: boolean;
}) {
  const order = [...value.filter((id, i) => items.includes(id) && value.indexOf(id) === i), ...items.filter(id => !value.includes(id))];
  const move = (from: number, to: number) => {
    const next = [...order];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    onChange(next);
  };
  return (
    <div className="gc-list-widget">
      {order.map((id, i) => {
        const label = itemLabel(id);
        const note = itemNote?.(id);
        return (
          <div key={id} className="gc-list-row">
            <span className="gc-list-value">{label}{note && <span className="gc-list-note"> · {note}</span>}</span>
            <span className="gc-list-actions">
              <button type="button" className="gc-icon-btn" title={l10n.t('Move Up')} aria-label={l10n.t('Move {0} up', label)} disabled={disabled || i === 0} onClick={() => move(i, i - 1)}>
                <Codicon name="arrow-up" />
              </button>
              <button type="button" className="gc-icon-btn" title={l10n.t('Move Down')} aria-label={l10n.t('Move {0} down', label)} disabled={disabled || i === order.length - 1} onClick={() => move(i, i + 1)}>
                <Codicon name="arrow-down" />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** gitcharm.projectColors: a key/value table listing every repository of the workspace, plus any other name already configured. */
export function ProjectColorsEditor({ value, repos, onChange, disabled }: {
  value: Record<string, string>; repos: { name: string; color: string }[]; onChange(v: Record<string, string>): void; disabled?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#ff6b6b');
  const names = [...repos.map(r => r.name), ...Object.keys(value).filter(n => !repos.some(r => r.name === n))];
  const set = (n: string, c: string | undefined) => {
    const next = { ...value };
    if (c === undefined) delete next[n];
    else next[n] = c;
    onChange(next);
  };
  return (
    <div className="gc-list-widget">
      <div className="gc-list-header"><span className="gc-list-key">{l10n.t('Item')}</span><span className="gc-list-value">{l10n.t('Value')}</span></div>
      {names.map(n => {
        const custom = value[n];
        const current = custom ?? repos.find(r => r.name === n)?.color ?? '#888888';
        return (
          <div key={n} className="gc-list-row">
            <span className="gc-list-key" title={n}>{n}</span>
            <span className="gc-list-value">
              <input
                type="color"
                className="gc-color"
                value={HEX_COLOR.test(current) ? current : '#888888'}
                disabled={disabled}
                aria-label={l10n.t('Color of {0}', n)}
                onChange={e => set(n, e.target.value)}
              />
              <span className="mono">{current}</span>
              {!custom && <span className="gc-muted">{l10n.t('(automatic)')}</span>}
              {!repos.some(r => r.name === n) && <span className="gc-muted">{l10n.t('(not in this workspace)')}</span>}
            </span>
            {custom && <RowActions itemLabel={n} disabled={disabled} onRemove={() => set(n, undefined)} />}
          </div>
        );
      })}
      {adding ? (
        <EditRow
          okDisabled={!name.trim() || names.includes(name.trim())}
          onOk={() => { set(name.trim(), color); setAdding(false); setName(''); }}
          onCancel={() => setAdding(false)}
        >
          <input className="gc-input" autoFocus value={name} placeholder={l10n.t('Repository or folder name')} aria-label={l10n.t('Repository or folder name')} onChange={e => setName(e.target.value)} />
          <input type="color" className="gc-color" value={color} aria-label={l10n.t('Color')} onChange={e => setColor(e.target.value)} />
        </EditRow>
      ) : (
        <button type="button" className="gc-btn gc-btn-primary gc-list-add" disabled={disabled} onClick={() => setAdding(true)}>{l10n.t('Add Item')}</button>
      )}
    </div>
  );
}

const FORGES = ['github', 'gitlab', 'bitbucket', 'gitea'] as const;
const FORGE_LABEL: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', gitea: 'Gitea' };

/** gitcharm.pullRequests.hostProviderOverrides: host → forge type, as a key/value table. */
export function HostOverridesEditor({ value, onChange, disabled }: { value: Record<string, string>; onChange(v: Record<string, string>): void; disabled?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState('');
  const [forge, setForge] = useState<string>('gitea');
  const add = () => {
    const h = host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (h) onChange({ ...value, [h]: forge });
    setHost('');
    setAdding(false);
  };
  const entries = Object.entries(value);
  return (
    <div className="gc-list-widget">
      {entries.length > 0 && <div className="gc-list-header"><span className="gc-list-key">{l10n.t('Item')}</span><span className="gc-list-value">{l10n.t('Value')}</span></div>}
      {entries.map(([h, f]) => (
        <div key={h} className="gc-list-row">
          <span className="gc-list-key mono" title={h}>{h}</span>
          <span className="gc-list-value">
            <select className="gc-select small" value={f} disabled={disabled} aria-label={l10n.t('Forge type of {0}', h)} onChange={e => onChange({ ...value, [h]: e.target.value })}>
              {FORGES.map(x => <option key={x} value={x}>{FORGE_LABEL[x]}</option>)}
            </select>
          </span>
          <RowActions itemLabel={h} disabled={disabled} onRemove={() => { const next = { ...value }; delete next[h]; onChange(next); }} />
        </div>
      ))}
      {adding ? (
        <EditRow okDisabled={!host.trim()} onOk={add} onCancel={() => setAdding(false)}>
          <input className="gc-input mono" autoFocus value={host} placeholder="git.mycompany.com" aria-label={l10n.t('Host')} onChange={e => setHost(e.target.value)} />
          <select className="gc-select small" value={forge} aria-label={l10n.t('Forge type')} onChange={e => setForge(e.target.value)}>
            {FORGES.map(x => <option key={x} value={x}>{FORGE_LABEL[x]}</option>)}
          </select>
        </EditRow>
      ) : (
        <button type="button" className="gc-btn gc-btn-primary gc-list-add" disabled={disabled} onClick={() => setAdding(true)}>{l10n.t('Add Item')}</button>
      )}
    </div>
  );
}

/** An API key: write-only. The page only ever learns whether one is stored. */
export function ApiKeyField({ stored, providerLabel, onSave }: { stored: boolean; providerLabel: string; onSave(v: string): void }) {
  const [editing, setEditing] = useState(!stored);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setEditing(!stored); setDraft(''); }, [stored]);
  useEffect(() => { if (editing && stored) inputRef.current?.focus(); }, [editing, stored]);

  if (!editing) {
    return (
      <div>
        <div className="gc-apikey-status"><Codicon name="lock" /> {l10n.t('Stored in secure storage')}</div>
        <div className="gc-inline">
          <button type="button" className="gc-btn gc-btn-secondary" onClick={() => setEditing(true)}>{l10n.t('Replace')}</button>
          <button type="button" className="gc-btn gc-btn-secondary" onClick={() => onSave('')}>{l10n.t('Remove')}</button>
        </div>
      </div>
    );
  }
  const save = () => { if (draft.trim()) onSave(draft); };
  return (
    <div className="gc-inline">
      <input
        ref={inputRef}
        className="gc-input mono"
        type="password"
        autoComplete="off"
        value={draft}
        placeholder={l10n.t('Paste your {0} API key', providerLabel)}
        aria-label={l10n.t('{0} API key', providerLabel)}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape' && stored) setEditing(false); }}
      />
      <button type="button" className="gc-btn gc-btn-primary" disabled={!draft.trim()} onClick={save}>{l10n.t('Save')}</button>
      {stored && <button type="button" className="gc-btn gc-btn-secondary" onClick={() => setEditing(false)}>{l10n.t('Cancel')}</button>}
    </div>
  );
}

/**
 * The model of a provider: a dropdown of what the provider lists, with the current value kept even when it
 * isn't listed, and a free-text fallback (custom ids, provider unreachable, CLI providers with no listing).
 */
export function ModelPicker({ value, onCommit, load, autoLabel, placeholder, canList, disabled }: {
  value: string;
  onCommit(v: string): void;
  load(): Promise<{ models: AiModelOptionMsg[]; error?: string }>;
  /** Label of the empty value: the provider's own default model. */
  autoLabel: string;
  placeholder?: string;
  canList: boolean;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<AiModelOptionMsg[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [manual, setManual] = useState(!canList);

  const refresh = () => {
    if (!canList) return;
    setLoading(true);
    setError(undefined);
    load().then(
      r => { setModels(r.models); setError(r.error); setLoading(false); },
      (e: unknown) => { setModels([]); setError(e instanceof Error ? e.message : String(e)); setLoading(false); },
    );
  };
  // Reload whenever the picker is shown for another provider (its `load` changes with it).
  useEffect(() => { setManual(!canList); setModels(null); refresh(); }, [load, canList]);

  const listed = models ?? [];
  const showSelect = canList && !manual && listed.length > 0;
  return (
    <div>
      <div className="gc-inline">
        {showSelect ? (
          <select className="gc-select" style={{ flex: 1, width: 'auto' }} value={value} disabled={disabled} aria-label={l10n.t('Model')} onChange={e => onCommit(e.target.value)}>
            <option value="">{autoLabel}</option>
            {value && !listed.some(m => m.id === value) && <option value={value}>{value}</option>}
            {listed.map(m => <option key={m.id} value={m.id}>{m.detail ? `${m.label} — ${m.detail}` : m.label}</option>)}
          </select>
        ) : (
          <TextInput value={value} onCommit={onCommit} placeholder={placeholder ?? autoLabel} disabled={disabled} monospace label={l10n.t('Model')} />
        )}
        {canList && (
          <button type="button" className="gc-icon-btn" title={l10n.t('Reload the model list')} aria-label={l10n.t('Reload the model list')} disabled={loading} onClick={refresh}>
            <Codicon name={loading ? 'loading' : 'refresh'} className={loading ? 'codicon-modifier-spin' : undefined} />
          </button>
        )}
        {canList && listed.length > 0 && (
          <button type="button" className="gc-icon-btn" title={manual ? l10n.t('Pick from the list') : l10n.t('Type a model id')}
            aria-label={manual ? l10n.t('Pick from the list') : l10n.t('Type a model id')} onClick={() => setManual(m => !m)}>
            <Codicon name={manual ? 'list-selection' : 'edit'} />
          </button>
        )}
      </div>
      {loading && <div className="gc-model-status">{l10n.t('Loading models…')}</div>}
      {!loading && error && <div className="gc-model-status warning"><Codicon name="warning" /> {error}</div>}
      {!loading && !error && models && models.length === 0 && canList && <div className="gc-model-status">{l10n.t('No models found. Type the model id instead.')}</div>}
    </div>
  );
}

export interface MenuItem { label: string; onClick(): void; disabled?: boolean; separatorBefore?: boolean }

/** The "More Actions…" gear of a setting row, with its context menu. */
export function GearMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} className={`gc-row-gear${open ? ' open' : ''}`}>
      <button type="button" className="gc-icon-btn" title={l10n.t('More Actions...')} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Codicon name="gear" />
      </button>
      {open && (
        <div className="gc-menu" role="menu" style={{ left: 0, top: 24 }}>
          {items.map(item => (
            <React.Fragment key={item.label}>
              {item.separatorBefore && <hr />}
              <button type="button" role="menuitem" disabled={item.disabled} onClick={() => { setOpen(false); item.onClick(); }}>{item.label}</button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
