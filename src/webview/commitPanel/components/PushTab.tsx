import React, { useEffect, useRef, useState } from 'react';
import type { UnpushedCommit } from '../../shared/msgTypes';
import type { RepoStatus, RepoMeta } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';
import { branchColor, tagColor } from '../../shared/branchColors';

interface Props {
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
  unpushedMap: Record<string, { loading: boolean; commits: UnpushedCommit[]; error?: string }>;
  onPush: (repoId: string) => void;
  onPushAll: () => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  onSquash: (repoId: string, hashes: string[], oldestHash: string, combinedMessage: string, commits: { hash: string; shortHash: string; message: string }[]) => void;
  onDropCommits: (repoId: string, hashes: string[], oldestHash: string) => void;
  onRevertCommits: (repoId: string, hashes: string[]) => void;
  onEditCommitMsg: (repoId: string, hash: string, currentMessage: string) => void;
  onOpenDetail: (repoId: string, hash: string) => void;
  onExplainCommit: (repoId: string, hash: string) => void;
  onBranchClick: (repoId: string) => void;
  aiEnabled: boolean;
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

// ── Context menu ──────────────────────────────────────────────────────────────

interface CommitCtxMenuState {
  x: number;
  y: number;
  repoId: string;
  selectedHashes: string[];
  commits: UnpushedCommit[];
  isHead: boolean;
  singleHash: string | null; // set only when n === 1
}

function MenuItem({ icon, label, danger, onClick }: { icon: string; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <div
      style={{ ...ctxStyles.item, ...(danger ? { color: 'var(--vscode-errorForeground)' } : {}) }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      onClick={onClick}
    >
      <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.8 }} />
      {label}
    </div>
  );
}

function CommitContextMenu({ state, onSquash, onDropCommits, onRevertCommits, onEditMsg, onUndo, onRevertSingle, onDropSingle, onViewInLog, onOpenDetail, onExplain, aiEnabled, onClose }: {
  state: CommitCtxMenuState;
  onSquash: () => void;
  onDropCommits: () => void;
  onRevertCommits: () => void;
  onEditMsg: () => void;
  onUndo: () => void;
  onRevertSingle: () => void;
  onDropSingle: () => void;
  onViewInLog: () => void;
  onOpenDetail: () => void;
  onExplain: () => void;
  aiEnabled: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const n = state.selectedHashes.length;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const [pos, setPos] = useState({ x: state.x, y: state.y });
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: state.x + rect.width > vw ? Math.max(0, vw - rect.width - 4) : state.x,
      y: state.y + rect.height > vh ? Math.max(0, vh - rect.height - 4) : state.y,
    });
  }, [state.x, state.y]);

  const wrap = (fn: () => void) => () => { fn(); onClose(); };

  return (
    <div ref={ref} style={{ ...ctxStyles.menu, left: pos.x, top: pos.y }} onContextMenu={e => e.preventDefault()}>
      {n === 1 && (
        <>
          <MenuItem icon="go-to-file" label="View in Git Log" onClick={wrap(onViewInLog)} />
          <MenuItem icon="open-preview" label="Open Full Detail" onClick={wrap(onOpenDetail)} />
          {aiEnabled && <MenuItem icon="sparkle" label="Explain with AI" onClick={wrap(onExplain)} />}
          <div style={ctxStyles.separator} />
          {state.isHead && <MenuItem icon="edit" label="Edit Commit Message…" onClick={wrap(onEditMsg)} />}
          <MenuItem icon="discard" label="Revert Commit" onClick={wrap(onRevertSingle)} />
          {state.isHead && (
            <>
              <div style={ctxStyles.separator} />
              <MenuItem icon="arrow-left" label="Undo Commit" onClick={wrap(onUndo)} />
              <MenuItem icon="trash" label="Drop Commit" danger onClick={wrap(onDropSingle)} />
            </>
          )}
        </>
      )}
      {n >= 2 && (
        <>
          <MenuItem icon="discard" label={`Revert ${n} commits`} onClick={wrap(onRevertCommits)} />
          <div style={ctxStyles.separator} />
          <MenuItem icon="trash" label={`Drop ${n} commits`} danger onClick={wrap(onDropCommits)} />
          <MenuItem icon="fold" label={`Squash ${n} commits…`} onClick={wrap(onSquash)} />
        </>
      )}
    </div>
  );
}

