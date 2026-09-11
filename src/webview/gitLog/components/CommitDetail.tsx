import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import type { CommitNode, RepoMeta, MergeParentCommit } from '../../shared/types';
import { getVsCodeApi } from '../../shared/vscodeApi';
import type { LogToHostMsg, HostToLogMsg, IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { groupRefs, branchColor, tagColor, headColor } from '../utils/refs';
import { formatDateTime } from '../../shared/dateUtils';
import type { RefGroup } from '../utils/refs';
import { isPrimaryBranch } from '../../shared/branchUtils';
import { AuthorAvatar } from '../../shared/AuthorAvatar';
import { GenericFileTree } from '../../shared/GenericFileTree';

const STASH_COLOR = '#e07b39';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const IS_MAC = navigator.userAgent.includes('Mac');
const IS_WIN = navigator.userAgent.includes('Windows');
const REVEAL_OS_LABEL = IS_MAC ? 'Reveal in Finder' : IS_WIN ? 'Show in Explorer' : 'Show in File Manager';

interface FileContextMenuProps {
  x: number;
  y: number;
  file: { path: string; status: string };
  onShowDiff: () => void;
  onShowCombinedDiff: () => void;
  onEditSource: () => void;
  onFileHistory: () => void;
  onCompareWith: () => void;
  onCherryPickFile: () => void;
  onRevertFile: () => void;
  onRevealExplorer: () => void;
  onRevealOS: () => void;
  onClose: () => void;
  canApplyCommitChanges: boolean;
}

function FileContextMenu({ x, y, onShowDiff, onShowCombinedDiff, onEditSource, onFileHistory, onCompareWith, onCherryPickFile, onRevertFile, onRevealExplorer, onRevealOS, onClose, canApplyCommitChanges }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const margin = 4;
    setPos({
      x: Math.max(margin, Math.min(x, window.innerWidth  - w - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - h - margin)),
    });
  }, [x, y]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', h, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', h, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: pos?.x ?? x,
    top: pos?.y ?? y,
    visibility: pos ? 'visible' : 'hidden',
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    padding: '3px 0',
    zIndex: 9999,
    minWidth: '160px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  };

  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    userSelect: 'none',
  };

  const hoverStyle = { background: 'var(--vscode-menu-selectionBackground)', color: 'var(--vscode-menu-selectionForeground)' };

  const Item = ({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) => {
    const [hovered, setHovered] = useState(false);
    return (
      <div
        style={{ ...itemStyle, ...(hovered ? hoverStyle : {}) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => { onClick(); onClose(); }}
      >
        <Codicon name={icon} style={{ fontSize: '13px', flexShrink: 0 }} />
        {label}
      </div>
    );
  };

  return (
    <div ref={menuRef} style={menuStyle} onContextMenu={e => e.preventDefault()}>
      <Item icon="diff" label="Show Diff" onClick={onShowDiff} />
      <Item icon="diff-multiple" label="Show Combined Diff" onClick={onShowCombinedDiff} />
      <Item icon="git-compare" label="Compare with…" onClick={onCompareWith} />
      <Item icon="history" label="Show File History" onClick={onFileHistory} />
      <Item icon="go-to-file" label="Edit Source" onClick={onEditSource} />
      {canApplyCommitChanges && (
        <>
          <Item icon="git-commit" label="Cherry-Pick Selected Changes" onClick={onCherryPickFile} />
          <Item icon="discard" label="Revert Selected Changes" onClick={onRevertFile} />
        </>
      )}
      <Item icon="list-tree" label="Reveal in Explorer" onClick={onRevealExplorer} />
      <Item icon="folder-opened" label="Reveal in File Manager" onClick={onRevealOS} />
    </div>
  );
}

interface Props {
  commit: CommitNode | null;
  /** Full (multi-line) commit message body — only used in twoColumnLayout mode's expanded "Commit message" section. Falls back to `commit.message` (subject only) when omitted. */
  fullMessage?: string;
  range?: { older: CommitNode; newer: CommitNode };
  files: Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }>;
  selectedFile: { path: string; status: string } | null;
  loadingFiles: boolean;
  repoColor?: string;
  repos: RepoMeta[];
  iconTheme?: IconThemeData | null;
  onSelectFile: (file: { path: string; status: string }) => void;
  onClose?: () => void;
  refColors?: Map<string, string>;
  themeVersion?: number;
  activeProfile?: { name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' };
  /** Hides the "Open extended commit detail" button — used when this component IS the extended/full detail view, so the button would otherwise be a dead no-op there. */
  hideExtendedDetailButton?: boolean;
  /** Renders the commit header (author/hash/dates/refs/message/merge list) and the file list
   * side by side instead of stacked — for use in a full-page context (the "Open Full Detail"
   * panel) where there's room for two columns, unlike the narrow Git Log sidebar this
   * component is otherwise embedded in. */
  twoColumnLayout?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
  A: 'var(--vscode-gitDecoration-addedResourceForeground)',
  D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  C: 'var(--vscode-gitDecoration-addedResourceForeground)',
};

interface FileEntry { path: string; status: string; added?: number; removed?: number; oldPath?: string; }

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--vscode-foreground)';
}

