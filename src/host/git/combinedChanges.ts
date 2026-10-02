import type { RangeFileEntry } from '../types/messages';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const ZERO_OID = /^0+$/;

interface RawChange {
  status: string;
  srcMode: string;
  dstMode: string;
  srcBlob: string;
  dstBlob: string;
  path: string;
  /** Renames/copies: the path the file came from. */
  oldPath?: string;
}

export interface RawCommitChanges {
  hash: string;
  parents: string[];
  changes: RawChange[];
  /** Line stats by (new) path; binary files have none. */
  stats: Map<string, { added: number; removed: number }>;
}

/**
 * Parses `git log --raw --numstat -z --format=%x01%H %P`: per commit, a header up to the first
 * NUL, then `:srcMode dstMode srcBlob dstBlob STATUS\0path\0` entries (renames/copies carry
 * the old and new path), then `added\tremoved\tpath\0` entries (renames: `added\tremoved\t\0old\0new\0`).
 */
export function parseRawLogChanges(raw: string): RawCommitChanges[] {
  const commits: RawCommitChanges[] = [];
  for (const chunk of raw.split('\x01')) {
    if (!chunk.trim()) continue;
    const tokens = chunk.split('\0');
    const [hash, ...parents] = tokens[0].trim().split(' ').filter(Boolean);
    if (!hash) continue;
    const changes: RawChange[] = [];
    const stats = new Map<string, { added: number; removed: number }>();
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i].replace(/^\n+/, '');
      if (!token) { i++; continue; }
      if (token.startsWith(':')) {
        const [srcMode, dstMode, srcBlob, dstBlob, status = ''] = token.slice(1).split(' ');
        const letter = status[0] ?? 'M';
        if (letter === 'R' || letter === 'C') {
          changes.push({ status: letter, srcMode, dstMode, srcBlob, dstBlob, oldPath: tokens[i + 1], path: tokens[i + 2] });
          i += 3;
        } else {
          changes.push({ status: letter, srcMode, dstMode, srcBlob, dstBlob, path: tokens[i + 1] });
          i += 2;
        }
        continue;
      }
      const stat = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
      if (stat) {
        let statPath = stat[3];
        if (statPath === '') { statPath = tokens[i + 2]; i += 3; } else { i += 1; }
        if (stat[1] !== '-' && stat[2] !== '-') stats.set(statPath, { added: Number(stat[1]), removed: Number(stat[2]) });
        continue;
      }
      i++;
    }
    commits.push({ hash, parents, changes, stats });
  }
  return commits;
}

interface FoldedFile {
  basePath: string;
  baseRef: string;
  baseMode: string;
  baseBlob: string;
  path: string;
  headRef: string;
  headMode: string;
  headBlob: string;
  added?: number;
  removed?: number;
}

/**
 * Folds the changes of commits (oldest first) into one change per file, following renames.
 * Each file spans from the parent of the first commit touching it to the last one; a file that
 * ends where it started is dropped.
 */
export function foldCommitChanges(commits: RawCommitChanges[]): Array<Omit<RangeFileEntry, 'repoId'>> {
  const all: FoldedFile[] = [];
  // Files by their path as of the commit being folded
  const live = new Map<string, FoldedFile>();

  const start = (commit: RawCommitChanges, change: RawChange, basePath: string): FoldedFile => {
    const file: FoldedFile = {
      basePath, baseRef: commit.parents[0] ?? EMPTY_TREE, baseMode: change.srcMode, baseBlob: change.srcBlob,
      path: basePath, headRef: commit.hash, headMode: change.dstMode, headBlob: change.dstBlob,
    };
    all.push(file);
    return file;
  };

  for (const commit of commits) {
    for (const change of commit.changes) {
      let file: FoldedFile;
      if (change.status === 'R' && change.oldPath !== undefined) {
        file = live.get(change.oldPath) ?? start(commit, change, change.oldPath);
        live.delete(change.oldPath);
      } else if (change.status === 'C') {
        // A copy leaves its source alone: for the selection it is a new file
        file = live.get(change.path) ?? start(commit, { ...change, srcMode: '000000', srcBlob: '0' }, change.path);
      } else {
        file = live.get(change.path) ?? start(commit, change, change.path);
      }
      file.path = change.path;
      file.headRef = commit.hash;
      file.headMode = change.dstMode;
      file.headBlob = change.dstBlob;
      // Renamed onto the path of a file deleted earlier: that one stays listed, as deleted
      live.set(change.path, file);

      const stat = commit.stats.get(change.path);
      if (stat) {
        file.added = (file.added ?? 0) + stat.added;
        file.removed = (file.removed ?? 0) + stat.removed;
      }
    }
  }

  const result: Array<Omit<RangeFileEntry, 'repoId'>> = [];
  for (const f of all) {
    const existedBefore = !ZERO_OID.test(f.baseBlob);
    const existsAfter = !ZERO_OID.test(f.headBlob);
    if (!existedBefore && !existsAfter) continue;
    if (existedBefore && existsAfter && f.basePath === f.path && f.baseBlob === f.headBlob && f.baseMode === f.headMode) continue;
    const stats = { added: f.added, removed: f.removed };
    if (!existedBefore) result.push({ path: f.path, status: 'A', ...stats, baseRef: EMPTY_TREE, headRef: f.headRef });
    else if (!existsAfter) result.push({ path: f.basePath, status: 'D', ...stats, baseRef: f.baseRef, headRef: f.headRef });
    else if (f.basePath !== f.path) result.push({ path: f.path, oldPath: f.basePath, status: 'R', ...stats, baseRef: f.baseRef, headRef: f.headRef });
    else result.push({ path: f.path, status: 'M', ...stats, baseRef: f.baseRef, headRef: f.headRef });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
