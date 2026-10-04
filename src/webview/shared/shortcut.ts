/**
 * Keyboard shortcut labels for tooltips and placeholders, written the way VS Code writes
 * them on each platform: modifier symbols run together on macOS (⌘Enter, ⌘⌥0, ⌥↑),
 * names joined with "+" elsewhere (Ctrl+Enter, Ctrl+Alt+0, Alt+Up).
 */

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** `mod` is ⌘ on macOS and Ctrl elsewhere — what the key handlers accept as metaKey || ctrlKey. */
type Modifier = 'mod' | 'alt' | 'shift';

const MAC_MODIFIERS: Record<Modifier, string> = { mod: '⌘', alt: '⌥', shift: '⇧' };
const OTHER_MODIFIERS: Record<Modifier, string> = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' };
const MAC_KEYS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→' };

/** `shortcut(['mod'], 'Enter')` → "⌘Enter" on macOS, "Ctrl+Enter" elsewhere. */
export function shortcut(modifiers: Modifier[], key: string): string {
  if (isMac) return modifiers.map(m => MAC_MODIFIERS[m]).join('') + (MAC_KEYS[key] ?? key);
  return [...modifiers.map(m => OTHER_MODIFIERS[m]), key].join('+');
}
