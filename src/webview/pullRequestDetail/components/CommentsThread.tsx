import React, { useMemo, useState } from 'react';
import type { PullRequestComment, PullRequestCommit } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { renderMarkdown } from '../renderMarkdown';
import { formatRelativeTime } from '../formatRelativeTime';
import { SkeletonList } from '../../shared/Skeleton';

interface Props {
  comments: PullRequestComment[];
  commits: PullRequestCommit[];
  loading: boolean;
  posting: boolean;
  canClose: boolean;
  closing: boolean;
  closeError?: string;
  onPostComment: (body: string) => void;
  onClose: () => void;
  onOpenCommitAllChanges: (commitSha: string, parentSha: string | undefined) => void;
  mergeActions?: React.ReactNode;
}

type TimelineItem =
  | { kind: 'comment'; date: string; comment: PullRequestComment }
  | { kind: 'commit'; date: string; commit: PullRequestCommit };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function CommentRow({ comment }: { comment: PullRequestComment }) {
  const html = useMemo(() => renderMarkdown(comment.body), [comment.body]);
  return (
    <div style={css.comment}>
      <div style={css.commentHeader}>
        {comment.authorAvatarUrl
          ? <img src={comment.authorAvatarUrl} alt={comment.authorName} style={css.avatarImg} />
          : <span style={css.avatarFallback}>{initials(comment.authorName)}</span>
        }
        <span>
          <strong style={css.commentAuthor}>{comment.authorName}</strong>
        </span>
        <span style={css.commentDate} title={new Date(comment.createdAt).toLocaleString()}>
          {formatRelativeTime(comment.createdAt)}
        </span>
      </div>
      <div style={css.commentBodyWrap}>
        <div className="markdown-body" style={css.commentBody} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

function CommitRow({ commit, onOpen }: { commit: PullRequestCommit; onOpen: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...css.commitRow, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onOpen}
      title="Open changes for this commit"
    >
      <Codicon name="git-commit" style={{ fontSize: '18px', opacity: 0.6, flexShrink: 0 }} />
      {commit.authorAvatarUrl
        ? <img src={commit.authorAvatarUrl} alt={commit.authorName} style={css.commitAvatarImg} />
        : <span style={css.commitAvatarFallback}>{initials(commit.authorName)}</span>
      }
      <span style={css.commitLink}>{commit.message.split('\n')[0]}</span>
      <span style={css.commitSha}>{commit.shortSha}</span>
      <span style={css.commitDate} title={new Date(commit.authoredAt).toLocaleString()}>
        {formatRelativeTime(commit.authoredAt)}
      </span>
    </div>
  );
}

export function CommentsThread({ comments, commits, loading, posting, canClose, closing, closeError, onPostComment, onClose, onOpenCommitAllChanges, mergeActions }: Props) {
  const [draft, setDraft] = useState('');

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...comments.map(comment => ({ kind: 'comment' as const, date: comment.createdAt, comment })),
      ...commits.map(commit => ({ kind: 'commit' as const, date: commit.authoredAt, commit })),
    ];
    return items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [comments, commits]);

  return (
    <div style={css.root}>
      {loading ? (
        <SkeletonList rows={3} />
      ) : timeline.length === 0 ? (
        <div style={css.empty}>No activity yet.</div>
      ) : (
        timeline.map(item => item.kind === 'comment'
          ? <CommentRow key={`c-${item.comment.id}`} comment={item.comment} />
          : <CommitRow key={`k-${item.commit.sha}`} commit={item.commit} onOpen={() => onOpenCommitAllChanges(item.commit.sha, item.commit.parentSha)} />
        )
      )}

      {mergeActions && (
        <div style={css.mergeActionsBox}>
          {mergeActions}
        </div>
      )}

      <div style={css.form}>
        <textarea
          style={css.textarea}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Leave a comment…"
          rows={3}
        />
      </div>

      <div style={css.actionsRow}>
        {canClose && (
          <button style={css.closeBtn} disabled={closing} onClick={onClose}>
            {closing ? 'Closing…' : 'Close Pull Request'}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button
          style={{ ...css.submitBtn, opacity: draft.trim() && !posting ? 1 : 0.5 }}
          disabled={!draft.trim() || posting}
          onClick={() => { onPostComment(draft.trim()); setDraft(''); }}
        >
          <Codicon name="comment" style={{ fontSize: '13px' }} />
          {posting ? 'Posting…' : 'Comment'}
        </button>
      </div>
      {closeError && <div style={css.errorText}>{closeError}</div>}
    </div>
  );
}

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, gap: '10px' },
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
  comment: {
    display: 'flex', flexDirection: 'column' as const,
    border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', overflow: 'hidden',
  } as React.CSSProperties,
  mergeActionsBox: {
    display: 'flex', flexDirection: 'column' as const, gap: '14px',
    border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', padding: '14px',
  } as React.CSSProperties,
  commentHeader: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 12px',
    background: 'color-mix(in srgb, var(--vscode-foreground) 5%, transparent)',
    borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  avatarImg: { width: '20px', height: '20px', borderRadius: '50%' } as React.CSSProperties,
  avatarFallback: {
    width: '20px', height: '20px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '9px', fontWeight: 'bold' as const, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
  commentAuthor: { fontWeight: 600 },
  commentDate: { opacity: 0.5, marginLeft: 'auto', flexShrink: 0 },
  commentBodyWrap: { padding: '12px' } as React.CSSProperties,
  commentBody: { fontSize: '13px', lineHeight: 1.5 } as React.CSSProperties,
  commitRow: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer',
    borderRadius: '4px',
  } as React.CSSProperties,
  commitAvatarImg: { width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0 } as React.CSSProperties,
  commitAvatarFallback: {
    width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '8px', fontWeight: 'bold' as const, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
  commitLink: {
    color: 'var(--vscode-textLink-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1,
  } as React.CSSProperties,
  commitSha: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '11px', opacity: 0.6, flexShrink: 0,
  } as React.CSSProperties,
  commitDate: { opacity: 0.5, flexShrink: 0 } as React.CSSProperties,
  form: { display: 'flex', flexDirection: 'column' as const, gap: '8px', marginTop: '4px' },
  textarea: {
    fontSize: '13px', padding: '8px', background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '3px',
    fontFamily: 'inherit', resize: 'vertical' as const, outline: 'none',
  } as React.CSSProperties,
  actionsRow: { display: 'flex', alignItems: 'center', gap: '8px' } as React.CSSProperties,
  closeBtn: {
    fontSize: '12px', padding: '6px 14px', borderRadius: '4px',
    background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-panel-border)', cursor: 'pointer',
  } as React.CSSProperties,
  submitBtn: {
    display: 'flex', alignItems: 'center', gap: '6px',
    fontSize: '12px', padding: '6px 16px', borderRadius: '3px', background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)', border: 'none', cursor: 'pointer',
  } as React.CSSProperties,
  errorText: {
    fontSize: '11px', color: 'var(--vscode-errorForeground)',
  } as React.CSSProperties,
};
