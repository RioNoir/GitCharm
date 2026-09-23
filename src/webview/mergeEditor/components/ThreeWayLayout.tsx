import React from 'react';
import type { MergeConflictFile } from '../../shared/types';
import { MonacoPane } from './MonacoPane';
import * as l10n from '@vscode/l10n';
import type { Resolution } from '../store/mergeStore';

interface Props {
  file: MergeConflictFile;
  resultContent: string;
  resolutions: Record<number, Resolution>;
  onResultChange: (content: string) => void;
  onResolveBlock: (index: number, resolution: Resolution) => void;
  currentConflictIndex: number;
}

export function ThreeWayLayout({ file, resultContent, resolutions, onResultChange, onResolveBlock, currentConflictIndex }: Props) {
  const oursContent = file.conflicts.map(b => b.oursLines.join('\n')).join('\n---conflict---\n');
  const theirsContent = file.conflicts.map(b => b.theirsLines.join('\n')).join('\n---conflict---\n');

  const currentBlock = file.conflicts[currentConflictIndex] ?? file.conflicts[0];

  return (
    <div style={styles.container}>
      {/* Conflict toolbar for current block */}
      {currentBlock && (
        <div style={styles.conflictBar}>
          <span style={styles.conflictLabel}>
            {l10n.t('Conflict {0} of {1}', currentConflictIndex + 1, file.conflicts.length)}
          </span>
          <span style={styles.resolutionStatus(resolutions[currentConflictIndex])}>
            {resolutions[currentConflictIndex] === 'unresolved' ? `⚠ ${l10n.t('Unresolved')}` : `✓ ${l10n.t('Resolved')}`}
          </span>
          <div style={styles.actions}>
            <button
              style={styles.acceptBtn('ours')}
              onClick={() => applyResolution(file, currentConflictIndex, 'ours', resultContent, onResultChange, onResolveBlock)}
              title={l10n.t('Accept OURS (left side)')}
            >
              {l10n.t('Accept Ours')}
            </button>
            <button
              style={styles.acceptBtn('both')}
              onClick={() => applyResolution(file, currentConflictIndex, 'both', resultContent, onResultChange, onResolveBlock)}
              title={l10n.t('Accept both sides')}
            >
              {l10n.t('Accept Both')}
            </button>
            <button
              style={styles.acceptBtn('theirs')}
              onClick={() => applyResolution(file, currentConflictIndex, 'theirs', resultContent, onResultChange, onResolveBlock)}
              title={l10n.t('Accept THEIRS (right side)')}
            >
              {l10n.t('Accept Theirs')}
            </button>
          </div>
        </div>
      )}

      {/* Three panes */}
      <div style={styles.panes}>
        <MonacoPane
          value={oursContent}
          readOnly={true}
          language="plaintext"
          label={l10n.t({ message: 'OURS  ({0})', args: [file.oursLabel], comment: ['Merge editor pane header: current side of the conflict; {0} is its branch/ref label'] })}
          labelColor="var(--vscode-gitDecoration-addedResourceForeground)"
        />

        <div style={styles.divider} />

        <MonacoPane
          value={resultContent}
          onChange={onResultChange}
          readOnly={false}
          language="plaintext"
          label={l10n.t({ message: 'RESULT  (editable)', comment: ['Merge editor pane header: the editable merged result'] })}
          labelColor="var(--vscode-foreground)"
        />

        <div style={styles.divider} />

        <MonacoPane
          value={theirsContent}
          readOnly={true}
          language="plaintext"
          label={l10n.t({ message: 'THEIRS  ({0})', args: [file.theirsLabel], comment: ['Merge editor pane header: incoming side of the conflict; {0} is its branch/ref label'] })}
          labelColor="var(--vscode-charts-red, #f44747)"
        />
      </div>
    </div>
  );
}

function applyResolution(
  file: MergeConflictFile,
  blockIndex: number,
  resolution: Resolution,
  currentContent: string,
  onResultChange: (c: string) => void,
  onResolveBlock: (i: number, r: Resolution) => void
): void {
  const block = file.conflicts[blockIndex];
  if (!block) return;

  let resolved: string[];
  if (resolution === 'ours') resolved = block.oursLines;
  else if (resolution === 'theirs') resolved = block.theirsLines;
  else resolved = [...block.oursLines, ...block.theirsLines];

  // Replace conflict block in result content
  // The result starts with conflict markers, so we find and replace
  const lines = currentContent.split('\n');
  const newLines: string[] = [];
  let inConflict = false;
  let matchedBlock = false;
  let foundCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<') && !matchedBlock) {
      inConflict = true;
      if (foundCount === blockIndex) {
        newLines.push(...resolved);
        matchedBlock = true;
      }
      foundCount++;
      continue;
    }
    if (inConflict && line.startsWith('>>>>>>>')) {
      inConflict = false;
      continue;
    }
    if (inConflict) continue;
    newLines.push(line);
  }

  onResultChange(newLines.join('\n'));
  onResolveBlock(blockIndex, resolution);
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    overflow: 'hidden',
  },
  conflictBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '6px 12px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
    flexShrink: 0,
  },
  conflictLabel: {
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    opacity: 0.7,
  },
  resolutionStatus: (res: Resolution) => ({
    fontSize: '12px',
    color: res === 'unresolved'
      ? 'var(--vscode-gitDecoration-conflictingResourceForeground, #f44747)'
      : 'var(--vscode-gitDecoration-addedResourceForeground)',
  }),
  actions: {
    display: 'flex',
    gap: '6px',
    marginLeft: 'auto',
  },
  acceptBtn: (side: 'ours' | 'theirs' | 'both') => ({
    padding: '3px 10px',
    background: side === 'ours'
      ? 'var(--vscode-gitDecoration-addedResourceForeground)'
      : side === 'theirs'
        ? 'var(--vscode-charts-red, #f44747)'
        : 'var(--vscode-button-background)',
    color: '#fff',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 'bold' as const,
  }),
  panes: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  divider: {
    width: '1px',
    background: 'var(--vscode-panel-border)',
    flexShrink: 0,
  },
};
