import React, { useEffect } from 'react';

/**
 * Vertical indent-guide lines for file trees, shown only on hover of the tree container —
 * matching VS Code's native Explorer. Guides are always in the DOM (so layout never shifts)
 * but only painted when the ancestor `[data-filetree-container]` is hovered.
 */
export function useTreeGuideHoverStyle(): void {
  useEffect(() => {
    const id = 'gitcharm-filetree-guide-hover';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `[data-filetree-container] [data-filetree-guide] { opacity: 0; } [data-filetree-container]:hover [data-filetree-guide] { opacity: 0.5; }`;
    document.head.appendChild(s);
  }, []);
}

interface TreeGuideLinesProps {
  /** Nesting depth of the row these guides are drawn for (one guide line per ancestor level). */
  depth: number;
  /** Horizontal position of the depth-0 guide line, in px from the row's left edge. */
  offset: number;
  /** Horizontal distance between consecutive guide lines, in px (matches the tree's per-level indent). */
  step: number;
}

/**
 * One row's worth of vertical indent guides, aligned with each ancestor directory's expand/
 * collapse chevron (or, where present, its selection checkbox — see each call site's offset
 * math) — matching VS Code's own indent guides, which sit under the twisty rather than the
 * folder icon. Absolutely positioned within a `position: relative` row so they don't affect
 * layout; visibility is toggled by the `[data-filetree-container]:hover` rule from
 * `useTreeGuideHoverStyle`.
 */
export function TreeGuideLines({ depth, offset, step }: TreeGuideLinesProps) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <div
          key={i}
          data-filetree-guide
          style={{
            position: 'absolute',
            left: offset + i * step,
            top: 0,
            bottom: 0,
            width: '1px',
            background: 'var(--vscode-tree-indentGuidesStroke, var(--vscode-panel-border))',
            pointerEvents: 'none',
          }}
        />
      ))}
    </>
  );
}
