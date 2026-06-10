import React from 'react';
import type { LaidOutCommit } from '../utils/graphLayout';
import { LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS } from '../utils/graphLayout';
import { anonymousLaneColor } from '../utils/refs';

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

const STROKE = 1.5;
const H = ROW_HEIGHT;
const cy = H / 2;

interface RowSvgProps {
  commit: LaidOutCommit;
  isSelected: boolean;
  prevCommit: LaidOutCommit | null;
  nextCommit: LaidOutCommit | null;
  index: number;
  totalCommits: number;
}

export const CommitRowSvg = React.memo(function CommitRowSvg({
  commit, isSelected,
}: RowSvgProps) {
  const lines = commit.graphLines ?? [];
  const dotLane = commit.lane ?? 0;
  const dotColor = commit.dotColor ?? anonymousLaneColor(dotLane);

  const activeLanes = lines.reduce(
    (m, l) => Math.max(m, l.fromLane + 1, l.toLane + 1),
    dotLane + 1
  );
  const svgWidth = activeLanes * LANE_WIDTH + 4;

  const dotX = laneX(dotLane);

  const segments: React.ReactNode[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const color = line.color ?? anonymousLaneColor(line.fromLane);

    if (line.type === 'pass-through') {
      const x = laneX(line.fromLane);
      segments.push(
        <line key={idx} x1={x} y1={0} x2={x} y2={H}
          stroke={color} strokeWidth={STROKE} />
      );

    } else if (line.type === 'straight') {
      const fromX = laneX(line.fromLane);
      const toX = laneX(line.toLane);

      if (!line.isStart) {
        segments.push(
          <line key={`${idx}u`} x1={fromX} y1={0} x2={fromX} y2={cy}
            stroke={color} strokeWidth={STROKE} />
        );
      }
      if (commit.parents.length > 0) {
        if (fromX === toX) {
          segments.push(
            <line key={`${idx}d`} x1={fromX} y1={cy} x2={toX} y2={H}
              stroke={color} strokeWidth={STROKE} />
          );
        } else {
          segments.push(
            <path key={`${idx}d`} d={bezier(fromX, cy, toX, H)}
              stroke={color} strokeWidth={STROKE} fill="none" />
          );
        }
      }

    } else if (line.type === 'merge-in') {
      const outerX = laneX(line.toLane);

      if (dotX === outerX) {
        segments.push(
          <line key={`${idx}d`} x1={dotX} y1={cy} x2={outerX} y2={H}
            stroke={color} strokeWidth={STROKE} />
        );
      } else {
        segments.push(
          <path key={`${idx}d`} d={bezier(dotX, cy, outerX, H)}
            stroke={color} strokeWidth={STROKE} fill="none" />
        );
      }
    }
  }

  const r = isSelected ? DOT_RADIUS + 1 : DOT_RADIUS;
  const isMerge = commit.parents.length > 1;
  // Merge commits get an outer ring; the halo must be wide enough to clear it.
  const haloR = isMerge ? r + 4.5 : r + 2.5;

  return (
    <svg width={svgWidth} height={H}
      style={{ display: 'block', flexShrink: 0, overflow: 'visible' }}>
      {segments}
      {/* Halo — clears lines behind the dot and ring */}
      <circle cx={dotX} cy={cy} r={haloR}
        fill="var(--vscode-editor-background)" />
      {/* Outer ring for merge commits */}
      {isMerge && (
        <circle cx={dotX} cy={cy} r={r + 3}
          fill="none"
          stroke={isSelected ? '#ffffff' : dotColor}
          strokeWidth={1.5}
          strokeOpacity={0.6}
        />
      )}
      {/* Commit dot */}
      <circle cx={dotX} cy={cy} r={r}
        fill={isSelected ? '#ffffff' : dotColor}
        stroke={isSelected ? dotColor : 'var(--vscode-editor-background)'}
        strokeWidth={isSelected ? 2 : 1}
      />
    </svg>
  );
});

function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}
