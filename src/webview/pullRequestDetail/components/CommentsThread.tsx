import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PullRequestComment, PullRequestCommit, PullRequestEvent } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { renderMarkdown } from '../../shared/renderMarkdown';
import { MarkdownEditor } from '../../shared/MarkdownEditor';
import { formatRelativeTime } from '../../shared/formatRelativeTime';
import { SkeletonList } from '../../shared/Skeleton';
import { LabelChip } from './LabelsPanel';

interface Props {
  comments: PullRequestComment[];
  commits: PullRequestCommit[];
  events: PullRequestEvent[];
  loading: boolean;
  posting: boolean;
  canClose: boolean;
  closing: boolean;
  closeError?: string;
  commentActionError?: string;
  onPostComment: (body: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onHideComment: (commentId: string) => void;
  onUnhideComment: (commentId: string) => void;
  onClose: () => void;
  onOpenCommitAllChanges: (commitSha: string, parentSha: string | undefined) => void;
}

type TimelineItem =
  | { kind: 'comment'; date: string; comment: PullRequestComment }
  | { kind: 'commit'; date: string; commit: PullRequestCommit }
  | { kind: 'event'; date: string; event: PullRequestEvent };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Rendered via a portal into document.body, positioned in fixed viewport coordinates from the trigger
 * button's own rect — necessary because CommentRow's rounded-corner container clips overflow, which would
 * otherwise cut off the dropdown whenever a short comment left too little room below the button. */
function CommentActionsMenuPopover({ buttonRect, comment, onClose, onEdit, onDelete, onToggleHide }: {
  buttonRect: DOMRect;
  comment: PullRequestComment;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleHide: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, buttonRect.right - w));
    const preferBelow = buttonRect.bottom + 4;
    const top = preferBelow + h <= window.innerHeight ? preferBelow : Math.max(4, buttonRect.top - h - 4);
    setPos({ top, left });
  }, [buttonRect]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h, true);
    const onScrollOrResize = () => onClose();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', h, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ ...css.commentMenu, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {comment.canEdit && (
        <div className="menu-item" style={css.commentMenuItem} onClick={() => { onClose(); onEdit(); }}>
          <Codicon name="edit" style={{ fontSize: '13px' }} />
          Edit
        </div>
      )}
      {comment.canHide && (
        <div className="menu-item" style={css.commentMenuItem} onClick={() => { onClose(); onToggleHide(); }}>
          <Codicon name={comment.isHidden ? 'eye' : 'eye-closed'} style={{ fontSize: '13px' }} />
          {comment.isHidden ? 'Unhide' : 'Hide'}
        </div>
      )}
      {comment.canDelete && (
        <div className="menu-item" style={css.commentMenuItem} onClick={() => { onClose(); onDelete(); }}>
          <Codicon name="trash" style={{ fontSize: '13px', color: '#cf222e' }} />
          <span style={{ color: '#cf222e' }}>Delete</span>
        </div>
      )}
    </div>,
    document.body,
  );
}

function CommentActionsMenu({ comment, onEdit, onDelete, onToggleHide }: {
  comment: PullRequestComment;
  onEdit: () => void;
  onDelete: () => void;
  onToggleHide: () => void;
}) {
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  if (!comment.canEdit && !comment.canDelete && !comment.canHide) return null;

  return (
    <>
      <button
        ref={btnRef}
        className="icon-btn"
        style={css.commentMenuBtn}
        onClick={() => setButtonRect(r => r ? null : btnRef.current!.getBoundingClientRect())}
        title="Comment actions"
      >
        <Codicon name="ellipsis" style={{ fontSize: '15px' }} />
      </button>
      {buttonRect && (
        <CommentActionsMenuPopover
          buttonRect={buttonRect}
          comment={comment}
          onClose={() => setButtonRect(null)}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleHide={onToggleHide}
        />
      )}
    </>
  );
}

