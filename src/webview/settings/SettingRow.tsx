import * as l10n from '@vscode/l10n';
import React, { useMemo } from 'react';
import { renderMarkdown } from '../shared/renderMarkdown';
import type { SettingSchema } from '../../host/types/messages';
import { Checkbox, EnumCards, EnumSelect, GearMenu, HostOverridesEditor, NumberInput, OrderedList, ProjectColorsEditor, StringList, TextInput } from './controls';
import { enumLabel, settingLabel } from './layout';
import { aiProviderIcon } from './providerIcons';
import { normalizeBranchModel } from '../../host/types/branchModels';

/** What a row needs from the page: values as seen from the selected target (User or Workspace), and how to change them. */
export interface RowContext {
  schema(key: string): SettingSchema | undefined;
  get<T>(key: string): T;
  /** Whether the selected target sets this setting. */
  isModified(key: string): boolean;
  update(key: string, value: unknown): void;
  /** Removes the value from the selected target. */
  reset(key: string): void;
  /** E.g. "Also modified in: Workspace" — set in the other target too. */
  scopeNote(key: string): string | undefined;
  /** Why the selected target can't hold this setting, if it can't. */
  writeBlockedReason(key: string): string | undefined;
  /** The label of the category the setting is listed under, so the search also matches it. */
  categoryOf(key: string): string;
  openNative(key: string): void;
  copy(text: string): void;
  repos: { name: string; color: string }[];
}

/** Enums with at most this many options are shown as cards. */
const CARD_ENUM_MAX = 6;

const PLACEHOLDER: Record<string, () => string> = {
  'ai.language': () => l10n.t('Empty: VS Code display language (e.g. en, it, fr)'),
  'pullRequests.defaultTargetBranch': () => l10n.t('Empty: detect main / master'),
};

const COMMIT_PANEL_TABS = ['changes', 'shelf', 'stash', 'worktrees', 'pullRequests', 'sync'];
/** The setting that hides each Commit Panel tab (Changes can't be hidden). */
const TAB_SHOW_SETTING: Record<string, string> = {
  shelf: 'commitPanel.showShelfTab',
  stash: 'commitPanel.showStashTab',
  worktrees: 'commitPanel.showWorktreesTab',
  pullRequests: 'commitPanel.showPullRequestsTab',
  sync: 'commitPanel.showSyncTab',
};

/** Stores branch models the way the branch prompt reads them ("feature" -> "feature/*"). */
function branchModel(v: string): string {
  return normalizeBranchModel(v) ?? '';
}

/** The title line and the gear menu, shared by every kind of row (also the AI prompts and the API key). */
export function RowHeader({ ctx, settingKey, label }: { ctx: RowContext; settingKey: string; label?: string }) {
  const title = label ?? settingLabel(settingKey);
  const note = ctx.scopeNote(settingKey);
  const modified = ctx.isModified(settingKey);
  const blocked = !!ctx.writeBlockedReason(settingKey);
  const id = `gitcharm.${settingKey}`;
  return (
    <>
      <GearMenu
        label={l10n.t('More actions for {0}', title)}
        items={[
          { label: l10n.t('Reset Setting'), disabled: !modified || blocked, onClick: () => ctx.reset(settingKey) },
          { label: l10n.t('Copy Setting ID'), onClick: () => ctx.copy(id), separatorBefore: true },
          { label: l10n.t('Copy Setting as JSON'), onClick: () => ctx.copy(`"${id}": ${JSON.stringify(ctx.get(settingKey), null, 2)}`) },
          { label: l10n.t('Show in VS Code Settings'), onClick: () => ctx.openNative(settingKey), separatorBefore: true },
        ]}
      />
      <div className="gc-row-title" title={id}>
        <span className="label">{title}</span>
        {note && <span className="gc-row-misc">{note}</span>}
      </div>
    </>
  );
}

