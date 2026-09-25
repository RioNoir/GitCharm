/**
 * Undocked panel — mounts both the Git Log and Commit Panel side by side.
 *
 * Host → Webview messages are wrapped: { target: 'log'|'commit', msg: <payload> }
 * Webview → Host messages are raw — the host routes them by type prefix (LOG_* vs COMMIT_*).
 *
 * acquireVsCodeApi() is called once; all sub-app components share the same API
 * instance within this bundle. Incoming messages are dispatched to each sub-app
 * via the central dispatcher below, which fires synthetic MessageEvents.
 */

// ── Must be the very first import — patches window.addEventListener ───────────
import './setupDispatch';
import '../shared/l10n';

import React from 'react';
import { createRoot } from 'react-dom/client';

// ── Log sub-app — mounts the full Git Log ────────────────────────────────────
import { LogApp } from '../gitLog/main';

// ── Commit sub-app — mounts the full commit panel ────────────────────────────
// The App component from commitPanel is mounted as a self-contained child.
// It uses window.addEventListener('message', ...) for incoming messages and
// getVsCodeApi().postMessage for outgoing — both are handled by the shared
// singleton in this bundle.
import { CommitApp } from '../commitPanel/main';

// ── Shared utilities ──────────────────────────────────────────────────────────
import { ResizeHandle } from '../shared/ResizeHandle';
import { useResize } from '../shared/useResize';

// ── Root split layout ─────────────────────────────────────────────────────────

declare const window: Window & { __INITIAL_CONFIG__?: { showCommit?: boolean } };

function UndockedApp() {
  const { panelRef: commitRef, onMouseDown: onCommitResize } = useResize('right', 420, 280, 700);
  const showCommit = window.__INITIAL_CONFIG__?.showCommit !== false;

  return (
    <div style={rootStyle}>
      {showCommit && (
        <>
          <div ref={commitRef} style={commitPane}>
            <CommitApp />
          </div>
          <ResizeHandle onMouseDown={onCommitResize} />
        </>
      )}
      <div style={logPane}>
        <LogApp />
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const rootStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  height: '100vh',
  overflow: 'hidden',
  background: 'var(--vscode-editor-background)',
  color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
};

const logPane: React.CSSProperties = {
  flex: 1,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const commitPane: React.CSSProperties = {
  width: '420px',
  flexShrink: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  borderLeft: '1px solid var(--vscode-panel-border)',
};

createRoot(document.getElementById('root')!).render(<UndockedApp />);
