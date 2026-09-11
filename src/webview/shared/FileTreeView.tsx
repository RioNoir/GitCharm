import React, { useState } from 'react';
import type { ChangedFile, IconThemeData } from '../../host/types/messages';
import { Codicon } from './Codicon';
import { GenericFileTree, type GenericTreeFile } from './GenericFileTree';

interface Props {
  files: ChangedFile[];
  iconTheme: IconThemeData | null;
  onOpenFile: (file: ChangedFile) => void;
}

const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

const STATUS_COLORS: Record<string, string> = {
  M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
  A: 'var(--vscode-gitDecoration-addedResourceForeground)',
  D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
};

function statusColor(status: string): string {
  return STATUS_COLORS[STATUS_LETTER[status as ChangedFile['status']] ?? status] ?? 'var(--vscode-foreground)';
}
function statusLetter(status: string): string {
  return STATUS_LETTER[status as ChangedFile['status']] ?? 'M';
}

/** Adapts `ChangedFile`'s additions/deletions naming to `GenericTreeFile`'s added/removed, keeping the original file for `onOpenFile`. */
interface TreeFile extends GenericTreeFile {
  original: ChangedFile;
}

function toTreeFile(file: ChangedFile): TreeFile {
  return { path: file.path, status: file.status, added: file.additions, removed: file.deletions, original: file };
}

/* ─── Public component ───────────────────────────────────────────────────── */

export function FileTreeView({ files, iconTheme, onOpenFile }: Props) {
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  const [dirOverrides, setDirOverrides] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);

  const isDirOpen = (dirPath: string) => {
    const defaultOpen = allExpanded ?? true;
    return dirOverrides.has(dirPath) ? !defaultOpen : defaultOpen;
  };
  const toggleDir = (dirPath: string) => {
    setDirOverrides(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath); else next.add(dirPath);
      return next;
    });
  };
  const applyAllExpanded = (value: boolean | null) => {
    setAllExpanded(value);
    setDirOverrides(new Set());
  };

  if (files.length === 0) return <div style={css.empty}>No changed files.</div>;

  const treeFiles = files.map(toTreeFile);

  return (
    <div style={css.wrapper}>
      <div style={css.toolbar}>
        <span style={css.fileCountLabel}>{files.length} file{files.length === 1 ? '' : 's'} changed</span>
        <div style={{ flex: 1 }} />
        {viewMode === 'tree' && (
          <>
            <button className="icon-btn" style={css.toolbarBtn(false)} onClick={() => applyAllExpanded(true)} title="Expand all">
              <Codicon name="expand-all" style={{ fontSize: '14px' }} />
            </button>
            <button className="icon-btn" style={css.toolbarBtn(false)} onClick={() => applyAllExpanded(false)} title="Collapse all">
              <Codicon name="collapse-all" style={{ fontSize: '14px' }} />
            </button>
          </>
        )}
        <button className="icon-btn" style={css.toolbarBtn(viewMode === 'tree')} onClick={() => { setViewMode('tree'); applyAllExpanded(null); }} title="Tree view">
          <Codicon name="list-tree" style={{ fontSize: '14px' }} />
        </button>
        <button className="icon-btn" style={css.toolbarBtn(viewMode === 'flat')} onClick={() => { setViewMode('flat'); applyAllExpanded(null); }} title="Flat view">
          <Codicon name="list-flat" style={{ fontSize: '14px' }} />
        </button>
      </div>
      <div style={css.root}>
        <GenericFileTree<TreeFile>
          files={treeFiles}
          viewMode={viewMode}
          iconTheme={iconTheme}
          statusColor={statusColor}
          statusLetter={statusLetter}
          isDirOpen={isDirOpen}
          toggleDir={toggleDir}
          onOpenFile={f => onOpenFile(f.original)}
        />
      </div>
    </div>
  );
}

const css = {
  wrapper: { display: 'flex', flexDirection: 'column' as const, gap: '8px' },
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
  toolbar: { display: 'flex', alignItems: 'center', gap: '6px' } as React.CSSProperties,
  fileCountLabel: { fontSize: '12px', opacity: 0.6 },
  toolbarBtn: (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '26px',
    background: active ? 'var(--vscode-toolbar-activeBackground)' : 'transparent',
    border: '1px solid transparent', borderColor: active ? 'var(--vscode-panel-border)' : 'transparent',
    borderRadius: '4px', cursor: 'pointer', color: 'inherit', opacity: 0.9,
  }),
  root: {
    display: 'flex', flexDirection: 'column' as const, border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px', overflow: 'hidden', fontSize: '12px',
  } as React.CSSProperties,
};
