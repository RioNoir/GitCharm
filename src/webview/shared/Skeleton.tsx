import React from 'react';

interface BlockProps {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  style?: React.CSSProperties;
}

/** A single shimmering placeholder block — the building block for composed skeletons below. */
export function SkeletonBlock({ width = '100%', height = 14, radius = 4, style }: BlockProps) {
  return (
    <div
      className="skeleton-block"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/** A handful of paragraph-like lines of varying width, for text-heavy content (description, comment body). */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  const widths = ['92%', '78%', '85%', '60%', '70%'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonBlock key={i} width={widths[i % widths.length]} />
      ))}
    </div>
  );
}

/** One avatar + a couple of lines — for comment cards, commit rows, file rows. */
export function SkeletonRow({ withAvatar = true }: { withAvatar?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 0' }}>
      {withAvatar && <SkeletonBlock width={24} height={24} radius="50%" style={{ flexShrink: 0 }} />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <SkeletonBlock width="60%" height={13} />
        <SkeletonBlock width="35%" height={11} />
      </div>
    </div>
  );
}

/** A handful of `SkeletonRow`s, for lists (comments, commits, files). */
export function SkeletonList({ rows = 4, withAvatar = true }: { rows?: number; withAvatar?: boolean }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => <SkeletonRow key={i} withAvatar={withAvatar} />)}
    </div>
  );
}

/** A couple of pill-shaped placeholders, for chip-based content (reviewers, assignees, labels). */
export function SkeletonChips({ count = 2 }: { count?: number }) {
  const widths = [72, 56, 88];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonBlock key={i} width={widths[i % widths.length]} height={22} radius={999} />
      ))}
    </div>
  );
}
