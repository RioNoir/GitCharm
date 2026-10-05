/** Widths measured on the hidden probe strip, in px. */
export interface TabBarWidths<T extends string> {
  /** Room available to the tab bar. */
  bar: number;
  /** Each tab as an inactive, icon-only tab (badge included). */
  icon: Partial<Record<T, number>>;
  /** Each tab as the active tab, with its label (badge included). */
  label: Partial<Record<T, number>>;
  /** The "more tabs" overflow button. */
  more: number;
}

/**
 * How the tab bar fits in the width it has, from the roomiest layout down. The active tab keeps its
 * label throughout, unless the label setting is `never`:
 *
 * - `strip` with `labels: 'all'` — every tab, each with its label (label setting `always`)
 * - `strip` with `labels: 'active'` — every tab, the active one with its label
 * - `strip` with `overflow` — the active tab, then the others by `rank` (lowest first, ties in
 *   tab order), up to the first that doesn't fit next to an overflow button that lists the rest
 * - `dropdown` — a single button for the active tab, when not even one more tab fits beside it
 *
 * `labels: 'none'` stands in for `'active'` with the label setting `never`.
 */
export type TabBarLayout<T extends string> =
  | { kind: 'strip'; visible: T[]; overflow: T[]; labels: 'all' | 'active' | 'none' }
  | { kind: 'dropdown' };

/** The active tab is wider than an inactive one even without its label: 12px side padding instead of 10px. */
const ACTIVE_ICON_EXTRA = 4;

export function layoutTabBar<T extends string>(
  tabs: T[],
  active: T,
  labels: 'active' | 'always' | 'never',
  widths: TabBarWidths<T>,
  rank: (tab: T) => number,
): TabBarLayout<T> {
  const icon = (t: T) => widths.icon[t] ?? 0;
  const label = (t: T) => widths.label[t] ?? icon(t);
  const activeLabels = labels === 'never' ? 'none' : 'active';
  const iconsOnly = tabs.reduce((sum, t) => sum + icon(t), 0) + ACTIVE_ICON_EXTRA;

  if (labels === 'always') {
    const allLabels = tabs.reduce((sum, t) => sum + label(t), 0) - ACTIVE_ICON_EXTRA * (tabs.length - 1);
    if (allLabels <= widths.bar) return { kind: 'strip', visible: tabs, overflow: [], labels: 'all' };
  }
  // With every tab shown, the widest label is reserved whichever tab is active, so switching tabs
  // never changes the layout.
  const everyTab = labels === 'never'
    ? iconsOnly
    : iconsOnly - ACTIVE_ICON_EXTRA + Math.max(0, ...tabs.map(t => label(t) - icon(t)));
  if (everyTab <= widths.bar) return { kind: 'strip', visible: tabs, overflow: [], labels: activeLabels };

  const budget = widths.bar - widths.more;
  let used = labels === 'never' ? icon(active) + ACTIVE_ICON_EXTRA : label(active);
  const kept = new Set<T>([active]);
  // Strictly by rank: a narrow low-priority tab never takes the place of a wider one ahead of it.
  const candidates = tabs.filter(t => t !== active).sort((a, b) => rank(a) - rank(b));
  for (const t of candidates) {
    if (used + icon(t) > budget) break;
    used += icon(t);
    kept.add(t);
  }
  // The active tab alone next to the overflow button says no more than the dropdown.
  if (used > budget || kept.size === 1) return { kind: 'dropdown' };
  return { kind: 'strip', visible: tabs.filter(t => kept.has(t)), overflow: tabs.filter(t => !kept.has(t)), labels: activeLabels };
}
