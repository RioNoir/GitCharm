import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LaidOutCommit, GraphLayout } from '../utils/graphLayout';
import { GraphOverlay, CommitDot, laneX } from './CommitGraph';
import { ROW_HEIGHT, LANE_WIDTH, getRowMaxX } from '../utils/graphLayout';
import type { RepoMeta } from '../../shared/types';
import { groupRefs, branchColor, tagColor, headColor } from '../utils/refs';
import type { RefGroup } from '../utils/refs';
import { Codicon } from '../../shared/Codicon';
import { getVsCodeApi } from '../../shared/vscodeApi';
import type { LogToHostMsg } from '../../../host/types/messages';
import { AuthorAvatar } from './AuthorAvatar';
import { formatDateTime } from '../../shared/dateUtils';


interface Props {
  layout: GraphLayout;
  selectedHash: string | null;
  repoColors: Record<string, string>;
  repos: RepoMeta[];
  currentBranchByRepo: Record<string, string>;
  headHashByRepo: Record<string, string>;
  onSelect: (commit: LaidOutCommit) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  storeHasMore: boolean;
  loading: boolean;
  backgroundLoading?: boolean;
  scrollToHash?: string | null;
  onScrolledToHash?: () => void;
  aiEnabled?: boolean;
  themeVersion?: number;
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

const BG_ANIM_STYLE = `
@keyframes gitcharm-bg-load {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(150%); }
  100% { transform: translateX(150%); }
}
@keyframes gitcharm-skeleton-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
`;

function CommitSkeleton() {
  const rows = Math.ceil(window.innerHeight / ROW_HEIGHT) + 2;
  return (
    <div style={skeletonStyles.container}>
      <style>{BG_ANIM_STYLE}</style>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={skeletonStyles.row(i, rows)}>
          <div style={skeletonStyles.graph} />
          <div style={skeletonStyles.message(i)} />
          <div style={skeletonStyles.meta} />
        </div>
      ))}
    </div>
  );
}

const SKELETON_MIN_MS = 400;

