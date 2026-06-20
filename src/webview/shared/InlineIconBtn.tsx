import React, { useState } from 'react';
import { Codicon } from './Codicon';

interface InlineIconBtnProps {
  icon: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  visible?: boolean;       // controlled by parent row hover; defaults to true (always visible)
  danger?: boolean;        // red color for destructive actions
  iconSize?: number;       // defaults to 16
}

export function InlineIconBtn({ icon, title, onClick, visible = true, danger = false, iconSize = 16 }: InlineIconBtnProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      data-action-btn=""
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hovered ? 'var(--vscode-toolbar-hoverBackground)' : 'transparent',
        border: 'none',
        color: danger ? 'var(--vscode-errorForeground)' : 'var(--vscode-foreground)',
        cursor: 'pointer',
        borderRadius: '3px',
        flexShrink: 0,
        opacity: visible ? (hovered ? 1 : 0.7) : 0,
        pointerEvents: visible ? 'auto' : 'none',
        width: visible ? undefined : 0,
        padding: visible ? '2px 2px' : 0,
        overflow: 'hidden',
        transition: 'opacity 0.1s',
      }}
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Codicon name={icon} style={{ fontSize: `${iconSize}px` }} />
    </button>
  );
}
