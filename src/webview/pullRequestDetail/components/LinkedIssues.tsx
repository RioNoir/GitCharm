import React from 'react';
import type { LinkedIssue } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import * as l10n from '@vscode/l10n';

function issueIcon(issue: LinkedIssue): { icon: string; color: string } {
  if (issue.state === 'open') return { icon: 'issues', color: '#3fb950' };
  if (issue.stateReason === 'notPlanned' || issue.stateReason === 'duplicate') return { icon: 'circle-slash', color: 'var(--vscode-descriptionForeground)' };
  return { icon: 'pass', color: '#a371f7' };
}

/** The issues a pull request closes once merged — each opens in the issue panel (or the browser, for another repository's). */
export function LinkedIssues({ issues, onOpen }: { issues: LinkedIssue[]; onOpen: (issue: LinkedIssue) => void }) {
  if (issues.length === 0) return <span style={css.empty}>{l10n.t('None — link one with "Fixes #123" in the description')}</span>;
  return (
    <div style={css.list}>
      {issues.map(issue => {
        const s = issueIcon(issue);
        return (
          <button key={`${issue.repoFullName ?? ''}#${issue.number}`} className="icon-btn" style={css.row} onClick={() => onOpen(issue)} title={issue.title}>
            <Codicon name={s.icon} style={{ fontSize: '14px', color: s.color, flexShrink: 0 }} />
            <span style={css.text}>
              <span style={css.number}>{issue.sameRepo ? `#${issue.number}` : `${issue.repoFullName}#${issue.number}`}</span>
              {issue.title}
            </span>
            {!issue.sameRepo && <Codicon name="link-external" style={{ fontSize: '12px', opacity: 0.6, flexShrink: 0 }} />}
          </button>
        );
      })}
    </div>
  );
}

const css = {
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
  list: { display: 'flex', flexDirection: 'column' as const, gap: '4px' } as React.CSSProperties,
  row: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', borderRadius: '4px', width: '100%',
    background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left' as const, fontSize: '12px',
  } as React.CSSProperties,
  text: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  number: { opacity: 0.55, marginRight: '5px' } as React.CSSProperties,
};
