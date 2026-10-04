import React from 'react';

/** One color per side of a compare, shared by the mode button's counts and the list's side markers. */
export const COMPARE_SIDE_COLORS = {
  target: 'var(--vscode-charts-blue)',
  base: 'var(--vscode-charts-purple)',
} as const;

// Two r=5 circles 5 apart, centred at (5.5, 8) and (10.5, 8): they cross at (8, 8 ± 4.33).
// Each crescent is the outer arc of its own circle back along the inner arc of the other.
const TARGET_ONLY = 'M8 3.67A5 5 0 1 0 8 12.33A5 5 0 0 1 8 3.67Z';
const BASE_ONLY = 'M8 3.67A5 5 0 1 1 8 12.33A5 5 0 0 0 8 3.67Z';

/**
 * A Venn diagram of the two compared refs (left circle `target`, right circle `base`) with
 * the part a compare shows filled in its side's color: one crescent for a one-sided compare,
 * both for a compare of both sides, where the shared commits in the middle are left out.
 */
export function CompareVennIcon({ target, base, size = 16, title }: {
  target: boolean;
  base: boolean;
  size?: number;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ flexShrink: 0 }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {target && <path d={TARGET_ONLY} fill={COMPARE_SIDE_COLORS.target} />}
      {base && <path d={BASE_ONLY} fill={COMPARE_SIDE_COLORS.base} />}
      <g fill="none" stroke="currentColor" strokeWidth="1" opacity="0.7">
        <circle cx="5.5" cy="8" r="5" />
        <circle cx="10.5" cy="8" r="5" />
      </g>
    </svg>
  );
}
