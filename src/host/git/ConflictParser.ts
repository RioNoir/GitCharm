const OURS_START = /^<{7} (.+)$/m;
const THEIRS_END = /^>{7} (.+)$/m;

export function hasConflictMarkers(content: string): boolean {
  return OURS_START.test(content) && THEIRS_END.test(content);
}
