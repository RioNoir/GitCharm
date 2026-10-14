import { useRef, useCallback } from 'react';

/**
 * Drag-to-resize hook for a panel adjacent to a resize handle.
 * Returns a callback ref to attach to the panel and a mousedown handler for the handle.
 *
 * There is no fixed maximum: the panel can grow until the flexible siblings in the
 * same flex row (the ones with flex-grow > 0) reach their CSS min-width, so on wide
 * screens every panel can be pushed to one side. The panel itself is laid out as
 * `flex: 0 1 <width>` with `min-width: <min>`, so when the window narrows it shrinks
 * down to `min` instead of being clipped, and gets its width back when it widens.
 *
 * @param direction  'right' = dragging handle resizes the panel on its left
 *                   'left'  = dragging handle resizes the panel on its right
 * @param initial    Initial pixel width
 * @param min        Minimum pixel width
 */
export function useResize(
  direction: 'right' | 'left',
  initial: number,
  min: number,
) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const widthRef = useRef(initial);

  // Apply the current width whenever the panel mounts, so a panel that is unmounted
  // and mounted again (e.g. the commit detail) keeps the width the user dragged it to.
  const panelRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    if (el) applyWidth(el, widthRef.current, min);
  }, [min]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const panel = elRef.current;
    if (!panel) return;
    const startX = e.clientX;
    const startWidth = panel.offsetWidth;
    const max = Math.max(startWidth, maxWidth(panel));

    const onMove = (ev: MouseEvent) => {
      const delta = direction === 'right' ? ev.clientX - startX : startX - ev.clientX;
      const next = Math.min(max, Math.max(min, startWidth + delta));
      widthRef.current = next;
      if (elRef.current) applyWidth(elRef.current, next, min);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [direction, min]);

  return { panelRef, onMouseDown };
}

function applyWidth(el: HTMLDivElement, width: number, min: number) {
  el.style.width = `${width}px`;
  el.style.flex = `0 1 ${width}px`;
  el.style.minWidth = `${min}px`;
}

/** Widest the panel can get: the row width minus the fixed siblings and the min-width of the flexible ones. */
function maxWidth(panel: HTMLElement): number {
  const parent = panel.parentElement;
  if (!parent) return Infinity;
  let taken = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === panel || !(sibling instanceof HTMLElement)) continue;
    const style = getComputedStyle(sibling);
    if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') continue;
    taken += parseFloat(style.flexGrow) > 0 ? parseFloat(style.minWidth) || 0 : sibling.offsetWidth;
  }
  return parent.clientWidth - taken;
}