/* ─── Badge helpers ───────────────────────────────────────────────────────── */

function remoteLabel(group: RefGroup): string {
  const r = group.remoteName || 'remote';
  return `${r}/${group.label}`;
}

function badgeTitle(group: RefGroup): string {
  if (group.isRemoteHead) return `Remote HEAD (${group.remoteName}/HEAD)`;
  if (group.isDetached && group.isHead) return 'HEAD (detached)';
  if (group.isTag) return `Tag: ${group.label}`;
  if (group.isRemote) return `Remote: ${remoteLabel(group)}`;
  return `Local: ${group.label}`;
}

function RefBadgeIcon({ group }: { group: RefGroup }) {
  const s: React.CSSProperties = { fontSize: '11px', flexShrink: 0, lineHeight: 1 };
  if (group.isRemoteHead) return <Codicon name="milestone" style={s} />;
  if (group.isDetached && group.isHead) return <Codicon name="warning" style={s} />;
  if (group.isTag) return <Codicon name="tag" style={s} />;
  if (group.isRemote) return <Codicon name="cloud" style={s} />;
  return <Codicon name="git-branch" style={s} />;
}

/* ─── Main component ──────────────────────────────────────────────────────── */

export function CommitDetail({ commit, fullMessage, range, files, selectedFile, loadingFiles, repoColor, repos, iconTheme, onSelectFile, onClose, refColors, activeProfile, hideExtendedDetailButton, twoColumnLayout }: Props) {
  // Same id/rule as CommitList.tsx's injection — that component isn't always mounted alongside
  // this one (e.g. the standalone "Full Detail" panel), so this component injects its own copy
  // of the [data-top-action-btn] hover rule its own toolbar buttons rely on. The shared id makes
  // this a no-op when CommitList.tsx already injected it.
  useEffect(() => {
    const id = 'gitcharm-log-action-btn-hover';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `[data-log-action-btn]:hover { background: var(--vscode-toolbar-hoverBackground) !important; opacity: 1 !important; }
[data-top-action-btn]:hover { background: var(--vscode-toolbar-hoverBackground) !important; opacity: 1 !important; }
[data-ctx-item]:hover { background: var(--vscode-menu-selectionBackground) !important; color: var(--vscode-menu-selectionForeground) !important; }`;
    document.head.appendChild(s);
  }, []);

  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);
  // Per-directory overrides on top of the Expand All/Collapse All default — cleared whenever
  // that default changes (including switching view mode, which resets allExpanded to null).
  const [dirOverrides, setDirOverrides] = useState<Set<string>>(new Set());
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
  const [mergeCommits, setMergeCommits] = useState<MergeParentCommit[]>([]);
  const [loadingMerge, setLoadingMerge] = useState(false);
  const [selectedMergeHash, setSelectedMergeHash] = useState<string | null>(null);
  const [mergeFiles, setMergeFiles] = useState<Array<{ path: string; status: string; added?: number; removed?: number }>>([]);
  const [loadingMergeFiles, setLoadingMergeFiles] = useState(false);
  const pendingRef = useRef<Map<string, (msg: HostToLogMsg) => void>>(new Map());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: FileEntry } | null>(null);
  const [refsExpanded, setRefsExpanded] = useState(false);
  const [descendantBranches, setDescendantBranches] = useState<{ local: string[]; remote: string[]; tags: string[] }>({ local: [], remote: [], tags: [] });
  const [loadingDescendants, setLoadingDescendants] = useState(false);
  const [descendantsExpanded, setDescendantsExpanded] = useState(false);

  const repoName = useMemo(() => {
    const activeCommit = range?.newer ?? commit;
    if (!activeCommit) return null;
    return repos.find(r => r.id === activeCommit.repoId)?.name ?? null;
  }, [commit, range, repos]);

  const isMerge = !range && (commit?.parents.length ?? 0) >= 2;

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

  useEffect(() => { setRefsExpanded(false); }, [commit?.hash, range]);

  // Descendant branches/tags — those that contain this commit without pointing at it
  // directly — are fetched separately from the exact-match refs shown as badges above,
  // so a lazy `git branch --contains` scan never blocks or clutters the primary view.
  useEffect(() => {
    setDescendantsExpanded(false);
    if (range || !commit || commit.isStash) { setDescendantBranches({ local: [], remote: [], tags: [] }); setLoadingDescendants(false); return; }
    setLoadingDescendants(true);
    const reqId = generateId();
    pendingRef.current.set(reqId, (msg) => {
      if (msg.type === 'LOG_COMMIT_BRANCHES_RESULT') {
        setDescendantBranches(msg.branches);
        setLoadingDescendants(false);
      }
    });
    getVsCodeApi().postMessage({
      type: 'LOG_REQUEST_COMMIT_BRANCHES',
      requestId: reqId,
      repoId: commit.repoId,
      hash: commit.hash,
    } satisfies LogToHostMsg);
  }, [commit?.hash, range]);

  useEffect(() => {
    setSelectedMergeHash(null);
    setMergeFiles([]);
    if (range || !commit || !isMerge || commit.isStash) { setMergeCommits([]); return; }
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
  }, [commit?.hash, range]);

  function openVscodeDiff(file: FileEntry, hash?: string, combined?: boolean) {
    onSelectFile(file);
    if (range) {
      getVsCodeApi().postMessage({
        type: 'LOG_OPEN_RANGE_FILE_DIFF',
        repoId: range.newer.repoId,
        hashes: [range.older.hash, range.newer.hash],
        filePath: file.path,
        fileStatus: file.status,
        oldPath: file.oldPath,
      } satisfies LogToHostMsg);
      return;
    }
    if (!commit) return;
    getVsCodeApi().postMessage({
      type: 'LOG_OPEN_FILE_DIFF',
      repoId: commit.repoId,
      hash: hash ?? commit.hash,
      filePath: file.path,
      fileStatus: file.status,
      oldPath: file.oldPath,
      parents: commit.parents,
      combined,
    } as LogToHostMsg);
  }

  const handleCtxShowDiff = useCallback(() => {
    if (!ctxMenu || !commit) return;
    openVscodeDiff(ctxMenu.file);
    setCtxMenu(null);
  }, [ctxMenu, commit]);

  const handleCtxShowCombinedDiff = useCallback(() => {
    if (!ctxMenu || !commit) return;
    openVscodeDiff(ctxMenu.file, undefined, true);
    setCtxMenu(null);
  }, [ctxMenu, commit]);

  const handleCtxEditSource = useCallback(() => {
    if (!ctxMenu || !commit) return;
    getVsCodeApi().postMessage({ type: 'LOG_OPEN_FILE', repoId: commit.repoId, filePath: ctxMenu.file.path } as LogToHostMsg);
    setCtxMenu(null);
  }, [ctxMenu, commit]);

  const handleCtxRevertFile = useCallback(() => {
    if (!ctxMenu || !commit || commit.isStash) return;
    const reqId = generateId();
    getVsCodeApi().postMessage({
      type: 'LOG_REVERT_FILE',
      requestId: reqId,
      repoId: commit.repoId,
      hash: commit.hash,
      filePath: ctxMenu.file.path,
      fileStatus: ctxMenu.file.status,
    } as LogToHostMsg);
    setCtxMenu(null);
  }, [ctxMenu, commit]);

  const handleCtxCherryPickFile = useCallback(() => {
    if (!ctxMenu || !commit || commit.isStash) return;
    const reqId = generateId();
    getVsCodeApi().postMessage({
      type: 'LOG_CHERRY_PICK_FILE',
      requestId: reqId,
      repoId: commit.repoId,
      hash: selectedMergeHash ?? commit.hash,
      filePath: ctxMenu.file.path,
      oldPath: ctxMenu.file.oldPath,
    } as LogToHostMsg);
    setCtxMenu(null);
  }, [ctxMenu, commit, selectedMergeHash]);

  const handleCtxRevealExplorer = useCallback(() => {
    if (!ctxMenu || !commit) return;
    getVsCodeApi().postMessage({ type: 'LOG_REVEAL_IN_EXPLORER', repoId: commit.repoId, filePath: ctxMenu.file.path } as LogToHostMsg);
    setCtxMenu(null);
  }, [ctxMenu, commit]);

  const handleCtxRevealOS = useCallback(() => {
    if (!ctxMenu || !commit) return;
    getVsCodeApi().postMessage({ type: 'LOG_REVEAL_IN_OS', repoId: commit.repoId, filePath: ctxMenu.file.path } as LogToHostMsg);
    setCtxMenu(null);
  }, [ctxMenu, commit]);

  const handleCtxFileHistory = useCallback(() => {
    if (!ctxMenu || !commit) return;
    getVsCodeApi().postMessage({ type: 'LOG_SHOW_FILE_HISTORY', repoId: commit.repoId, filePath: ctxMenu.file.path } as LogToHostMsg);
    setCtxMenu(null);
  }, [ctxMenu, commit]);

  const handleCtxCompareWith = useCallback(() => {
    if (!ctxMenu || !commit) return;
    getVsCodeApi().postMessage({
      type: 'LOG_COMPARE_FILE_WITH',
      repoId: commit.repoId,
      hash: selectedMergeHash ?? commit.hash,
      filePath: ctxMenu.file.path,
    } as LogToHostMsg);
    setCtxMenu(null);
  }, [ctxMenu, commit, selectedMergeHash]);

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

  const activeFiles = !range && selectedMergeHash ? mergeFiles : files;
  const activeLoading = !range && selectedMergeHash ? loadingMergeFiles : loadingFiles;
  const activeHash = !range && selectedMergeHash ? selectedMergeHash : commit?.hash;

  return (
    <div
      className={twoColumnLayout ? 'commit-detail-two-column' : undefined}
      style={twoColumnLayout ? styles.containerTwoColumn : styles.container}
      onContextMenu={e => e.preventDefault()}
    >
      {!twoColumnLayout && (
      <div style={styles.topActions}>
        {!range && (
          <>
            <button
              data-top-action-btn=""
              style={styles.topActionBtn}
              title="Open Changes"
              onClick={() => getVsCodeApi().postMessage({ type: 'LOG_OPEN_COMMIT_CHANGES', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg)}
            >
              <Codicon name="diff-multiple" style={{ fontSize: '16px' }} />
            </button>
            {!hideExtendedDetailButton && (
              <button
                data-top-action-btn=""
                style={styles.topActionBtn}
                title="Open extended commit detail"
                onClick={() => getVsCodeApi().postMessage({ type: 'LOG_OPEN_EXTENDED_DETAIL', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg)}
              >
                <Codicon name="open-preview" style={{ fontSize: '16px' }} />
              </button>
            )}
          </>
        )}
        {onClose && (
          <button data-top-action-btn="" style={styles.topActionBtn} title="Close commit detail" onClick={onClose}>
            <Codicon name="layout-sidebar-right" style={{ fontSize: '16px' }} />
          </button>
        )}
      </div>
      )}
      {/* Commit header */}
      <div
        className={twoColumnLayout ? 'commit-detail-two-column-header' : undefined}
        style={twoColumnLayout ? styles.headerTwoColumn : styles.header}
      >
        {range ? (
          <>
            {repoName && (
              <div style={styles.repoRow}>
                <Codicon name="repo" style={styles.repoIcon} />
                <span style={styles.repoName(repoColor)}>{repoName}</span>
              </div>
            )}
            <div style={styles.rangeTitle}>
              <Codicon name="diff-multiple" style={{ fontSize: '14px', opacity: 0.8 }} />
              <span>Compare commits</span>
            </div>
            <div style={styles.hashRow}>
              <span style={styles.hash}>{range.older.shortHash}</span>
              <Codicon name="arrow-right" style={{ fontSize: '11px', opacity: 0.6 }} />
              <span style={styles.hash}>{range.newer.shortHash}</span>
            </div>
            <div style={styles.rangeHint}>Changes between the selected snapshots</div>
          </>
        ) : (
          <>
            {repoName && !twoColumnLayout && (
              <div style={styles.repoRow}>
            <Codicon name="repo" style={styles.repoIcon} />
            <span style={styles.repoName(repoColor)}>{repoName}</span>
          </div>
        )}
        {!twoColumnLayout && (
          <div style={styles.hashRow}>
            <span style={styles.hash}>{commit.shortHash}</span>
            <span style={styles.message}>
              {commit.message}
            </span>
          </div>
        )}
        {commit.isStash ? (
          <div>
            {twoColumnLayout && <div style={styles.detailsLabel}>Author</div>}
            <div style={twoColumnLayout ? styles.authorRowTwoColumn : styles.authorRow}>
              <AuthorAvatar authorName={activeProfile?.gitName ?? 'You'} authorEmail={activeProfile?.gitEmail ?? ''} size={32} isYou={!activeProfile} />
              {twoColumnLayout ? (
                <div style={styles.authorMeta}>
                  <span style={styles.authorName}>{activeProfile?.gitName ?? 'You'}</span>
                  {activeProfile?.gitEmail && <span style={styles.authorEmail}>{activeProfile.gitEmail}</span>}
                </div>
              ) : (
                <div style={styles.meta}>
                  <span>{activeProfile?.gitName ?? 'You'}</span>
                  {activeProfile?.gitEmail && (
                    <>
                      <span style={styles.dot}>·</span>
                      <span>{activeProfile.gitEmail}</span>
                    </>
                  )}
                  <span style={styles.dot}>·</span>
                  <span>{formatDateTime(commit.authorDate)}</span>
                </div>
              )}
            </div>
            {commit.stashBranch && (
              <div style={styles.refsRow}>
                <span style={styles.refBadge(branchColor(commit.stashBranch, false))}>
                  <Codicon name="git-branch" style={{ fontSize: '11px', flexShrink: 0, lineHeight: 1 }} />
                  {commit.stashBranch}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div>
            {twoColumnLayout && <div style={styles.detailsLabel}>Author</div>}
            <div style={twoColumnLayout ? styles.authorRowTwoColumn : styles.authorRow}>
              <AuthorAvatar authorName={commit.authorName} authorEmail={commit.authorEmail} size={32} />
              {twoColumnLayout ? (
                <div style={styles.authorMeta}>
                  <span style={styles.authorName}>{commit.authorName}</span>
                  <span style={styles.authorEmail}>{commit.authorEmail}</span>
                </div>
              ) : (
                <div style={styles.meta}>
                  <span>{commit.authorName}</span>
                  <span style={styles.dot}>·</span>
                  <span>{commit.authorEmail}</span>
                  <span style={styles.dot}>·</span>
                  <span>{formatDateTime(commit.authorDate)}</span>
                </div>
              )}
            </div>
          </div>
        )}
        {twoColumnLayout && (
          <div>
            <div style={styles.detailsLabel}>Details</div>
            <div style={styles.detailsGrid}>
              <span style={styles.detailsKey}>Hash</span>
              <span style={styles.detailsVal}>{commit.hash}</span>
              <span style={styles.detailsKey}>Author date</span>
              <span style={styles.detailsValNormal}>{formatDateTime(commit.authorDate)}</span>
              <span style={styles.detailsKey}>Commit date</span>
              <span style={styles.detailsValNormal}>{formatDateTime(commit.committerDate)}</span>
              {repoName && (
                <>
                  <span style={styles.detailsKey}>Repository</span>
                  <span style={styles.detailsValNormal}>{repoName}</span>
                </>
              )}
            </div>
          </div>
        )}
        {(() => {
          const LIMIT = 5;
          // Only refs that point AT this commit — never branches that merely contain it.
          const refGroups = groupRefs(commit.refs);
          const other = (g: RefGroup) => !g.isHead && !g.isTag;
          const pick = (f: (g: RefGroup) => boolean) => refGroups.filter(f);

          // Order: HEAD, tags, primary locals, other locals, primary remotes, other remotes.
          const allBadges: RefGroup[] = [
            ...pick(g => g.isHead),
            ...pick(g => g.isTag),
            ...pick(g => other(g) && g.isLocal && isPrimaryBranch(g.label)),
            ...pick(g => other(g) && g.isLocal && !isPrimaryBranch(g.label)),
            ...pick(g => other(g) && !g.isLocal && isPrimaryBranch(g.label)),
            ...pick(g => other(g) && !g.isLocal && !isPrimaryBranch(g.label)),
          ];
          if (allBadges.length === 0) return null;

          const visible = refsExpanded ? allBadges : allBadges.slice(0, LIMIT);
          const hiddenCount = allBadges.length - LIMIT;

          function renderBadge(g: RefGroup) {
            const isSpecialHead = g.isRemoteHead || (g.isHead && g.isDetached);
            const rid = commit!.repoId;
            const remoteRefKey = g.remoteName ? `${rid}:${g.remoteName}/${g.label}` : null;
            const resolvedRefColor = (remoteRefKey ? refColors?.get(remoteRefKey) : undefined) ?? refColors?.get(`${rid}:${g.label}`);
            const color = g.isTag ? tagColor() : isSpecialHead ? headColor() : (resolvedRefColor ?? branchColor(g.label, false));
            const label = g.isRemoteHead ? `${g.remoteName}/HEAD` : g.isRemote ? remoteLabel(g) : g.label;
            return (
              <span key={g.key} style={styles.refBadge(color, (g.isHead || g.isDetached) && !g.isRemoteHead)} title={badgeTitle(g)}>
                <RefBadgeIcon group={g} />
                {label}
              </span>
            );
          }

          const nonDetachedHeadGroup = refGroups.find(g => g.isHead && !g.isDetached && !g.isRemoteHead);
          return (
            <div style={refsExpanded ? styles.refsRowExpanded : styles.refsRow}>
              {nonDetachedHeadGroup && (
                <span style={styles.refBadge(headColor(), true)} title={`HEAD → ${nonDetachedHeadGroup.label}`}>
                  <Codicon name="arrow-right" style={{ fontSize: '9px', flexShrink: 0, lineHeight: 1 }} />
                  HEAD
                </span>
              )}
              {visible.map(renderBadge)}
              {!refsExpanded && hiddenCount > 0 && (
                <span
                  style={styles.refsShowMore}
                  onClick={() => setRefsExpanded(true)}
                  title={`Show ${hiddenCount} more`}
                >
                  +{hiddenCount} more
                </span>
              )}
              {refsExpanded && allBadges.length > LIMIT && (
                <span
                  style={{ ...styles.refsShowMore, width: '100%', marginTop: '2px' }}
                  onClick={() => setRefsExpanded(false)}
                >
                  Show less
                </span>
              )}
            </div>
          );
        })()}

        {(() => {
          if (!commit || commit.isStash) return null;
          const total = descendantBranches.local.length + descendantBranches.remote.length + descendantBranches.tags.length;
          if (!loadingDescendants && total === 0) return null;
          const DLIMIT = 8;
          type DescBadge = { kind: 'local' | 'remote' | 'tag'; name: string };
          const allDescBadges: DescBadge[] = [
            ...descendantBranches.local.map(name => ({ kind: 'local' as const, name })),
            ...descendantBranches.remote.map(name => ({ kind: 'remote' as const, name })),
            ...descendantBranches.tags.map(name => ({ kind: 'tag' as const, name })),
          ];
          const visibleDesc = descendantsExpanded ? allDescBadges : allDescBadges.slice(0, DLIMIT);
          const hiddenDescCount = allDescBadges.length - DLIMIT;
          return (
            <div style={styles.mergeSection}>
              <div style={styles.mergeSectionTitle}>
                <Codicon name="git-branch" style={{ fontSize: '11px', opacity: 0.7 }} />
                <span>Descendant branches</span>
              </div>
              {loadingDescendants && <div style={styles.mergeLoading}>Loading...</div>}
              {!loadingDescendants && (
                <div style={styles.refsRow}>
                  {visibleDesc.map(b => (
                    <span
                      key={`${b.kind}:${b.name}`}
                      style={styles.refBadge(b.kind === 'tag' ? tagColor() : branchColor(b.name, false), false)}
                      title={`${b.name} contains this commit`}
                    >
                      {b.name}
                    </span>
                  ))}
                  {!descendantsExpanded && hiddenDescCount > 0 && (
                    <span
                      style={styles.refsShowMore}
                      onClick={() => setDescendantsExpanded(true)}
                      title={`Show ${hiddenDescCount} more`}
                    >
                      +{hiddenDescCount} more
                    </span>
                  )}
                  {descendantsExpanded && allDescBadges.length > DLIMIT && (
                    <span
                      style={{ ...styles.refsShowMore, width: '100%', marginTop: '2px' }}
                      onClick={() => setDescendantsExpanded(false)}
                    >
                      Show less
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {twoColumnLayout && (
          <div>
            <div style={styles.detailsLabel}>Commit message</div>
            <pre style={styles.commitMessageBlock}>{fullMessage || commit.message}</pre>
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
          </>
        )}
      </div>

      <div
        className={twoColumnLayout ? 'commit-detail-two-column-right' : undefined}
        style={twoColumnLayout ? styles.rightColumn : styles.rightColumnInline}
      >
      {/* File list toolbar */}
      <div style={styles.fileListToolbar}>
        {twoColumnLayout && !range && (
          <button
            data-top-action-btn=""
            style={styles.toggleBtn(false, twoColumnLayout)}
            title="Open Changes"
            onClick={() => getVsCodeApi().postMessage({ type: 'LOG_OPEN_COMMIT_CHANGES', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg)}
          >
            <Codicon name="diff-multiple" style={{ fontSize: twoColumnLayout ? '16px' : '14px' }} />
          </button>
        )}
        <span style={styles.fileCount}>{activeFiles.length} file{activeFiles.length !== 1 ? 's' : ''}{selectedMergeHash ? ` · ${mergeCommits.find(c => c.hash === selectedMergeHash)?.shortHash}` : ''}</span>
        {viewMode === 'tree' && (
          <div style={styles.expandBtns}>
            <button
              data-top-action-btn=""
              style={styles.toggleBtn(false, twoColumnLayout)}
              onClick={() => applyAllExpanded(true)}
              title="Expand all"
            >
              <Codicon name="expand-all" style={{ fontSize: twoColumnLayout ? '16px' : '14px' }} />
            </button>
            <button
              data-top-action-btn=""
              style={styles.toggleBtn(false, twoColumnLayout)}
              onClick={() => applyAllExpanded(false)}
              title="Collapse all"
            >
              <Codicon name="collapse-all" style={{ fontSize: twoColumnLayout ? '16px' : '14px' }} />
            </button>
          </div>
        )}
        <div style={styles.viewToggle}>
          <button
            data-top-action-btn=""
            style={styles.toggleBtn(viewMode === 'tree', twoColumnLayout)}
            onClick={() => { setViewMode('tree'); applyAllExpanded(null); }}
            title="Tree view"
          >
            <Codicon name="list-tree" style={{ fontSize: twoColumnLayout ? '16px' : '14px' }} />
          </button>
          <button
            data-top-action-btn=""
            style={styles.toggleBtn(viewMode === 'flat', twoColumnLayout)}
            onClick={() => { setViewMode('flat'); applyAllExpanded(null); }}
            title="Flat view"
          >
            <Codicon name="list-flat" style={{ fontSize: twoColumnLayout ? '16px' : '14px' }} />
          </button>
        </div>
      </div>

      {/* File context menu */}
      {ctxMenu && commit && !range && (
        <FileContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          file={ctxMenu.file}
          onShowDiff={handleCtxShowDiff}
          onShowCombinedDiff={handleCtxShowCombinedDiff}
          onFileHistory={handleCtxFileHistory}
          onCompareWith={handleCtxCompareWith}
          onEditSource={handleCtxEditSource}
          onCherryPickFile={handleCtxCherryPickFile}
          onRevertFile={handleCtxRevertFile}
          onRevealExplorer={handleCtxRevealExplorer}
          onRevealOS={handleCtxRevealOS}
          canApplyCommitChanges={!commit.isStash}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* File list */}
      <div style={styles.fileList}>
        {activeLoading && <div style={styles.loading}>Loading files...</div>}
        {!activeLoading && activeFiles.length === 0 && (
          <div style={styles.loading}>No changed files</div>
        )}

        {!activeLoading && activeFiles.length > 0 && (
          <GenericFileTree<FileEntry>
            files={activeFiles}
            viewMode={viewMode}
            iconTheme={iconTheme}
            statusColor={statusColor}
            statusLetter={f => f}
            isDirOpen={isDirOpen}
            toggleDir={toggleDir}
            isFileSelected={f => selectedFile?.path === f.path}
            isFileContextActive={f => ctxMenu?.file.path === f.path}
            onOpenFile={f => openVscodeDiff(f, activeHash)}
            onContextMenuFile={range ? undefined : (e, f) => setCtxMenu({ x: e.clientX, y: e.clientY, file: f })}
          />
        )}
      </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    borderLeft: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
  },
  // Full-page variant (the "Open Full Detail" panel): commit header/metadata on the left,
  // file list on the right, side by side instead of stacked — there's room for two columns
  // there, unlike the narrow Git Log sidebar this component is normally embedded in.
  containerTwoColumn: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'row' as const,
    height: '100%',
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
  topActions: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  },
  topActionBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '3px 4px',
    borderRadius: '3px',
    color: 'var(--vscode-foreground)',
    opacity: 0.5,
    display: 'flex',
    alignItems: 'center',
  },
  header: {
    padding: '10px 12px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  headerTwoColumn: {
    padding: '20px 24px',
    borderRight: '1px solid var(--vscode-panel-border)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
    flex: '0 0 70%',
    minWidth: '260px',
    overflowY: 'auto' as const,
  },
  detailsLabel: {
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    opacity: 0.5,
    marginBottom: '6px',
  },
  detailsGrid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    gap: '4px 14px',
    alignItems: 'start',
  } as React.CSSProperties,
  detailsKey: {
    opacity: 0.55,
    fontSize: '12px',
    whiteSpace: 'nowrap' as const,
  },
  detailsVal: {
    fontSize: '12px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    wordBreak: 'break-all' as const,
  },
  detailsValNormal: {
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    wordBreak: 'normal' as const,
  },
  commitMessageBlock: {
    background: 'var(--vscode-textCodeBlock-background, var(--vscode-input-background))',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
    padding: '12px 14px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '12px',
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    margin: 0,
  } as React.CSSProperties,
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
  rangeTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    fontWeight: 600,
    paddingRight: '28px',
  } as React.CSSProperties,
  rangeHint: {
    fontSize: '11px',
    opacity: 0.65,
  } as React.CSSProperties,
  hashRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  hash: {
    fontFamily: 'monospace',
    fontSize: '11px',
    color: 'var(--vscode-badge-foreground)',
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
    minWidth: 0,
  },
  authorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '8px',
    marginBottom: '8px',
  },
  authorRowTwoColumn: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  } as React.CSSProperties,
  meta: {
    display: 'flex',
    gap: '6px',
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
    opacity: 0.7,
    flexWrap: 'wrap' as const,
    alignItems: 'center',
  },
  dot: {
    opacity: 0.4,
  },
  authorMeta: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    minWidth: 0,
  } as React.CSSProperties,
  authorName: {
    fontWeight: 500,
    fontSize: '13px',
  } as React.CSSProperties,
  authorEmail: {
    fontSize: '11px',
    opacity: 0.55,
  } as React.CSSProperties,
  refsRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
  },
  refsRowExpanded: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
    maxHeight: '160px',
    overflowY: 'auto' as const,
    paddingRight: '2px',
  },
  refsShowMore: {
    fontSize: '10px',
    color: 'var(--vscode-textLink-foreground)',
    cursor: 'pointer',
    alignSelf: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  refBadge: (color: string, isHead = false): React.CSSProperties => ({
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
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
    boxSizing: 'border-box' as const,
    fontWeight: isHead ? 700 : 500,
  }),
  mergeSection: {
    marginTop: '6px',
    borderTop: '1px solid var(--vscode-panel-border)',
    paddingTop: '6px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    maxHeight: '180px',
    overflowY: 'auto' as const,
    flexShrink: 0,
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
    color: 'var(--vscode-badge-foreground)',
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
  toggleBtn: (active: boolean, large = false): React.CSSProperties => ({
    background: active ? 'var(--vscode-toolbar-activeBackground)' : 'transparent',
    border: 'none',
    borderRadius: large ? '5px' : '3px',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: active ? 1 : 0.7,
    padding: large ? '5px 6px' : '2px 4px',
    display: 'flex',
    alignItems: 'center',
  }),
  fileList: {
    flex: 1,
    overflowY: 'auto' as const,
    fontSize: '12px',
  },
  // Wraps the file toolbar + file list (everything after the header) as the right column in
  // twoColumnLayout mode; a no-op passthrough wrapper otherwise so the JSX stays balanced.
  rightColumn: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } as React.CSSProperties,
  rightColumnInline: {
    display: 'contents',
  } as React.CSSProperties,
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