const ctxStyles = {
  menu: {
    position: 'fixed' as const,
    zIndex: 9999,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    padding: '3px 0',
    minWidth: '170px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    fontSize: '12px',
    color: 'var(--vscode-menu-foreground)',
  },
  item: {
    display: 'flex', alignItems: 'center', gap: '7px',
    padding: '5px 12px',
    cursor: 'pointer',
    background: 'transparent',
    userSelect: 'none' as const,
  },
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground, var(--vscode-panel-border))',
    margin: '3px 0',
  } as React.CSSProperties,
};

// ── Single commit row ─────────────────────────────────────────────────────────

function CommitRow({ commit, repoId, isHead, isSelected, onOpenInLog, onUndoCommit, onClick, onContextMenu }: {
  commit: UnpushedCommit;
  repoId: string;
  isHead: boolean;
  isSelected: boolean;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);

  let bg = 'transparent';
  if (isSelected) bg = 'var(--vscode-list-inactiveSelectionBackground)';
  else if (hovered) bg = 'var(--vscode-list-hoverBackground)';

  return (
    <div
      style={{ ...styles.commitRow, background: bg }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span style={styles.commitHash}>{commit.shortHash}</span>
      <span style={styles.commitMessage}>{commit.message.split('\n')[0]}</span>
      <span style={styles.commitMeta}>
        {commit.author} · {formatDate(commit.date)}
        {commit.filesChanged != null && (
          <span style={styles.commitStats}>
            &nbsp;·&nbsp;{commit.filesChanged} file{commit.filesChanged !== 1 ? 's' : ''}
            {commit.additions != null && commit.additions > 0 && <span style={styles.statAdd}>&nbsp;+{commit.additions}</span>}
            {commit.deletions != null && commit.deletions > 0 && <span style={styles.statDel}>&nbsp;-{commit.deletions}</span>}
          </span>
        )}
      </span>
      <div style={styles.commitActions(hovered || isSelected)}>
        {isHead && (
          <button
            style={styles.actionBtn}
            title="Undo this commit (keeps changes as unstaged)"
            onClick={e => { e.stopPropagation(); onUndoCommit(repoId); }}
          >
            <Codicon name="arrow-left" style={{ fontSize: '16px' }} />
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


function RepoSection({ repoStatus, repoMeta, unpushed, checked, canCheck, onToggle, onOpenInLog, onUndoCommit, onSquash, onDropCommits, onRevertCommits, onEditCommitMsg, onOpenDetail, onExplainCommit, onBranchClick, aiEnabled, singleRepo }: {
  repoStatus: RepoStatus;
  repoMeta: RepoMeta | undefined;
  unpushed: Props['unpushedMap'][string] | undefined;
  checked: boolean;
  canCheck: boolean;
  onToggle: (repoId: string) => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  onSquash: (repoId: string, hashes: string[], oldestHash: string, combinedMessage: string, commits: { hash: string; shortHash: string; message: string }[]) => void;
  onDropCommits: (repoId: string, hashes: string[], oldestHash: string) => void;
  onRevertCommits: (repoId: string, hashes: string[]) => void;
  onEditCommitMsg: (repoId: string, hash: string, currentMessage: string) => void;
  onOpenDetail: (repoId: string, hash: string) => void;
  onExplainCommit: (repoId: string, hash: string) => void;
  onBranchClick: (repoId: string) => void;
  aiEnabled: boolean;
  singleRepo?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [multiSelectHashes, setMultiSelectHashes] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<CommitCtxMenuState | null>(null);

  const rawName = repoMeta?.name ?? repoStatus.repoId.split('/').pop() ?? repoStatus.repoId;
  const isWorktree = repoMeta?.isWorktree;
  const worktreeBranch = isWorktree
    ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
    : undefined;
  const mainRepoName = repoMeta?.mainWorktreePath?.split('/').pop();
  const repoName = worktreeBranch ? (mainRepoName ?? rawName) : rawName;
  const branchLabel = repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name;
  const branchClr = repoStatus.branch.detachedTag ? tagColor() : branchColor(repoStatus.branch.name, false);
  const repoColor = repoMeta?.color ?? '#4ec9b0';
  const ahead = repoStatus.branch.aheadBehind?.ahead ?? 0;
  const behind = repoStatus.branch.aheadBehind?.behind ?? 0;
  const hasUpstream = !!repoStatus.branch.upstream;
  const commitCount = hasUpstream ? ahead : (unpushed?.commits?.length ?? 0);
  const commits = unpushed?.commits ?? [];

  const handleCommitClick = (e: React.MouseEvent, hash: string) => {
    if (e.ctrlKey || e.metaKey) {
      setMultiSelectHashes(prev => {
        const next = new Set(prev);
        if (next.has(hash)) next.delete(hash); else next.add(hash);
        return next;
      });
    } else {
      setMultiSelectHashes(new Set());
    }
  };

  const handleCommitContextMenu = (e: React.MouseEvent, commit: UnpushedCommit, isHead: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    let selectedHashes: Set<string>;
    if (multiSelectHashes.has(commit.hash) && multiSelectHashes.size > 1) {
      selectedHashes = multiSelectHashes;
    } else {
      selectedHashes = new Set([commit.hash]);
      setMultiSelectHashes(selectedHashes);
    }
    const isSingle = selectedHashes.size === 1;
    const singleHash = isSingle ? commit.hash : null;
    setCtxMenu({ x: e.clientX, y: e.clientY, repoId: repoStatus.repoId, selectedHashes: Array.from(selectedHashes), commits, isHead: isSingle && isHead, singleHash });
  };

  const handleEditMsg = () => {
    if (!ctxMenu?.singleHash) return;
    const commit = commits.find(c => c.hash === ctxMenu.singleHash);
    if (!commit) return;
    onEditCommitMsg(repoStatus.repoId, ctxMenu.singleHash, commit.message);
  };

  const handleUndo = () => {
    onUndoCommit(repoStatus.repoId);
  };

  const handleRevertSingle = () => {
    if (!ctxMenu?.singleHash) return;
    onRevertCommits(repoStatus.repoId, [ctxMenu.singleHash]);
  };

  const handleDropSingle = () => {
    if (!ctxMenu?.singleHash) return;
    onDropCommits(repoStatus.repoId, [ctxMenu.singleHash], ctxMenu.singleHash);
  };

  const handleViewInLog = () => {
    if (!ctxMenu?.singleHash) return;
    onOpenInLog(ctxMenu.singleHash, repoStatus.repoId);
  };

  const handleOpenDetail = () => {
    if (!ctxMenu?.singleHash) return;
    onOpenDetail(repoStatus.repoId, ctxMenu.singleHash);
  };

  const handleExplain = () => {
    if (!ctxMenu?.singleHash) return;
    onExplainCommit(repoStatus.repoId, ctxMenu.singleHash);
  };

  const getOrderedSelection = () => {
    const hashes = ctxMenu?.selectedHashes ?? [];
    const ordered = [...commits].filter(c => hashes.includes(c.hash));
    const oldestHash = ordered[ordered.length - 1]?.hash ?? hashes[hashes.length - 1];
    return { hashes, ordered, oldestHash };
  };

  const handleSquash = () => {
    if (!ctxMenu || ctxMenu.selectedHashes.length < 2) return;
    const { hashes, ordered, oldestHash } = getOrderedSelection();
    const combinedMessage = ordered.map(c => c.message).join('\n\n');
    onSquash(repoStatus.repoId, hashes, oldestHash, combinedMessage, ordered.map(c => ({ hash: c.hash, shortHash: c.shortHash, message: c.message })));
    setMultiSelectHashes(new Set());
  };

  const handleDropCommits = () => {
    if (!ctxMenu || ctxMenu.selectedHashes.length < 2) return;
    const { hashes, oldestHash } = getOrderedSelection();
    onDropCommits(repoStatus.repoId, hashes, oldestHash);
    setMultiSelectHashes(new Set());
  };

  const handleRevertCommits = () => {
    if (!ctxMenu || ctxMenu.selectedHashes.length < 2) return;
    const { hashes } = getOrderedSelection();
    onRevertCommits(repoStatus.repoId, hashes);
    setMultiSelectHashes(new Set());
  };

  // Clear selection when clicking outside commit list
  const handleBodyClick = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('[data-commit-row]')) {
      setMultiSelectHashes(new Set());
    }
  };

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
        <div style={styles.headerMain} onClick={singleRepo ? undefined : () => setExpanded(e => !e)}>
          {!singleRepo && <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '11px', opacity: 0.65, flexShrink: 0 }} />}
          <span style={styles.dot(repoColor)} />
          <span style={styles.repoName}>{repoName}</span>
          <span
            style={{ ...styles.branchBadge(branchClr), cursor: 'pointer' }}
            title={repoStatus.branch.detachedTag ? `Tag: ${repoStatus.branch.detachedTag} (detached HEAD)` : repoStatus.branch.detachedHash ? `Detached HEAD at ${repoStatus.branch.detachedHash}` : branchLabel}
            onClick={e => { e.stopPropagation(); onBranchClick(repoStatus.repoId); }}
          >
            <Codicon name={worktreeBranch ? 'worktree' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0, opacity: 0.8 }} />
            <span style={styles.branchName}>{branchLabel}</span>
          </span>
          {commitCount > 0 && (
            <span style={styles.aheadBadge}>
              <Codicon name="arrow-up" style={{ fontSize: '10px', marginRight: '2px' }} />
              {commitCount}
            </span>
          )}
          {behind > 0 && commitCount === 0 && (
            <span style={styles.behindBadge}>
              <Codicon name="arrow-down" style={{ fontSize: '10px', marginRight: '2px' }} />
              {behind}
            </span>
          )}
          {!hasUpstream && commitCount === 0 && (
            <span style={styles.publishBadge}>
              <Codicon name="cloud-upload" style={{ fontSize: '10px', marginRight: '3px' }} />
              Unpublished
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      {expanded && (
        <div style={styles.repoBody} onClick={handleBodyClick}>
          {hasUpstream && ahead === 0 && behind === 0 ? (
            <div style={styles.upToDate}>
              <Codicon name="check" style={{ marginRight: '6px', opacity: 0.6 }} />
              Up to date
            </div>
          ) : hasUpstream && ahead === 0 && behind > 0 ? (
            <div style={styles.behindRow}>
              <Codicon name="arrow-down" style={{ marginRight: '6px', opacity: 0.7, flexShrink: 0 }} />
              <span>
                {behind} commit{behind !== 1 ? 's' : ''} to pull from <em>{repoStatus.branch.upstream}</em>
              </span>
            </div>
          ) : unpushed?.loading ? (
            <div style={styles.emptyRow}>Loading commits…</div>
          ) : unpushed?.error ? (
            <div style={styles.errorRow}>
              <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
              {unpushed.error}
            </div>
          ) : commits.length > 0 ? (
            <div style={styles.commitList}>
              {commits.map((c, i) => (
                <div key={c.hash} data-commit-row="true">
                  <CommitRow
                    commit={c}
                    repoId={repoStatus.repoId}
                    isHead={i === 0}
                    isSelected={multiSelectHashes.has(c.hash)}
                    onOpenInLog={onOpenInLog}
                    onUndoCommit={onUndoCommit}
                    onClick={e => handleCommitClick(e, c.hash)}
                    onContextMenu={e => handleCommitContextMenu(e, c, i === 0)}
                  />
                </div>
              ))}
            </div>
          ) : !hasUpstream ? (
            <div style={styles.unpublishedRow}>
              <Codicon name="cloud-upload" style={{ marginRight: '6px', opacity: 0.7, flexShrink: 0 }} />
              <span>Local branch — not published to any remote yet</span>
            </div>
          ) : (
            <div style={styles.emptyRow}>No commits found</div>
          )}
        </div>
      )}

      {ctxMenu && (
        <CommitContextMenu
          state={ctxMenu}
          onSquash={handleSquash}
          onDropCommits={handleDropCommits}
          onRevertCommits={handleRevertCommits}
          onEditMsg={handleEditMsg}
          onUndo={handleUndo}
          onRevertSingle={handleRevertSingle}
          onDropSingle={handleDropSingle}
          onViewInLog={handleViewInLog}
          onOpenDetail={handleOpenDetail}
          onExplain={handleExplain}
          aiEnabled={aiEnabled}
          onClose={() => { setCtxMenu(null); setMultiSelectHashes(new Set()); }}
        />
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function PushTab({ repos, repoMetas, unpushedMap, onPush, onPushAll, onOpenInLog, onUndoCommit, onSquash, onDropCommits, onRevertCommits, onEditCommitMsg, onOpenDetail, onExplainCommit, onBranchClick, aiEnabled }: Props) {
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

  const pushButtonLabel = (targets: RepoStatus[]) => {
    const hasPublish = targets.some(r => !r.branch.upstream);
    const hasPush = targets.some(r => !!r.branch.upstream);
    const publishCount = targets.filter(r => !r.branch.upstream).length;
    if (hasPublish && hasPush) return publishCount === 1 ? 'Push & Publish Branch' : 'Push & Publish Branches';
    if (hasPublish) return targets.length === 1 ? 'Publish Branch' : 'Publish Branches';
    return 'Push';
  };

  // Single repo: push directly, no checkbox needed
  if (isSingleRepo) {
    const solo = repos[0];
    const canPush = canPushRepo(solo);
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
            onSquash={onSquash}
            onDropCommits={onDropCommits}
            onRevertCommits={onRevertCommits}
            onEditCommitMsg={onEditCommitMsg}
            onOpenDetail={onOpenDetail}
            onExplainCommit={onExplainCommit}
            onBranchClick={onBranchClick}
            aiEnabled={aiEnabled}
            singleRepo
          />
        </div>
        <div style={css.footer}>
          <button style={css.pushBtn(canPush)} disabled={!canPush} onClick={() => onPush(solo.repoId)}>
            <Codicon name="cloud-upload" style={{ marginRight: '6px' }} />
            {pushButtonLabel([solo])}
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
            onSquash={onSquash}
            onDropCommits={onDropCommits}
            onRevertCommits={onRevertCommits}
            onEditCommitMsg={onEditCommitMsg}
            onOpenDetail={onOpenDetail}
            onExplainCommit={onExplainCommit}
            onBranchClick={onBranchClick}
            aiEnabled={aiEnabled}
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
          {pushButtonLabel(pushableChecked)}
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
  behindBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--vscode-inputValidation-warningBackground, #6b4f00)', color: 'var(--vscode-inputValidation-warningForeground, #cca700)',
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 'bold' as const,
    flexShrink: 0, marginLeft: 'auto',
  } as React.CSSProperties,
  publishBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 500 as const,
    flexShrink: 0, marginLeft: 'auto',
  } as React.CSSProperties,
  branchBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    fontSize: '10px', fontWeight: 600,
    background: `${color}33`, color, border: `1px solid ${color}88`,
    borderRadius: '3px', padding: '1px 5px',
    flexShrink: 1, minWidth: 0, maxWidth: '160px', marginLeft: '4px',
    overflow: 'hidden',
  }),
  branchName: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0,
  } as React.CSSProperties,
  repoBody: { background: 'var(--vscode-sideBar-background)' } as React.CSSProperties,
  upToDate: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 8px', fontSize: '12px', opacity: 0.5,
  } as React.CSSProperties,
  emptyRow: { padding: '12px 8px', fontSize: '12px', opacity: 0.45, textAlign: 'center' as const } as React.CSSProperties,
  behindRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '12px 8px', fontSize: '12px', opacity: 0.75,
    color: 'var(--vscode-inputValidation-warningForeground, #cca700)',
  } as React.CSSProperties,
  unpublishedRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '12px 8px', fontSize: '12px', opacity: 0.5,
  } as React.CSSProperties,
  loadingRow: { padding: '8px 12px', fontSize: '12px', opacity: 0.45 } as React.CSSProperties,
  errorRow: {
    display: 'flex', alignItems: 'flex-start', padding: '6px 10px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)',
  } as React.CSSProperties,
  commitList: { display: 'flex', flexDirection: 'column' as const } as React.CSSProperties,
  selectionHint: {
    display: 'flex', alignItems: 'center', gap: '5px',
    padding: '4px 12px', fontSize: '11px', opacity: 0.65,
    background: 'var(--vscode-editor-selectionHighlightBackground, rgba(255,255,255,0.05))',
    borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  commitRow: {
    display: 'grid',
    gridTemplateColumns: '48px 1fr auto',
    gridTemplateRows: 'auto auto',
    gap: '0 8px',
    padding: '7px 12px',
    alignItems: 'center',
    cursor: 'default',
    userSelect: 'none' as const,
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
    display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  commitStats: { display: 'inline-flex', alignItems: 'center', flexShrink: 0 } as React.CSSProperties,
  statAdd: { color: 'var(--vscode-gitDecoration-addedResourceForeground)' } as React.CSSProperties,
  statDel: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)' } as React.CSSProperties,
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
