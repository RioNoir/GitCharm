const OURS_START = /^<{7} (.+)$/m;
const THEIRS_END = /^>{7} (.+)$/m;

export function hasConflictMarkers(content: string): boolean {
  return OURS_START.test(content) && THEIRS_END.test(content);
}

/** One conflict of a file, as git writes it (with or without the `|||||||` ancestor section of diff3/zdiff3). */
export interface ConflictHunk {
  /** Line of `<<<<<<<` (0-based). */
  startLine: number;
  /** Line of `>>>>>>>` (0-based). */
  endLine: number;
  currentLabel: string;
  incomingLabel: string;
  current: string[];
  /** The common ancestor, when the markers include it. */
  base?: string[];
  incoming: string[];
}

/** Any conflict marker line, which a resolution must never contain. */
export const CONFLICT_MARKER_LINE = /^(<{7}|\|{7}|={7}|>{7})( |$)/m;

/** The conflicts of a file's text, in order. Incomplete marker sets are ignored. */
export function parseConflicts(text: string): ConflictHunk[] {
  const lines = text.split(/\r?\n/);
  const hunks: ConflictHunk[] = [];
  let open: { start: number; label: string; current: string[]; base?: string[]; incoming?: string[] } | undefined;
  lines.forEach((line, i) => {
    if (/^<{7}( |$)/.test(line)) {
      open = { start: i, label: line.slice(8), current: [] };
    } else if (!open) {
      return;
    } else if (/^\|{7}( |$)/.test(line) && !open.incoming) {
      open.base = [];
    } else if (/^={7}$/.test(line) && !open.incoming) {
      open.incoming = [];
    } else if (/^>{7}( |$)/.test(line) && open.incoming) {
      hunks.push({
        startLine: open.start, endLine: i, currentLabel: open.label, incomingLabel: line.slice(8),
        current: open.current, base: open.base, incoming: open.incoming,
      });
      open = undefined;
    } else if (open.incoming) {
      open.incoming.push(line);
    } else if (open.base) {
      open.base.push(line);
    } else {
      open.current.push(line);
    }
  });
  return hunks;
}
