import React, { useState } from 'react';
import type { MergeStrategy, PullRequestDetail } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';

interface Props {
  detail: PullRequestDetail;
  merging: boolean;
  mergeError?: string;
  reopening: boolean;
  reopenError?: string;
  onMerge: (strategy: MergeStrategy) => void;
  onReopen: () => void;
}

const STRATEGY_LABEL: Record<MergeStrategy, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
  fastForward: 'Fast-forward merge',
};

export function MergeActions({ detail, merging, mergeError, reopening, reopenError, onMerge, onReopen }: Props) {
  const strategies = detail.capabilities.mergeStrategies;
  const [strategy, setStrategy] = useState<MergeStrategy>(strategies[0] ?? 'merge');

  if (detail.merged) {
    return (
      <div style={css.mergedBanner}>
        <Codicon name="git-merge" style={{ fontSize: '15px', flexShrink: 0 }} />
        <span>This pull request was merged.</span>
      </div>
    );
  }

  const isOpen = detail.state === 'open' || detail.state === 'draft';
  const isConflicting = detail.capabilities.hasMergeableState && detail.mergeableState === 'conflicting';

  return (
    <div style={css.root}>
      {detail.capabilities.hasMergeableState && (
        <div style={isConflicting ? css.conflictBanner : css.cleanBanner}>
          <Codicon name={isConflicting ? 'warning' : 'check'} style={{ fontSize: '14px', flexShrink: 0 }} />
          <span>{isConflicting ? 'This branch has conflicts that must be resolved.' : 'This branch has no conflicts with the base branch.'}</span>
        </div>
      )}

      {isOpen && detail.capabilities.canMerge && strategies.length > 0 && (
        <div style={css.mergeRow}>
          <button
            style={{ ...css.mergeBtn, opacity: merging || isConflicting ? 0.6 : 1 }}
            disabled={merging || isConflicting}
            onClick={() => onMerge(strategy)}
            title={isConflicting ? 'Resolve conflicts before merging' : undefined}
          >
            {merging ? 'Merging…' : 'Merge Pull Request'}
          </button>
          {strategies.length > 1 && (
            <>
              <span style={css.usingMethod}>using method</span>
              <select style={css.select} value={strategy} onChange={e => setStrategy(e.target.value as MergeStrategy)} disabled={merging}>
                {strategies.map(s => (
                  <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
                ))}
              </select>
            </>
          )}
        </div>
      )}
      {mergeError && <div style={css.errorText}>{mergeError}</div>}

      {!isOpen && detail.capabilities.canReopen && (
        <button style={css.reopenBtn} disabled={reopening} onClick={onReopen}>
          <Codicon name="git-pull-request" style={{ fontSize: '13px' }} />
          {reopening ? 'Reopening…' : 'Reopen pull request'}
        </button>
      )}
      {reopenError && <div style={css.errorText}>{reopenError}</div>}
    </div>
  );
}

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, gap: '10px' },
  mergedBanner: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '10px 14px', borderRadius: '6px',
    color: '#8957e5', background: 'color-mix(in srgb, #8957e5 12%, transparent)', border: '1px solid color-mix(in srgb, #8957e5 30%, transparent)',
  } as React.CSSProperties,
  cleanBanner: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '10px 14px', borderRadius: '6px',
    color: '#3fb950', background: 'color-mix(in srgb, #3fb950 10%, transparent)', border: '1px solid color-mix(in srgb, #3fb950 25%, transparent)',
  } as React.CSSProperties,
  conflictBanner: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '10px 14px', borderRadius: '6px',
    color: 'var(--vscode-inputValidation-warningForeground)', background: 'var(--vscode-inputValidation-warningBackground)',
    border: '1px solid var(--vscode-inputValidation-warningBorder)',
  } as React.CSSProperties,
  mergeRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' as const } as React.CSSProperties,
  mergeBtn: {
    fontSize: '13px', padding: '8px 16px', borderRadius: '4px',
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', cursor: 'pointer', fontWeight: 600,
  } as React.CSSProperties,
  usingMethod: { fontSize: '12px', opacity: 0.7 },
  select: {
    fontSize: '12px', padding: '6px 8px', background: 'var(--vscode-dropdown-background)',
    color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-dropdown-border)', borderRadius: '4px',
  } as React.CSSProperties,
  reopenBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 12px', borderRadius: '4px',
    background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)',
    border: 'none', cursor: 'pointer', alignSelf: 'flex-start' as const,
  } as React.CSSProperties,
  errorText: {
    fontSize: '11px', color: 'var(--vscode-errorForeground)',
  } as React.CSSProperties,
};
