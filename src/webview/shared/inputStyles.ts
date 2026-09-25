import type React from 'react';

/** Focus-ring style shared with the commit message editor (UnifiedCommitForm) — border switches to the theme's focus color plus a soft outer glow when focused. */
export function focusableFieldStyle(focused: boolean): React.CSSProperties {
  return {
    border: focused ? '1px solid var(--vscode-focusBorder)' : '1px solid var(--vscode-input-border, rgba(128,128,128,0.35))',
    borderRadius: '3px',
    outline: 'none',
    boxShadow: focused ? '0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent)' : 'none',
    transition: 'border-color 0.12s ease, box-shadow 0.12s ease',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
  };
}

/** The commit message's "AI is writing this" look (UnifiedCommitForm's textarea while generating): focus-colored
 * border, no glow, and the content pulsing. Spread over focusableFieldStyle; the keyframes live in webviewHtml.ts. */
export function generatingFieldStyle(): React.CSSProperties {
  return {
    border: '1px solid var(--vscode-focusBorder)',
    boxShadow: 'none',
    cursor: 'default',
    animation: 'gs-ai-generating-pulse 1.2s ease-in-out infinite',
  };
}

/** Auto-resizes a textarea to fit its content, capped at a fraction of the viewport height beyond which it scrolls internally instead. Shared with UnifiedCommitForm's resizeTextarea. */
export function resizeTextareaEl(el: HTMLTextAreaElement, maxHeightFraction = 0.5): void {
  el.style.height = 'auto';
  const maxHeight = Math.floor(window.innerHeight * maxHeightFraction);
  if (el.scrollHeight > maxHeight) {
    el.style.height = `${maxHeight}px`;
    el.style.overflow = 'auto';
  } else {
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflow = 'hidden';
  }
}
