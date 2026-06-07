import React, { useEffect, useState } from 'react';
import type { UnpushedCommit } from '../../shared/msgTypes';
import type { RepoStatus, RepoMeta } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';

interface Props {
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
  unpushedMap: Record<string, { loading: boolean; commits: UnpushedCommit[]; error?: string }>;
  onPush: (repoId: string) => void;
  onPushAll: () => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: diffD > 365 ? 'numeric' : undefined });
  } catch { return iso; }
}

// ── Single commit row ─────────────────────────────────────────────────────────

function CommitRow({ commit, repoId, isHead, onOpenInLog, onUndoCommit }: {
  commit: UnpushedCommit;
  repoId: string;
  isHead: boolean;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...styles.commitRow, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={styles.commitHash}>{commit.shortHash}</span>
      <span style={styles.commitMessage}>{commit.message}</span>
      <span style={styles.commitMeta}>{commit.author} · {formatDate(commit.date)}</span>
      <div style={styles.commitActions(hovered)}>
        {isHead && (
          <button
            style={styles.actionBtn}
            title="Undo this commit (keeps changes as unstaged)"
            onClick={e => { e.stopPropagation(); onUndoCommit(repoId); }}
          >
            <Codicon name="discard" style={{ fontSize: '16px' }} />
          </button>
        )}
        <button
          style={styles.actionBtn}
          title="Open in Log"
          onClick={e => { e.stopPropagation(); onOpenInLog(commit.hash, repoId); }}
        >
          <Codicon name="go-to-file" style={{ fontSize: '16px' }} />
        </button>
      </div>
    </div>
  );
}

// ── Per-repo section ──────────────────────────────────────────────────────────

