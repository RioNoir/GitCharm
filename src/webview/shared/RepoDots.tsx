import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as l10n from '@vscode/l10n';

export interface RepoDotInfo { name: string; color: string }

/** Past this many repos the group shows MAX_REPO_DOTS - 1 dots and a "+N" count instead of one dot each. */
const MAX_REPO_DOTS = 5;
const OPEN_DELAY_MS = 300;
/** Grace period to move the pointer from the dots into the list (e.g. to scroll it). */
const CLOSE_DELAY_MS = 150;

/**
 * One colored dot per repo that has a branch, folder or tag — capped, since the dots
 * never shrink and a name shared by dozens of repos (submodules all on `main`) would
 * otherwise push the name itself out of its row. Hovering the dots lists every repo,
 * by color and name.
 */
export function RepoDots({ repoIds, repos, dotSize = 7 }: {
  repoIds: string[];
  repos: Record<string, RepoDotInfo>;
  dotSize?: number;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  useEffect(() => clearTimers, []);

  const scheduleOpen = () => {
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  const capped = repoIds.length > MAX_REPO_DOTS;
  const shown = capped ? repoIds.slice(0, MAX_REPO_DOTS - 1) : repoIds;

  return (
    <span ref={anchorRef} style={styles.group} onMouseEnter={scheduleOpen} onMouseLeave={scheduleClose}>
      {shown.map(id => (
        <span key={id} style={styles.dot(repos[id]?.color ?? '#888', dotSize)} />
      ))}
      {capped && <span style={styles.overflow}>+{repoIds.length - shown.length}</span>}
      {open && anchorRef.current && (
        <RepoListPopover
          anchor={anchorRef.current}
          repoIds={repoIds}
          repos={repos}
          onMouseEnter={clearTimers}
          onMouseLeave={scheduleClose}
        />
      )}
    </span>
  );
}

function RepoListPopover({ anchor, repoIds, repos, onMouseEnter, onMouseLeave }: {
  anchor: HTMLElement;
  repoIds: string[];
  repos: Record<string, RepoDotInfo>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measured while invisible, then placed below the dots — or above when there's no room —
  // and kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, a.right - w));
    const below = a.bottom + 4;
    const top = below + h <= window.innerHeight - 4 ? below : Math.max(4, a.top - h - 4);
    setPos({ top, left });
  }, [anchor]);

  // Display only: a press inside must not count as a click outside an open dropdown (those
  // listen for mousedown on document, natively), nor reach the row underneath.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('mousedown', stop);
    return () => el.removeEventListener('mousedown', stop);
  }, []);

  return createPortal(
    <div
      ref={ref}
      style={{ ...styles.popover, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={e => e.stopPropagation()}
    >
      <div style={styles.header}>{l10n.t('In {0} repositories', repoIds.length)}</div>
      <div style={styles.list}>
        {repoIds.map(id => (
          <div key={id} style={styles.item}>
            <span style={styles.dot(repos[id]?.color ?? '#888', 8)} />
            <span style={styles.name}>{repos[id]?.name ?? id}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

const styles = {
  group: {
    display: 'flex',
    gap: '2px',
    alignItems: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  dot: (color: string, size: number): React.CSSProperties => ({
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  overflow: {
    fontSize: '10px',
    opacity: 0.65,
    marginLeft: '1px',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  popover: {
    position: 'fixed',
    zIndex: 2000,
    background: 'var(--vscode-editorWidget-background)',
    border: '1px solid var(--vscode-widget-border)',
    borderRadius: '6px',
    padding: '6px 0',
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    minWidth: '160px',
    maxWidth: '320px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
    fontWeight: 'normal',
    color: 'var(--vscode-foreground)',
    cursor: 'default',
  } as React.CSSProperties,
  header: {
    padding: '0 10px 4px',
    fontSize: '11px',
    opacity: 0.65,
  } as React.CSSProperties,
  list: {
    maxHeight: '260px',
    overflowY: 'auto',
    padding: '0 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  } as React.CSSProperties,
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  } as React.CSSProperties,
  name: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
};