function CommentRow({ comment, onUpdate, onDelete, onHide, onUnhide }: {
  comment: PullRequestComment;
  onUpdate: (body: string) => void;
  onDelete: () => void;
  onHide: () => void;
  onUnhide: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const html = useMemo(() => renderMarkdown(comment.body), [comment.body]);

  const startEdit = () => {
    setDraft(comment.body);
    setEditing(true);
  };

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== comment.body) onUpdate(trimmed);
    setEditing(false);
  };

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
        {!editing && (
          <CommentActionsMenu
            comment={comment}
            onEdit={startEdit}
            onDelete={onDelete}
            onToggleHide={comment.isHidden ? onUnhide : onHide}
          />
        )}
      </div>
      {editing ? (
        <div style={css.commentEditWrap}>
          <MarkdownEditor value={draft} onChange={setDraft} placeholder="Edit comment…" minHeight="80px" bare />
          <div style={css.commentEditActions}>
            <button className="icon-btn" style={css.commentEditCancelBtn} onClick={() => setEditing(false)}>Cancel</button>
            <button style={{ ...css.submitBtn, opacity: draft.trim() ? 1 : 0.5 }} disabled={!draft.trim()} onClick={save}>
              <Codicon name="check" style={{ fontSize: '13px' }} />
              Save
            </button>
          </div>
        </div>
      ) : comment.isHidden ? (
        <div style={css.commentHiddenWrap}>
          <Codicon name="eye-closed" style={{ fontSize: '13px', opacity: 0.6 }} />
          <span style={css.commentHiddenText}>This comment has been minimized.</span>
          <button className="icon-btn" style={css.commentShowBtn} onClick={onUnhide} title="Show comment">
            <Codicon name="unfold" style={{ fontSize: '13px' }} />
            Show comment
          </button>
        </div>
      ) : (
        <div style={css.commentBodyWrap}>
          <div className="markdown-body" style={css.commentBody} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
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
      <span style={{ ...css.eventIconDot, color: 'var(--vscode-descriptionForeground)', borderColor: 'var(--vscode-descriptionForeground)' }}>
        <Codicon name="git-commit" style={{ fontSize: '14px' }} />
      </span>
      {commit.authorAvatarUrl
        ? <img src={commit.authorAvatarUrl} alt={commit.authorName} title={commit.authorName} style={css.commitAvatarImg} />
        : <span style={css.commitAvatarFallback} title={commit.authorName}>{initials(commit.authorName)}</span>
      }
      <span style={css.commitAuthor}>{commit.authorName}</span>
      <span style={css.commitLink}>{commit.message.split('\n')[0]}</span>
      <span style={css.commitSha}>{commit.shortSha}</span>
      <span style={css.commitDate} title={new Date(commit.authoredAt).toLocaleString()}>
        {formatRelativeTime(commit.authoredAt)}
      </span>
    </div>
  );
}

function eventIcon(kind: PullRequestEvent['kind']): string {
  switch (kind) {
    case 'renamed': return 'edit';
    case 'labeled': case 'unlabeled': return 'tag';
    case 'closed': return 'git-pull-request-closed';
    case 'reopened': return 'git-pull-request';
    case 'merged': return 'git-merge';
    case 'baseChanged': return 'git-branch';
    case 'assigned': case 'unassigned': return 'account';
    case 'reviewRequested': case 'reviewRequestRemoved': return 'eye';
  }
}

/** Matches GitHub's own timeline dot colors: red for closed, purple/green for merge states, blue-ish default
 * for everything else — gives the thread's connecting line something to visually "plug into" at each event. */
function eventColor(kind: PullRequestEvent['kind']): string {
  switch (kind) {
    case 'closed': return '#cf222e';
    case 'reopened': return '#1a7f37';
    case 'merged': return '#8250df';
    case 'labeled': case 'unlabeled': return '#9a6700';
    case 'baseChanged': return '#0969da';
    default: return 'var(--vscode-descriptionForeground)';
  }
}

