import React, { useState } from 'react';
import type { IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { GenericFileTree, type GenericTreeFile } from '../../shared/GenericFileTree';
import { handleTreeNavKeyDown } from '../../shared/keyboardNav';
import { plural } from '../../shared/l10n';
import * as l10n from '@vscode/l10n';

export interface WorkingTreeDiffFile extends GenericTreeFile {
  oldPath?: string;
  repoId: string;
  ref: string;
}

export interface WorkingTreeDiffGroup {
  repoId: string;
  ref: string;
  files: Array<{ path: string; status: string; oldPath?: string }>;
}

interface Props {
  label: string;
  groups: WorkingTreeDiffGroup[];
  repos: Array<{ id: string; name: string }>;
  iconTheme: IconThemeData | null;
  onShowDiff: (file: WorkingTreeDiffFile) => void;
  onGetFromBranch: (file: WorkingTreeDiffFile) => void;
  onShowDirDiff: (dirPath: string, files: WorkingTreeDiffFile[]) => void;
  onGetDirFromBranch: (dirPath: string, files: WorkingTreeDiffFile[]) => void;
  onRefresh: () => void;
  onClose: () => void;
}

type DiffMenu =
  | { x: number; y: number; kind: 'file'; file: WorkingTreeDiffFile }
  | { x: number; y: number; kind: 'dir'; dirPath: string; repoId: string; files: WorkingTreeDiffFile[] };

const STATUS_COLORS: Record<string, string> = {
  M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
  A: 'var(--vscode-gitDecoration-addedResourceForeground)',
  D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  C: 'var(--vscode-gitDecoration-addedResourceForeground)',
  U: 'var(--vscode-gitDecoration-untrackedResourceForeground)',
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--vscode-foreground)';
}

export function WorkingTreeBranchDiff({ label, groups, repos, iconTheme, onShowDiff, onGetFromBranch, onShowDirDiff, onGetDirFromBranch, onRefresh, onClose }: Props) {
  const [dirOverrides, setDirOverrides] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<DiffMenu | null>(null);

  const files = groups.flatMap(group => group.files.map(file => ({
    ...file,
    repoId: group.repoId,
    ref: group.ref,
  })));
  const multiRepo = groups.length > 1;

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

  const showDiff = (file: WorkingTreeDiffFile) => {
    setSelected(`${file.repoId}:${file.path}`);
    setMenu(null);
    onShowDiff(file);
  };

  const renderTree = (treeFiles: WorkingTreeDiffFile[], dirPrefix: string) => (
    <GenericFileTree<WorkingTreeDiffFile>
      files={treeFiles}
      viewMode="tree"
      compact
      basePad={dirPrefix ? 22 : undefined}
      iconTheme={iconTheme}
      statusColor={statusColor}
      statusLetter={status => status}
      isDirOpen={dir => isDirOpen(dirPrefix + dir)}
      toggleDir={dir => toggleDir(dirPrefix + dir)}
      isFileSelected={file => selected === `${file.repoId}:${file.path}`}
      isFileContextActive={file => menu?.kind === 'file' && menu.file.repoId === file.repoId && menu.file.path === file.path}
      isDirContextActive={dirPath => menu?.kind === 'dir' && menu.dirPath === dirPath && menu.repoId === (treeFiles[0]?.repoId ?? '')}
      onOpenFile={file => showDiff(file)}
      onContextMenuFile={(event, file) => {
        setSelected(`${file.repoId}:${file.path}`);
        setMenu({ kind: 'file', x: event.clientX, y: event.clientY, file });
      }}
      onContextMenuDir={(event, dirPath, dirFiles) => {
        setMenu({ kind: 'dir', x: event.clientX, y: event.clientY, dirPath, repoId: dirFiles[0]?.repoId ?? '', files: dirFiles });
      }}
    />
  );

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>{l10n.t('"{0}" vs Working Tree', label)}</div>
        <button type="button" style={styles.close} title={l10n.t('Close')} onClick={onClose}>
          <Codicon name="close" style={{ fontSize: '16px' }} />
        </button>
      </div>
      <div style={styles.toolbar}>
        <span style={styles.count}>{plural(files.length, l10n.t('1 file'), l10n.t('{0} files', files.length))}</span>
        <button type="button" style={styles.iconBtn} title={l10n.t('Refresh')} onClick={onRefresh}>
          <Codicon name="refresh" style={{ fontSize: '14px' }} />
        </button>
        <button type="button" style={styles.iconBtn} title={l10n.t('Expand all')} onClick={() => applyAllExpanded(true)}>
          <Codicon name="expand-all" style={{ fontSize: '14px' }} />
        </button>
        <button type="button" style={styles.iconBtn} title={l10n.t('Collapse all')} onClick={() => applyAllExpanded(false)}>
          <Codicon name="collapse-all" style={{ fontSize: '14px' }} />
        </button>
      </div>
      <div style={styles.list} onKeyDown={event => handleTreeNavKeyDown(event, event.currentTarget)}>
        {multiRepo
          ? groups.map(group => {
            const repoFiles = files.filter(file => file.repoId === group.repoId);
            const collapsed = collapsedRepos.has(group.repoId);
            const repoName = repos.find(repo => repo.id === group.repoId)?.name ?? group.repoId;
            return (
              <div key={group.repoId}>
                <div
                  data-nav-row=""
                  tabIndex={-1}
                  style={styles.repoHeader}
                  onClick={() => setCollapsedRepos(prev => {
                    const next = new Set(prev);
                    if (next.has(group.repoId)) next.delete(group.repoId); else next.add(group.repoId);
                    return next;
                  })}
                >
                  <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={{ fontSize: '12px' }} />
                  <span style={styles.repoName}>{repoName}</span>
                  <span style={styles.repoRef}>{group.ref}</span>
                </div>
                {!collapsed && renderTree(repoFiles, `${group.repoId}:`)}
              </div>
            );
          })
          : renderTree(files, '')}
        {files.length === 0 && <div style={styles.empty}>{l10n.t('No changed files')}</div>}
      </div>
      {menu && (
        <FileMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onShowDiff={() => {
            if (menu.kind === 'file') showDiff(menu.file);
            else { setMenu(null); onShowDirDiff(menu.dirPath, menu.files); }
          }}
          onGetFromBranch={() => {
            if (menu.kind === 'file') { setMenu(null); onGetFromBranch(menu.file); }
            else { setMenu(null); onGetDirFromBranch(menu.dirPath, menu.files); }
          }}
        />
      )}
    </div>
  );
}

