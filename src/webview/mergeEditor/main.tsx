import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { useMergeStore } from './store/mergeStore';
import { ThreeWayLayout } from './components/ThreeWayLayout';
import { getVsCodeApi } from '../shared/vscodeApi';
import type { MergeToHostMsg, HostToMergeMsg } from '../../host/types/messages';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function App() {
  const store = useMergeStore();
  const [currentConflictIndex, setCurrentConflictIndex] = useState(0);
  const [, setRawFileContent] = useState<string>('');

  const send = useCallback((msg: MergeToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToMergeMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'MERGE_FILE_LOADED': {
          store.setFile(msg.file);
          // Build initial result: the raw file content with conflict markers
          // The user edits this directly
          const initialContent = buildRawConflictContent(msg.file);
          store.setResultContent(initialContent);
          setRawFileContent(initialContent);
          break;
        }
        case 'MERGE_SAVE_RESULT':
          store.setSaving(false);
          if (msg.ok) {
            store.setSavedOk(true);
          } else {
            store.setError(msg.error ?? 'Save failed');
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleSave = useCallback(() => {
    store.setSaving(true);
    const reqId = generateId();
    send({
      type: 'MERGE_SAVE_FILE',
      requestId: reqId,
      resolvedContent: store.resultContent,
    });
  }, [store.resultContent]);

  const handlePrevConflict = () => {
    setCurrentConflictIndex(i => Math.max(0, i - 1));
  };

  const handleNextConflict = () => {
    const max = (store.file?.conflicts.length ?? 1) - 1;
    setCurrentConflictIndex(i => Math.min(max, i + 1));
  };

  if (!store.file) {
    return (
      <div style={loadingStyle}>
        <div style={loadingText}>Loading conflict file...</div>
      </div>
    );
  }

  const unresolved = store.unresolvedCount();
  const totalConflicts = store.file.conflicts.length;

  return (
    <div style={appStyle}>
      {/* Header */}
      <div style={header}>
        <div style={headerLeft}>
          <span style={fileName}>{store.file.relativePath}</span>
          <span style={conflictCount(unresolved > 0)}>
            {unresolved > 0 ? `${unresolved} conflicts remaining` : '✓ All conflicts resolved'}
          </span>
        </div>
        <div style={headerActions}>
          <button style={navBtn} onClick={handlePrevConflict} disabled={currentConflictIndex === 0}>
            ↑ Prev
          </button>
          <span style={conflictNav}>
            {currentConflictIndex + 1} / {totalConflicts}
          </span>
          <button style={navBtn} onClick={handleNextConflict} disabled={currentConflictIndex >= totalConflicts - 1}>
            ↓ Next
          </button>
          <div style={divider} />
          <button
            style={saveBtn(unresolved === 0 && !store.saving)}
            onClick={handleSave}
            disabled={store.saving}
            title={unresolved > 0 ? 'There are still unresolved conflicts' : 'Save and mark as resolved'}
          >
            {store.saving ? 'Saving...' : store.savedOk ? '✓ Saved' : 'Apply & Mark Resolved'}
          </button>
        </div>
      </div>

      {store.error && (
        <div style={errorBar}>{store.error}</div>
      )}

      {/* 3-way layout */}
      <ThreeWayLayout
        file={store.file}
        resultContent={store.resultContent}
        resolutions={store.resolutions}
        onResultChange={store.setResultContent}
        onResolveBlock={store.resolveBlock}
        currentConflictIndex={currentConflictIndex}
      />
    </div>
  );
}

function buildRawConflictContent(file: import('../shared/types').MergeConflictFile): string {
  // Build the raw file content with conflict markers as the starting point for the result editor
  const lines: string[] = [];
  for (const block of file.conflicts) {
    lines.push(`<<<<<<< ${block.oursLabel}`);
    lines.push(...block.oursLines);
    if (block.baseLines.length > 0) {
      lines.push('||||||| base');
      lines.push(...block.baseLines);
    }
    lines.push('=======');
    lines.push(...block.theirsLines);
    lines.push(`>>>>>>> ${block.theirsLabel}`);
  }
  return lines.join('\n');
}

const appStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--vscode-editor-background)',
  color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
  overflow: 'hidden',
};

const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  borderBottom: '1px solid var(--vscode-panel-border)',
  background: 'var(--vscode-editor-background)',
  flexShrink: 0,
};

const headerLeft: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
};

const fileName: React.CSSProperties = {
  fontWeight: 'bold',
  fontSize: '13px',
};

const conflictCount = (hasConflicts: boolean): React.CSSProperties => ({
  fontSize: '12px',
  color: hasConflicts
    ? 'var(--vscode-gitDecoration-conflictingResourceForeground, #f44747)'
    : 'var(--vscode-gitDecoration-addedResourceForeground)',
});

const headerActions: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const navBtn: React.CSSProperties = {
  padding: '3px 8px',
  background: 'var(--vscode-button-secondaryBackground)',
  color: 'var(--vscode-button-secondaryForeground)',
  border: 'none',
  borderRadius: '3px',
  cursor: 'pointer',
  fontSize: '11px',
};

const conflictNav: React.CSSProperties = {
  fontSize: '11px',
  opacity: 0.7,
  minWidth: '40px',
  textAlign: 'center',
};

const divider: React.CSSProperties = {
  width: '1px',
  height: '16px',
  background: 'var(--vscode-panel-border)',
  margin: '0 4px',
};

const saveBtn = (enabled: boolean): React.CSSProperties => ({
  padding: '4px 14px',
  background: enabled ? 'var(--vscode-button-background)' : 'var(--vscode-button-background)',
  color: 'var(--vscode-button-foreground)',
  border: 'none',
  borderRadius: '3px',
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.5,
  fontSize: '12px',
  fontWeight: 'bold',
});

const errorBar: React.CSSProperties = {
  padding: '6px 12px',
  background: 'var(--vscode-inputValidation-errorBackground)',
  color: 'var(--vscode-inputValidation-errorForeground)',
  fontSize: '12px',
  borderBottom: '1px solid var(--vscode-inputValidation-errorBorder)',
};

const loadingStyle: React.CSSProperties = {
  height: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--vscode-editor-background)',
  color: 'var(--vscode-foreground)',
};

const loadingText: React.CSSProperties = {
  fontSize: '13px',
  opacity: 0.6,
};

createRoot(document.getElementById('root')!).render(<App />);