function eventText(event: PullRequestEvent): React.ReactNode {
  switch (event.kind) {
    case 'renamed':
      return event.previousTitle
        ? <>changed the title from <strong>"{event.previousTitle}"</strong> to <strong>"{event.newTitle}"</strong></>
        : <>changed the title to <strong>"{event.newTitle}"</strong></>;
    case 'labeled':
      return event.label ? <>added the <LabelChip label={event.label} /> label</> : 'added a label';
    case 'unlabeled':
      return event.label ? <>removed the <LabelChip label={event.label} /> label</> : 'removed a label';
    case 'closed':
      return 'closed this pull request';
    case 'reopened':
      return 'reopened this pull request';
    case 'merged':
      return 'merged this pull request';
    case 'baseChanged':
      return <>changed the base branch from <strong>{event.previousBranch}</strong> to <strong>{event.newBranch}</strong></>;
    case 'assigned':
      return <>assigned <strong>{event.user?.username}</strong></>;
    case 'unassigned':
      return <>unassigned <strong>{event.user?.username}</strong></>;
    case 'reviewRequested':
      return <>requested a review from <strong>{event.user?.username}</strong></>;
    case 'reviewRequestRemoved':
      return <>removed the review request for <strong>{event.user?.username}</strong></>;
  }
}

function EventRow({ event }: { event: PullRequestEvent }) {
  const color = eventColor(event.kind);
  return (
    <div style={css.eventRow}>
      <span style={{ ...css.eventIconDot, color, borderColor: color }}>
        <Codicon name={eventIcon(event.kind)} style={{ fontSize: '14px' }} />
      </span>
      {event.actorAvatarUrl
        ? <img src={event.actorAvatarUrl} alt={event.actorName} title={event.actorName} style={css.commitAvatarImg} />
        : <span style={css.commitAvatarFallback} title={event.actorName}>{initials(event.actorName)}</span>
      }
      <span style={css.eventText}>
        <strong>{event.actorName}</strong> {eventText(event)}
      </span>
      <span style={css.commitDate} title={new Date(event.createdAt).toLocaleString()}>
        {formatRelativeTime(event.createdAt)}
      </span>
    </div>
  );
}

