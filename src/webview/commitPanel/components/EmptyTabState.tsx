import React from 'react';
import { Codicon } from '../../shared/Codicon';

/**
 * What a Commit Panel tab shows when it has nothing to list: its icon, large, above a line
 * of text, both centered in the space the list would take. Takes that space itself (flex: 1),
 * so it goes in place of the tab's scroll area rather than inside it.
 */
export function EmptyTabState({ icon, message, hint, loading = false }: {
  icon: string;
  message: string;
  /** A smaller line under the message, e.g. how to create what the tab lists. */
  hint?: string;
  /** Shows a spinning loading icon instead of the tab's. */
  loading?: boolean;
}) {
  return (
    <div style={css.root} role="status">
      <Codicon
        name={loading ? 'loading' : icon}
        className={loading ? 'codicon-modifier-spin' : undefined}
        style={css.icon}
      />
      <div style={css.message}>{message}</div>
      {hint && !loading && <div style={css.hint}>{hint}</div>}
    </div>
  );
}

const css = {
  root: {
    flex: 1, minHeight: 0,
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', gap: '12px',
    padding: '24px 16px', boxSizing: 'border-box' as const,
    color: 'var(--vscode-foreground)', textAlign: 'center' as const,
  } as React.CSSProperties,
  icon: { fontSize: '36px', opacity: 0.35 } as React.CSSProperties,
  message: { fontSize: '12px', opacity: 0.65, maxWidth: '260px', lineHeight: 1.4 } as React.CSSProperties,
  hint: { fontSize: '11px', opacity: 0.45, maxWidth: '260px', lineHeight: 1.5, marginTop: '-4px' } as React.CSSProperties,
};
