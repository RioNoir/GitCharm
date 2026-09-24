import React from 'react';
import type { CommitNode } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { SkeletonList } from '../../shared/Skeleton';
import { avatarColor, initials, initialsFontSize } from '../../shared/avatars';
import * as l10n from '@vscode/l10n';
import { locale } from '../../shared/l10n';

interface Props {
  commits: CommitNode[];
  loading: boolean;
}

export function LocalCommitsList({ commits, loading }: Props) {
  if (loading) return <SkeletonList rows={5} />;
  if (commits.length === 0) return <div style={css.empty}>{l10n.t('No commits.')}</div>;

  return (
    <div style={css.root}>
      {commits.map((c, i) => (
        <div key={c.hash} style={css.commitRow(i === commits.length - 1)}>
          <span style={{ ...css.avatarFallback, background: avatarColor(c.authorName) }}>{initials(c.authorName)}</span>
          <div style={css.commitMain}>
            <span style={css.commitMessage}>{c.message.split('\n')[0]}</span>
            <span style={css.commitMeta}>
              <strong style={css.commitAuthor}>{c.authorName}</strong>
              <span title={new Date(c.authorDate).toLocaleString(locale)}>{new Date(c.authorDate).toLocaleDateString(locale)}</span>
            </span>
          </div>
          <span style={css.commitShaBadge}>
            <Codicon name="git-commit" style={{ fontSize: '11px', marginRight: '4px', opacity: 0.6 }} />
            {c.shortHash}
          </span>
        </div>
      ))}
    </div>
  );
}

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, border: '1px solid var(--vscode-panel-border)', borderRadius: '4px', overflow: 'hidden' } as React.CSSProperties,
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const, padding: '4px 0' } as React.CSSProperties,
  commitRow: (isLast: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', fontSize: '12px',
    borderBottom: isLast ? 'none' : '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
  }),
  avatarFallback: {
    width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: initialsFontSize(24), fontWeight: 600, lineHeight: 1, color: '#fff',
  } as React.CSSProperties,
  commitMain: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0, gap: '3px' } as React.CSSProperties,
  commitMessage: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  commitMeta: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', opacity: 0.65 } as React.CSSProperties,
  commitAuthor: { fontWeight: 600 },
  commitShaBadge: {
    display: 'flex', alignItems: 'center', flexShrink: 0, fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '11px', opacity: 0.7, background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
    padding: '3px 8px', borderRadius: '999px',
  } as React.CSSProperties,
};
