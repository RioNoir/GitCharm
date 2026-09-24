import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Codicon } from '../../shared/Codicon';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: string;
  danger?: boolean;
  /** Count shown as a pill at the right edge of the item, styled like VS Code's own badges. */
  badge?: string;
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
  /** Fixed menu width in px (e.g. to match the button it drops down from) instead of sizing to its content. */
  width?: number;
  /** The element the menu drops down from — presses on it don't count as "outside", so its own click handler can toggle the menu closed instead of it closing and immediately reopening. */
  anchor?: HTMLElement | null;
  /** Overrides for the menu container's look (background, border…) — positioning stays managed here. */
  menuStyle?: React.CSSProperties;
}

export function ContextMenu({ x, y, items, onSelect, onClose, width, anchor, menuStyle }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; maxHeight?: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = window.innerWidth;
    // A menu as wide as the viewport (e.g. matched to a full-width button) has no room for side margins.
    const margin = w >= vw - 8 ? 0 : 4;
    const vh = window.innerHeight;
    const px = Math.max(margin, Math.min(x, vw - w - margin));
    let py = y;
    let maxHeight: number | undefined;
    if (y + h + margin > vh) {
      const topIfUp = y - h;
      if (topIfUp >= margin) {
        py = topIfUp;
      } else {
        py = margin;
        maxHeight = vh - margin * 2;
      }
    }
    setPos({ x: px, y: py, maxHeight });
  }, [x, y, width]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (anchor?.contains(e.target as Node)) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handler, true);
    document.addEventListener('keydown', keyHandler);
    window.addEventListener('blur', onClose);
    // A resized panel leaves the menu at a stale position (and a width-matched menu at a stale width).
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', handler, true);
      document.removeEventListener('keydown', keyHandler);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, anchor]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: pos?.y ?? y,
    left: pos?.x ?? x,
    zIndex: 9999,
    visibility: pos ? 'visible' : 'hidden',
    ...(width != null ? { width, minWidth: 0, boxSizing: 'border-box' as const } : {}),
    ...(pos?.maxHeight ? { maxHeight: pos.maxHeight, overflowY: 'auto' as const } : {}),
  };

  return (
    <div ref={ref} style={{ ...styles.menu, ...menuStyle, ...style }}>
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
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--vscode-menu-selectionBackground)'; e.currentTarget.style.color = it.danger ? 'var(--vscode-errorForeground)' : 'var(--vscode-menu-selectionForeground)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = it.danger ? 'var(--vscode-errorForeground)' : 'var(--vscode-menu-foreground, var(--vscode-foreground))'; }}
          >
            <Codicon name={it.icon} style={styles.icon} />
            <span style={styles.label}>{it.label}</span>
            {it.badge && <span style={styles.badge}>{it.badge}</span>}
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
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
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
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  badge: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px',
    padding: '0 5px',
    fontSize: '10px',
    fontWeight: 'bold' as const,
    lineHeight: '16px',
    flexShrink: 0,
  },
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
