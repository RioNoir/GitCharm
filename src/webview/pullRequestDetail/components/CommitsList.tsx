import React, { useState } from 'react';
import type { ChangedFile, IconThemeData, PullRequestCommit } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileTreeView } from './FileTreeView';
import { formatRelativeTime } from '../formatRelativeTime';

interface Props {
  commits: PullRequestCommit[];
  loading: boolean;
  iconTheme: IconThemeData | null;
  commitFiles: Record<string, ChangedFile[]>;
  commitFilesLoading: Record<string, boolean>;
  onRequestCommitFiles: (sha: string) => void;
  onOpenCommitFileDiff: (file: ChangedFile, commitSha: string, parentSha: string | undefined) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function CommitRow({ commit, expanded, files, filesLoading, iconTheme, onToggle, onOpenFileDiff }: {
  commit: PullRequestCommit;
  expanded: boolean;
  files: ChangedFile[] | undefined;
  filesLoading: boolean;
  iconTheme: IconThemeData | null;
  onToggle: () => void;
  onOpenFileDiff: (file: ChangedFile) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const hasExtendedMessage = commit.message.includes('\n') && commit.message.split('\n').slice(1).join('').trim().length > 0;

  return (
    <div style={css.commitWrapper}>
      <div
        style={{ ...css.commitRow, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onToggle}
      >
        <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '13px', opacity: 0.6, flexShrink: 0 }} />
        {commit.authorAvatarUrl
          ? <img src={commit.authorAvatarUrl} alt={commit.authorName} style={css.avatarImg} />
          : <span style={css.avatarFallback}>{initials(commit.authorName)}</span>
        }
        <div style={css.commitMain}>
          <span style={css.commitMessage}>{commit.message.split('\n')[0]}</span>
          <span style={css.commitMeta}>
            <strong style={css.commitAuthor}>{commit.authorName}</strong>
            <span style={css.commitDate} title={new Date(commit.authoredAt).toLocaleString()}>
              committed {formatRelativeTime(commit.authoredAt)}
            </span>
          </span>
        </div>
        <span style={css.commitShaBadge}>
          <Codicon name="git-commit" style={{ fontSize: '11px', marginRight: '4px', opacity: 0.6 }} />
          {commit.shortSha}
        </span>
      </div>
      {expanded && (
        <div style={css.commitDetail}>
          {hasExtendedMessage && (
            <pre style={css.commitDetailMessage}>{commit.message.split('\n').slice(1).join('\n').trim()}</pre>
          )}
          {filesLoading ? (
            <div style={css.empty}>Loading files…</div>
          ) : (
            <FileTreeView
              files={files ?? []}
              iconTheme={iconTheme}
              onOpenFile={f => onOpenFileDiff(f)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function CommitsList({ commits, loading, iconTheme, commitFiles, commitFilesLoading, onRequestCommitFiles, onOpenCommitFileDiff }: Props) {
  const [expandedSha, setExpandedSha] = useState<string | null>(null);

  if (loading) return <div style={css.empty}>Loading commits…</div>;
  if (commits.length === 0) return <div style={css.empty}>No commits.</div>;

  const handleToggle = (sha: string) => {
    if (expandedSha === sha) {
      setExpandedSha(null);
      return;
    }
    setExpandedSha(sha);
    if (!commitFiles[sha]) onRequestCommitFiles(sha);
  };

  return (
    <div style={css.root}>
      {commits.map(c => (
        <CommitRow
          key={c.sha}
          commit={c}
          expanded={expandedSha === c.sha}
          files={commitFiles[c.sha]}
          filesLoading={!!commitFilesLoading[c.sha]}
          iconTheme={iconTheme}
          onToggle={() => handleToggle(c.sha)}
          onOpenFileDiff={file => onOpenCommitFileDiff(file, c.sha, c.parentSha)}
        />
      ))}
    </div>
  );
}

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, border: '1px solid var(--vscode-panel-border)', borderRadius: '4px', overflow: 'hidden' },
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const, padding: '4px 0' },
  commitWrapper: { borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)' } as React.CSSProperties,
  commitRow: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', cursor: 'pointer', fontSize: '12px',
  } as React.CSSProperties,
  avatarImg: { width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0 } as React.CSSProperties,
  avatarFallback: {
    width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '10px', fontWeight: 'bold' as const, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
  commitMain: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0, gap: '3px' } as React.CSSProperties,
  commitMessage: {
    fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  commitMeta: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', opacity: 0.65 } as React.CSSProperties,
  commitAuthor: { fontWeight: 600 },
  commitDate: {},
  commitShaBadge: {
    display: 'flex', alignItems: 'center', flexShrink: 0, fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '11px', opacity: 0.7, background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
    padding: '3px 8px', borderRadius: '999px',
  } as React.CSSProperties,
  commitDetail: {
    padding: '4px 12px 14px 46px', display: 'flex', flexDirection: 'column' as const, gap: '10px',
    background: 'color-mix(in srgb, var(--vscode-foreground) 3%, transparent)',
  } as React.CSSProperties,
  commitDetailMessage: {
    fontSize: '11px', margin: 0, whiteSpace: 'pre-wrap' as const, fontFamily: 'inherit', opacity: 0.85,
  } as React.CSSProperties,
};
