import type { CommitNode, GraphLine } from '../../shared/types';
import { branchColor, anonymousLaneColor } from './refs';
import { headColor, primaryBranchColor, currentPalette, branchPaletteIndex } from '../../shared/branchColors';
import { isPrimaryBranch } from '../../shared/branchUtils';

export const LANE_WIDTH = 20;
export const ROW_HEIGHT = 28;
export const DOT_RADIUS = 4;

export interface LaidOutCommit extends CommitNode {
  lane: number;
  totalLanes: number;
  graphLines: GraphLine[];
  dotColor: string;
}

// Extract the branch name that "owns" a commit from its refs array.
// Priority: HEAD → local branch → remote branch → tag.
// Returns null for commits with no refs (middle-of-branch commits).
function primaryRefName(refs: string[]): string | null {
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) return r.slice('HEAD -> '.length);
  }
  for (const r of refs) {
    if (!r.startsWith('HEAD') && !r.startsWith('tag: ') && !r.includes('/')) return r;
  }
  for (const r of refs) {
    if (!r.startsWith('HEAD') && !r.startsWith('tag: ') && r.includes('/')) return r;
  }
  for (const r of refs) {
    if (r.startsWith('tag: ')) return r.slice('tag: '.length);
  }
  return null;
}

// Returns true if this commit has a ref that is a primary branch (main/master/…).
function hasPrimaryBranchRef(refs: string[]): boolean {
  for (const r of refs) {
    let name = r;
    if (name.startsWith('HEAD -> ')) name = name.slice('HEAD -> '.length);
    else if (name === 'HEAD' || name.startsWith('tag: ')) continue;
    else if (name.includes('/')) name = name.slice(name.indexOf('/') + 1);
    if (isPrimaryBranch(name)) return true;
  }
  return false;
}

// Walk the first-parent chain from a starting commit, returning every hash.
function firstParentChain(startIdx: number, commits: CommitNode[], hashIndex: Map<string, number>): Set<string> {
  const chain = new Set<string>();
  let idx = startIdx;
  while (idx >= 0 && idx < commits.length) {
    const hash = commits[idx].hash;
    if (chain.has(hash)) break; // cycle guard
    chain.add(hash);
    const p0 = commits[idx].parents[0];
    if (!p0) break;
    idx = hashIndex.get(p0) ?? -1;
  }
  return chain;
}

// Circular distance between two palette indices.
function paletteDist(a: number, b: number, n: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, n - d);
}

