import type React from 'react';

/**
 * True while an IME (Chinese, Japanese, Korean input…) is composing text. The Enter or
 * Escape that confirms or cancels the composition still fires keydown, so text-input
 * handlers must ignore it instead of submitting or closing. keyCode 229 covers the
 * keydown Chromium sends for the key that ends the composition.
 */
export function isImeComposing(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const native = 'nativeEvent' in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
}
