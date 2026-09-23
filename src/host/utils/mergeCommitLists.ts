/**
 * Interleaves several newest-first commit lists by committer date while keeping each list's
 * own order. git's --date-order output is topological (a commit never precedes its parent),
 * and the graph layout depends on that; a plain sort by date breaks it whenever dates are
 * skewed — clock skew, or rebased/cherry-picked commits keeping older dates.
 */
export function mergeCommitLists<T extends { committerDate: string }>(lists: T[][]): T[] {
  const next = lists.map(() => 0);
  const time = (c: T) => new Date(c.committerDate).getTime();
  const merged: T[] = [];
  for (;;) {
    let pick = -1;
    for (let l = 0; l < lists.length; l++) {
      if (next[l] >= lists[l].length) continue;
      if (pick < 0 || time(lists[l][next[l]]) > time(lists[pick][next[pick]])) pick = l;
    }
    if (pick < 0) return merged;
    merged.push(lists[pick][next[pick]++]);
  }
}