function FileMenu({ x, y, onClose, onShowDiff, onGetFromBranch }: {
  x: number;
  y: number;
  onClose: () => void;
  onShowDiff: () => void;
  onGetFromBranch: () => void;
}) {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onPointer = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [onClose]);

  const left = Math.max(4, Math.min(x, window.innerWidth - 220));
  const top = Math.max(4, Math.min(y, window.innerHeight - 120));
  const item = (label: string, icon: string, action: () => void) => (
    <button
      type="button"
      style={styles.menuItem}
      onMouseDown={event => event.stopPropagation()}
      onMouseEnter={event => {
        event.currentTarget.style.background = 'var(--vscode-menu-selectionBackground)';
        event.currentTarget.style.color = 'var(--vscode-menu-selectionForeground)';
      }}
      onMouseLeave={event => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = 'inherit';
      }}
      onClick={() => { action(); }}
    >
      <Codicon name={icon} style={{ fontSize: '14px' }} />
      {label}
    </button>
  );

  return (
    <div style={{ ...styles.menu, left, top }} onMouseDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
      {item(l10n.t('Show Diff'), 'diff', onShowDiff)}
      <div style={styles.menuSep} />
      {item(l10n.t('Get from Branch'), 'cloud-download', onGetFromBranch)}
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    minWidth: 0,
    background: 'var(--vscode-sideBar-background)',
    color: 'var(--vscode-foreground)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '10px 8px 6px 12px',
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: '13px',
    fontWeight: 600,
    lineHeight: '18px',
  },
  close: {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
  } as React.CSSProperties,
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '0 8px 4px 12px',
  },
  count: { fontSize: '12px', opacity: 0.7, marginRight: 'auto' },
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    width: '22px',
    height: '22px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '3px',
  } as React.CSSProperties,
  list: { flex: 1, overflow: 'auto', minHeight: 0 },
  repoHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: '12px',
  } as React.CSSProperties,
  repoName: { fontWeight: 600 },
  repoRef: { opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  empty: { padding: '12px', fontSize: '12px', opacity: 0.6 },
  menu: {
    position: 'fixed' as const,
    zIndex: 20,
    minWidth: '200px',
    padding: '4px 0',
    background: 'var(--vscode-menu-background)',
    color: 'var(--vscode-menu-foreground)',
    border: '1px solid var(--vscode-menu-border, transparent)',
    borderRadius: '4px',
    boxShadow: '0 2px 8px var(--vscode-widget-shadow)',
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '4px 12px',
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    font: 'inherit',
    fontSize: '12px',
    textAlign: 'left' as const,
    cursor: 'pointer',
  } as React.CSSProperties,
  menuSep: { height: '1px', margin: '4px 0', background: 'var(--vscode-menu-separatorBackground, var(--vscode-panel-border))' },
};