export function CommitList({ layout, selectedHash, repoColors, repos, currentBranchByRepo, headHashByRepo, onSelect, onLoadMore, hasMore, storeHasMore, loading, backgroundLoading, scrollToHash, onScrolledToHash, aiEnabled }: Props) {
  const { commits, segments, refColors } = layout;

  // graphWidth is stable: it only grows, never shrinks, so adding new commits
  // doesn't cause the existing rows to shift right.
  const graphWidthRef = useRef(0);
  const graphWidth = Math.max(graphWidthRef.current, layout.totalCols * LANE_WIDTH + 4);
  graphWidthRef.current = graphWidth;

  const parentRef = useRef<HTMLDivElement>(null);
  // Start as true — skeleton is always shown until commits arrive (handles first load correctly)
  const [showSkeleton, setShowSkeleton] = useState(true);
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (commits.length === 0 && (repos.length === 0 || !storeHasMore)) {
      // No repos, or server confirmed no commits (isLast=true with empty batch) — exit skeleton immediately
      if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current);
      setShowSkeleton(false);
      return;
    }
    if (commits.length === 0) {
      // Reset: show skeleton again (e.g. on reload/refresh)
      if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current);
      setShowSkeleton(true);
      shownSinceRef.current = Date.now();
    } else if (showSkeleton) {
      // Commits arrived — hide skeleton, but respect the minimum display time
      const elapsed = shownSinceRef.current ? Date.now() - shownSinceRef.current : SKELETON_MIN_MS;
      const remaining = Math.max(0, SKELETON_MIN_MS - elapsed);
      if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current);
      skeletonTimerRef.current = setTimeout(() => setShowSkeleton(false), remaining);
    }
    return () => { if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current); };
  }, [commits.length, repos.length, storeHasMore]);

  useEffect(() => {
    const id = 'gitcharm-log-action-btn-hover';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `[data-log-action-btn]:hover { background: var(--vscode-toolbar-hoverBackground) !important; opacity: 1 !important; }
[data-top-action-btn]:hover { background: var(--vscode-toolbar-hoverBackground) !important; opacity: 1 !important; }
[data-ctx-item]:hover { background: var(--vscode-menu-selectionBackground) !important; color: var(--vscode-menu-selectionForeground) !important; }`;
    document.head.appendChild(s);
  }, []);

  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ commit: LaidOutCommit; x: number; y: number; multiSelected: LaidOutCommit[] } | null>(null);
  const [popover, setPopover] = useState<{ commit: LaidOutCommit; rowTop: number; listRect: DOMRect; mouseX: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverHoveredRef = useRef(false);
  const closePopoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [multiSelectHashes, setMultiSelectHashes] = useState<Set<string>>(new Set());
  const [containerWidth, setContainerWidth] = useState<number>(9999);
  const containerRoRef = useRef<ResizeObserver | null>(null);

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

  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  const scrollRafRef = useRef<number | null>(null);

  // Attach scroll listener once via callback ref — avoids dependency on parentRef timing
  const scrollListenerRef = useRef<(() => void) | null>(null);
  const containerRefCb = useCallback((el: HTMLDivElement | null) => {
    if (containerRoRef.current) { containerRoRef.current.disconnect(); containerRoRef.current = null; }
    // Remove old scroll listener
    if (scrollListenerRef.current && (parentRef as React.MutableRefObject<HTMLDivElement | null>).current) {
      (parentRef as React.MutableRefObject<HTMLDivElement | null>).current!.removeEventListener('scroll', scrollListenerRef.current);
      scrollListenerRef.current = null;
    }
    (parentRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver(entries => {
      setContainerWidth(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    ro.observe(el);
    containerRoRef.current = ro;
    // Attach scroll listener directly on the element
    const listener = () => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 15;
        if (hasMoreRef.current && nearBottom) onLoadMoreRef.current();
      });
    };
    scrollListenerRef.current = listener;
    el.addEventListener('scroll', listener, { passive: true });
  }, []);

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
  const labelColWidth = multiRepo ? (anyExpanded ? REPO_LABEL_WIDTH_EXPANDED + 6 : REPO_LABEL_WIDTH + 8) : 0;

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

  if (showSkeleton) {
    return <CommitSkeleton />;
  }

  if (commits.length === 0 && !storeHasMore) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, alignSelf: 'stretch', height: '100%', gap: '8px', fontFamily: 'var(--vscode-font-family)', userSelect: 'none' }}>
        <Codicon name="git-commit" style={{ fontSize: '32px', opacity: 0.3, color: 'var(--vscode-foreground)' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--vscode-foreground)', opacity: 0.6 }}>No commits yet</span>
        <span style={{ fontSize: '12px', color: 'var(--vscode-foreground)', opacity: 0.4 }}>Make your first commit to see the history here</span>
      </div>
    );
  }

  return (
    <div style={styles.outerWrapper}>
    <div ref={containerRefCb} style={styles.container} onClick={() => { setContextMenu(null); setPopover(null); }}>
      <style>{BG_ANIM_STYLE}</style>
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

        {/* Graph overlay SVG — single SVG covering the entire virtual height */}
        <GraphOverlay
          segments={segments}
          visibleRows={items}
          totalHeight={virtualizer.getTotalSize()}
          graphWidth={graphWidth}
          offsetX={labelColWidth}
        />

        {/* Commit rows (virtual) */}
        {items.map((vrow) => {
          const commit = commits[vrow.index];
          if (!commit) return null;
          const isSelected = `${commit.hash}:${commit.repoId}` === selectedHash;
          const isCurrentHead = headHashByRepo[commit.repoId] === commit.hash;
          const isMultiSelected = multiSelectHashes.has(`${commit.hash}:${commit.repoId}`);
          const rowMaxX = Math.max(getRowMaxX(vrow.index, segments), laneX(commit.lane ?? 0));
          const rawTextStart = rowMaxX + LANE_WIDTH / 2 + 10;
          // Snap to the nearest LANE_WIDTH boundary so adjacent rows with near-identical
          // graph widths align rather than showing a few-pixel stagger.
          const textStart = Math.ceil(rawTextStart / LANE_WIDTH) * LANE_WIDTH + labelColWidth;

          return (
            <div
              key={commit.hash}
              style={{ ...styles.row(vrow.start, isSelected, isMultiSelected, hoveredIndex === vrow.index, !isSelected && contextMenu?.commit.hash === commit.hash && contextMenu?.commit.repoId === commit.repoId), paddingLeft: textStart }}
              onMouseEnter={(e) => {
                setHoveredIndex(vrow.index);
                if (closePopoverTimerRef.current) clearTimeout(closePopoverTimerRef.current);
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                // Don't restart the open-timer if popover for this commit is already showing
                if (popover?.commit.hash === commit.hash) return;
                setPopover(null);
                const rowEl = e.currentTarget as HTMLElement;
                const mouseX = e.clientX;
                hoverTimerRef.current = setTimeout(() => {
                  const rect = rowEl.getBoundingClientRect();
                  const listRect = parentRef.current!.getBoundingClientRect();
                  setPopover({ commit, rowTop: rect.top, listRect, mouseX });
                }, 1000);
              }}
              onMouseLeave={() => {
                setHoveredIndex(null);
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                // Delay closing so mouse can travel into the popover
                closePopoverTimerRef.current = setTimeout(() => {
                  if (!popoverHoveredRef.current) setPopover(null);
                }, 120);
              }}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  setMultiSelectHashes(prev => {
                    const next = new Set(prev);
                    const key = `${commit.hash}:${commit.repoId}`;
                    // If starting a new multi-select, auto-include the currently single-selected commit
                    if (next.size === 0 && selectedHash && selectedHash !== key) {
                      // Find selected commit to check stash type and repo compatibility
                      const selectedCommit = commits.find(c => `${c.hash}:${c.repoId}` === selectedHash);
                      if (selectedCommit && selectedCommit.isStash !== commit.isStash) return prev;
                      if (selectedCommit && selectedCommit.repoId !== commit.repoId) return prev;
                      next.add(selectedHash);
                    }
                    // Block mixing stashes and commits, or commits from different repos
                    if (next.size > 0) {
                      const existingCommit = commits.find(c => next.has(`${c.hash}:${c.repoId}`));
                      const existingIsStash = existingCommit?.isStash ?? false;
                      if (existingIsStash !== !!commit.isStash) return prev;
                      if (existingCommit && existingCommit.repoId !== commit.repoId) return prev;
                    }
                    if (next.has(key)) next.delete(key); else next.add(key);
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
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                setPopover(null);
                const key = `${commit.hash}:${commit.repoId}`;
                const isInMulti = multiSelectHashes.has(key) && multiSelectHashes.size > 1;
                const multiSelected = isInMulti
                  ? commits.filter(c => multiSelectHashes.has(`${c.hash}:${c.repoId}`))
                  : [];
                if (!isInMulti) setMultiSelectHashes(new Set());
                setContextMenu({ commit, x: e.clientX, y: e.clientY, multiSelected });
              }}
            >
              <CommitDot
                commit={commit}
                isSelected={isSelected}
                graphWidth={graphWidth}
                offsetX={labelColWidth}
              />

              {commit.refs.length > 0 && (() => {
                const allGroups = mergeLocalRemote(groupRefs(commit.refs));
                const headBranchGroup = allGroups.find(g => g.isHead && !g.isDetached);
                const remoteHeadGroup = allGroups.find(g => g.isRemoteHead);
                const headAndRemoteHead = headBranchGroup && remoteHeadGroup;
                const hc = headColor();

                // Build the flat badge list in display order:
                //   1. All branch/tag/remoteHead groups from mergeLocalRemote (unchanged order)
                //      — remoteHead is skipped only when it is absorbed into the HEAD badge
                //   2. A synthetic HEAD sentinel appended last (when HEAD branch exists)
                // The HEAD sentinel is a separate entry so the branch badge ("origin & main")
                // and the HEAD arrow badge are independent items in the MAX/overflow logic.
                const HEAD_SENTINEL = '__HEAD__' as const;
                type DisplayItem = RefGroup | '__HEAD__';
                const displayItems: DisplayItem[] = [
                  ...(headBranchGroup ? [HEAD_SENTINEL] : []),
                  ...allGroups.filter(g => !(headAndRemoteHead && g.isRemoteHead)),
                ];

                const refsSpace = containerWidth - labelColWidth - 340;
                const MAX = refsSpace < 80 ? 0 : refsSpace < 170 ? 1 : 2;
                const visible = displayItems.slice(0, MAX);
                const overflow = displayItems.slice(MAX);

                const renderBadge = (item: DisplayItem, key: string | number) => {
                  if (item === HEAD_SENTINEL) {
                    const title = headAndRemoteHead
                      ? `HEAD → ${headBranchGroup!.label} (${remoteHeadGroup!.remoteName}/HEAD)`
                      : `HEAD → ${headBranchGroup!.label}`;
                    return (
                      <span key={key} style={styles.refBadge(hc, false, true, isSelected)} title={title}>
                        {headAndRemoteHead
                          ? <Codicon name="milestone" style={{ fontSize: '11px', flexShrink: 0, lineHeight: 1 }} />
                          : <Codicon name="arrow-right" style={{ fontSize: '9px', flexShrink: 0, lineHeight: 1 }} />}
                        <span style={styles.refBadgeLabel}>{headAndRemoteHead ? `${remoteHeadGroup!.remoteName} & HEAD` : 'HEAD'}</span>
                      </span>
                    );
                  }
                  const color = badgeColor(item, commit.repoId, refColors);
                  return (
                    <span key={key} style={styles.refBadge(color, item.isTag, (item.isHead || item.isDetached) && !item.isRemoteHead, isSelected)} title={badgeTitle(item)}>
                      <RefBadgeIcon group={item} />
                      <span style={styles.refBadgeLabel}>
                        {item.isRemoteHead ? `${item.remoteName}/HEAD` : item.isLocal && item.isRemote ? `${item.remoteName || 'remote'} & ${item.label}` : item.isRemote ? remoteLabel(item) : item.label}
                      </span>
                    </span>
                  );
                };

                const overflowColor = (item: DisplayItem) => item === HEAD_SENTINEL ? hc : badgeColor(item as RefGroup, commit.repoId, refColors);

                return (
                  <div style={styles.refs}>
                    {visible.map((item, i) => renderBadge(item, i))}
                    {overflow.length > 0 && (() => {
                      const STEP = 4;
                      const layers = overflow.slice(0, 3).reverse();
                      const totalShift = layers.length * STEP;
                      const frontColor = overflowColor(overflow[0]);
                      return (
                        <span
                          style={{ ...styles.overflowWrapper, marginRight: totalShift }}
                          title={overflow.map(g => g === HEAD_SENTINEL ? `HEAD → ${headBranchGroup!.label}` : badgeTitle(g as RefGroup)).join('\n')}
                        >
                          {layers.map((g, i) => (
                            <span key={i} style={styles.overflowStackLayer(overflowColor(g), (layers.length - i) * STEP, isSelected)} />
                          ))}
                          <span style={styles.overflowLabel(frontColor, isSelected)}>{visible.length === 0 ? `${overflow.length}` : `+${overflow.length}`}</span>
                        </span>
                      );
                    })()}
                  </div>
                );
              })()}
              <div style={styles.info}>
                {commit.isStash && (
                  <span style={{ ...styles.refBadge(commit.dotColor, false, false, isSelected), marginRight: '4px' }}>
                    <Codicon name="archive" style={{ fontSize: '10px', flexShrink: 0, lineHeight: 1 }} />
                    <span style={styles.refBadgeLabel}>{commit.stashRef}</span>
                  </span>
                )}
                <span style={{ ...styles.message, ...(isCurrentHead ? { fontWeight: 700 } : {}), ...(commit.parents.length >= 2 ? { opacity: 0.5 } : {}) }}>{commit.message.split('\n')[0]}</span>
              </div>

              {hoveredIndex === vrow.index && (
                <div style={styles.inlineActions}>
                  <button
                    data-log-action-btn=""
                    style={styles.inlineActionBtn}
                    title="Open Commit Detail"
                    onClick={e => { e.stopPropagation(); getVsCodeApi().postMessage({ type: 'LOG_OPEN_EXTENDED_DETAIL', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg); }}
                  >
                    <Codicon name="open-preview" style={{ fontSize: '16px', lineHeight: 1 }} />
                  </button>
                  <button
                    data-log-action-btn=""
                    style={styles.inlineActionBtn}
                    title="Open Changes"
                    onClick={e => { e.stopPropagation(); getVsCodeApi().postMessage({ type: 'LOG_OPEN_COMMIT_CHANGES', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg); }}
                  >
                    <Codicon name="diff-multiple" style={{ fontSize: '16px', lineHeight: 1 }} />
                  </button>
                </div>
              )}
              {commit.incoming && (
                <Codicon name="arrow-down" style={styles.incomingIcon} title="Not pulled" />
              )}
              {commit.unpushed && (
                <Codicon name="arrow-up" style={styles.unpushedIcon} title="Not pushed" />
              )}
              <div style={styles.meta}>
                <AuthorAvatar authorName={commit.isStash ? 'You' : commit.authorName} authorEmail={commit.authorEmail} size={20} isYou={commit.isStash} />
                {containerWidth > 500 && <span style={styles.author}>{commit.isStash ? 'You' : formatAuthorName(commit.authorName)}</span>}
              </div>
              <span style={styles.date}>{formatDateTime(commit.authorDate)}</span>
            </div>
          );
        })}
      </div>

      {popover && (
        <CommitPopover
          commit={popover.commit}
          rowTop={popover.rowTop}
          listRect={popover.listRect}
          mouseX={popover.mouseX}
          onClose={() => setPopover(null)}
          popoverHoveredRef={popoverHoveredRef}
          closePopoverTimerRef={closePopoverTimerRef}
          refColors={refColors}
        />
      )}

      {contextMenu && (
        <CommitContextMenu
          commit={contextMenu.commit}
          x={contextMenu.x}
          y={contextMenu.y}
          multiSelected={contextMenu.multiSelected}
          allCommits={commits}
          currentBranchByRepo={currentBranchByRepo}
          headHashByRepo={headHashByRepo}
          aiEnabled={aiEnabled}
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
              commits: selected.map(c => ({ hash: c.hash, shortHash: c.hash.slice(0, 8), message: c.message })),
            } satisfies LogToHostMsg);
            setMultiSelectHashes(new Set());
          }}
        />
      )}
    </div>

    {(backgroundLoading || (hasMore && loading)) && (
      <div style={styles.bgLoadingBar}>
        <div style={styles.bgLoadingBarFill} />
      </div>
    )}
    </div>
  );
}

