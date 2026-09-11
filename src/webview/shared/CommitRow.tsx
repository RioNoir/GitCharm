import React, { useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { AuthorAvatar } from './AuthorAvatar';
import { formatRelativeTime } from './formatRelativeTime';
import { renderMarkdown } from './renderMarkdown';

export interface CommitRowData {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  /** Resolves an avatar via Gravatar/GitHub heuristics when no authorAvatarUrl is given. */
  authorEmail?: string;
  /** A forge-provided avatar URL (e.g. from the GitHub API) — preferred over authorEmail when present. */
  authorAvatarUrl?: string;
  authoredAt: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

interface Props {
  commit: CommitRowData;
  expanded: boolean;
  isLast: boolean;
  onToggle: () => void;
  /** Renders the expanded file list — each caller uses its own file-tree component. */
  renderFiles: () => React.ReactNode;
}

/**
 * A single commit row shared by the PR detail's commit list and the Git Log's Full
 * Detail merged-commits list: avatar, hash badge, message (with an expandable full
 * body), author/relative-date, and optional aggregate +/- stats. Expands to a caller-
 * supplied file list.
 */
export function CommitRow({ commit, expanded, isLast, onToggle, renderFiles }: Props) {
  const [hovered, setHovered] = useState(false);
  const [messageExpanded, setMessageExpanded] = useState(false);
  const extendedMessage = commit.message.split('\n').slice(1).join('\n').trim();
  const hasExtendedMessage = extendedMessage.length > 0;
  const extendedMessageHtml = useMemo(() => renderMarkdown(extendedMessage), [extendedMessage]);
  const hasStats = commit.filesChanged != null || commit.additions != null || commit.deletions != null;

  return (
    <div style={css.commitWrapper(isLast)}>
      <div
        style={{ ...css.commitRow, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onToggle}
      >
        <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '13px', opacity: 0.6, flexShrink: 0 }} />
        {commit.authorAvatarUrl
          ? <img src={commit.authorAvatarUrl} alt={commit.authorName} style={css.avatarImg} />
          : <AuthorAvatar authorName={commit.authorName} authorEmail={commit.authorEmail ?? ''} size={24} />
        }
        <div style={css.commitMain}>
          <span style={css.commitMessage}>
            {commit.message.split('\n')[0]}
            {hasExtendedMessage && (
              <button
                className="icon-btn"
                style={css.viewMoreBtn}
                onClick={e => { e.stopPropagation(); setMessageExpanded(o => !o); }}
                title={messageExpanded ? 'Hide full message' : 'Show full message'}
              >
                <Codicon name="ellipsis" style={{ fontSize: '15px' }} />
              </button>
            )}
          </span>
          <span style={css.commitMeta}>
            <strong style={css.commitAuthor}>{commit.authorName}</strong>
            <span style={css.commitDate} title={new Date(commit.authoredAt).toLocaleString()}>
              committed {formatRelativeTime(commit.authoredAt)}
            </span>
            {hasStats && (
              <>
                {commit.filesChanged != null && (
                  <span>{commit.filesChanged} file{commit.filesChanged !== 1 ? 's' : ''}</span>
                )}
                {(commit.additions != null || commit.deletions != null) && (
                  <span style={css.lineStats}>
                    {commit.additions != null && <span style={css.added}>+{commit.additions}</span>}
                    {commit.deletions != null && <span style={css.removed}>-{commit.deletions}</span>}
                  </span>
                )}
              </>
            )}
          </span>
        </div>
        <span style={css.commitShaBadge}>
          <Codicon name="git-commit" style={{ fontSize: '11px', marginRight: '4px', opacity: 0.6 }} />
          {commit.shortHash}
        </span>
      </div>
      {messageExpanded && hasExtendedMessage && (
        <div className="markdown-body" style={css.commitMessageExpanded} dangerouslySetInnerHTML={{ __html: extendedMessageHtml }} />
      )}
      {expanded && (
        <div style={css.commitDetail}>
          {renderFiles()}
        </div>
      )}
    </div>
  );
}

const css = {
  commitWrapper: (isLast: boolean): React.CSSProperties => ({
    borderBottom: isLast ? 'none' : '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
  }),
  commitRow: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', cursor: 'pointer', fontSize: '12px',
  } as React.CSSProperties,
  avatarImg: { width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0 } as React.CSSProperties,
  commitMain: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0, gap: '3px' } as React.CSSProperties,
  commitMessage: {
    fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  viewMoreBtn: {
    marginLeft: '8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle',
    color: 'inherit', opacity: 0.7, background: 'transparent', border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px', padding: '3px', cursor: 'pointer',
  } as React.CSSProperties,
  commitMessageExpanded: {
    fontSize: '12px', margin: '0 12px 10px 46px', lineHeight: 1.5, opacity: 0.85,
  } as React.CSSProperties,
  commitMeta: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', opacity: 0.65 } as React.CSSProperties,
  commitAuthor: { fontWeight: 600 },
  commitDate: {},
  lineStats: { display: 'inline-flex', gap: '4px' } as React.CSSProperties,
  added: { color: 'var(--vscode-gitDecoration-addedResourceForeground)' } as React.CSSProperties,
  removed: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)' } as React.CSSProperties,
  commitShaBadge: {
    display: 'flex', alignItems: 'center', flexShrink: 0, fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '11px', opacity: 0.7, background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
    padding: '3px 8px', borderRadius: '999px',
  } as React.CSSProperties,
  commitDetail: {
    padding: '4px 12px 14px 46px', display: 'flex', flexDirection: 'column' as const, gap: '10px',
    background: 'color-mix(in srgb, var(--vscode-foreground) 3%, transparent)',
  } as React.CSSProperties,
};