function RepoSection({ repoStatus, repoMeta, unpushed, checked, canCheck, onToggle, onOpenInLog, onUndoCommit, singleRepo }: {
  repoStatus: RepoStatus;
  repoMeta: RepoMeta | undefined;
  unpushed: Props['unpushedMap'][string] | undefined;
  checked: boolean;
  canCheck: boolean;
  onToggle: (repoId: string) => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  singleRepo?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const rawName = repoMeta?.name ?? repoStatus.repoId.split('/').pop() ?? repoStatus.repoId;
  const isWorktree = repoMeta?.isWorktree;
  const worktreeBranch = isWorktree
    ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
    : undefined;
  const mainRepoName = repoMeta?.mainWorktreePath?.split('/').pop();
  const repoName = worktreeBranch ? (mainRepoName ?? rawName) : rawName;
  const repoColor = repoMeta?.color ?? '#4ec9b0';
  const ahead = repoStatus.branch.aheadBehind?.ahead ?? 0;
  const hasUpstream = !!repoStatus.branch.upstream;
  const commitCount = hasUpstream ? ahead : (unpushed?.commits?.length ?? 0);

  return (
    <div style={styles.repoRoot}>
      {/* Repo header */}
      <div style={styles.repoHeader(repoColor)}>
        {!singleRepo && (
          <input
            type="checkbox"
            checked={checked}
            disabled={!canCheck}
            onChange={() => onToggle(repoStatus.repoId)}
            onClick={e => e.stopPropagation()}
            style={{ ...styles.checkbox, opacity: canCheck ? 1 : 0.35, cursor: canCheck ? 'pointer' : 'default' }}
            title={!canCheck ? 'Nothing to push' : checked ? 'Exclude from push' : 'Include in push'}
          />
        )}
        <div style={styles.headerMain} onClick={() => setExpanded(e => !e)}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '11px', opacity: 0.65, flexShrink: 0 }} />
          <span style={styles.dot(repoColor)} />
          <span style={styles.repoName}>{repoName}</span>
          {worktreeBranch && (
            <span style={styles.worktreeBadge} title={`Worktree branch: ${worktreeBranch}`}>
              <Codicon name="repo-clone" style={{ fontSize: '11px', marginRight: '3px' }} />
              {worktreeBranch}
            </span>
          )}
          {commitCount > 0 && (
            <span style={styles.aheadBadge}>
              <Codicon name="arrow-up" style={{ fontSize: '10px', marginRight: '2px' }} />
              {commitCount}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      {expanded && (
        <div style={styles.repoBody}>
          {hasUpstream && ahead === 0 ? (
            <div style={styles.upToDate}>
              <Codicon name="check" style={{ marginRight: '6px', opacity: 0.6 }} />
              Up to date
            </div>
          ) : unpushed?.loading ? (
            <div style={styles.loadingRow}>Loading commits…</div>
          ) : unpushed?.error ? (
            <div style={styles.errorRow}>
              <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
              {unpushed.error}
            </div>
          ) : unpushed?.commits && unpushed.commits.length > 0 ? (
            <div style={styles.commitList}>
              {unpushed.commits.map((c, i) => (
                <CommitRow key={c.hash} commit={c} repoId={repoStatus.repoId} isHead={i === 0} onOpenInLog={onOpenInLog} onUndoCommit={onUndoCommit} />
              ))}
            </div>
          ) : (
            <div style={styles.loadingRow}>No commits found</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function PushTab({ repos, repoMetas, unpushedMap, onPush, onPushAll, onOpenInLog, onUndoCommit }: Props) {
  const metaMap = new Map(repoMetas.map(m => [m.id, m]));
  const isSingleRepo = repos.length === 1;
  const [checked, setChecked] = useState<Set<string>>(() => new Set<string>());

  const canPushRepo = (r: RepoStatus) => {
    const ahead = r.branch.aheadBehind?.ahead ?? 0;
    const hasUpstream = !!r.branch.upstream;
    return (hasUpstream && ahead > 0) || !hasUpstream;
  };

  // Auto-deselect repos that no longer have commits to push
  useEffect(() => {
    setChecked(prev => {
      const toRemove = repos.filter(r => prev.has(r.repoId) && !canPushRepo(r));
      if (toRemove.length === 0) return prev;
      const next = new Set(prev);
      toRemove.forEach(r => next.delete(r.repoId));
      return next;
    });
  }, [repos, unpushedMap]);

  const toggleRepo = (repoId: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId); else next.add(repoId);
      return next;
    });
  };

  // Single repo: push directly, no checkbox needed
  if (isSingleRepo) {
    const solo = repos[0];
    const canPush = canPushRepo(solo);
    const hasUpstream = !!solo.branch.upstream;
    return (
      <div style={css.root}>
        <div style={css.list}>
          <RepoSection
            key={solo.repoId}
            repoStatus={solo}
            repoMeta={metaMap.get(solo.repoId)}
            unpushed={unpushedMap[solo.repoId]}
            checked={false}
            canCheck={false}
            onToggle={() => {}}
            onOpenInLog={onOpenInLog}
            onUndoCommit={onUndoCommit}
            singleRepo
          />
        </div>
        <div style={css.footer}>
          <button style={css.pushBtn(canPush)} disabled={!canPush} onClick={() => onPush(solo.repoId)}>
            <Codicon name="cloud-upload" style={{ marginRight: '6px' }} />
            {!hasUpstream ? 'Publish Branch' : 'Push'}
          </button>
        </div>
      </div>
    );
  }

  const checkedRepos = repos.filter(r => checked.has(r.repoId));
  const pushableChecked = checkedRepos.filter(canPushRepo);
  const canPush = pushableChecked.length > 0;

  const handlePush = () => {
    if (!canPush) return;
    if (pushableChecked.length === 1) {
      onPush(pushableChecked[0].repoId);
    } else {
      pushableChecked.forEach(r => onPush(r.repoId));
    }
  };

  return (
    <div style={css.root}>
      {/* Scrollable repo list */}
      <div style={css.list}>
        {repos.map(repoStatus => (
          <RepoSection
            key={repoStatus.repoId}
            repoStatus={repoStatus}
            repoMeta={metaMap.get(repoStatus.repoId)}
            unpushed={unpushedMap[repoStatus.repoId]}
            checked={checked.has(repoStatus.repoId)}
            canCheck={canPushRepo(repoStatus)}
            onToggle={toggleRepo}
            onOpenInLog={onOpenInLog}
            onUndoCommit={onUndoCommit}
          />
        ))}
      </div>

      {/* Anchored footer */}
      <div style={css.footer}>
        {checkedRepos.length > 0 && (
          <div style={css.pills}>
            {checkedRepos.map(r => {
              const meta = metaMap.get(r.repoId);
              const color = meta?.color ?? '#4ec9b0';
              const rawName = meta?.name ?? r.repoId.split('/').pop() ?? r.repoId;
              const wtBranch = meta?.isWorktree
                ? (r.branch.detachedTag ?? r.branch.detachedHash ?? r.branch.name)
                : undefined;
              const displayName = wtBranch
                ? `${meta?.mainWorktreePath?.split('/').pop() ?? rawName} (${wtBranch})`
                : rawName;
              const ahead = r.branch.aheadBehind?.ahead ?? 0;
              return (
                <span key={r.repoId} style={css.pill(color)}>
                  <button style={css.pillRemove(color)} title={`Remove ${displayName}`} onClick={() => toggleRepo(r.repoId)}>
                    <Codicon name="close" style={{ fontSize: '10px' }} />
                  </button>
                  {displayName}
                  {ahead > 0 && (
                    <span style={css.pillCount}>
                      <Codicon name="arrow-up" style={{ fontSize: '8px', marginRight: '1px' }} />
                      {ahead}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        <button style={css.pushBtn(canPush)} disabled={!canPush} onClick={handlePush}>
          <Codicon name="cloud-upload" style={{ marginRight: '6px' }} />
          {checkedRepos.length === 1 && !checkedRepos[0].branch.upstream ? 'Publish Branch' : 'Push'}
        </button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0 },
  list: { flex: 1, overflowY: 'auto' as const, minHeight: 0 },
  footer: {
    flexShrink: 0,
    display: 'flex', flexDirection: 'column' as const, gap: '6px',
    padding: '8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
  } as React.CSSProperties,
  pills: { display: 'flex', flexWrap: 'wrap' as const, gap: '4px' } as React.CSSProperties,
  pill: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    padding: '1px 7px 1px 4px', borderRadius: '10px',
    fontSize: '11px', lineHeight: '16px',
    background: color + '28', color,
    border: `1px solid ${color}60`,
  }),
  pillRemove: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', color,
    cursor: 'pointer', padding: '0 1px', borderRadius: '50%', lineHeight: 1,
  }),
  pillCount: {
    display: 'inline-flex', alignItems: 'center',
    background: 'rgba(255,255,255,0.15)', borderRadius: '7px',
    padding: '0 3px', fontSize: '10px', minWidth: '14px', height: '14px',
    justifyContent: 'center', boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  pushBtn: (enabled: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none', borderRadius: '3px', padding: '6px 12px',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '12px', fontFamily: 'var(--vscode-font-family)',
    opacity: enabled ? 1 : 0.45, width: '100%',
  }),
};

const styles = {
  repoRoot: { borderBottom: '1px solid var(--vscode-panel-border)' } as React.CSSProperties,
  repoHeader: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center',
    padding: '4px 8px', minHeight: '26px',
    background: color + '14', borderBottom: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box',
  }),
  checkbox: {
    margin: '0 2px 0 0', flexShrink: 0,
    accentColor: 'var(--vscode-button-background)',
  } as React.CSSProperties,
  headerMain: {
    display: 'flex', alignItems: 'center', gap: '6px',
    flex: 1, minWidth: 0, cursor: 'pointer',
  } as React.CSSProperties,
  dot: (color: string): React.CSSProperties => ({
    width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
  }),
  repoName: {
    fontSize: '11px', fontWeight: 'bold' as const, opacity: 0.9,
    textTransform: 'uppercase' as const, letterSpacing: '0.04em', minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flexShrink: 1,
  },
  aheadBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 'bold' as const,
    flexShrink: 0, marginLeft: 'auto',
  } as React.CSSProperties,
  worktreeBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
    borderRadius: '3px', padding: '1px 5px 1px 4px', fontSize: '11px', fontWeight: 'normal' as const,
    letterSpacing: '0.02em', flexShrink: 0, opacity: 0.75,
  } as React.CSSProperties,
  repoBody: { background: 'var(--vscode-sideBar-background)' } as React.CSSProperties,
  upToDate: {
    display: 'flex', alignItems: 'center', padding: '8px 12px', fontSize: '12px', opacity: 0.5,
  } as React.CSSProperties,
  loadingRow: { padding: '8px 12px', fontSize: '12px', opacity: 0.45, fontStyle: 'italic' as const } as React.CSSProperties,
  errorRow: {
    display: 'flex', alignItems: 'flex-start', padding: '6px 10px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)',
  } as React.CSSProperties,
  commitList: { display: 'flex', flexDirection: 'column' as const } as React.CSSProperties,
  commitRow: {
    display: 'grid',
    gridTemplateColumns: '48px 1fr auto',
    gridTemplateRows: 'auto auto',
    gap: '0 8px',
    padding: '7px 12px',
    alignItems: 'center',
  } as React.CSSProperties,
  commitHash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '10px',
    opacity: 0.55, gridRow: '1', gridColumn: '1',
    display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  commitMessage: {
    fontSize: '12px', fontWeight: 500, gridRow: '1', gridColumn: '2',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  commitMeta: {
    fontSize: '10px', opacity: 0.45, gridRow: '2', gridColumn: '2',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  commitActions: (visible: boolean): React.CSSProperties => ({
    gridRow: '1 / 3', gridColumn: '3',
    display: 'flex', alignItems: 'center', gap: '4px', alignSelf: 'center',
    opacity: visible ? 1 : 0, transition: 'opacity 0.1s',
  }),
  actionBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer', padding: '2px', borderRadius: '3px', opacity: 0.65,
  } as React.CSSProperties,
};