function CommitPopover({ commit, rowTop, listRect, mouseX, onClose, popoverHoveredRef, closePopoverTimerRef, refColors }: {
  commit: LaidOutCommit;
  rowTop: number;
  listRect: DOMRect;
  mouseX: number;
  onClose: () => void;
  popoverHoveredRef: React.MutableRefObject<boolean>;
  closePopoverTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  refColors?: Map<string, string>;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<{ files: number; added: number; removed: number } | null>(null);
  // null = measuring, object = positioned and visible
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Fetch file stats on mount
  useEffect(() => {
    const reqId = generateId();
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'LOG_COMMIT_FILES' && msg.requestId === reqId) {
        window.removeEventListener('message', handler);
        const files = msg.files as Array<{ added?: number; removed?: number }>;
        const added = files.reduce((s: number, f: { added?: number }) => s + (f.added ?? 0), 0);
        const removed = files.reduce((s: number, f: { removed?: number }) => s + (f.removed ?? 0), 0);
        setStats({ files: files.length, added, removed });
      }
    };
    window.addEventListener('message', handler);
    getVsCodeApi().postMessage({ type: 'LOG_REQUEST_COMMIT_FILES', requestId: reqId, repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg);
    return () => window.removeEventListener('message', handler);
  }, [commit.hash]);

  // Once stats arrive and the element is in the DOM (invisible), measure and position it
  useLayoutEffect(() => {
    if (!stats) return;
    const el = popoverRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    // Center on mouse X, clamped inside the list
    const left = Math.max(listRect.left, Math.min(listRect.right - w, mouseX - w / 2));
    // Prefer above the row; fall back to below if no room inside the list
    const preferTop = rowTop - h - 6;
    const top = preferTop >= listRect.top ? preferTop : rowTop + ROW_HEIGHT + 6;
    setPos({ top, left });
  }, [stats, rowTop, listRect, mouseX]);

  // Close on window blur
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [onClose]);

  // Reset hover flag on unmount
  useEffect(() => () => { popoverHoveredRef.current = false; }, []);

  // Don't render at all until stats are fetched
  if (!stats) return null;

  const refGroups = mergeLocalRemote(groupRefs(commit.refs));

  // Render invisible for measurement on first paint, visible once pos is computed
  const visible = pos !== null;

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        ...popoverStyles.container,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
      onMouseEnter={() => {
        popoverHoveredRef.current = true;
        if (closePopoverTimerRef.current) clearTimeout(closePopoverTimerRef.current);
      }}
      onMouseLeave={() => {
        popoverHoveredRef.current = false;
        onClose();
      }}
    >
      {/* Hash */}
      <div style={popoverStyles.row}>
        <Codicon name="git-commit" style={popoverStyles.icon} />
        <span style={popoverStyles.hash}>{commit.shortHash}</span>
      </div>

      {/* Author + date */}
      <div style={popoverStyles.row}>
        <AuthorAvatar authorName={commit.isStash ? 'You' : commit.authorName} authorEmail={commit.authorEmail} size={16} isYou={commit.isStash} />
        <span style={popoverStyles.author}>{commit.isStash ? 'You' : commit.authorName}</span>
        <span style={popoverStyles.dot}>·</span>
        <span style={popoverStyles.date}>{formatDateTime(commit.authorDate)}</span>
      </div>

      {/* File stats */}
      <div style={popoverStyles.row}>
        <Codicon name="diff" style={popoverStyles.icon} />
        <span style={popoverStyles.statText}>
          {stats.files} file{stats.files !== 1 ? 's' : ''} changed
        </span>
        {stats.added > 0 && <span style={popoverStyles.added}>+{stats.added}</span>}
        {stats.removed > 0 && <span style={popoverStyles.removed}>-{stats.removed}</span>}
      </div>

      {/* Ref badges */}
      {refGroups.length > 0 && (() => {
        const popoverHeadGroup = refGroups.find(g => g.isHead && !g.isDetached);
        const popoverRemoteHeadGroup = refGroups.find(g => g.isRemoteHead);
        const headAndRemoteHead = popoverHeadGroup && popoverRemoteHeadGroup;
        const displayGroups = headAndRemoteHead ? refGroups.filter(g => !g.isRemoteHead) : refGroups;
        const hc = headColor();
        return (
          <div style={popoverStyles.refs}>
            {popoverHeadGroup && (
              <span style={popoverStyles.badge(hc, true)} title={headAndRemoteHead ? `HEAD → ${popoverHeadGroup.label} (${popoverRemoteHeadGroup.remoteName}/HEAD)` : `HEAD → ${popoverHeadGroup.label}`}>
                {headAndRemoteHead
                  ? <Codicon name="milestone" style={{ fontSize: '11px', flexShrink: 0, lineHeight: 1 }} />
                  : <Codicon name="arrow-right" style={{ fontSize: '9px', flexShrink: 0, lineHeight: 1 }} />}
                <span style={popoverStyles.badgeLabel}>{headAndRemoteHead ? `${popoverRemoteHeadGroup.remoteName} & HEAD` : 'HEAD'}</span>
              </span>
            )}
            {displayGroups.map(group => {
              const color = badgeColor(group, commit.repoId, refColors);
              return (
                <span key={group.key} style={popoverStyles.badge(color, (group.isHead || group.isDetached) && !group.isRemoteHead)} title={badgeTitle(group)}>
                  <RefBadgeIcon group={group} />
                  <span style={popoverStyles.badgeLabel}>
                    {group.isRemoteHead ? `${group.remoteName}/HEAD` : group.isLocal && group.isRemote ? `${group.remoteName || 'remote'} & ${group.label}` : group.isRemote ? remoteLabel(group) : group.label}
                  </span>
                </span>
              );
            })}
          </div>
        );
      })()}

      <div style={popoverStyles.hint}>Click for more details</div>
    </div>,
    document.body
  );
}