export function CommentsThread({
  comments, commits, events, loading, posting, canClose, closing, closeError, commentActionError,
  onPostComment, onUpdateComment, onDeleteComment, onHideComment, onUnhideComment, onClose, onOpenCommitAllChanges,
}: Props) {
  const [draft, setDraft] = useState('');

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...comments.map(comment => ({ kind: 'comment' as const, date: comment.createdAt, comment })),
      ...commits.map(commit => ({ kind: 'commit' as const, date: commit.authoredAt, commit })),
      ...events.map(event => ({ kind: 'event' as const, date: event.createdAt, event })),
    ];
    return items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [comments, commits, events]);

  return (
    <div style={css.root}>
      {loading ? (
        <SkeletonList rows={3} />
      ) : timeline.length === 0 ? (
        <div style={css.empty}>No activity yet.</div>
      ) : (
        <div style={css.timelineWrap}>
          <div style={css.timelineThread} />
          {timeline.map(item => {
            if (item.kind === 'comment') {
              return (
                <CommentRow
                  key={`c-${item.comment.id}`}
                  comment={item.comment}
                  onUpdate={body => onUpdateComment(item.comment.id, body)}
                  onDelete={() => onDeleteComment(item.comment.id)}
                  onHide={() => onHideComment(item.comment.id)}
                  onUnhide={() => onUnhideComment(item.comment.id)}
                />
              );
            }
            if (item.kind === 'commit') {
              return <CommitRow key={`k-${item.commit.sha}`} commit={item.commit} onOpen={() => onOpenCommitAllChanges(item.commit.sha, item.commit.parentSha)} />;
            }
            return <EventRow key={`e-${item.event.id}`} event={item.event} />;
          })}
        </div>
      )}
      {commentActionError && <div style={css.errorText}>{commentActionError}</div>}

      <div style={css.form}>
        <MarkdownEditor value={draft} onChange={setDraft} placeholder="Leave a comment…" minHeight="80px" />
      </div>

      <div style={css.actionsRow}>
        {canClose && (
          <button className="icon-btn" style={css.closeBtn} disabled={closing} onClick={onClose}>
            <Codicon name="git-pull-request-closed" style={{ fontSize: '13px', color: '#cf222e' }} />
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
  timelineWrap: {
    position: 'relative' as const, display: 'flex', flexDirection: 'column' as const, gap: '10px',
  } as React.CSSProperties,
  /** Centered on the 26px event/commit icon column (12px left padding + half of 26px = 25px) — `left` is the
   * line's own left edge, so it's offset by half its own width to actually center the line on that point,
   * not put its edge there. Runs from the center of the first row's icon to the center of the last row's
   * icon (13px = half of 26px, matching whichever row happens to be first/last) rather than a fixed offset,
   * since rows have very different heights (a comment box vs. a slim commit/event row) and a fixed inset
   * would overshoot or undershoot depending on which kind of row is at either end. Individual rows have a
   * transparent background (only their icon dot is opaque) so the line reads as continuous through the
   * whole stack, not just in the gaps between rows. */
  timelineThread: {
    position: 'absolute' as const, top: '13px', bottom: '13px', left: '25px', width: '2px', marginLeft: '-1px',
    background: 'var(--vscode-panel-border)', zIndex: 0,
  } as React.CSSProperties,
  comment: {
    position: 'relative' as const, zIndex: 1,
    display: 'flex', flexDirection: 'column' as const,
    border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', overflow: 'hidden',
    background: 'var(--vscode-editor-background)',
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
  commentMenuBtn: {
    background: 'transparent', border: 'none', color: 'inherit', opacity: 0.6, cursor: 'pointer',
    display: 'flex', alignItems: 'center', padding: '2px', flexShrink: 0,
  } as React.CSSProperties,
  commentMenu: {
    position: 'fixed' as const, zIndex: 1000, minWidth: '140px',
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', padding: '4px 0',
  } as React.CSSProperties,
  commentMenuItem: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', cursor: 'pointer', fontSize: '12px',
  } as React.CSSProperties,
  commentBodyWrap: { padding: '12px' } as React.CSSProperties,
  commentHiddenWrap: {
    display: 'flex', alignItems: 'center', gap: '8px', margin: '12px', padding: '10px 12px',
    fontSize: '12px', fontStyle: 'italic' as const, opacity: 0.75,
    border: '1px dashed var(--vscode-panel-border)', borderRadius: '4px',
  } as React.CSSProperties,
  commentHiddenText: { flex: 1 } as React.CSSProperties,
  commentShowBtn: {
    display: 'flex', alignItems: 'center', gap: '4px', fontStyle: 'normal' as const, opacity: 0.8,
    background: 'transparent', border: 'none', color: 'inherit', fontSize: '12px', padding: '2px 4px', borderRadius: '3px',
  } as React.CSSProperties,
  commentBody: { fontSize: '13px', lineHeight: 1.5 } as React.CSSProperties,
  commentEditWrap: { display: 'flex', flexDirection: 'column' as const } as React.CSSProperties,
  commentEditActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', padding: '8px 12px 12px' } as React.CSSProperties,
  commentEditCancelBtn: {
    fontSize: '12px', padding: '6px 14px', borderRadius: '4px',
    background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-panel-border)', cursor: 'pointer',
  } as React.CSSProperties,
  commitRow: {
    position: 'relative' as const, zIndex: 1,
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer',
    borderRadius: '4px',
  } as React.CSSProperties,
  commitAvatarImg: { width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0 } as React.CSSProperties,
  commitAvatarFallback: {
    width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '8px', fontWeight: 'bold' as const, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
  commitAuthor: {
    fontWeight: 600, flexShrink: 0, maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  commitLink: {
    color: 'var(--vscode-textLink-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1,
  } as React.CSSProperties,
  commitSha: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '11px', opacity: 0.6, flexShrink: 0,
  } as React.CSSProperties,
  commitDate: { opacity: 0.5, flexShrink: 0 } as React.CSSProperties,
  eventRow: {
    position: 'relative' as const, zIndex: 1,
    display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 12px', fontSize: '12px', opacity: 0.85,
  } as React.CSSProperties,
  /** The circular badge every timeline row (event/commit) plugs its icon into — bordered in the event's own
   * color, with a solid background so it visually breaks the connecting thread running behind it. */
  eventIconDot: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    width: '26px', height: '26px', borderRadius: '50%', boxSizing: 'border-box' as const,
    border: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-editor-background)',
  } as React.CSSProperties,
  eventText: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1,
  } as React.CSSProperties,
  form: { display: 'flex', flexDirection: 'column' as const, gap: '8px', marginTop: '4px' },
  actionsRow: { display: 'flex', alignItems: 'center', gap: '8px' } as React.CSSProperties,
  closeBtn: {
    display: 'flex', alignItems: 'center', gap: '6px',
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
