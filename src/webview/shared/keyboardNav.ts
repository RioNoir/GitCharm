import type React from 'react';
import { isImeComposing } from './ime';

/**
 * Shared keyboard-navigation primitives for tree/list views (branch sidebar, file trees):
 * arrow/Home/End/PageUp/PageDown moves focus between DOM rows tagged `data-nav-row`, in
 * document order — the same order they're rendered in, so it stays correct through any
 * filter or collapsed state without each caller duplicating its own tree-walk logic.
 *
 * A row using this becomes a plain focusable div (`tabIndex={-1}`, `data-nav-row`) whose
 * own `onKeyDown` handles Enter/Space as that row's action, and whose container wires
 * `handleTreeNavKeyDown` to its scrollable ancestor.
 */

// Suppresses hover-driven focus for a brief window after a keyboard-driven scroll.
// Comparing the cursor's exact coordinates isn't reliable: scrollIntoView can snap the new
// row to the top or bottom edge of the viewport, which is exactly where a user holding an
// arrow key tends to rest the mouse — so ordinary hardware jitter reads as "real" movement
// and defeats a position check. A short timed suppression window sidesteps that: any hover
// event firing immediately after a scroll is almost certainly the scroll sliding a row under
// the pointer, not the user choosing to hover it.
let suppressHoverUntil = 0;

export function suppressHoverBriefly(): void {
  suppressHoverUntil = Date.now() + 150;
}

export function isHoverSuppressed(): boolean {
  return Date.now() < suppressHoverUntil;
}

/** Hovering a row makes it keyboard-navigable without a click first — but never steals focus
 * away from a text field the user is typing into, never reacts to a "mouseenter" that only
 * happened because a keyboard-driven scroll moved a row under a stationary cursor, and never
 * steals focus from outside the webview: a VS Code QuickPick/InputBox lives in the host window,
 * not this webview's document, so `document.activeElement` still points at whatever had focus
 * in here before the QuickPick opened — `document.hasFocus()` is what actually reflects whether
 * this webview currently owns keyboard focus. Calling `el.focus()` while it doesn't would pull
 * focus away from the QuickPick and close it out from under the user. */
export function focusOnHover(el: HTMLElement): void {
  if (isHoverSuppressed()) return;
  if (!document.hasFocus()) return;
  const active = document.activeElement;
  const isTyping = active instanceof HTMLElement && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if (!isTyping) el.focus({ preventScroll: true });
}

/** Attach to a scrollable container's onKeyDown. Moves focus between its `[data-nav-row]`
 * descendants in document order on Arrow/Page/Home/End, scrolling the target into view. */
export function handleTreeNavKeyDown(e: React.KeyboardEvent<HTMLElement>, root: HTMLElement | null): void {
  // Rows can contain inline rename inputs; arrows there may be picking an IME candidate.
  if (isImeComposing(e)) return;
  if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) return;
  if (!root) return;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-nav-row]'));
  if (rows.length === 0) return;

  const active = document.activeElement;
  const currentIndex = active instanceof HTMLElement ? rows.indexOf(active) : -1;
  const rowHeight = rows[0].getBoundingClientRect().height || 22;
  const pageSize = Math.max(1, Math.floor(root.clientHeight / rowHeight));

  let nextIndex: number;
  switch (e.key) {
    case 'ArrowDown': nextIndex = currentIndex < 0 ? 0 : Math.min(rows.length - 1, currentIndex + 1); break;
    case 'ArrowUp': nextIndex = currentIndex < 0 ? 0 : Math.max(0, currentIndex - 1); break;
    case 'PageDown': nextIndex = Math.min(rows.length - 1, (currentIndex < 0 ? 0 : currentIndex) + pageSize); break;
    case 'PageUp': nextIndex = Math.max(0, (currentIndex < 0 ? 0 : currentIndex) - pageSize); break;
    case 'Home': nextIndex = 0; break;
    case 'End': nextIndex = rows.length - 1; break;
    default: return;
  }

  e.preventDefault();
  if (nextIndex === currentIndex) return;
  suppressHoverBriefly();
  rows[nextIndex].focus({ preventScroll: true });
  rows[nextIndex].scrollIntoView({ block: 'nearest' });
}