const popoverStyles = {
  container: {
    position: 'fixed',
    zIndex: 1000,
    background: 'var(--vscode-editorWidget-background)',
    border: '1px solid var(--vscode-widget-border)',
    borderRadius: '6px',
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    minWidth: '260px',
    maxWidth: '420px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  } as React.CSSProperties,
  icon: {
    fontSize: '12px',
    opacity: 0.6,
    flexShrink: 0,
  } as React.CSSProperties,
  hash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontWeight: 600,
    fontSize: '12px',
    flexShrink: 0,
  } as React.CSSProperties,
  fullHash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '10px',
    opacity: 0.45,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  },
  author: {
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  dot: { opacity: 0.4, flexShrink: 0 } as React.CSSProperties,
  date: { opacity: 0.6, flexShrink: 0, fontSize: '11px' } as React.CSSProperties,
  statText: { opacity: 0.75 } as React.CSSProperties,
  added: {
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
    fontWeight: 600,
    fontSize: '11px',
    flexShrink: 0,
  } as React.CSSProperties,
  removed: {
    color: 'var(--vscode-gitDecoration-deletedResourceForeground)',
    fontWeight: 600,
    fontSize: '11px',
    flexShrink: 0,
  } as React.CSSProperties,
  refs: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '3px',
    marginTop: '1px',
  } as React.CSSProperties,
  badge: (color: string, isHead = false): React.CSSProperties => ({
    fontSize: '10px',
    padding: '0 5px',
    height: '16px',
    lineHeight: '16px',
    borderRadius: '3px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    maxWidth: '180px',
    overflow: 'hidden',
    flexShrink: 0,
    boxSizing: 'border-box' as const,
    fontWeight: isHead ? 700 : 500,
  }),
  badgeLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  } as React.CSSProperties,
  hint: {
    fontSize: '10px',
    opacity: 0.4,
    textAlign: 'center',
    marginTop: '2px',
  } as React.CSSProperties,
};

