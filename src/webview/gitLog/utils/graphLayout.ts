import type { CommitNode } from '../../shared/types';
import { anonymousLaneColor } from './refs';
import { headColor, primaryBranchColor, currentPalette, branchPaletteIndex } from '../../shared/branchColors';
import { isPrimaryBranch } from '../../shared/branchUtils';

export const LANE_WIDTH = 20;
export const ROW_HEIGHT = 28;
export const DOT_RADIUS = 4;

export function laneX(col: number): number {
  return col * LANE_WIDTH + LANE_WIDTH / 2;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface LaidOutCommit extends CommitNode {
  lane: number;
  totalLanes: number;
  dotColor: string;
}

/**
 * A branch segment stored as grid coordinates (not pre-expanded per-row).
 * p1 = source (newer commit, lower row index), p2 = target (older commit, higher row index).
 * lockedFirst: true = diagonal bend at p1 row (lower half), false = bend at p2 row (upper half).
 */
export interface Segment {
  p1x: number; p1y: number;
  p2x: number; p2y: number;
  color: string;
  lockedFirst: boolean;
  branchId: number;
}

export interface GraphLayout {
  commits: LaidOutCommit[];
  segments: Segment[];
  totalCols: number;
  /** Maps normalized branch/tag ref name → graph color, for badge color consistency. */
  refColors: Map<string, string>;
}

/**
 * Given all segments, return the RowLine descriptors for a specific row.
 * Called per visible row by the virtualizer — O(segments) per call, but
 * segments is bounded by O(commits) not O(commits²).
 */
export interface RowLine {
  /** pixel x entering this row from above */
  x1: number;
  /** pixel x leaving this row downward */
  x2: number;
  color: string;
  lockedFirst: boolean;
}

/**
 * Returns the maximum pixel X occupied by any segment passing through this row.
 * Used to determine where text can safely start without overlapping graph lines.
 */
export function getRowMaxX(row: number, segments: Segment[]): number {
  let max = 0;
  for (const s of segments) {
    if (row < s.p1y || row > s.p2y) continue;
    const px1 = laneX(s.p1x);
    const px2 = laneX(s.p2x);
    if (px1 > max) max = px1;
    if (px2 > max) max = px2;
  }
  return max;
}

export function getRowLines(row: number, segments: Segment[]): RowLine[] {
  const result: RowLine[] = [];
  for (const s of segments) {
    if (row < s.p1y || row > s.p2y) continue;

    const px1 = laneX(s.p1x);
    const px2 = laneX(s.p2x);

    let x1: number, x2: number;

    if (s.p1x === s.p2x) {
      // Straight vertical
      x1 = px1; x2 = px1;
    } else if (row === s.p1y) {
      // Source row
      x1 = px1;
      x2 = s.lockedFirst ? px2 : px1; // bend here (lower half) or not yet
    } else if (row === s.p2y) {
      // Target row
      if (s.lockedFirst) {
        x1 = px2; x2 = px2; // already transitioned, straight arrive
      } else {
        x1 = px1; x2 = px2; // bend here (upper half)
      }
    } else {
      // Intermediate row: straight at whichever x the line settled into
      const x = s.lockedFirst ? px2 : px1;
      x1 = x; x2 = x;
    }

    result.push({ x1, x2, color: s.color, lockedFirst: s.lockedFirst });
  }
  return result;
}

// ─── Internal GVertex / GBranch ──────────────────────────────────────────────

const NULL_ID = -1;

class GVertex {
  public readonly id: number;
  private x: number = 0;
  private parents: GVertex[] = [];
  private nextParentIdx: number = 0;
  private onBranch: GBranch | null = null;
  public nextX: number = 0;
  private connections: Array<{ connectsTo: GVertex | null; onBranch: GBranch } | undefined> = [];

  constructor(id: number) { this.id = id; }

  addParent(v: GVertex) { this.parents.push(v); }
  getNextParent(): GVertex | null {
    return this.nextParentIdx < this.parents.length ? this.parents[this.nextParentIdx] : null;
  }
  registerParentProcessed() { this.nextParentIdx++; }
  addToBranch(branch: GBranch, x: number) {
    if (this.onBranch === null) { this.onBranch = branch; this.x = x; }
  }
  isNotOnBranch() { return this.onBranch === null; }
  getBranch() { return this.onBranch; }
  isMerge() { return this.parents.length > 1; }
  getPoint() { return { x: this.x, y: this.id }; }
  getNextPoint() { return { x: this.nextX, y: this.id }; }
  getPointConnectingTo(targetVertex: GVertex | null, branch: GBranch): { x: number; y: number } | null {
    for (let i = 0; i < this.connections.length; i++) {
      const c = this.connections[i];
      if (c && c.connectsTo === targetVertex && c.onBranch === branch) return { x: i, y: this.id };
    }
    return null;
  }
  registerUnavailablePoint(x: number, connectsTo: GVertex | null, onBranch: GBranch) {
    if (x === this.nextX) {
      this.nextX = x + 1;
      this.connections[x] = { connectsTo, onBranch };
    }
  }
}

class GBranch {
  public readonly colourSlot: number;
  public endRow: number = 0;
  public readonly lines: Array<{
    p1: { x: number; y: number };
    p2: { x: number; y: number };
    lockedFirst: boolean;
  }> = [];

  constructor(colourSlot: number) { this.colourSlot = colourSlot; }
  addLine(p1: { x: number; y: number }, p2: { x: number; y: number }, lockedFirst: boolean) {
    this.lines.push({ p1, p2, lockedFirst });
  }
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function primaryRefName(refs: string[]): string | null {
  for (const r of refs) { if (r.startsWith('HEAD -> ')) return r.slice('HEAD -> '.length); }
  for (const r of refs) { if (!r.startsWith('HEAD') && !r.startsWith('tag: ') && !r.includes('/')) return r; }
  for (const r of refs) { if (!r.startsWith('HEAD') && !r.startsWith('tag: ') && r.includes('/')) return r; }
  for (const r of refs) { if (r.startsWith('tag: ')) return r.slice('tag: '.length); }
  return null;
}

function colorForBranch(colourSlot: number, refName: string | null): string {
  const palette = currentPalette();
  if (refName !== null) {
    const norm = refName.replace(/^[^/]+\//, '');
    if (isPrimaryBranch(norm)) return primaryBranchColor();
    return palette[branchPaletteIndex(norm)];
  }
  return palette[colourSlot % palette.length];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function assignLanes(commits: CommitNode[], isFiltered = false): GraphLayout {
  // In filtered/search mode each result is an isolated node — strip all parent links so
  // the graph shows only dots with no connecting lines between unrelated results.
  if (commits.length === 0) return { commits: [], segments: [], totalCols: 1, refColors: new Map() };

  // Always filter out parents not in the visible set — without this, commits whose
  // parent hasn't been loaded yet (or was filtered out) create dangling branches that
  // never close, corrupting the graph layout.
  const visibleHashes = new Set(commits.map(c => c.hash));
  commits = commits.map(c => ({ ...c, parents: c.parents.filter(p => visibleHashes.has(p)) }));

  const n = commits.length;
  const hashIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) hashIndex.set(commits[i].hash, i);

  // ── Build vertices ────────────────────────────────────────────────────────
  const nullVertex = new GVertex(NULL_ID);
  const vertices: GVertex[] = Array.from({ length: n }, (_, i) => new GVertex(i));

  for (let i = 0; i < n; i++) {
    for (const ph of commits[i].parents) {
      const pidx = hashIndex.get(ph) ?? -1;
      if (pidx >= 0) { vertices[i].addParent(vertices[pidx]); }
      else vertices[i].addParent(nullVertex);
    }
  }

  // ── determinePath (faithful port of vscode-git-graph) ────────────────────
  const branches: GBranch[] = [];
  const availableColours: number[] = [];

  function getAvailableColour(startAt: number): number {
    for (let i = 0; i < availableColours.length; i++) {
      if (startAt > availableColours[i]) return i;
    }
    availableColours.push(0);
    return availableColours.length - 1;
  }

  function determinePath(startAt: number) {
    let i = startAt;
    let vertex = vertices[i];
    let parentVertex = vertex.getNextParent();
    let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();

    if (parentVertex !== null && parentVertex.id !== NULL_ID && vertex.isMerge() &&
        !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
      let foundPointToParent = false;
      const parentBranch = parentVertex.getBranch()!;
      for (i = startAt + 1; i < vertices.length; i++) {
        const curVertex = vertices[i];
        let curPoint = curVertex.getPointConnectingTo(parentVertex, parentBranch);
        if (curPoint !== null) { foundPointToParent = true; }
        else { curPoint = curVertex.getNextPoint(); }
        // vscode-git-graph line 721
        const lockedFirst = !foundPointToParent && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true;
        parentBranch.addLine(lastPoint, curPoint, lockedFirst);
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch);
        lastPoint = curPoint;
        if (foundPointToParent) { vertex.registerParentProcessed(); break; }
      }
    } else {
      const branch = new GBranch(getAvailableColour(startAt));
      vertex.addToBranch(branch, lastPoint.x);
      vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);
      // No parent in the visible set — close the branch immediately, no lines drawn.
      if (parentVertex === null) {
        branch.endRow = startAt;
        branches.push(branch);
        availableColours[branch.colourSlot] = startAt;
        return;
      }
      for (i = startAt + 1; i < vertices.length; i++) {
        const curVertex = vertices[i];
        const curPoint = (parentVertex === curVertex && !parentVertex.isNotOnBranch())
          ? curVertex.getPoint() : curVertex.getNextPoint();
        // vscode-git-graph line 738
        branch.addLine(lastPoint, curPoint, lastPoint.x < curPoint.x);
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
        lastPoint = curPoint;
        if (parentVertex === curVertex) {
          vertex.registerParentProcessed();
          const parentVertexOnBranch = !parentVertex.isNotOnBranch();
          parentVertex.addToBranch(branch, curPoint.x);
          vertex = parentVertex;
          parentVertex = vertex.getNextParent();
          if (parentVertex === null || parentVertexOnBranch) break;
        }
      }
      if (i === vertices.length && parentVertex !== null && parentVertex.id === NULL_ID) {
        vertex.registerParentProcessed();
      }
      branch.endRow = i;
      branches.push(branch);
      availableColours[branch.colourSlot] = i;
    }
  }

  let j = 0;
  while (j < vertices.length) {
    if (vertices[j].getNextParent() !== null || vertices[j].isNotOnBranch()) {
      determinePath(j);
    } else {
      j++;
    }
  }

  // ── Assign colors ─────────────────────────────────────────────────────────
  const branchColors: string[] = new Array(branches.length);
  const refColors = new Map<string, string>();
  for (let bi = 0; bi < branches.length; bi++) {
    const branch = branches[bi];
    let refName: string | null = null;
    let repoId = '';
    for (let vi = 0; vi < n; vi++) {
      if (vertices[vi].getBranch() === branch) {
        refName = primaryRefName(commits[vi].refs);
        repoId = commits[vi].repoId;
        break;
      }
    }
    const color = colorForBranch(branch.colourSlot, refName);
    branchColors[bi] = color;
    if (refName && repoId) {
      let normKey = refName.replace(/^HEAD -> /, '');
      normKey = normKey
        .replace(/^refs\/remotes\//, '')
        .replace(/^remotes\//, '')
        .replace(/^refs\/heads\//, '')
        .replace(/^heads\//, '');
      if (normKey && normKey !== 'HEAD') {
        refColors.set(`${repoId}:${normKey}`, color);
      }
    }
  }

  // ── Build Segment[] — O(total branch lines), NOT O(n²) ───────────────────
  // Merge consecutive collinear segments on the same branch to minimize count.
  const segments: Segment[] = [];
  let totalCols = 1;

  for (let bi = 0; bi < branches.length; bi++) {
    const color = branchColors[bi];
    const lines = branches[bi].lines;
    if (lines.length === 0) continue;

    // Merge consecutive straight segments (same x, no bend needed)
    let cur = lines[0];
    for (let li = 1; li < lines.length; li++) {
      const next = lines[li];
      const canMerge =
        cur.p1.x === cur.p2.x &&   // cur is straight
        next.p1.x === next.p2.x && // next is straight
        cur.p1.x === next.p1.x &&  // same column
        cur.p2.y === next.p1.y;    // consecutive rows
      if (canMerge) {
        cur = { p1: cur.p1, p2: next.p2, lockedFirst: false };
      } else {
        const s: Segment = { p1x: cur.p1.x, p1y: cur.p1.y, p2x: cur.p2.x, p2y: cur.p2.y, color, lockedFirst: cur.lockedFirst, branchId: bi };
        segments.push(s);
        if (cur.p1.x + 1 > totalCols) totalCols = cur.p1.x + 1;
        if (cur.p2.x + 1 > totalCols) totalCols = cur.p2.x + 1;
        cur = next;
      }
    }
    const s: Segment = { p1x: cur.p1.x, p1y: cur.p1.y, p2x: cur.p2.x, p2y: cur.p2.y, color, lockedFirst: cur.lockedFirst, branchId: bi };
    segments.push(s);
    if (cur.p1.x + 1 > totalCols) totalCols = cur.p1.x + 1;
    if (cur.p2.x + 1 > totalCols) totalCols = cur.p2.x + 1;
  }

  // ── Build LaidOutCommit[] ─────────────────────────────────────────────────
  const laidOut: LaidOutCommit[] = [];

  for (let vi = 0; vi < n; vi++) {
    const dotCol = vertices[vi].getPoint().x;
    const myBranch = vertices[vi].getBranch();
    const myBranchIdx = myBranch ? branches.indexOf(myBranch) : -1;
    const dotColor = myBranchIdx >= 0 ? branchColors[myBranchIdx] : anonymousLaneColor(dotCol);
    if (dotCol + 1 > totalCols) totalCols = dotCol + 1;
    laidOut.push({ ...commits[vi], lane: dotCol, totalLanes: totalCols, dotColor });
  }

  for (const c of laidOut) c.totalLanes = totalCols;

  // Second pass: register the dot color of every commit against all its refs.
  // Key format: "repoId:name" where name preserves the remote prefix for remote refs,
  // so "origin/beta" and "beta" remain distinct keys and don't overwrite each other.
  //
  // Ref forms and how they are stored:
  //   "HEAD -> beta"              → "beta"           (local, HEAD points here)
  //   "refs/heads/beta"           → "beta"           (local)
  //   "heads/beta"                → "beta"           (local)
  //   "refs/remotes/origin/beta"  → "origin/beta"    (remote — keeps remote/ prefix)
  //   "remotes/origin/beta"       → "origin/beta"    (remote — keeps remote/ prefix)
  //   "origin/beta"               → "origin/beta"    (remote — already has prefix)
  for (const c of laidOut) {
    for (const ref of c.refs) {
      if (ref.startsWith('tag: ') || ref === 'HEAD') continue;
      let name = ref;
      if (name.startsWith('HEAD -> ')) name = name.slice('HEAD -> '.length);
      // Strip only the full git path prefixes, keeping remote/branch intact
      name = name
        .replace(/^refs\/remotes\//, '')   // "refs/remotes/origin/beta" → "origin/beta"
        .replace(/^remotes\//, '')         // "remotes/origin/beta"      → "origin/beta"
        .replace(/^refs\/heads\//, '')     // "refs/heads/beta"          → "beta"
        .replace(/^heads\//, '');          // "heads/beta"               → "beta"
      if (!name || name === 'HEAD') continue;
      const key = `${c.repoId}:${name}`;
      if (!refColors.has(key)) refColors.set(key, c.dotColor);
    }
  }

  return { commits: laidOut, segments, totalCols, refColors };
}
