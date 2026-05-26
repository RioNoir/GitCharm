import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Codicon } from '../../shared/Codicon';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: string;
  danger?: boolean;
  separator?: false;
}
export interface ContextMenuSeparator {
  separator: true;
}
export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const margin = 4;
    setPos({
      x: Math.max(margin, Math.min(x, window.innerWidth  - w - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - h - margin)),
    });
  }, [x, y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handler, true);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler, true);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: pos?.y ?? y,
    left: pos?.x ?? x,
    zIndex: 9999,
    visibility: pos ? 'visible' : 'hidden',
  };

  return (
    <div ref={ref} style={{ ...styles.menu, ...style }}>
      {items.map((item, i) => {
        if ('separator' in item && item.separator) {
          return <div key={i} style={styles.separator} />;
        }
        const it = item as ContextMenuItem;
        return (
          <div
            key={it.id}
            style={styles.item(!!it.danger)}
            onClick={() => { onSelect(it.id); onClose(); }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Codicon name={it.icon} style={styles.icon} />
            <span>{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  menu: {
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    minWidth: '180px',
    padding: '4px 0',
    fontSize: '12px',
    color: 'var(--vscode-menu-foreground, var(--vscode-foreground))',
    userSelect: 'none' as const,
  },
  item: (danger: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 12px',
    cursor: 'pointer',
    background: 'transparent',
    color: danger
      ? 'var(--vscode-errorForeground)'
      : 'var(--vscode-menu-foreground, var(--vscode-foreground))',
    transition: 'background 0.08s',
  }),
  icon: {
    fontSize: '14px',
    opacity: 0.8,
    flexShrink: 0,
  },
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground, var(--vscode-panel-border))',
    margin: '4px 0',
  } as React.CSSProperties,
};