export function SettingRow({ ctx, settingKey, children }: { ctx: RowContext; settingKey: string; children?: React.ReactNode }) {
  const schema = ctx.schema(settingKey);
  const description = useMemo(() => (schema?.description ? renderMarkdown(schema.description) : ''), [schema?.description]);
  if (!schema) return null;

  const value = ctx.get<unknown>(settingKey);
  const modified = ctx.isModified(settingKey);
  const blocked = ctx.writeBlockedReason(settingKey);
  const label = settingLabel(settingKey);
  const disabled = !!blocked;
  const descNode = description ? <div className="gc-row-desc markdown-body" dangerouslySetInnerHTML={{ __html: description }} /> : null;

  // Booleans: the checkbox sits before the description, and clicking the description toggles it (as in VS Code).
  if (schema.type === 'boolean' && !children) {
    return (
      <div className={`gc-row${modified ? ' modified' : ''}`} data-setting={settingKey}>
        <RowHeader ctx={ctx} settingKey={settingKey} />
        <div
          className="gc-checkbox-line"
          onClick={e => {
            if (disabled || (e.target as HTMLElement).closest('a')) return;
            ctx.update(settingKey, !value);
          }}
        >
          <Checkbox checked={!!value} disabled={disabled} label={label} onChange={v => ctx.update(settingKey, v)} />
          {descNode}
        </div>
        {blocked && <div className="gc-row-note">{blocked}</div>}
      </div>
    );
  }

  let control: React.ReactNode = children;
  if (!control) {
    if (settingKey === 'projectColors') {
      control = <ProjectColorsEditor value={(value as Record<string, string>) ?? {}} repos={ctx.repos} disabled={disabled} onChange={v => ctx.update(settingKey, v)} />;
    } else if (settingKey === 'commitPanel.tabOrder') {
      control = (
        <OrderedList
          value={(value as string[]) ?? []}
          items={COMMIT_PANEL_TABS}
          itemLabel={id => enumLabel('commitPanel.defaultTab', id)}
          itemNote={id => (TAB_SHOW_SETTING[id] && !ctx.get<boolean>(TAB_SHOW_SETTING[id]) ? l10n.t('hidden') : undefined)}
          disabled={disabled}
          onChange={v => ctx.update(settingKey, v)}
        />
      );
    } else if (settingKey === 'pullRequests.hostProviderOverrides') {
      control = <HostOverridesEditor value={(value as Record<string, string>) ?? {}} disabled={disabled} onChange={v => ctx.update(settingKey, v)} />;
    } else if (schema.type === 'array') {
      control = (
        <StringList
          value={(value as string[]) ?? []}
          disabled={disabled}
          label={label}
          placeholder={settingKey === 'branchNameModels' ? 'feature/' : settingKey === 'protectedBranches' ? 'release/*' : 'node_modules'}
          format={settingKey === 'branchNameModels' ? branchModel : undefined}
          onChange={v => ctx.update(settingKey, v)}
        />
      );
    } else if (schema.enum) {
      // Cards show every option with its explanation; a long list stays a dropdown.
      control = schema.enum.length <= CARD_ENUM_MAX || settingKey === 'ai.provider'
        ? <EnumCards settingKey={settingKey} schema={schema} value={String(value)} disabled={disabled} label={label} icon={settingKey === 'ai.provider' ? aiProviderIcon : undefined} onChange={v => ctx.update(settingKey, v)} />
        : <EnumSelect settingKey={settingKey} schema={schema} value={String(value)} disabled={disabled} label={label} onChange={v => ctx.update(settingKey, v)} />;
    } else if (schema.type === 'number') {
      control = <NumberInput value={Number(value)} schema={schema} disabled={disabled} label={label} onCommit={v => ctx.update(settingKey, v)} />;
    } else if (schema.type === 'string') {
      control = (
        <TextInput
          value={String(value ?? '')}
          disabled={disabled}
          label={label}
          monospace={/Path$|Url$|Branch$/.test(settingKey)}
          type={/Url$/.test(settingKey) ? 'url' : 'text'}
          placeholder={PLACEHOLDER[settingKey]?.()}
          onCommit={v => ctx.update(settingKey, v)}
        />
      );
    }
  }

  return (
    <div className={`gc-row${modified ? ' modified' : ''}`} data-setting={settingKey}>
      <RowHeader ctx={ctx} settingKey={settingKey} />
      {descNode}
      {control && <div className="gc-row-control">{control}</div>}
      {blocked && <div className="gc-row-note">{blocked}</div>}
    </div>
  );
}
