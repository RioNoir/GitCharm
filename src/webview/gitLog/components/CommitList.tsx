import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LaidOutCommit } from '../utils/graphLayout';
import { CommitRowSvg } from './CommitGraph';
import { ROW_HEIGHT, LANE_WIDTH } from '../utils/graphLayout';
import type { RepoMeta } from '../../shared/types';
import { groupRefs, branchColor } from '../utils/refs';
import type { RefGroup } from '../utils/refs';
import { Codicon } from '../../shared/Codicon';
import { getVsCodeApi } from '../../shared/vscodeApi';
import type { LogToHostMsg } from '../../../host/types/messages';
import { AuthorAvatar } from './AuthorAvatar';

// Suppress unused import warning — LANE_WIDTH is used by CommitRowSvg indirectly
void LANE_WIDTH;

interface Props {
  commits: LaidOutCommit[];
  selectedHash: string | null;
  repoColors: Record<string, string>;
  repos: RepoMeta[];
  currentBranchByRepo: Record<string, string>;
  onSelect: (commit: LaidOutCommit) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
  scrollToHash?: string | null;
  onScrolledToHash?: () => void;
}

interface RepoBlock {
  repoId: string;
  name: string;
  color: string;
  startRow: number;
  rowCount: number;
}

const REPO_LABEL_WIDTH = 6;
const REPO_LABEL_WIDTH_EXPANDED = 110;
const BLOCK_GAP = 4;

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function CommitList({ commits, selectedHash, repoColors, repos, currentBranchByRepo, onSelect, onLoadMore, hasMore, loading, scrollToHash, onScrolledToHash }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ commit: LaidOutCommit; x: number; y: number; multiSelected: LaidOutCommit[] } | null>(null);
  const [multiSelectHashes, setMultiSelectHashes] = useState<Set<string>>(new Set());

  const repoMeta = useMemo(() => {
    const map: Record<string, RepoMeta> = {};
    repos.forEach(r => { map[r.id] = r; });
    return map;
  }, [repos]);

  const multiRepo = repos.length > 1;

  const repoBlocks = useMemo((): RepoBlock[] => {
    if (!multiRepo || commits.length === 0) return [];
    const blocks: RepoBlock[] = [];
    let cur: RepoBlock | null = null;
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const meta = repoMeta[c.repoId];
      if (!cur || cur.repoId !== c.repoId) {
        cur = { repoId: c.repoId, name: meta?.name ?? c.repoId, color: meta?.color ?? '#888', startRow: i, rowCount: 1 };
        blocks.push(cur);
      } else {
        cur.rowCount++;
      }
    }
    return blocks;
  }, [commits, repoMeta, multiRepo]);


  // Last index of each block — the gap is added after these rows.
  const blockLastIndex = useMemo(() => {
    const s = new Set<number>();
    for (const block of repoBlocks) {
      if (block.startRow > 0) s.add(block.startRow - 1);
    }
    return s;
  }, [repoBlocks]);

  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    // Tell the virtualizer the true height of each row, including the gap
    // that follows the last row of each block.
    estimateSize: (i) => ROW_HEIGHT + (multiRepo && blockLastIndex.has(i) ? BLOCK_GAP : 0),
    overscan: 10,
  });

  const rawItems = virtualizer.getVirtualItems();
  // Use the virtualizer's own start positions — they already account for the
  // variable sizes above, so no manual offset calculation is needed.
  const items = rawItems;

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    if (hasMore && !loading) {
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 5;
      if (nearBottom) onLoadMore();
    }
  }, [hasMore, loading, onLoadMore]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (!scrollToHash) return;
    const idx = commits.findIndex(c => c.hash === scrollToHash);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center' });
      onSelect(commits[idx]);
      onScrolledToHash?.();
      return;
    }
    // Commit not yet in the loaded list — keep fetching batches until found or exhausted
    if (hasMore && !loading) onLoadMore();
  }, [scrollToHash, commits, hasMore, loading]);

  const anyExpanded = expandedRepos.size > 0;
  const labelColWidth = multiRepo ? (anyExpanded ? REPO_LABEL_WIDTH_EXPANDED : REPO_LABEL_WIDTH + 2) : 0;

  // Map from commit index → virtualizer start position, for strip positioning.
  const itemStartByIndex = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of virtualizer.getVirtualItems()) map.set(item.index, item.start);
    return map;
  }, [virtualizer.getVirtualItems()]);

  function toggleRepo(repoId: string) {
    setExpandedRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId); else next.add(repoId);
      return next;
    });
  }

  return (
    <div ref={parentRef} style={styles.container} onClick={() => setContextMenu(null)}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>

        {/* Repo label strips */}
        {multiRepo && repoBlocks.map((block) => {
          const topPx = itemStartByIndex.get(block.startRow) ?? block.startRow * ROW_HEIGHT;
          const lastRowStart = itemStartByIndex.get(block.startRow + block.rowCount - 1) ?? ((block.startRow + block.rowCount - 1) * ROW_HEIGHT);
          const heightPx = lastRowStart + ROW_HEIGHT - topPx;
          const expanded = expandedRepos.has(block.repoId);
          return (
            <div
              key={`strip-${block.repoId}-${block.startRow}`}
              style={styles.repoStrip(topPx, heightPx, block.color, expanded)}
              onClick={() => toggleRepo(block.repoId)}
              title={block.name}
            >
              <span style={styles.repoStripBar(block.color)} />
              {expanded && (
                <span style={styles.repoStripName}>{block.name}</span>
              )}
            </div>
          );
        })}

        {/* Commit rows (virtual) */}
        {items.map((vrow) => {
          const commit = commits[vrow.index];
          if (!commit) return null;
          const isSelected = commit.hash === selectedHash;
          const isMultiSelected = multiSelectHashes.has(commit.hash);

          return (
            <div
              key={commit.hash}
              style={styles.row(vrow.start, isSelected, isMultiSelected)}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  setMultiSelectHashes(prev => {
                    const next = new Set(prev);
                    // If starting a new multi-select, auto-include the currently single-selected commit
                    if (next.size === 0 && selectedHash && selectedHash !== commit.hash) {
                      next.add(selectedHash);
                    }
                    if (next.has(commit.hash)) next.delete(commit.hash); else next.add(commit.hash);
                    return next;
                  });
                } else {
                  setMultiSelectHashes(new Set());
                  onSelect(commit);
                }
              }}
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                const isInMulti = multiSelectHashes.has(commit.hash) && multiSelectHashes.size > 1;
                const multiSelected = isInMulti
                  ? commits.filter(c => multiSelectHashes.has(c.hash))
                  : [];
                setContextMenu({ commit, x: e.clientX, y: e.clientY, multiSelected });
              }}
              title={`${commit.hash}\n${commit.authorName} <${commit.authorEmail}>\n${commit.authorDate}`}
            >
              {labelColWidth > 0 && <div style={{ width: labelColWidth, flexShrink: 0 }} />}

              <CommitRowSvg
                commit={commit}
                isSelected={isSelected}
                prevCommit={vrow.index > 0 ? commits[vrow.index - 1] : null}
                nextCommit={vrow.index < commits.length - 1 ? commits[vrow.index + 1] : null}
                index={vrow.index}
                totalCommits={commits.length}
              />

              {commit.refs.length > 0 && (
                <div style={styles.refs}>
                  {mergeLocalRemote(groupRefs(commit.refs)).slice(0, 4).map(group => {
                    const color = branchColor(group.label);
                    return (
                      <span key={group.key} style={styles.refBadge(color, group.isTag)} title={badgeTitle(group)}>
                        <RefBadgeIcon group={group} />
                        <span style={styles.refBadgeLabel}>
                          {group.isLocal && group.isRemote ? `origin & ${group.label}` : group.isRemote ? `origin/${group.label}` : group.label}
                        </span>
                      </span>
                    );
                  })}
                </div>
              )}
              <div style={styles.info}>
                <span style={styles.message}>{commit.message}</span>
              </div>

              <div style={styles.meta}>
                {commit.unpushed && (
                  <Codicon name="arrow-up" style={styles.unpushedIcon} title="Not pushed" />
                )}
                <AuthorAvatar authorName={commit.authorName} authorEmail={commit.authorEmail} size={20} />
                <span style={styles.author}>{commit.authorName}</span>
                <span style={styles.date}>{formatDateTime(commit.authorDate)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {loading && commits.length > 0 && (
        <div style={styles.loading}>Loading more commits...</div>
      )}

      {contextMenu && (
        <CommitContextMenu
          commit={contextMenu.commit}
          x={contextMenu.x}
          y={contextMenu.y}
          multiSelected={contextMenu.multiSelected}
          allCommits={commits}
          currentBranchByRepo={currentBranchByRepo}
          onClose={() => setContextMenu(null)}
          onSquash={(selected) => {
            setContextMenu(null);
            let maxIdx = -1;
            let oldestHash = selected[0].hash;
            for (const c of selected) {
              const idx = commits.findIndex(x => x.hash === c.hash);
              if (idx > maxIdx) { maxIdx = idx; oldestHash = c.hash; }
            }
            getVsCodeApi().postMessage({
              type: 'LOG_SQUASH_COMMITS',
              requestId: generateId(),
              repoId: selected[0].repoId,
              hashes: selected.map(c => c.hash),
              oldestHash,
              message: selected.map(c => c.message).join('\n\n'),
            } satisfies LogToHostMsg);
            setMultiSelectHashes(new Set());
          }}
        />
      )}
    </div>
  );
}

