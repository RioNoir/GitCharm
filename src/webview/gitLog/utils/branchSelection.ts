// Multi-selection of branches in the Log's branch sidebar (Ctrl/Cmd-click, Shift-click), the
// way JetBrains IDEs select branches in their Git Log. A selection lives in one section only —
// Local, or a single remote — since a bulk action across local and remote-tracking branches
// would mean different things for each of them.

export interface BranchSelection {
  /** The sidebar section the selection lives in: 'local' or 'remote:<name>'. */
  section: string | null;
  /** Selected branch base names, in the order they were added. */
  names: string[];
  /** The branch a Shift-click range starts from: the last one clicked without Shift. */
  anchor: string | null;
}

export const EMPTY_BRANCH_SELECTION: BranchSelection = { section: null, names: [], anchor: null };

export type BranchClickMode = 'single' | 'toggle' | 'range';

/**
 * The selection after clicking `name` in `section`. `visibleOrder` lists the section's branch
 * names in the order their rows are on screen (pinned ones first, collapsed folders left out),
 * which is the order a Shift-click range follows.
 */
export function applyBranchClick(
  selection: BranchSelection,
  section: string,
  name: string,
  mode: BranchClickMode,
  visibleOrder: string[],
): BranchSelection {
  const single: BranchSelection = { section, names: [name], anchor: name };
  if (mode === 'single' || selection.section !== section) return single;

  if (mode === 'toggle') {
    const names = selection.names.includes(name)
      ? selection.names.filter(n => n !== name)
      : [...selection.names, name];
    return { section, names, anchor: name };
  }

  const from = selection.anchor ? visibleOrder.indexOf(selection.anchor) : -1;
  const to = visibleOrder.indexOf(name);
  if (from < 0 || to < 0) return single;
  const [start, end] = from <= to ? [from, to] : [to, from];
  return { section, names: visibleOrder.slice(start, end + 1), anchor: selection.anchor };
}

/** Drops selected branches that no longer exist in the section (deleted, renamed, filtered out). */
export function pruneBranchSelection(selection: BranchSelection, existing: ReadonlySet<string>): BranchSelection {
  if (selection.names.every(n => existing.has(n))) return selection;
  return { ...selection, names: selection.names.filter(n => existing.has(n)) };
}
