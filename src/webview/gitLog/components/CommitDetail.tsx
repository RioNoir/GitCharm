import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { CommitNode, RepoMeta, MergeParentCommit } from '../../shared/types';
import { getVsCodeApi } from '../../shared/vscodeApi';
import type { LogToHostMsg, HostToLogMsg, IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { groupRefs, branchColor } from '../utils/refs';
import type { RefGroup } from '../utils/refs';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface Props {
  commit: CommitNode | null;
  files: Array<{ path: string; status: string; added?: number; removed?: number }>;
  selectedFile: { path: string; status: string } | null;
  loadingFiles: boolean;
  repoColor?: string;
  repos: RepoMeta[];
  iconTheme?: IconThemeData | null;
  onSelectFile: (file: { path: string; status: string }) => void;
}

const STATUS_COLORS: Record<string, string> = {
  M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
  A: 'var(--vscode-gitDecoration-addedResourceForeground)',
  D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  C: 'var(--vscode-gitDecoration-addedResourceForeground)',
};

/* ─── Tree builder ────────────────────────────────────────────────────────── */

interface FileEntry { path: string; status: string; added?: number; removed?: number; }

interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  file: FileEntry | null;
  fileCount: number;
}

function makeNode(name: string, fullPath: string): TreeNode {
  return { name, fullPath, children: new Map(), file: null, fileCount: 0 };
}

function buildTree(files: FileEntry[]): TreeNode {
  const root = makeNode('', '');
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, makeNode(part, accumulated));
      }
      node = node.children.get(part)!;
      if (i === parts.length - 1) node.file = f;
    }
  }
  computeFileCounts(root);
  return root;
}

function computeFileCounts(node: TreeNode): number {
  if (node.file) { node.fileCount = 1; return 1; }
  let count = 0;
  for (const child of node.children.values()) count += computeFileCounts(child);
  node.fileCount = count;
  return count;
}

function collapseSingleChildDirs(node: TreeNode): TreeNode {
  if (node.file) return node;
  if (node.children.size === 1) {
    const [, child] = node.children.entries().next().value as [string, TreeNode];
    if (!child.file) {
      const collapsed = collapseSingleChildDirs(child);
      const joinedName = node.name ? `${node.name}/${collapsed.name}` : collapsed.name;
      return { ...collapsed, name: joinedName };
    }
  }
  const newChildren = new Map<string, TreeNode>();
  for (const [k, v] of node.children) {
    newChildren.set(k, collapseSingleChildDirs(v));
  }
  return { ...node, children: newChildren };
}

/* ─── Tree renderer ───────────────────────────────────────────────────────── */

function TreeDir({ node, depth, selectedFile, onOpen, allExpanded, iconTheme }: {
  node: TreeNode;
  depth: number;
  selectedFile: FileEntry | null;
  onOpen: (f: FileEntry) => void;
  allExpanded: boolean | null;
  iconTheme?: IconThemeData | null;
}) {
  const [localOpen, setLocalOpen] = useState(true);
  const open = allExpanded !== null ? allExpanded : localOpen;
  const indent = depth * 14;

  if (node.file) {
    const isSelected = selectedFile?.path === node.file.path;
    const statusColor = STATUS_COLORS[node.file.status] ?? 'var(--vscode-foreground)';
    return (
      <div
        style={styles.fileRow(isSelected)}
        onClick={() => onOpen(node.file!)}
        title={`${node.file.path}\nClick to open diff`}
      >
        <div style={{ width: indent + 18, flexShrink: 0 }} />
        <FileIcon name={node.name} theme={iconTheme} size={14} style={styles.fileIconBase} />
        <span style={styles.fileName(statusColor, isSelected)}>{node.name}</span>
        {(node.file.added != null || node.file.removed != null) && (
          <span style={styles.lineStats}>
            {node.file.added != null && <span style={styles.added}>+{node.file.added}</span>}
            {node.file.removed != null && <span style={styles.removed}>-{node.file.removed}</span>}
          </span>
        )}
        <span style={styles.statusLetter(statusColor)}>{node.file.status}</span>
      </div>
    );
  }

  // Last segment of collapsed path for folder icon lookup
  const folderBaseName = node.name.includes('/') ? node.name.split('/').pop()! : node.name;

  return (
    <>
      <div style={styles.dirRow} onClick={() => { if (allExpanded === null) setLocalOpen(o => !o); }}>
        <div style={{ width: indent, flexShrink: 0 }} />
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.chevron} />
        <FileIcon name={folderBaseName} isFolder isOpen={open} theme={iconTheme} size={16} style={styles.folderIconBase} />
        <span style={styles.dirName}>{node.name}</span>
        <span style={styles.fileCountBadge}>{node.fileCount}</span>
      </div>
      {open && Array.from(node.children.values())
        .sort((a, b) => {
          if (!a.file && b.file) return -1;
          if (a.file && !b.file) return 1;
          return a.name.localeCompare(b.name);
        })
        .map(child => (
          <TreeDir key={child.fullPath} node={child} depth={depth + 1} selectedFile={selectedFile} onOpen={onOpen} allExpanded={allExpanded} iconTheme={iconTheme} />
        ))
      }
    </>
  );
}

