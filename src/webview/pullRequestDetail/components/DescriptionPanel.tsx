import React, { useEffect, useMemo, useState } from 'react';
import { renderMarkdown } from '../../shared/renderMarkdown';
import { useMentionCandidates } from '../../shared/mentions';
import { MarkdownEditor } from '../../shared/MarkdownEditor';
import { SkeletonText } from '../../shared/Skeleton';
import { Codicon } from '../../shared/Codicon';
import * as l10n from '@vscode/l10n';

interface Props {
  description: string;
  loading: boolean;
  editing: boolean;
  saving: boolean;
  saveError?: string;
  onSave: (description: string) => void;
  onCancelEdit: () => void;
}

export function DescriptionPanel({ description, loading, editing, saving, saveError, onSave, onCancelEdit }: Props) {
  const mentionCandidates = useMentionCandidates();
  const html = useMemo(() => renderMarkdown(description, mentionCandidates), [description, mentionCandidates]);
  const [draft, setDraft] = useState(description);

  // Each edit session starts from the description as it is now, not from a draft abandoned earlier.
  useEffect(() => {
    if (editing) setDraft(description);
  }, [editing]);

  if (loading) return <SkeletonText lines={3} />;

  if (editing) {
    const unchanged = draft.trim() === description.trim();
    return (
      <div style={css.editWrap}>
        <MarkdownEditor value={draft} onChange={setDraft} placeholder={l10n.t('Describe your changes…')} minHeight="120px" />
        {saveError && (
          <div style={css.alertError}>
            <Codicon name="error" style={{ fontSize: '14px', flexShrink: 0 }} />
            <span>{saveError}</span>
          </div>
        )}
        <div style={css.editActions}>
          <button className="gc-btn-secondary" style={css.cancelBtn} onClick={onCancelEdit} disabled={saving}>{l10n.t('Cancel')}</button>
          <button
            style={{ ...css.saveBtn, opacity: saving || unchanged ? 0.5 : 1, cursor: saving || unchanged ? 'default' : 'pointer' }}
            disabled={saving || unchanged}
            onClick={() => onSave(draft.trim())}
          >
            <Codicon name={saving ? 'loading~spin' : 'check'} style={{ fontSize: '13px' }} />
            {saving ? l10n.t('Saving…') : l10n.t('Save')}
          </button>
        </div>
      </div>
    );
  }

  if (!html) return <div style={css.empty}>{l10n.t('No description provided.')}</div>;

  return <div className="markdown-body" style={css.markdown} dangerouslySetInnerHTML={{ __html: html }} />;
}

const css = {
  empty: { padding: '12px 0', fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
  markdown: {
    fontSize: '13px', lineHeight: 1.6,
  } as React.CSSProperties,
  editWrap: { display: 'flex', flexDirection: 'column' as const, gap: '8px' } as React.CSSProperties,
  editActions: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } as React.CSSProperties,
  cancelBtn: { fontSize: '12px', padding: '5px 12px' } as React.CSSProperties,
  saveBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 12px', borderRadius: '3px',
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none',
  } as React.CSSProperties,
  alertError: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)',
  } as React.CSSProperties,
};
