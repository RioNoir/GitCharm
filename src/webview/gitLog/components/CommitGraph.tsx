import React from 'react';
import type { LaidOutCommit, Segment } from '../utils/graphLayout';
import { LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS, laneX } from '../utils/graphLayout';
import { anonymousLaneColor } from '../utils/refs';

export { laneX };

const STROKE = 1.5;
const D = ROW_HEIGHT * 0.8;

function colToX(col: number): number {
  return col * LANE_WIDTH + LANE_WIDTH / 2;
}

// ─── Overlay SVG ─────────────────────────────────────────────────────────────

interface GraphOverlayProps {
  segments: Segment[];
  visibleRows: Array<{ index: number; start: number }>;
  totalHeight: number;
  graphWidth: number;
  offsetX?: number;
}

export const GraphOverlay = React.memo(function GraphOverlay({
  segments, visibleRows, totalHeight, graphWidth, offsetX = 0,
}: GraphOverlayProps) {
  if (visibleRows.length === 0) return null;

  const firstVisible = visibleRows[0].index;
  const lastVisible = visibleRows[visibleRows.length - 1].index;

  const rowYMap = new Map<number, number>();
  for (const r of visibleRows) rowYMap.set(r.index, r.start + ROW_HEIGHT / 2);
  function getY(row: number): number {
    return rowYMap.get(row) ?? row * ROW_HEIGHT + ROW_HEIGHT / 2;
  }

  const branchPaths = new Map<number, { color: string; path: string; lastY: number; lastX: number }>();

  for (const s of segments) {
    if (s.p2y < firstVisible || s.p1y > lastVisible) continue;
    const x1 = colToX(s.p1x);
    const x2 = colToX(s.p2x);
    let entry = branchPaths.get(s.branchId);

    if (x1 === x2) {
      const y1 = getY(s.p1y);
      const y2 = getY(s.p2y);
      if (!entry) {
        entry = { color: s.color, path: `M${x1.toFixed(0)},${y1.toFixed(1)}`, lastY: y1, lastX: x1 };
        branchPaths.set(s.branchId, entry);
      } else if (entry.lastX !== x1 || entry.lastY !== y1) {
        entry.path += `M${x1.toFixed(0)},${y1.toFixed(1)}`;
      }
      entry.path += `L${x2.toFixed(0)},${y2.toFixed(1)}`;
      entry.lastX = x2; entry.lastY = y2;
    } else {
      for (let row = s.p1y; row < s.p2y; row++) {
        if (row + 1 < firstVisible || row > lastVisible) continue;
        const y1 = getY(row);
        const y2 = getY(row + 1);
        if (!entry) {
          entry = { color: s.color, path: `M${x1.toFixed(0)},${y1.toFixed(1)}`, lastY: y1, lastX: x1 };
          branchPaths.set(s.branchId, entry);
        } else if (entry.lastX !== x1 || entry.lastY !== y1) {
          entry.path += `M${x1.toFixed(0)},${y1.toFixed(1)}`;
        }
        entry.path += `C${x1.toFixed(0)},${(y1 + D).toFixed(1)} ${x2.toFixed(0)},${(y2 - D).toFixed(1)} ${x2.toFixed(0)},${y2.toFixed(1)}`;
        entry.lastX = x2; entry.lastY = y2;
      }
    }
  }

  const pathElements: React.ReactNode[] = [];
  let i = 0;
  for (const [, { color, path }] of branchPaths) {
    pathElements.push(<path key={i++} d={path} stroke={color} strokeWidth={STROKE} fill="none" />);
  }

  return (
    <svg width={graphWidth} height={totalHeight} style={{
      position: 'absolute', top: 0, left: offsetX,
      pointerEvents: 'none', overflow: 'visible', zIndex: 2,
    }}>
      {pathElements}
    </svg>
  );
});

// ─── Per-row dot + text mask ──────────────────────────────────────────────────

interface CommitDotProps {
  commit: LaidOutCommit;
  isSelected: boolean;
  graphWidth: number;
  offsetX?: number;
}

export const CommitDot = React.memo(function CommitDot({ commit, isSelected, graphWidth, offsetX = 0 }: CommitDotProps) {
  const dotCol = commit.lane ?? 0;
  const dotColor = commit.dotColor ?? anonymousLaneColor(dotCol);
  const dotX = laneX(dotCol);
  const cy = ROW_HEIGHT / 2;
  const r = isSelected ? DOT_RADIUS + 1 : DOT_RADIUS;
  const isMerge = commit.parents.length > 1;
  const haloR = isMerge ? r + 4.5 : r + 2.5;
  return (
    <svg
      width={graphWidth}
      height={ROW_HEIGHT}
      style={{ position: 'absolute', left: offsetX, top: 0, overflow: 'hidden', zIndex: 3, pointerEvents: 'none' }}
    >
      <circle cx={dotX} cy={cy} r={haloR} fill="var(--vscode-editor-background)" />
      {isMerge && (
        <circle cx={dotX} cy={cy} r={r + 3}
          fill="none"
          stroke={isSelected ? '#ffffff' : dotColor}
          strokeWidth={1.5} strokeOpacity={0.6}
        />
      )}
      <circle cx={dotX} cy={cy} r={r}
        fill={isSelected ? '#ffffff' : dotColor}
        stroke={isSelected ? dotColor : 'var(--vscode-editor-background)'}
        strokeWidth={isSelected ? 2 : 1}
      />
    </svg>
  );
});