/* ─── Badge helpers ───────────────────────────────────────────────────────── */

function badgeTitle(group: RefGroup): string {
  if (group.isTag) return `Tag: ${group.label}`;
  if (group.isRemote) return `Remote: origin/${group.label}`;
  return `Local: ${group.label}`;
}

function RefBadgeIcon({ group }: { group: RefGroup }) {
  const s: React.CSSProperties = { fontSize: '11px', flexShrink: 0, lineHeight: 1 };
  if (group.isTag) return <Codicon name="tag" style={s} />;
  if (group.isRemote) return <Codicon name="cloud" style={s} />;
  return <Codicon name="git-branch" style={s} />;
}

/* ─── Main component ──────────────────────────────────────────────────────── */

export function CommitDetail({ commit, files, selectedFile, loadingFiles, repoColor, repos, iconTheme, onSelectFile }: Props) {
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);
  const [mergeCommits, setMergeCommits] = useState<MergeParentCommit[]>([]);
  const [loadingMerge, setLoadingMerge] = useState(false);
  const [selectedMergeHash, setSelectedMergeHash] = useState<string | null>(null);
  const [mergeFiles, setMergeFiles] = useState<Array<{ path: string; status: string; added?: number; removed?: number }>>([]);
  const [loadingMergeFiles, setLoadingMergeFiles] = useState(false);
  const pendingRef = useRef<Map<string, (msg: HostToLogMsg) => void>>(new Map());

  const repoName = useMemo(() => {
    if (!commit) return null;
    return repos.find(r => r.id === commit.repoId)?.name ?? null;
  }, [commit, repos]);

  const isMerge = (commit?.parents.length ?? 0) >= 2;

  useEffect(() => {
    const handler = (event: MessageEvent<HostToLogMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      if ('requestId' in msg && msg.requestId && pendingRef.current.has(msg.requestId as string)) {
        const resolve = pendingRef.current.get(msg.requestId as string)!;
        pendingRef.current.delete(msg.requestId as string);
        resolve(msg);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    setSelectedMergeHash(null);
    setMergeFiles([]);
    if (!commit || !isMerge) { setMergeCommits([]); return; }
    setLoadingMerge(true);
    const reqId = generateId();
    pendingRef.current.set(reqId, (msg) => {
      if (msg.type === 'LOG_MERGE_COMMITS_RESULT') {
        setMergeCommits(msg.commits);
        setLoadingMerge(false);
      }
    });
    getVsCodeApi().postMessage({
      type: 'LOG_REQUEST_MERGE_COMMITS',
      requestId: reqId,
      repoId: commit.repoId,
      hash: commit.hash,
      parents: commit.parents,
    } satisfies LogToHostMsg);
  }, [commit?.hash]);

  function openVscodeDiff(file: { path: string; status: string }, hash?: string) {
    onSelectFile(file);
    if (!commit) return;
    getVsCodeApi().postMessage({
      type: 'LOG_OPEN_FILE_DIFF',
      repoId: commit.repoId,
      hash: hash ?? commit.hash,
      filePath: file.path,
    } as LogToHostMsg);
  }

  function selectMergeCommit(c: MergeParentCommit) {
    if (selectedMergeHash === c.hash) {
      setSelectedMergeHash(null);
      setMergeFiles([]);
      return;
    }
    setSelectedMergeHash(c.hash);
    setMergeFiles([]);
    setLoadingMergeFiles(true);
    const reqId = generateId();
    pendingRef.current.set(reqId, (msg) => {
      if (msg.type === 'LOG_COMMIT_FILES') {
        setMergeFiles(msg.files);
        setLoadingMergeFiles(false);
      }
    });
    getVsCodeApi().postMessage({
      type: 'LOG_REQUEST_COMMIT_FILES',
      requestId: reqId,
      repoId: commit!.repoId,
      hash: c.hash,
    } satisfies LogToHostMsg);
  }

  if (!commit) {
    return (
      <div style={styles.empty}>
        <span style={styles.emptyText}>Select a commit to view details</span>
      </div>
    );
  }

  const activeFiles = selectedMergeHash ? mergeFiles : files;
  const activeLoading = selectedMergeHash ? loadingMergeFiles : loadingFiles;
  const activeHash = selectedMergeHash ?? commit?.hash;

  const tree = viewMode === 'tree' && activeFiles.length > 0
    ? collapseSingleChildDirs(buildTree(activeFiles))
    : null;

  return (
    <div style={styles.container}>
      {/* Commit header */}
      <div style={styles.header}>
        {repoName && (
          <div style={styles.repoRow}>
            <Codicon name="repo" style={styles.repoIcon} />
            <span style={styles.repoName(repoColor)}>{repoName}</span>
          </div>
        )}
        <div style={styles.hashRow}>
          <span style={styles.hash}>{commit.shortHash}</span>
          <span style={styles.message}>{commit.message}</span>
        </div>
        <div style={styles.meta}>
          <span>{commit.authorName}</span>
          <span style={styles.dot}>·</span>
          <span>{commit.authorEmail}</span>
          <span style={styles.dot}>·</span>
          <span>{new Date(commit.authorDate).toLocaleString()}</span>
        </div>
        {commit.refs.length > 0 && (
          <div style={styles.refsRow}>
            {groupRefs(commit.refs).map(group => {
              const color = branchColor(group.label);
              return (
                <span key={group.key} style={styles.refBadge(color)} title={badgeTitle(group)}>
                  <RefBadgeIcon group={group} />
                  {group.isRemote ? `origin/${group.label}` : group.label}
                </span>
              );
            })}
          </div>
        )}

        {/* Merged commits section */}
        {isMerge && (
          <div style={styles.mergeSection}>
            <div style={styles.mergeSectionTitle}>
              <Codicon name="git-merge" style={{ fontSize: '11px', opacity: 0.7 }} />
              <span>Merged commits</span>
            </div>
            {loadingMerge && <div style={styles.mergeLoading}>Loading...</div>}
            {!loadingMerge && mergeCommits.length === 0 && (
              <div style={styles.mergeLoading}>No commits found</div>
            )}
            {!loadingMerge && mergeCommits.map(c => {
              const isActive = selectedMergeHash === c.hash;
              return (
                <div key={c.hash}>
                  <div
                    style={styles.mergeCommitRow(isActive)}
                    title={`${c.hash}\nClick to view files`}
                    onClick={() => selectMergeCommit(c)}
                  >
                    <Codicon name={isActive ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '10px', opacity: 0.5, flexShrink: 0 }} />
                    <span style={styles.mergeHash}>{c.shortHash}</span>
                    <span style={styles.mergeMessage}>{c.message}</span>
                    <span style={styles.mergeMeta}>{c.authorName}</span>
                  </div>
                  {isActive && (
                    <div style={styles.mergeFileList}>
                      {loadingMergeFiles && <div style={styles.mergeLoading}>Loading files...</div>}
                      {!loadingMergeFiles && mergeFiles.length === 0 && <div style={styles.mergeLoading}>No changed files</div>}
                      {!loadingMergeFiles && mergeFiles.map(f => {
                        const statusColor = STATUS_COLORS[f.status] ?? 'var(--vscode-foreground)';
                        const fileName = f.path.split('/').pop() ?? f.path;
                        return (
                          <div
                            key={f.path}
                            style={styles.mergeFileRow}
                            title={f.path}
                            onClick={() => openVscodeDiff(f, c.hash)}
                          >
                            <FileIcon name={fileName} theme={iconTheme} size={13} style={{ opacity: 0.85, flexShrink: 0 }} />
                            <span style={{ ...styles.mergeMessage, color: statusColor }}>{fileName}</span>
                            {(f.added != null || f.removed != null) && (
                              <span style={styles.lineStats}>
                                {f.added != null && <span style={styles.added}>+{f.added}</span>}
                                {f.removed != null && <span style={styles.removed}>-{f.removed}</span>}
                              </span>
                            )}
                            <span style={{ fontSize: '10px', fontWeight: 'bold', color: statusColor, flexShrink: 0 }}>{f.status}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* File list toolbar */}
      <div style={styles.fileListToolbar}>
        <span style={styles.fileCount}>{activeFiles.length} file{activeFiles.length !== 1 ? 's' : ''}{selectedMergeHash ? ` · ${mergeCommits.find(c => c.hash === selectedMergeHash)?.shortHash}` : ''}</span>
        {viewMode === 'tree' && (
          <div style={styles.expandBtns}>
            <button
              style={styles.toggleBtn(false)}
              onClick={() => setAllExpanded(true)}
              title="Expand all"
            >
              <Codicon name="expand-all" style={{ fontSize: '13px' }} />
            </button>
            <button
              style={styles.toggleBtn(false)}
              onClick={() => setAllExpanded(false)}
              title="Collapse all"
            >
              <Codicon name="collapse-all" style={{ fontSize: '13px' }} />
            </button>
          </div>
        )}
        <div style={styles.viewToggle}>
          <button
            style={styles.toggleBtn(viewMode === 'tree')}
            onClick={() => { setViewMode('tree'); setAllExpanded(null); }}
            title="Tree view"
          >
            <Codicon name="list-tree" style={{ fontSize: '13px' }} />
          </button>
          <button
            style={styles.toggleBtn(viewMode === 'flat')}
            onClick={() => { setViewMode('flat'); setAllExpanded(null); }}
            title="Flat view"
          >
            <Codicon name="list-flat" style={{ fontSize: '13px' }} />
          </button>
        </div>
      </div>

      {/* File list */}
      <div style={styles.fileList}>
        {activeLoading && <div style={styles.loading}>Loading files...</div>}
        {!activeLoading && activeFiles.length === 0 && (
          <div style={styles.loading}>No changed files</div>
        )}

        {viewMode === 'tree' && tree && (
          Array.from(tree.children.values())
            .sort((a, b) => {
              if (!a.file && b.file) return -1;
              if (a.file && !b.file) return 1;
              return a.name.localeCompare(b.name);
            })
            .map(child => (
              <TreeDir key={child.fullPath} node={child} depth={0} selectedFile={selectedFile} onOpen={f => openVscodeDiff(f, activeHash)} allExpanded={allExpanded} iconTheme={iconTheme} />
            ))
        )}

        {viewMode === 'flat' && activeFiles.map(file => {
          const isSelected = selectedFile?.path === file.path;
          const statusColor = STATUS_COLORS[file.status] ?? 'var(--vscode-foreground)';
          const fileName = file.path.split('/').pop() ?? file.path;
          const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

          return (
            <div
              key={file.path}
              style={styles.fileRow(isSelected)}
              onClick={() => openVscodeDiff(file, activeHash)}
              title={`${file.path}\nClick to open diff`}
            >
              <div style={{ width: 4, flexShrink: 0 }} />
              <FileIcon name={fileName} theme={iconTheme} size={14} style={styles.fileIconBase} />
              <span style={styles.fileName(statusColor, isSelected)}>{fileName}</span>
              {dir && <span style={styles.dirPath}>{dir}</span>}
              {(file.added != null || file.removed != null) && (
                <span style={styles.lineStats}>
                  {file.added != null && <span style={styles.added}>+{file.added}</span>}
                  {file.removed != null && <span style={styles.removed}>-{file.removed}</span>}
                </span>
              )}
              <span style={styles.statusLetter(statusColor)}>{file.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    borderLeft: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    borderLeft: '1px solid var(--vscode-panel-border)',
  },
  emptyText: {
    fontSize: '13px',
    opacity: 0.4,
    color: 'var(--vscode-foreground)',
  },
  header: {
    padding: '10px 12px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  repoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    marginBottom: '2px',
  } as React.CSSProperties,
  repoIcon: {
    fontSize: '11px',
    opacity: 0.6,
  } as React.CSSProperties,
  repoName: (color?: string): React.CSSProperties => ({
    fontSize: '11px',
    fontWeight: 600,
    color: color ?? 'var(--vscode-foreground)',
    opacity: 0.85,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  }),
  hashRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  hash: {
    fontFamily: 'monospace',
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
    opacity: 0.65,
    padding: '1px 4px',
    background: 'var(--vscode-badge-background)',
    borderRadius: '3px',
    flexShrink: 0,
  } as React.CSSProperties,
  message: {
    fontWeight: 'bold' as const,
    fontSize: '13px',
    color: 'var(--vscode-foreground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  meta: {
    display: 'flex',
    gap: '6px',
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
    opacity: 0.7,
    flexWrap: 'wrap' as const,
  },
  dot: {
    opacity: 0.4,
  },
  refsRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
  },
  refBadge: (color: string): React.CSSProperties => ({
    fontSize: '10px',
    padding: '0 6px',
    height: '16px',
    lineHeight: '16px',
    borderRadius: '3px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
    boxSizing: 'border-box' as const,
    fontWeight: 500,
  }),
  mergeSection: {
    marginTop: '6px',
    borderTop: '1px solid var(--vscode-panel-border)',
    paddingTop: '6px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  mergeSectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '11px',
    opacity: 0.6,
    marginBottom: '2px',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  mergeLoading: {
    fontSize: '11px',
    opacity: 0.45,
    padding: '2px 0',
  } as React.CSSProperties,
  mergeCommitRow: (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 4px',
    fontSize: '11px',
    cursor: 'pointer',
    borderRadius: '3px',
    background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
  }),
  mergeFileList: {
    marginLeft: '16px',
    marginBottom: '2px',
    borderLeft: '1px solid var(--vscode-panel-border)',
    paddingLeft: '6px',
  } as React.CSSProperties,
  mergeFileRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 4px',
    fontSize: '11px',
    cursor: 'pointer',
    borderRadius: '2px',
  } as React.CSSProperties,
  mergeHash: {
    fontFamily: 'monospace',
    fontSize: '10px',
    opacity: 0.6,
    background: 'var(--vscode-badge-background)',
    padding: '0 3px',
    borderRadius: '2px',
    flexShrink: 0,
  } as React.CSSProperties,
  mergeMessage: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  mergeMeta: {
    fontSize: '10px',
    opacity: 0.5,
    flexShrink: 0,
    maxWidth: '80px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  fileListToolbar: {
    display: 'flex',
    alignItems: 'center',
    padding: '3px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    gap: '4px',
  } as React.CSSProperties,
  fileCount: {
    flex: 1,
    fontSize: '11px',
    opacity: 0.55,
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  expandBtns: {
    display: 'flex',
    gap: '2px',
  } as React.CSSProperties,
  viewToggle: {
    display: 'flex',
    gap: '2px',
    marginLeft: '4px',
    paddingLeft: '4px',
    borderLeft: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  toggleBtn: (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--vscode-toolbar-activeBackground)' : 'transparent',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: active ? 1 : 0.5,
    padding: '2px 4px',
    display: 'flex',
    alignItems: 'center',
  }),
  fileList: {
    flex: 1,
    overflowY: 'auto' as const,
    fontSize: '12px',
  },
  fileRow: (selected: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingRight: '10px',
    paddingTop: '2px',
    paddingBottom: '2px',
    cursor: 'pointer',
    background: selected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    minHeight: '22px',
  }),
  dirRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    padding: '2px 10px 2px 0',
    cursor: 'pointer',
    minHeight: '22px',
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  chevron: {
    fontSize: '10px',
    opacity: 0.5,
    flexShrink: 0,
    width: '14px',
  } as React.CSSProperties,
  fileIconBase: {
    opacity: 0.9,
  } as React.CSSProperties,
  folderIconBase: {
    color: 'var(--vscode-symbolIcon-folderForeground, #dcb67a)',
  } as React.CSSProperties,
  dirName: {
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    opacity: 0.85,
    flex: 1,
  },
  fileCountBadge: {
    fontSize: '10px',
    opacity: 0.5,
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px',
    padding: '0 5px',
    minWidth: '16px',
    textAlign: 'center' as const,
    flexShrink: 0,
  } as React.CSSProperties,
  statusLetter: (color: string) => ({
    fontSize: '11px',
    fontWeight: 'bold' as const,
    color,
    minWidth: '14px',
    flexShrink: 0,
  }),
  fileName: (color: string, selected: boolean) => ({
    color: selected ? 'inherit' : color,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  }),
  dirPath: {
    fontSize: '10px',
    opacity: 0.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    maxWidth: '80px',
  },
  lineStats: {
    display: 'flex',
    gap: '3px',
    flexShrink: 0,
    fontSize: '10px',
    fontFamily: 'monospace',
  } as React.CSSProperties,
  added: {
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
  } as React.CSSProperties,
  removed: {
    color: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  } as React.CSSProperties,
  loading: {
    padding: '8px',
    fontSize: '11px',
    opacity: 0.6,
    color: 'var(--vscode-foreground)',
    textAlign: 'center' as const,
  },
};