// Given a preferred starting index and the set of palette indices already used
// by active lanes, return the index that:
//   1. Maximises the minimum circular distance from all used indices.
//   2. Breaks ties by preferring the index closest to `preferred` (stable naming).
function pickPaletteIndex(preferred: number, usedIndices: Set<number>): number {
  const palette = currentPalette();
  const n = palette.length;

  if (usedIndices.size === 0) return preferred;

  let bestIdx = preferred;
  let bestMinDist = -1;

  for (let i = 0; i < n; i++) {
    // Min distance from this candidate to any used index.
    let minDist = n;
    for (const u of usedIndices) {
      const d = paletteDist(i, u, n);
      if (d < minDist) minDist = d;
    }
    // Prefer: larger minDist first; same minDist → closer to preferred.
    if (
      minDist > bestMinDist ||
      (minDist === bestMinDist && paletteDist(i, preferred, n) < paletteDist(bestIdx, preferred, n))
    ) {
      bestMinDist = minDist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

export function assignLanes(commits: CommitNode[], isFiltered = false): LaidOutCommit[] {
  if (isFiltered) {
    const visibleHashes = new Set(commits.map(c => c.hash));
    commits = commits.map(c => ({
      ...c,
      parents: c.parents.filter(p => visibleHashes.has(p)),
    }));
  }

  // Build a hash→index lookup for chain walking.
  const hashIndex = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) hashIndex.set(commits[i].hash, i);

  // Identify the set of hashes that belong to the primary branch's first-parent
  // chain. These commits will be forced onto lane 0 when they are first seen,
  // overriding nextFreeLane() which would otherwise give lane 0 to whoever
  // happens to appear first in the list (e.g. a feature branch at HEAD).
  const primaryStartIdx = commits.findIndex(c => hasPrimaryBranchRef(c.refs));
  const primaryChain: Set<string> = primaryStartIdx >= 0
    ? firstParentChain(primaryStartIdx, commits, hashIndex)
    : new Set();

  // laneOf: parent-hash → lane index reserved by one of its children.
  const laneOf = new Map<string, number>();
  // laneNameOf: lane → branch name that "owns" this lane (for coloring).
  const laneNameOf = new Map<number, string | null>();
  // laneColorOf: lane → resolved color string.
  const laneColorOf = new Map<number, string>();
  // lanePaletteIdx: lane → palette index currently assigned to that lane.
  const lanePaletteIdx = new Map<number, number>();
  // occupied: lane indices that have an active "thread" going downward.
  const occupied = new Set<number>();
  const laidOut: LaidOutCommit[] = [];

  // Returns the set of palette indices currently in use by occupied lanes.
  function usedPaletteIndices(): Set<number> {
    const s = new Set<number>();
    for (const l of occupied) {
      const idx = lanePaletteIdx.get(l);
      if (idx !== undefined) s.add(idx);
    }
    return s;
  }

  // Assign a color to a lane, choosing the palette index that is maximally
  // distant from all currently occupied lanes' indices.
  // For named branches: preferred index comes from the branch name hash.
  // For anonymous lanes: preferred index is based on lane number.
  function assignLaneColor(lane: number, refName: string | null, isHeadCommit: boolean): void {
    const palette = currentPalette();

    // Fixed colors for primary and HEAD — not from palette.
    if (refName !== null) {
      const norm = refName.replace(/^[^/]+\//, '');
      if (isPrimaryBranch(norm)) {
        laneColorOf.set(lane, primaryBranchColor());
        // Use a virtual index outside palette range so it doesn't affect spacing.
        lanePaletteIdx.set(lane, -1);
        return;
      }
      if (isHeadCommit) {
        laneColorOf.set(lane, headColor());
        lanePaletteIdx.set(lane, -2);
        return;
      }
    }

    const preferred = refName !== null
      ? branchPaletteIndex(refName)
      : lane % palette.length;

    // Exclude this lane's own current index so it can shift if needed.
    const used = usedPaletteIndices();
    used.delete(lanePaletteIdx.get(lane) ?? -99);

    const chosen = pickPaletteIndex(preferred, used);
    lanePaletteIdx.set(lane, chosen);
    laneColorOf.set(lane, palette[chosen]);
  }

  function nextFreeLane(preferZero = false): number {
    if (preferZero && !occupied.has(0)) return 0;
    let i = 0;
    while (occupied.has(i)) i++;
    return i;
  }

  for (const commit of commits) {
    // ── Step 1: find this commit's lane ──────────────────────────────────────
    let lane: number;
    let isStart: boolean;

    if (laneOf.has(commit.hash)) {
      // This commit was already claimed by one of its children.
      lane = laneOf.get(commit.hash)!;
      isStart = false;
      laneOf.delete(commit.hash);
    } else {
      // New thread: pick lane 0 if this commit is on the primary chain and
      // lane 0 is free, otherwise pick the next available lane.
      const wantPrimary = primaryChain.has(commit.hash);
      lane = nextFreeLane(wantPrimary);
      isStart = true;
      occupied.add(lane);
    }

    // ── Assign / update branch name and color for this lane ──────────────────
    const refName = primaryRefName(commit.refs);
    const isHeadCommit = commit.refs.some(r => r.startsWith('HEAD -> ') || r === 'HEAD');
    if (isStart || refName !== null) {
      laneNameOf.set(lane, refName);
      assignLaneColor(lane, refName, isHeadCommit);
    }

    // ── Step 2: snapshot lanes active *entering* this row ────────────────────
    const enteringLanes = new Set(occupied);

    // ── Step 3: assign lanes to parents ──────────────────────────────────────
    const parentLanes: number[] = [];

    for (let i = 0; i < commit.parents.length; i++) {
      const parentHash = commit.parents[i];

      if (i === 0) {
        if (laneOf.has(parentHash)) {
          // Parent already claimed by another child (diamond merge).
          // Our lane thread ends here.
          parentLanes.push(laneOf.get(parentHash)!);
          occupied.delete(lane);
          laneColorOf.delete(lane);
          laneNameOf.delete(lane);
          lanePaletteIdx.delete(lane);
        } else {
          laneOf.set(parentHash, lane);
          parentLanes.push(lane);
        }
      } else {
        // Secondary (merge) parent.
        if (laneOf.has(parentHash)) {
          parentLanes.push(laneOf.get(parentHash)!);
        } else {
          // Open a new lane for this merge parent. Prefer lane 0 if the parent
          // is on the primary chain and lane 0 is free.
          const wantPrimary = primaryChain.has(parentHash);
          const newLane = nextFreeLane(wantPrimary);
          occupied.add(newLane);
          laneOf.set(parentHash, newLane);
          parentLanes.push(newLane);
          laneNameOf.set(newLane, null);
          assignLaneColor(newLane, null, false);
        }
      }
    }

    if (commit.parents.length === 0) {
      occupied.delete(lane);
      laneColorOf.delete(lane);
      laneNameOf.delete(lane);
      lanePaletteIdx.delete(lane);
    }

    // ── Step 4: build graph lines with pre-computed colors ───────────────────
    const dotColor = laneColorOf.get(lane) ?? anonymousLaneColor(lane);
    const graphLines: GraphLine[] = [];

    graphLines.push({
      fromLane: lane,
      toLane: parentLanes.length > 0 ? parentLanes[0] : lane,
      type: 'straight',
      repoId: commit.repoId,
      isStart,
      color: dotColor,
    });

    for (let p = 1; p < parentLanes.length; p++) {
      const pl = parentLanes[p];
      graphLines.push({
        fromLane: lane,
        toLane: pl,
        type: 'merge-in',
        repoId: commit.repoId,
        color: laneColorOf.get(pl) ?? dotColor,
      });
    }

    for (const l of enteringLanes) {
      if (l === lane) continue;
      graphLines.push({
        fromLane: l,
        toLane: l,
        type: 'pass-through',
        repoId: commit.repoId,
        color: laneColorOf.get(l) ?? anonymousLaneColor(l),
      });
    }

    const activeLaneCount = occupied.size > 0 ? Math.max(...occupied) + 1 : lane + 1;

    laidOut.push({
      ...commit,
      lane,
      totalLanes: activeLaneCount,
      graphLines,
      dotColor,
    });
  }

  return laidOut;
}
