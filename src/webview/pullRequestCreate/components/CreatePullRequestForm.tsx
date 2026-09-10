import React, { useEffect, useState } from 'react';
import type { ChangedFile, CommitNode, CreatePullRequestInput, ForgeProvider, IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { focusableFieldStyle } from '../../shared/inputStyles';
import { ChangedFilesList } from '../../pullRequestDetail/components/ChangedFilesList';
import { BranchPickerField } from './BranchPickerField';
import { MarkdownEditor } from '../../shared/MarkdownEditor';
import { LocalCommitsList } from './LocalCommitsList';

const NARROW_BREAKPOINT_STYLE_ID = 'gitcharm-pr-create-narrow-style';
const NARROW_BREAKPOINT_CSS = `
@media (max-width: 760px) {
  .gitcharm-pr-create-body { flex-direction: column !important; }
  .gitcharm-pr-create-form-column { width: 100% !important; border-right: none !important; border-bottom: 1px solid var(--vscode-panel-border); }
}
`;

interface Props {
  repoName: string;
  provider: ForgeProvider;
  branchesLoading: boolean;
  branchesError?: string;
  iconTheme: IconThemeData | null;

  sourceBranch: string;
  targetBranch: string;
  onPickBranch: (role: 'source' | 'target') => void;
  pickingBranch: 'source' | 'target' | null;

  title: string;
  onTitleChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  draft: boolean;
  onDraftChange: (v: boolean) => void;

  compareLoading: boolean;
  compareFiles: ChangedFile[];
  compareCommits: CommitNode[];
  compareError?: string;
  onOpenFile: (file: ChangedFile) => void;
  onOpenNativeCompare: () => void;

  submitting: boolean;
  submitError?: string;
  onSubmit: (input: CreatePullRequestInput) => void;
  onCancel: () => void;
}

export function CreatePullRequestForm({
  repoName, provider, branchesLoading, branchesError, iconTheme,
  sourceBranch, targetBranch, onPickBranch, pickingBranch,
  title, onTitleChange, description, onDescriptionChange, draft, onDraftChange,
  compareLoading, compareFiles, compareCommits, compareError, onOpenFile, onOpenNativeCompare,
  submitting, submitError, onSubmit, onCancel,
}: Props) {
  const [titleFocused, setTitleFocused] = useState(false);
  const [compareCollapsed, setCompareCollapsed] = useState(false);

  useEffect(() => {
    if (document.getElementById(NARROW_BREAKPOINT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = NARROW_BREAKPOINT_STYLE_ID;
    style.textContent = NARROW_BREAKPOINT_CSS;
    document.head.appendChild(style);
  }, []);

  const supportsDraft = provider === 'github' || provider === 'gitlab';
  const sameBranch = !!sourceBranch && !!targetBranch && sourceBranch === targetBranch;
  const canSubmit = sourceBranch.trim() && targetBranch.trim() && !sameBranch && title.trim() && !submitting;
  const canCompare = sourceBranch.trim() && targetBranch.trim() && !sameBranch;
  // Nothing to show the user yet (no branches picked, same branch picked twice, or a real "0 changes" result) —
  // hide the whole panel rather than rendering an empty shell, freeing the width back to the form column.
  const hasChangesToShow = !sameBranch && (compareLoading || !!compareError || compareFiles.length > 0 || compareCommits.length > 0);

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
        <div style={{ ...css.alertError, margin: '20px 24px' }}>
          <Codicon name="error" style={{ fontSize: '14px', flexShrink: 0 }} />
          <span>{branchesError}</span>
        </div>
      ) : (
        <div style={css.body} className="gitcharm-pr-create-body">
          <div style={css.formColumn} className="gitcharm-pr-create-form-column">
            <div style={css.branchRow}>
              <BranchPickerField
                label="From"
                value={sourceBranch}
                placeholder="Select branch…"
                onPick={() => onPickBranch('source')}
                disabled={pickingBranch !== null}
              />
              <div style={css.branchArrowSpacer}>
                <span aria-hidden style={css.branchArrowSpacerLabel}>&nbsp;</span>
                <div style={css.branchArrowIcon}>
                  <Codicon name="arrow-right" style={{ fontSize: '14px', opacity: 0.5 }} />
                </div>
              </div>
              <BranchPickerField
                label="Into"
                value={targetBranch}
                placeholder="Select branch…"
                onPick={() => onPickBranch('target')}
                disabled={pickingBranch !== null}
              />
            </div>

            {sameBranch && (
              <div style={css.alertWarning}>
                <Codicon name="warning" style={{ fontSize: '14px', flexShrink: 0 }} />
                <span>Source and target branch must differ.</span>
              </div>
            )}

            <label style={css.fieldLabel}>
              Title
              <input
                style={{ ...focusableFieldStyle(titleFocused), ...css.input }}
                value={title}
                onChange={e => onTitleChange(e.target.value)}
                onFocus={() => setTitleFocused(true)}
                onBlur={() => setTitleFocused(false)}
                placeholder="Pull request title"
                autoFocus
              />
            </label>

            <div style={css.fieldLabel}>
              {/* A native <label> here would implicitly associate its click target with the first
                  form-associated descendant — the MarkdownEditor's toolbar buttons — so a plain click
                  anywhere in the editor's text area (itself inside the <label>) would fire that button's
                  click handler (toggleBold) as if it had been pressed. A plain <div> avoids that entirely. */}
              Description
              <MarkdownEditor value={description} onChange={onDescriptionChange} placeholder="Describe your changes…" />
            </div>

            {supportsDraft && (
              <label style={css.checkboxLabel}>
                <input type="checkbox" checked={draft} onChange={e => onDraftChange(e.target.checked)} />
                Create as draft
              </label>
            )}

            {submitError && (
              <div style={css.alertError}>
                <Codicon name="error" style={{ fontSize: '14px', flexShrink: 0 }} />
                <span>{submitError}</span>
              </div>
            )}
          </div>

          {hasChangesToShow && (
            compareCollapsed ? (
              <button type="button" style={css.comparePanelCollapsed} onClick={() => setCompareCollapsed(false)} title="Show changes">
                <Codicon name="layout-sidebar-right-off" style={{ fontSize: '14px', opacity: 0.75 }} />
                <span style={css.comparePanelCollapsedLabel}>Changes</span>
              </button>
            ) : (
              <div style={css.comparePanel}>
                <div style={css.compareToolbar}>
                  <button type="button" style={css.collapseBtn} onClick={() => setCompareCollapsed(true)} title="Hide changes">
                    <Codicon name="layout-sidebar-right" style={{ fontSize: '14px' }} />
                  </button>
                  <span style={css.compareTitle}>{sourceBranch} → {targetBranch}</span>
                  <button
                    type="button"
                    style={{ ...css.compareBtn, opacity: canCompare ? 1 : 0.5, cursor: canCompare ? 'pointer' : 'default' }}
                    disabled={!canCompare}
                    onClick={onOpenNativeCompare}
                  >
                    <Codicon name="diff-multiple" style={{ fontSize: '13px' }} />
                    Compare in Editor
                  </button>
                </div>

                {compareError && (
                  <div style={css.alertError}>
                    <Codicon name="error" style={{ fontSize: '14px', flexShrink: 0 }} />
                    <span>{compareError}</span>
                  </div>
                )}

                <div style={css.compareSection}>
                  <div style={css.compareSectionTitle}>Commits</div>
                  <LocalCommitsList commits={compareCommits} loading={compareLoading} />
                </div>
                <div style={css.compareSectionDivider} />
                <div style={css.compareSection}>
                  <div style={css.compareSectionTitle}>Files changed</div>
                  <ChangedFilesList files={compareFiles} loading={compareLoading} iconTheme={iconTheme} onOpenFile={onOpenFile} />
                </div>
              </div>
            )
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
    flex: 1, display: 'flex', flexDirection: 'row' as const, overflow: 'hidden',
  } as React.CSSProperties,
  formColumn: {
    flex: 1, minWidth: '380px', display: 'flex', flexDirection: 'column' as const,
    gap: '14px', padding: '20px 24px', overflow: 'auto', borderRight: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  comparePanel: {
    flex: 1, minWidth: '320px', display: 'flex', flexDirection: 'column' as const, gap: '16px',
    overflow: 'auto', padding: '20px 24px', boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  comparePanelCollapsed: {
    flexShrink: 0, width: '32px', display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
    gap: '8px', padding: '16px 0', background: 'transparent', border: 'none', borderLeft: '1px solid var(--vscode-panel-border)',
    cursor: 'pointer', color: 'inherit',
  } as React.CSSProperties,
  comparePanelCollapsedLabel: {
    writingMode: 'vertical-rl' as const, transform: 'rotate(180deg)', fontSize: '11px', opacity: 0.6, letterSpacing: '0.03em',
  } as React.CSSProperties,
  collapseBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', flexShrink: 0,
    background: 'transparent', border: 'none', borderRadius: '4px', cursor: 'pointer', color: 'inherit', opacity: 0.75,
  } as React.CSSProperties,
  compareToolbar: { display: 'flex', alignItems: 'center', gap: '8px' } as React.CSSProperties,
  compareTitle: {
    flex: 1, minWidth: 0, fontSize: '12px', fontWeight: 600, fontFamily: 'var(--vscode-editor-font-family, monospace)', opacity: 0.85,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  compareBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '5px 10px', borderRadius: '3px',
    background: 'var(--vscode-button-secondaryBackground, transparent)', color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-button-border, var(--vscode-panel-border))', flexShrink: 0,
  } as React.CSSProperties,
  compareSection: { display: 'flex', flexDirection: 'column' as const, gap: '8px' } as React.CSSProperties,
  compareSectionDivider: { height: '1px', background: 'var(--vscode-panel-border)', margin: '4px 0' } as React.CSSProperties,
  compareSectionTitle: { fontSize: '11px', fontWeight: 600, opacity: 0.6, textTransform: 'uppercase' as const, letterSpacing: '0.03em' },
  branchRow: { display: 'flex', alignItems: 'flex-end', gap: '8px' } as React.CSSProperties,
  // Mirrors BranchPickerField's own label (11px text + 4px gap) as an invisible spacer, so the arrow
  // centers against the pill button's height instead of the whole field (label included).
  branchArrowSpacer: {
    display: 'flex', flexDirection: 'column' as const, gap: '4px', alignItems: 'center', flexShrink: 0,
  } as React.CSSProperties,
  branchArrowIcon: { display: 'flex', alignItems: 'center', minHeight: '28px' } as React.CSSProperties,
  branchArrowSpacerLabel: { fontSize: '11px', lineHeight: 1.4, visibility: 'hidden' as const } as React.CSSProperties,
  fieldLabel: { display: 'flex', flexDirection: 'column' as const, gap: '4px', fontSize: '11px', opacity: 0.7 } as React.CSSProperties,
  input: {
    fontSize: '13px', padding: '6px 8px', boxSizing: 'border-box' as const, width: '100%',
  } as React.CSSProperties,
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } as React.CSSProperties,
  alertWarning: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: 'var(--vscode-inputValidation-warningForeground)', background: 'var(--vscode-inputValidation-warningBackground)',
    border: '1px solid var(--vscode-inputValidation-warningBorder)',
  } as React.CSSProperties,
  alertError: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
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
