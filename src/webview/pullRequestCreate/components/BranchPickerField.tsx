import React from 'react';
import { Codicon } from '../../shared/Codicon';

interface Props {
  label: string;
  value: string;
  placeholder: string;
  onPick: () => void;
  disabled?: boolean;
}

export function BranchPickerField({ label, value, placeholder, onPick, disabled }: Props) {
  return (
    <label style={css.label}>
      {label}
      <button type="button" style={css.pill} onClick={onPick} disabled={disabled}>
        <Codicon name="git-branch" style={{ fontSize: '13px', opacity: 0.7, flexShrink: 0 }} />
        <span style={css.pillText}>{value || placeholder}</span>
        <Codicon name="chevron-down" style={{ fontSize: '11px', opacity: 0.5, marginLeft: 'auto', flexShrink: 0 }} />
      </button>
    </label>
  );
}

const css = {
  label: { display: 'flex', flexDirection: 'column' as const, gap: '4px', fontSize: '11px', opacity: 0.7, flex: 1, minWidth: 0 } as React.CSSProperties,
  pill: {
    display: 'flex', alignItems: 'center', gap: '6px', width: '100%', textAlign: 'left' as const,
    fontSize: '13px', padding: '5px 8px', background: 'var(--vscode-dropdown-background)',
    color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-dropdown-border)', borderRadius: '3px',
    cursor: 'pointer', boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  pillText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1, minWidth: 0 } as React.CSSProperties,
};