function CommitContextMenu({ commit, x, y, multiSelected, allCommits, currentBranchByRepo, headHashByRepo, aiEnabled, onClose, onSquash }: {
  commit: LaidOutCommit;
  x: number;
  y: number;
  multiSelected: LaidOutCommit[];
  allCommits: LaidOutCommit[];
  currentBranchByRepo: Record<string, string>;
  headHashByRepo: Record<string, string>;
  aiEnabled?: boolean;
  onClose: () => void;
  onSquash: (selected: LaidOutCommit[]) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Tags from commit refs (format "tag: <name>")
  const tagsFromRefs = commit.refs
    .filter(r => r.startsWith('tag: '))
    .map(r => r.replace('tag: ', ''));

  // Local branch names from commit refs (exclude tags, HEAD marker, remote refs)
  const localBranchesFromRefs = commit.refs
    .filter(r => !r.startsWith('tag: ') && r !== 'HEAD' && !r.includes('/'))
    .map(r => r.startsWith('HEAD -> ') ? r.slice('HEAD -> '.length) : r);
  // Remote-only branch names (origin/branchname → branchname), used as fallback
  const remoteBranchesFromRefs = commit.refs
    .filter(r => r.includes('/') && !r.startsWith('tag: '))
    .map(r => r.slice(r.indexOf('/') + 1));
  const branchesFromRefs = localBranchesFromRefs.length > 0 ? localBranchesFromRefs : remoteBranchesFromRefs;
  const primaryBranch = branchesFromRefs[0] ?? null;

  useEffect(() => {
    const onBlur = () => onClose();
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('blur', onBlur);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Smart repositioning: open upward if not enough space below; scroll as last resort
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; maxHeight?: number }>({ left: x, top: y });
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;
    const left = rect.right > vw ? Math.max(margin, x - (rect.right - vw) - margin) : x;
    let top = y;
    let maxHeight: number | undefined;
    if (y + rect.height + margin > vh) {
      const topIfUp = y - rect.height;
      if (topIfUp >= margin) {
        top = topIfUp;
      } else {
        top = margin;
        maxHeight = vh - margin * 2;
      }
    }
    setMenuPos({ left, top, maxHeight });
  }, []);

  const isMulti = multiSelected.length > 1 && multiSelected.every(c => c.repoId === multiSelected[0].repoId);
  const allUnpushed = isMulti && multiSelected.every(c => c.unpushed);
  const isHead = headHashByRepo[commit.repoId] === commit.hash;

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

  const hasStashInMulti = isMulti && multiSelected.some(c => c.isStash);
  const allStashInMulti = isMulti && multiSelected.every(c => c.isStash);

  if (isMulti) {
    return (
      <>
        <div style={ctxStyles.backdrop} onClick={onClose} />
        <div ref={menuRef} style={ctxStyles.menu(menuPos.left, menuPos.top, menuPos.maxHeight)}>
          <div style={ctxStyles.header}>{multiSelected.length} commits selected</div>
          <div style={ctxStyles.separator} />
          {!hasStashInMulti && (
            <>
              <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_VIEW_COMBINED_DIFF', repoId, hashes: multiSelected.map(c => c.hash) })}>
                <Codicon name="diff-multiple" style={ctxStyles.icon} />
                <span>View Combined Diff</span>
              </div>
              <div style={ctxStyles.separator} />
              <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_PATCH_MULTI', requestId: generateId(), repoId, hashes: multiSelected.map(c => c.hash) })}>
                <Codicon name="diff" style={ctxStyles.icon} />
                <span>Create Patch...</span>
              </div>
              <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHERRY_PICK_MULTI', requestId: generateId(), repoId, hashes: sortedOldestFirst.map(c => c.hash) })}>
                <Codicon name="git-commit" style={ctxStyles.icon} />
                <span>Cherry-Pick All</span>
              </div>
              <div style={ctxStyles.separator} />
              <div style={ctxStyles.itemDisabled}>
                <Codicon name="history" style={ctxStyles.icon} />
                <span>Reset Current Branch to Here</span>
              </div>
              <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_REVERT_COMMITS', requestId: generateId(), repoId, hashes: sortedNewestFirst.map(c => c.hash) })}>
                <Codicon name="discard" style={ctxStyles.icon} />
                <span>Revert Commits</span>
              </div>
              {allUnpushed && (
                <>
                  <div style={ctxStyles.separator} />
                  <div
                    data-ctx-item="" style={{ ...ctxStyles.item, color: 'var(--vscode-errorForeground)' }}
                    onClick={() => send({ type: 'LOG_DROP_COMMITS', requestId: generateId(), repoId, hashes: multiSelected.map(c => c.hash), oldestHash })}
                  >
                    <Codicon name="trash" style={ctxStyles.icon} />
                    <span>Drop Commits</span>
                  </div>
                  <div data-ctx-item="" style={ctxStyles.item} onClick={() => onSquash(multiSelected)}>
                    <Codicon name="fold-down" style={ctxStyles.icon} />
                    <span>Squash {multiSelected.length} Commits...</span>
                  </div>
                </>
              )}
            </>
          )}
          {hasStashInMulti && (
            <div style={{ ...ctxStyles.header, opacity: 0.45, fontSize: '11px' }}>
              Mixed selection — no actions available
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div style={ctxStyles.backdrop} onClick={onClose} />
      <div ref={menuRef} style={ctxStyles.menu(menuPos.left, menuPos.top, menuPos.maxHeight)}>
        <div data-ctx-item="" style={ctxStyles.item} onClick={copyHash}>
          <Codicon name="copy" style={ctxStyles.icon} />
          <span>Copy Revision Number</span>
        </div>
        <div style={ctxStyles.separator} />
        <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_OPEN_EXTENDED_DETAIL', repoId: commit.repoId, hash: commit.hash })}>
          <Codicon name="open-preview" style={ctxStyles.icon} />
          <span>Open Full Detail</span>
        </div>
        <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_OPEN_COMMIT_CHANGES', repoId: commit.repoId, hash: commit.hash })}>
          <Codicon name="diff-multiple" style={ctxStyles.icon} />
          <span>Open Changes</span>
        </div>
        {!commit.isStash && (
          <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_COMPARE_COMMIT_WITH', repoId: commit.repoId, hash: commit.hash })}>
            <Codicon name="git-compare" style={ctxStyles.icon} />
            <span>Compare with…</span>
          </div>
        )}
        {aiEnabled && (
          <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_EXPLAIN_COMMIT', repoId: commit.repoId, hash: commit.hash })}>
            <Codicon name="sparkle" style={ctxStyles.icon} />
            <span>Explain with AI</span>
          </div>
        )}
        {commit.isStash ? (
          <>
            <div style={ctxStyles.separator} />
            <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_STASH_POP', requestId: generateId(), repoId: commit.repoId, stashRef: commit.hash })}>
              <Codicon name="git-stash-pop" style={ctxStyles.icon} />
              <span>Pop Stash</span>
            </div>
            <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_STASH_APPLY', requestId: generateId(), repoId: commit.repoId, stashRef: commit.hash })}>
              <Codicon name="git-stash-apply" style={ctxStyles.icon} />
              <span>Apply Stash</span>
            </div>
            <div style={ctxStyles.separator} />
            <div
              data-ctx-item="" style={{ ...ctxStyles.item, color: 'var(--vscode-errorForeground)' }}
              onClick={() => send({ type: 'LOG_STASH_DROP', requestId: generateId(), repoId: commit.repoId, stashRef: commit.hash })}
            >
              <Codicon name="trash" style={ctxStyles.icon} />
              <span>Delete Stash</span>
            </div>
          </>
        ) : (
          <>
            <div style={ctxStyles.separator} />
            <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_NEW_BRANCH_FROM_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
              <Codicon name="git-branch" style={ctxStyles.icon} />
              <span>New Branch...</span>
            </div>
            {tagsFromRefs.length === 0 ? (
              <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_TAG', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
                <Codicon name="tag" style={ctxStyles.icon} />
                <span>New Tag...</span>
              </div>
            ) : (
              <div
                data-ctx-item=""
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
            {primaryBranch ? (
              <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHECKOUT_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash, branchName: primaryBranch })}>
                <Codicon name="arrow-right" style={ctxStyles.icon} />
                <span>Checkout...</span>
              </div>
            ) : (
              <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHECKOUT_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
                <Codicon name="arrow-right" style={ctxStyles.icon} />
                <span>Checkout Revision</span>
              </div>
            )}
            {primaryBranch && (
              <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_SHOW_BRANCH_OPTIONS', repoId: commit.repoId, branchName: primaryBranch })}>
                <Codicon name="git-branch" style={ctxStyles.icon} />
                <span>Branch options...</span>
              </div>
            )}
            <div style={ctxStyles.separator} />
            <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_PATCH', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
              <Codicon name="diff" style={ctxStyles.icon} />
              <span>Create Patch...</span>
            </div>
            <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHERRY_PICK', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
              <Codicon name="git-commit" style={ctxStyles.icon} />
              <span>Cherry-Pick</span>
            </div>
            <div style={ctxStyles.separator} />
            <div
              data-ctx-item=""
              style={ctxStyles.item}
              onClick={() => send({ type: 'LOG_RESET_TO_PICK', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg)}
            >
              <Codicon name="history" style={ctxStyles.icon} />
              <span>Reset Current Branch to Here...</span>
            </div>
            <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_REVERT_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
              <Codicon name="discard" style={ctxStyles.icon} />
              <span>Revert Commit</span>
            </div>
            {commit.unpushed && isHead && (
              <>
                <div style={ctxStyles.separator} />
                <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_EDIT_COMMIT_MESSAGE', requestId: generateId(), repoId: commit.repoId, hash: commit.hash, currentMessage: commit.message })}>
                  <Codicon name="edit" style={ctxStyles.icon} />
                  <span>Edit Commit Message</span>
                </div>
                <div data-ctx-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_UNDO_COMMIT', requestId: generateId(), repoId: commit.repoId })}>
                  <Codicon name="arrow-left" style={ctxStyles.icon} />
                  <span>Undo Commit</span>
                </div>
              </>
            )}
            {commit.unpushed && (
              <>
                <div style={ctxStyles.separator} />
                <div
                  data-ctx-item="" style={{ ...ctxStyles.item, color: 'var(--vscode-errorForeground)' }}
                  onClick={() => send({ type: 'LOG_DROP_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}
                >
                  <Codicon name="trash" style={ctxStyles.icon} />
                  <span>Drop Commit</span>
                </div>
              </>
            )}
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
  menu: (x: number, y: number, maxHeight?: number): React.CSSProperties => ({
    position: 'fixed' as const,
    left: x,
    top: y,
    zIndex: 201,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border)',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    minWidth: '220px',
    padding: '4px 0',
    fontSize: '12px',
    userSelect: 'none' as const,
    ...(maxHeight ? { maxHeight, overflowY: 'auto' as const } : {}),
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
    if (!g.isTag && !g.isRemoteHead && !g.isDetached && seen.has(g.label)) {
      const existing = seen.get(g.label)!;
      const combined: RefGroup = { ...existing, isLocal: existing.isLocal || g.isLocal, isRemote: existing.isRemote || g.isRemote, remoteName: existing.remoteName || g.remoteName };
      seen.set(g.label, combined);
      const idx = merged.findIndex(x => x.key === existing.key);
      if (idx >= 0) merged[idx] = combined;
    } else {
      seen.set(g.label, g);
      merged.push(g);
    }
  }
  // Order: detached HEAD, local branches, remote branches, tags, origin/HEAD last
  merged.sort((a, b) => {
    const rank = (g: RefGroup): number => {
      if (g.isDetached) return 0;
      if (g.isRemoteHead) return 4;
      if (g.isTag) return 3;
      if (g.isRemote) return 2;
      return 1; // local (including isHead branch)
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label);
  });
  return merged;
}

function formatAuthorName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function remoteLabel(group: RefGroup): string {
  const r = group.remoteName || 'remote';
  return `${r}/${group.label}`;
}

function badgeTitle(group: RefGroup): string {
  if (group.isRemoteHead) return `Remote HEAD (${group.remoteName}/HEAD)`;
  if (group.isDetached && group.isHead) return 'HEAD (detached)';
  if (group.isTag) return group.isDetached ? `Tag: ${group.label} (HEAD)` : `Tag: ${group.label}`;
  if (group.isLocal && group.isRemote) return `Local & remote: ${group.label}`;
  if (group.isRemote) return `Remote: ${remoteLabel(group)}`;
  return `Local: ${group.label}`;
}

function badgeColor(group: RefGroup, repoId: string, refColors?: Map<string, string>): string {
  if (group.isRemoteHead || (group.isHead && group.isDetached)) return headColor();
  if (group.isTag) return tagColor();
  if (refColors && repoId) {
    // Remote badge: look up "origin/beta" key first, fall back to bare "beta"
    // Local badge: look up "beta" directly
    const remoteKey = group.remoteName ? `${repoId}:${group.remoteName}/${group.label}` : null;
    const localKey  = `${repoId}:${group.label}`;
    const c = (remoteKey ? refColors.get(remoteKey) : undefined) ?? refColors.get(localKey);
    if (c) return c;
  }
  return branchColor(group.label, false);
}

function RefBadgeIcon({ group }: { group: RefGroup }) {
  const s: React.CSSProperties = { fontSize: '11px', flexShrink: 0, lineHeight: 1 };
  if (group.isRemoteHead) return <Codicon name="milestone" style={s} />;
  if (group.isDetached && group.isHead) return <Codicon name="warning" style={s} />;
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


const skeletonStyles = {
  container: {
    flex: 1,
    minHeight: 0,
    overflowY: 'hidden' as const,
    overflowX: 'hidden' as const,
    background: 'var(--vscode-editor-background)',
    display: 'flex',
    flexDirection: 'column' as const,
    alignSelf: 'stretch' as const,
  },
  row: (i: number, total: number): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: ROW_HEIGHT,
    paddingRight: '8px',
    flexShrink: 0,
    opacity: 1 - i * (0.6 / total),
    animation: `gitcharm-skeleton-pulse 1.8s ease-in-out ${(i * 0.04).toFixed(2)}s infinite`,
  }),
  graph: {
    width: 24,
    height: 12,
    borderRadius: 6,
    background: 'var(--vscode-editor-foreground)',
    opacity: 0.1,
    flexShrink: 0,
  } as React.CSSProperties,
  message: (i: number): React.CSSProperties => ({
    flex: 1,
    height: 10,
    borderRadius: 5,
    background: 'var(--vscode-editor-foreground)',
    opacity: 0.08,
    maxWidth: `${55 + ((i * 37) % 30)}%`,
  }),
  meta: {
    width: 120,
    height: 10,
    borderRadius: 5,
    background: 'var(--vscode-editor-foreground)',
    opacity: 0.06,
    flexShrink: 0,
  } as React.CSSProperties,
};

const styles = {
  outerWrapper: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column' as const,
  },
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
  row: (top: number, selected: boolean, multiSelected = false, hovered = false, ctxActive = false): React.CSSProperties => ({
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
      : ctxActive
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : hovered
      ? 'var(--vscode-list-hoverBackground)'
      : 'var(--vscode-editor-background)',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    fontSize: '12px',
  }),
  refsMeasureRow: (labelColWidth: number): React.CSSProperties => ({
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingRight: '8px',
    left: labelColWidth,
    right: 0,
    height: 0,
    overflow: 'hidden',
  }),
  refsMeasureFixed: {
    // Represents graph SVG + meta columns — fixed placeholder so refs gets compressed realistically.
    // 60px graph estimate + 180px meta estimate + some gap.
    flex: '1 3 0',
    minWidth: '300px',
    maxWidth: '500px',
  } as React.CSSProperties,
  info: {
    flex: '1 1 auto',
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    minWidth: '60px',
  },
  refs: {
    display: 'flex',
    gap: '3px',
    flex: '0 0 auto',
    alignItems: 'center',
  },
  refBadge: (color: string, isTag: boolean, isHead = false, isRowSelected = false): React.CSSProperties => ({
    fontSize: '10px',
    padding: '0 6px',
    height: '16px',
    lineHeight: '16px',
    borderRadius: '3px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: isRowSelected ? color : `${color}33`,
    color: isRowSelected ? 'var(--vscode-editor-background)' : color,
    border: `1px solid ${isRowSelected ? color : `${color}88`}`,
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
    boxSizing: 'border-box' as const,
    fontWeight: isHead ? 700 : 500,
  }),
  refBadgeLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  } as React.CSSProperties,
  overflowWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    height: '16px',
    flexShrink: 0,
  } as React.CSSProperties,
  overflowStackLayer: (color: string, shift: number, isRowSelected = false): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    borderRadius: '3px',
    boxSizing: 'border-box',
    background: isRowSelected ? color : `${color}33`,
    border: `1px solid ${isRowSelected ? color : `${color}88`}`,
    transform: `translateX(${shift}px)`,
    opacity: isRowSelected ? 0.7 : 1,
  }),
  overflowLabel: (color: string, isRowSelected = false): React.CSSProperties => ({
    position: 'relative',
    fontSize: '10px',
    fontWeight: 600,
    height: '16px',
    lineHeight: '14px',
    borderRadius: '3px',
    border: `1px solid ${isRowSelected ? color : `${color}88`}`,
    background: isRowSelected ? color : `color-mix(in srgb, var(--vscode-editor-background) 75%, ${color})`,
    color: isRowSelected ? 'var(--vscode-editor-background)' : color,
    padding: '0 5px',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
  }),
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
    flex: '0 4 auto',
    maxWidth: '300px',
    minWidth: '20px',
    fontSize: '11px',
    opacity: 0.65,
    overflow: 'hidden',
    marginLeft: '8px',
  },
  incomingIcon: {
    fontSize: '12px',
    opacity: 0.75,
    color: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
    flexShrink: 0,
  } as React.CSSProperties,
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
    minWidth: 0,
  },
  date: {
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
    fontSize: '11px',
    opacity: 0.65,
    marginLeft: '8px',
  },
  inlineActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 0,
    marginLeft: '4px',
  } as React.CSSProperties,
  inlineActionBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: 0.7,
    padding: '2px 3px',
    borderRadius: '3px',
    display: 'flex',
    alignItems: 'center',
  } as React.CSSProperties,
  bgLoadingBar: {
    flexShrink: 0,
    height: 3,
    background: 'var(--vscode-editor-background)',
    overflow: 'hidden' as const,
  },
  bgLoadingBarFill: {
    height: '100%',
    width: '40%',
    background: 'var(--vscode-progressBar-background)',
    animation: 'gitcharm-bg-load 1.4s ease-in-out infinite',
  } as React.CSSProperties,
};
