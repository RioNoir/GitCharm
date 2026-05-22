import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react';
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

interface Props {
  commits: LaidOutCommit[];
  selectedHash: string | null;
  repoColors: Record<string, string>;
  repos: RepoMeta[];
  onSelect: (commit: LaidOutCommit) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
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

export function CommitList({ commits, selectedHash, repoColors, repos, onSelect, onLoadMore, hasMore, loading }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ commit: LaidOutCommit; x: number; y: number } | null>(null);

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

          return (
            <div
              key={commit.hash}
              style={styles.row(vrow.start, isSelected)}
              onClick={() => onSelect(commit)}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ commit, x: e.clientX, y: e.clientY }); }}
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
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function CommitContextMenu({ commit, x, y, onClose }: {
  commit: LaidOutCommit;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const [showResetSub, setShowResetSub] = useState(false);

  function send(msg: LogToHostMsg) {
    getVsCodeApi().postMessage(msg);
    onClose();
  }

  function copyHash() {
    navigator.clipboard.writeText(commit.hash).catch(() => {});
    onClose();
  }

  return (
    <>
      <div style={ctxStyles.backdrop} onClick={onClose} />
      <div style={ctxStyles.menu(x, y)}>
        <div style={ctxStyles.item} onClick={copyHash}>
          Copy Revision Number
        </div>
        <div style={ctxStyles.separator} />
        <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_PATCH', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          Create Patch...
        </div>
        <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHERRY_PICK', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          Cherry-Pick
        </div>
        <div style={ctxStyles.separator} />
        <div
          style={ctxStyles.itemWithArrow}
          onMouseEnter={() => setShowResetSub(true)}
          onMouseLeave={() => setShowResetSub(false)}
        >
          <span>Reset Current Branch to Here</span>
          <span style={ctxStyles.arrow}>▶</span>
          {showResetSub && (
            <div style={ctxStyles.submenu}>
              {(['soft', 'mixed', 'hard'] as const).map(mode => (
                <div
                  key={mode}
                  style={mode === 'hard' ? { ...ctxStyles.item, color: 'var(--vscode-errorForeground)' } : ctxStyles.item}
                  onClick={e => { e.stopPropagation(); send({ type: 'LOG_RESET_TO', requestId: generateId(), repoId: commit.repoId, hash: commit.hash, mode }); }}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={ctxStyles.item} onClick={() => send({ type: 'LOG_REVERT_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          Revert Commit
        </div>
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
    minWidth: '210px',
    padding: '4px 0',
    fontSize: '12px',
    userSelect: 'none' as const,
  }),
  item: {
    padding: '4px 12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  itemWithArrow: {
    padding: '4px 12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    position: 'relative' as const,
  } as React.CSSProperties,
  arrow: { fontSize: '9px', opacity: 0.6 } as React.CSSProperties,
  submenu: {
    position: 'absolute' as const,
    left: '100%',
    top: 0,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border)',
    borderRadius: '4px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
    minWidth: '100px',
    padding: '4px 0',
    zIndex: 202,
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
  if (group.isTag) return `Tag: ${group.label}`;
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
  row: (top: number, selected: boolean): React.CSSProperties => ({
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
    background: selected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    fontSize: '12px',
    zIndex: 2,
  }),
  info: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    minWidth: 0,
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
    flex: 1,
  },
  meta: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    flexShrink: 0,
    width: '220px',
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
    flexShrink: 0,
    width: '90px',
    marginLeft: 'auto',
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
