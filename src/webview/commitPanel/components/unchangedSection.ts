/** Past this many repos the "Unchanged" section starts collapsed. */
export const UNCHANGED_COLLAPSE_THRESHOLD = 5;

/**
 * Whether the "Unchanged" section is collapsed. It starts collapsed with more than
 * UNCHANGED_COLLAPSE_THRESHOLD repos in it; each default keeps its own record of the user's
 * toggle, so crossing the threshold doesn't invert a choice already made.
 */
export function unchangedSectionState(baseKey: string, count: number, isCollapsed: (key: string) => boolean) {
  const collapsedByDefault = count > UNCHANGED_COLLAPSE_THRESHOLD;
  const key = `${baseKey}:${collapsedByDefault ? 'closed' : 'open'}`;
  return { key, collapsed: collapsedByDefault ? !isCollapsed(key) : isCollapsed(key) };
}