function CommitContextMenu({ commit, x, y, multiSelected, allCommits, currentBranchByRepo, onClose, onSquash }: {
  commit: LaidOutCommit;
  x: number;
  y: number;
  multiSelected: LaidOutCommit[];
  allCommits: LaidOutCommit[];
  currentBranchByRepo: Record<string, string>;
  onClose: () => void;
  onSquash: (selected: LaidOutCommit[]) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Tags from commit refs (format "tag: <name>")
  const tagsFromRefs = commit.refs
    .filter(r => r.startsWith('tag: '))
    .map(r => r.replace('tag: ', ''));

  // Clamp menu position so it stays within the viewport (useLayoutEffect avoids flash)
  const [menuPos, setMenuPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = rect.right > vw ? Math.max(0, x - (rect.right - vw) - 4) : x;
    const top = rect.bottom > vh ? Math.max(0, y - (rect.bottom - vh) - 4) : y;
    if (left !== x || top !== y) setMenuPos({ left, top });
  }, []);

  const isMulti = multiSelected.length > 1 && multiSelected.every(c => c.repoId === multiSelected[0].repoId);
  const allUnpushed = isMulti && multiSelected.every(c => c.unpushed);
  // HEAD for this repo = the first commit in allCommits with the same repoId
  const isHead = allCommits.find(c => c.repoId === commit.repoId)?.hash === commit.hash;

  function send(msg: LogToHostMsg) {
    getVsCodeApi().postMessage(msg);
    onClose();
  }

  function copyHash() {
    navigator.clipboard.writeText(commit.hash).catch(() => {});
    onClose();
  }

  // Build index map once for sorting (higher index = older commit in log)
  const indexMap = new Map<string, number>();
  allCommits.forEach((c, i) => indexMap.set(c.hash, i));
  const sortedOldestFirst = [...multiSelected].sort((a, b) => (indexMap.get(b.hash) ?? 0) - (indexMap.get(a.hash) ?? 0));
  const sortedNewestFirst = [...multiSelected].sort((a, b) => (indexMap.get(a.hash) ?? 0) - (indexMap.get(b.hash) ?? 0));

  const repoId = isMulti ? multiSelected[0].repoId : commit.repoId;
  const oldestHash = sortedOldestFirst[0]?.hash ?? commit.hash;

  if (isMulti) {
    return (
      <>
        <div style={ctxStyles.backdrop} onClick={onClose} />
        <div ref={menuRef} style={ctxStyles.menu(menuPos.left, menuPos.top)}>
          <div style={ctxStyles.header}>{multiSelected.length} commits selected</div>
          <div style={ctxStyles.separator} />
          <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_PATCH_MULTI', requestId: generateId(), repoId, hashes: multiSelected.map(c => c.hash) })}>
            <Codicon name="diff" style={ctxStyles.icon} />
            <span>Create Patch...</span>
          </div>
          <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHERRY_PICK_MULTI', requestId: generateId(), repoId, hashes: sortedOldestFirst.map(c => c.hash) })}>
            <Codicon name="git-commit" style={ctxStyles.icon} />
            <span>Cherry-Pick All</span>
          </div>
          <div style={ctxStyles.separator} />
          <div style={ctxStyles.itemDisabled}>
            <Codicon name="history" style={ctxStyles.icon} />
            <span>Reset Current Branch to Here</span>
          </div>
          <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_REVERT_COMMITS', requestId: generateId(), repoId, hashes: sortedNewestFirst.map(c => c.hash) })}>
            <Codicon name="discard" style={ctxStyles.icon} />
            <span>Revert Commits</span>
          </div>
          {allUnpushed && (
            <>
              <div style={ctxStyles.separator} />
              <div
                style={{ ...ctxStyles.item, color: 'var(--vscode-errorForeground)' }}
                onClick={() => send({ type: 'LOG_DROP_COMMITS', requestId: generateId(), repoId, hashes: multiSelected.map(c => c.hash), oldestHash })}
              >
                <Codicon name="trash" style={ctxStyles.icon} />
                <span>Drop Commits</span>
              </div>
              <div style={ctxStyles.item} onClick={() => onSquash(multiSelected)}>
                <Codicon name="fold-down" style={ctxStyles.icon} />
                <span>Squash {multiSelected.length} Commits...</span>
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div style={ctxStyles.backdrop} onClick={onClose} />
      <div ref={menuRef} style={ctxStyles.menu(menuPos.left, menuPos.top)}>
        <div style={ctxStyles.item} onClick={copyHash}>
          <Codicon name="copy" style={ctxStyles.icon} />
          <span>Copy Revision Number</span>
        </div>
        <div style={ctxStyles.separator} />
        <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_NEW_BRANCH_FROM_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          <Codicon name="git-branch" style={ctxStyles.icon} />
          <span>New Branch...</span>
        </div>
        {tagsFromRefs.length === 0 ? (
          <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_TAG', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
            <Codicon name="tag" style={ctxStyles.icon} />
            <span>New Tag...</span>
          </div>
        ) : (
          <div
            style={ctxStyles.item}
            onClick={() => {
              const currentBranch = currentBranchByRepo[commit.repoId] ?? '';
              send({ type: 'LOG_MANAGE_COMMIT_TAGS', repoId: commit.repoId, hash: commit.hash, currentBranch } satisfies LogToHostMsg);
            }}
          >
            <Codicon name="tag" style={ctxStyles.icon} />
            <span>Manage Tags...</span>
          </div>
        )}
        <div style={ctxStyles.separator} />
        <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_PATCH', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          <Codicon name="diff" style={ctxStyles.icon} />
          <span>Create Patch...</span>
        </div>
        <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHERRY_PICK', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          <Codicon name="git-commit" style={ctxStyles.icon} />
          <span>Cherry-Pick</span>
        </div>
        <div style={ctxStyles.separator} />
        <div
          style={ctxStyles.item}
          onClick={() => send({ type: 'LOG_RESET_TO_PICK', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg)}
        >
          <Codicon name="history" style={ctxStyles.icon} />
          <span>Reset Current Branch to Here...</span>
        </div>
        <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_REVERT_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          <Codicon name="discard" style={ctxStyles.icon} />
          <span>Revert Commit</span>
        </div>
        {commit.unpushed && isHead && (
          <>
            <div style={ctxStyles.separator} />
            <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_EDIT_COMMIT_MESSAGE', requestId: generateId(), repoId: commit.repoId, hash: commit.hash, currentMessage: commit.message })}>
              <Codicon name="edit" style={ctxStyles.icon} />
              <span>Edit Commit Message</span>
            </div>
            <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_UNDO_COMMIT', requestId: generateId(), repoId: commit.repoId })}>
              <Codicon name="arrow-left" style={ctxStyles.icon} />
              <span>Undo Commit</span>
            </div>
          </>
        )}
        {commit.unpushed && (
          <>
            <div style={ctxStyles.separator} />
            <div
              style={{ ...ctxStyles.item, color: 'var(--vscode-errorForeground)' }}
              onClick={() => send({ type: 'LOG_DROP_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}
            >
              <Codicon name="trash" style={ctxStyles.icon} />
              <span>Drop Commit</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}

const ctxStyles = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 200,
  },
  menu: (x: number, y: number): React.CSSProperties => ({
    position: 'fixed' as const,
    left: x,
    top: y,
    zIndex: 201,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border)',
    borderRadius: '4px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
    minWidth: '220px',
    padding: '4px 0',
    fontSize: '12px',
    userSelect: 'none' as const,
  }),
  header: {
    padding: '4px 12px',
    fontSize: '11px',
    opacity: 0.55,
    color: 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  item: {
    padding: '4px 12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as React.CSSProperties,
  itemDisabled: {
    padding: '4px 12px',
    cursor: 'default',
    color: 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    opacity: 0.35,
    pointerEvents: 'none' as const,
  } as React.CSSProperties,
  icon: {
    fontSize: '14px',
    flexShrink: 0,
    opacity: 0.8,
  } as React.CSSProperties,
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground)',
    margin: '4px 0',
  } as React.CSSProperties,
};

function mergeLocalRemote(groups: RefGroup[]): RefGroup[] {
  const merged: RefGroup[] = [];
  const seen = new Map<string, RefGroup>();
  for (const g of groups) {
    if (!g.isTag && seen.has(g.label)) {
      const existing = seen.get(g.label)!;
      const combined: RefGroup = { ...existing, isLocal: existing.isLocal || g.isLocal, isRemote: existing.isRemote || g.isRemote };
      seen.set(g.label, combined);
      const idx = merged.findIndex(x => x.key === existing.key);
      if (idx >= 0) merged[idx] = combined;
    } else {
      seen.set(g.label, g);
      merged.push(g);
    }
  }
  return merged;
}

function badgeTitle(group: RefGroup): string {
  if (group.isTag) return group.isDetached ? `Tag: ${group.label} (HEAD)` : `Tag: ${group.label}`;
  if (group.isLocal && group.isRemote) return `Local & remote: ${group.label}`;
  if (group.isRemote) return `Remote: origin/${group.label}`;
  return `Local: ${group.label}`;
}

function RefBadgeIcon({ group }: { group: RefGroup }) {
  const s: React.CSSProperties = { fontSize: '11px', flexShrink: 0, lineHeight: 1 };
  if (group.isTag) return <Codicon name="tag" style={s} />;
  if (group.isLocal && group.isRemote) return (
    <>
      <Codicon name="git-branch" style={s} />
      <Codicon name="cloud" style={{ ...s, opacity: 0.7 }} />
    </>
  );
  if (group.isRemote) return <Codicon name="cloud" style={s} />;
  if (group.isHead) return <Codicon name="git-branch" style={{ ...s, opacity: 1 }} />;
  return <Codicon name="git-branch" style={s} />;
}

function formatDateTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const y = date.getFullYear();
    const hh = date.getHours().toString().padStart(2, '0');
    const mm = date.getMinutes().toString().padStart(2, '0');
    return `${d}/${m}/${y} ${hh}:${mm}`;
  } catch { return dateStr; }
}

const styles = {
  container: {
    flex: 1,
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
    position: 'relative' as const,
    background: 'var(--vscode-editor-background)',
  },
  repoStrip: (top: number, height: number, color: string, expanded: boolean): React.CSSProperties => ({
    position: 'absolute',
    top,
    left: 0,
    width: expanded ? REPO_LABEL_WIDTH_EXPANDED : REPO_LABEL_WIDTH,
    height,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    cursor: 'pointer',
    zIndex: 3,
    userSelect: 'none' as const,
    overflow: 'hidden',
    borderRadius: expanded ? '0 3px 3px 0' : '0',
    background: expanded ? `${color}22` : 'transparent',
    border: expanded ? `1px solid ${color}55` : 'none',
    borderLeft: 'none',
    transition: 'width 0.15s ease, background 0.1s',
  }),
  repoStripBar: (color: string): React.CSSProperties => ({
    width: REPO_LABEL_WIDTH,
    minWidth: REPO_LABEL_WIDTH,
    height: '100%',
    background: color,
    opacity: 0.85,
    flexShrink: 0,
  }),
  repoStripName: {
    fontSize: '10px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--vscode-foreground)',
    opacity: 0.8,
    whiteSpace: 'nowrap' as const,
    padding: '0 6px',
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis' as const,
    lineHeight: `${ROW_HEIGHT}px`,
  } as React.CSSProperties,
  row: (top: number, selected: boolean, multiSelected = false): React.CSSProperties => ({
    position: 'absolute' as const,
    top,
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingRight: '8px',
    cursor: 'pointer',
    background: selected
      ? 'var(--vscode-list-activeSelectionBackground)'
      : multiSelected
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    fontSize: '12px',
    zIndex: 2,
  }),
  info: {
    flex: '1 2 0',
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    minWidth: '60px',
  },
  refs: {
    display: 'flex',
    gap: '3px',
    flexShrink: 0,
    alignItems: 'center',
  },
  refBadge: (color: string, isTag: boolean): React.CSSProperties => ({
    fontSize: '10px',
    padding: '0 6px',
    height: '16px',
    lineHeight: '16px',
    borderRadius: '3px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: isTag ? `${color}33` : `${color}33`,
    color,
    border: `1px solid ${color}88`,
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
    boxSizing: 'border-box' as const,
    fontWeight: 500,
  }),
  refBadgeLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  } as React.CSSProperties,
  message: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: '1 1 0',
    minWidth: 0,
  },
  meta: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    flexShrink: 1,
    maxWidth: '300px',
    minWidth: 0,
    fontSize: '11px',
    opacity: 0.65,
    overflow: 'hidden',
  },
  unpushedIcon: {
    fontSize: '12px',
    opacity: 0.75,
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
    flexShrink: 0,
  } as React.CSSProperties,
  author: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 1,
    minWidth: '40px',
  },
  date: {
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
    textAlign: 'right' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  loading: {
    padding: '8px',
    textAlign: 'center' as const,
    fontSize: '11px',
    opacity: 0.6,
    color: 'var(--vscode-foreground)',
  },
};
