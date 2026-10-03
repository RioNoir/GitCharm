import React from 'react';
import type { LinkedPullRequest } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import * as l10n from '@vscode/l10n';

function prStateIcon(state: LinkedPullRequest['state']): { icon: string; color: string } {
  switch (state) {
    case 'merged': return { icon: 'git-merge', color: '#a371f7' };
    case 'closed': return { icon: 'git-pull-request-closed', color: 'var(--vscode-errorForeground)' };
    case 'draft': return { icon: 'git-pull-request-draft', color: 'var(--vscode-descriptionForeground)' };
    default: return { icon: 'git-pull-request', color: '#3fb950' };
  }
}

export function LinkedPullRequests({ pullRequests, onOpen }: { pullRequests: LinkedPullRequest[]; onOpen: (pr: LinkedPullRequest) => void }) {
  if (pullRequests.length === 0) return <span style={css.empty}>{l10n.t('None yet')}</span>;
  return (
    <div style={css.list}>
      {pullRequests.map(pr => {
        const s = prStateIcon(pr.state);
        return (
          <button key={`${pr.repoFullName ?? ''}#${pr.number}`} className="icon-btn" style={css.row} onClick={() => onOpen(pr)} title={pr.title}>
            <Codicon name={s.icon} style={{ fontSize: '14px', color: s.color, flexShrink: 0 }} />
            <span style={css.text}>
              <span style={css.number}>{pr.sameRepo ? `#${pr.number}` : `${pr.repoFullName}#${pr.number}`}</span>
              {pr.title}
            </span>
            {pr.willClose && <span style={css.closesTag} title={l10n.t('Merging this pull request closes the issue')}>{l10n.t('closes')}</span>}
            {!pr.sameRepo && <Codicon name="link-external" style={{ fontSize: '12px', opacity: 0.6, flexShrink: 0 }} />}
          </button>
        );
      })}
    </div>
  );
}

const css = {
  empty: { fontSize: '13px', opacity: 0.5, fontStyle: 'italic' as const },
  list: { display: 'flex', flexDirection: 'column' as const, gap: '4px' } as React.CSSProperties,
  row: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', borderRadius: '4px', width: '100%',
    background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left' as const, fontSize: '12px',
  } as React.CSSProperties,
  text: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  number: { opacity: 0.55, marginRight: '5px' } as React.CSSProperties,
  closesTag: {
    fontSize: '10px', padding: '0 6px', borderRadius: '8px', flexShrink: 0,
    background: 'color-mix(in srgb, #a371f7 18%, transparent)', color: '#a371f7',
  } as React.CSSProperties,
};
