import React, { useEffect, useMemo, useState } from 'react';
import type { CreatePullRequestInput, ForgeProvider } from '../../../host/types/messages';
import type { BranchInfo } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';

interface Props {
  repoName: string;
  provider: ForgeProvider;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesError?: string;
  submitting: boolean;
  submitError?: string;
  onSubmit: (input: CreatePullRequestInput) => void;
  onCancel: () => void;
}

function pickDefaultTarget(branches: BranchInfo[]): string {
  const local = branches.filter(b => !b.isRemote);
  const main = local.find(b => b.name === 'main') ?? local.find(b => b.name === 'master');
  if (main) return main.name;
  const remoteMain = branches.find(b => b.isRemote && (b.name.endsWith('/main') || b.name.endsWith('/master')));
  if (remoteMain) return remoteMain.name.split('/').pop()!;
  return local[0]?.name ?? '';
}

export function CreatePullRequestForm({
  repoName, provider, branches, branchesLoading, branchesError, submitting, submitError,
  onSubmit, onCancel,
}: Props) {
  const localBranches = useMemo(() => branches.filter(b => !b.isRemote), [branches]);
  const currentBranch = useMemo(() => localBranches.find(b => b.isHead)?.name ?? '', [localBranches]);

  const [sourceBranch, setSourceBranch] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState(false);

  useEffect(() => {
    if (!sourceBranch && currentBranch) setSourceBranch(currentBranch);
  }, [currentBranch, sourceBranch]);

  useEffect(() => {
    if (!targetBranch && localBranches.length > 0) setTargetBranch(pickDefaultTarget(branches));
  }, [branches, localBranches, targetBranch]);

  const supportsDraft = provider === 'github' || provider === 'gitlab';
  const canSubmit = sourceBranch.trim() && targetBranch.trim() && sourceBranch !== targetBranch && title.trim() && !submitting;

  return (
    <div style={css.page}>
      <div style={css.header}>
        <Codicon name="git-pull-request" style={css.headerIcon} />
        <div>
          <div style={css.headerTitle}>New Pull Request</div>
          <div style={css.headerSub}>{repoName}</div>
        </div>
      </div>

      {branchesLoading ? (
        <div style={css.loading}>Loading branches…</div>
      ) : branchesError ? (
        <div style={css.errorBanner}>
          <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
          {branchesError}
        </div>
      ) : (
        <div style={css.body}>
          <div style={css.branchRow}>
            <label style={css.label}>
              From
              <select style={css.select} value={sourceBranch} onChange={e => setSourceBranch(e.target.value)}>
                {localBranches.map(b => (
                  <option key={b.fullName} value={b.name}>{b.name}</option>
                ))}
              </select>
            </label>
            <Codicon name="arrow-left" style={{ fontSize: '14px', opacity: 0.5, marginTop: '18px' }} />
            <label style={css.label}>
              Into
              <select style={css.select} value={targetBranch} onChange={e => setTargetBranch(e.target.value)}>
                {localBranches.map(b => (
                  <option key={b.fullName} value={b.name}>{b.name}</option>
                ))}
              </select>
            </label>
          </div>

          {sourceBranch && targetBranch && sourceBranch === targetBranch && (
            <div style={css.warning}>Source and target branch must differ.</div>
          )}

          <label style={css.fieldLabel}>
            Title
            <input
              style={css.input}
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Pull request title"
              autoFocus
            />
          </label>

          <label style={css.fieldLabel}>
            Description
            <textarea
              style={css.textarea}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe your changes…"
              rows={12}
            />
          </label>

          {supportsDraft && (
            <label style={css.checkboxLabel}>
              <input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} />
              Create as draft
            </label>
          )}

          {submitError && (
            <div style={css.errorBanner}>
              <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
              {submitError}
            </div>
          )}
        </div>
      )}

      <div style={css.footer}>
        <button style={css.cancelBtn} onClick={onCancel} disabled={submitting}>
          <Codicon name="close" style={{ fontSize: '13px' }} />
          Cancel
        </button>
        <button
          style={{ ...css.submitBtn, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'default' }}
          disabled={!canSubmit}
          onClick={() => onSubmit({
            sourceBranch, targetBranch, title: title.trim(), description, draft: supportsDraft ? draft : undefined,
          })}
        >
          <Codicon name="check" style={{ fontSize: '13px' }} />
          {submitting ? 'Creating…' : 'Create Pull Request'}
        </button>
      </div>
    </div>
  );
}

const css = {
  page: {
    display: 'flex', flexDirection: 'column' as const, height: '100vh',
    background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)',
    fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size, 13px)',
  } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '16px 24px 12px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0,
  } as React.CSSProperties,
  headerIcon: { fontSize: '18px', opacity: 0.7 } as React.CSSProperties,
  headerTitle: { fontSize: '15px', fontWeight: 600 },
  headerSub: { fontSize: '12px', opacity: 0.55, marginTop: '1px', fontFamily: 'var(--vscode-editor-font-family, monospace)' },
  loading: { padding: '20px 24px', fontSize: '12px', opacity: 0.5 },
  body: {
    flex: 1, display: 'flex', flexDirection: 'column' as const, gap: '14px',
    padding: '20px 24px', overflow: 'auto', maxWidth: '640px',
  } as React.CSSProperties,
  branchRow: { display: 'flex', alignItems: 'flex-end', gap: '8px' } as React.CSSProperties,
  label: { display: 'flex', flexDirection: 'column' as const, gap: '4px', fontSize: '11px', opacity: 0.7, flex: 1, minWidth: 0 } as React.CSSProperties,
  fieldLabel: { display: 'flex', flexDirection: 'column' as const, gap: '4px', fontSize: '11px', opacity: 0.7 } as React.CSSProperties,
  select: {
    fontSize: '13px', padding: '5px 6px', background: 'var(--vscode-dropdown-background)',
    color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-dropdown-border)', borderRadius: '3px',
  } as React.CSSProperties,
  input: {
    fontSize: '13px', padding: '6px 8px', background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '3px',
    outline: 'none',
  } as React.CSSProperties,
  textarea: {
    fontSize: '13px', padding: '8px', background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '3px',
    fontFamily: 'var(--vscode-editor-font-family, var(--vscode-font-family))', resize: 'vertical' as const, outline: 'none',
  } as React.CSSProperties,
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } as React.CSSProperties,
  warning: {
    fontSize: '11px', color: 'var(--vscode-inputValidation-warningForeground)',
    background: 'var(--vscode-inputValidation-warningBackground)', padding: '4px 8px', borderRadius: '3px',
  } as React.CSSProperties,
  errorBanner: {
    display: 'flex', alignItems: 'flex-start', fontSize: '11px', padding: '6px 8px', borderRadius: '3px',
    color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)',
  } as React.CSSProperties,
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
    padding: '12px 24px 20px', borderTop: '1px solid var(--vscode-panel-border)', flexShrink: 0,
  } as React.CSSProperties,
  cancelBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 16px', borderRadius: '3px',
    background: 'var(--vscode-button-secondaryBackground, transparent)', color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-button-border, var(--vscode-panel-border))', cursor: 'pointer',
  } as React.CSSProperties,
  submitBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 16px', borderRadius: '3px',
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none',
  } as React.CSSProperties,
};
