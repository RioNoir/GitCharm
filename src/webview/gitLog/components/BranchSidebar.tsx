import React, { useState, useRef, useLayoutEffect, useEffect, useCallback, useMemo, forwardRef } from 'react';
import { ScrollArea } from '../../shared/ScrollArea';
import type { BranchInfo, RepoMeta, TagInfo } from '../../shared/types';
import { isPrimaryBranch } from '../../shared/branchUtils';
import { primaryBranchColor } from '../../shared/branchColors';
import { Codicon } from '../../shared/Codicon';
import { focusOnHover, handleTreeNavKeyDown } from '../../shared/keyboardNav';
import * as l10n from '@vscode/l10n';
import { isImeComposing } from '../../shared/ime';

interface Props {
  repos: RepoMeta[];
  branches: BranchInfo[];
  tags: TagInfo[];
  filter: string;
  selectedBranchFilter: string;
  activeRepoId?: string | null;
  onFilterChange: (v: string) => void;
  onBranchFilterSelect: (branchName: string) => void;
  onBranchFocus: (branch: BranchInfo) => void;
  onCheckout: (repoIds: string[], branchName: string) => void;
  onMerge: (repoId: string, from: string) => void;
  onRebase: (repoId: string, onto: string) => void;
  onRename: (repoIds: string[], branchName: string) => void;
  onDelete: (repoIds: string[], branchName: string) => void;
  onFetchRepo: (repoId: string) => void;
  onPull: (repoIds: string[], branchName: string) => void;
  onPush: (repoIds: string[], branchName: string) => void;
  onCheckoutTag: (repoIds: string[], tagName: string) => void;
  onMergeTag: (repoIds: string[], tagName: string) => void;
  onPushTag: (repoId: string, tagName: string) => void;
  onDeleteTag: (repoIds: string[], tagName: string) => void;
  onCollapse: () => void;
  hidden?: boolean;
}

type SectionKey = string; // 'local' | 'remote:<name>' | 'tags'

function stripRemotePrefix(name: string): string {
  return name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
}


interface MergedBranch {
  baseName: string;
  isPrimary: boolean;
  isHead: boolean;
  instances: BranchInfo[];
  repoIds: string[];
}

/**
 * `defaultBranchByRepo` maps repoId → the remote's actual default branch name (from
 * RepoMeta.defaultBranch), the source of truth for "primary" when known. A branch merged
 * across repos with disagreeing defaults (different remotes) is primary if it matches in any
 * of them. Falls back to the naming heuristic for a repo whose default couldn't be resolved.
 */
function buildMergedBranches(branches: BranchInfo[], defaultBranchByRepo: Map<string, string | undefined>): MergedBranch[] {
  const map = new Map<string, MergedBranch>();
  for (const b of branches) {
    const baseName = b.isRemote ? stripRemotePrefix(b.name) : b.name;
    const actualDefault = defaultBranchByRepo.get(b.repoId);
    const isPrimaryHere = actualDefault ? baseName === actualDefault : isPrimaryBranch(baseName);
    const existing = map.get(baseName);
    if (existing) {
      existing.instances.push(b);
      if (!existing.repoIds.includes(b.repoId)) existing.repoIds.push(b.repoId);
      if (b.isHead) existing.isHead = true;
      if (isPrimaryHere) existing.isPrimary = true;
    } else {
      map.set(baseName, {
        baseName,
        isPrimary: isPrimaryHere,
        isHead: b.isHead,
        instances: [b],
        repoIds: [b.repoId],
      });
    }
  }
  return Array.from(map.values());
}

function sortMerged(list: MergedBranch[]): MergedBranch[] {
  return [...list].sort((a, b) => {
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.baseName.localeCompare(b.baseName);
  });
}

// Splits out the current branch and the primary branch (e.g. "main") — pinned to the top of
// their section, current first — from the rest, which the tree view sorts alphabetically by
// name alongside folders instead of head-first. A branch namespaced under a folder (e.g.
// "feature/log-improvements") is never pinned even when current: pulling it out of the tree
// would make its folder vanish and show the full slash-joined path in its place, which reads
// as the branch disappearing rather than being promoted.
function splitPinned(list: MergedBranch[]): { pinned: MergedBranch[]; rest: MergedBranch[] } {
  const head = list.find(m => m.isHead && !m.baseName.includes('/'));
  const primary = list.find(m => m.isPrimary && m !== head && !m.baseName.includes('/'));
  const pinned = [head, primary].filter((m): m is MergedBranch => !!m);
  const pinnedSet = new Set(pinned);
  return { pinned, rest: list.filter(m => !pinnedSet.has(m)) };
}

// A branch tree groups merged branches (or tags) by "/"-separated path segments (e.g.
// "pr/strayge/34" becomes folder "pr" > folder "strayge" > leaf "34"), mirroring how most
// git tools present slash-namespaced refs. Folders carry no ref of their own — only leaves do.
interface BranchTreeFolder<T> {
  kind: 'folder';
  name: string;
  path: string; // full slash-joined path from the section root, used as the collapse key
  folders: BranchTreeFolder<T>[];
  leaves: T[];
}

function buildBranchTree<T>(list: T[], getPath: (item: T) => string): BranchTreeFolder<T> {
  const root: BranchTreeFolder<T> = { kind: 'folder', name: '', path: '', folders: [], leaves: [] };
  for (const item of list) {
    const segments = getPath(item).split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      const path = node.path ? `${node.path}/${segment}` : segment;
      let child = node.folders.find(f => f.name === segment);
      if (!child) {
        child = { kind: 'folder', name: segment, path, folders: [], leaves: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.leaves.push(item);
  }
  return root;
}

function collectFolderPaths<T>(node: BranchTreeFolder<T>, out: string[] = []): string[] {
  for (const folder of node.folders) {
    out.push(folder.path);
    collectFolderPaths(folder, out);
  }
  return out;
}

// The repos a folder's dots should reflect: the union of every repo any branch/tag nested
// under it (at any depth) belongs to.
function collectRepoIds<T>(node: BranchTreeFolder<T>, getRepoIds: (leaf: T) => string[]): string[] {
  const ids = new Set<string>();
  for (const leaf of node.leaves) for (const id of getRepoIds(leaf)) ids.add(id);
  for (const folder of node.folders) for (const id of collectRepoIds(folder, getRepoIds)) ids.add(id);
  return Array.from(ids);
}

// Total ahead/behind across every branch nested under a folder (at any depth), so a folder
// shows how much of what it contains is out of sync with its upstream(s) combined.
function collectAheadBehind<T>(node: BranchTreeFolder<T>, getAheadBehind: (leaf: T) => { ahead: number; behind: number } | undefined): { ahead: number; behind: number } {
  let ahead = 0, behind = 0;
  for (const leaf of node.leaves) {
    const ab = getAheadBehind(leaf);
    if (ab) { ahead += ab.ahead; behind += ab.behind; }
  }
  for (const folder of node.folders) {
    const ab = collectAheadBehind(folder, getAheadBehind);
    ahead += ab.ahead;
    behind += ab.behind;
  }
  return { ahead, behind };
}

// The folder paths a branch/tag name is nested under, root to leaf — e.g. "feature/log/foo"
// gives ["feature", "feature/log"]. Used to expand every ancestor folder of the current
// branch by default, so checking out a namespaced branch never hides it.
function ancestorFolderPaths(name: string): string[] {
  const segments = name.split('/').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    paths.push(segments.slice(0, i + 1).join('/'));
  }
  return paths;
}

interface MergedTag {
  name: string;
  repoIds: string[];
}

function buildMergedTags(tags: TagInfo[]): MergedTag[] {
  const map = new Map<string, MergedTag>();
  for (const t of tags) {
    const existing = map.get(t.name);
    if (existing) {
      if (!existing.repoIds.includes(t.repoId)) existing.repoIds.push(t.repoId);
    } else {
      map.set(t.name, { name: t.name, repoIds: [t.repoId] });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export const BranchSidebar = forwardRef<HTMLDivElement, Props>(function BranchSidebar({
  repos, branches, tags, filter, selectedBranchFilter, activeRepoId, onFilterChange, onBranchFilterSelect, onBranchFocus,
  onCheckout, onMerge, onRebase, onRename, onDelete, onFetchRepo: _onFetchRepo, onPull, onPush,
  onCheckoutTag, onMergeTag, onPushTag, onDeleteTag, onCollapse, hidden,
}, ref) {
  const defaultBranchByRepo = useMemo(
    () => new Map(repos.map(r => [r.id, r.defaultBranch])),
    [repos]
  );
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ merged: MergedBranch; x: number; y: number } | null>(null);
  const [tagContextMenu, setTagContextMenu] = useState<{ mergedTag: MergedTag; x: number; y: number } | null>(null);
  const navScrollRef = useRef<HTMLDivElement>(null);

  // Arrow/Home/End/PageUp/PageDown move focus between rows (branches, tags, folders) in
  // document order — the same order they're rendered in, so it stays correct through any
  // filter or collapsed state without duplicating the tree-walk logic here. Enter/Space on
  // a focused row is handled by the row itself (BranchRow/FolderRow), same as a click.
  const handleNavKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    handleTreeNavKeyDown(e, navScrollRef.current);
  }, []);

  useEffect(() => {
    const id = 'gitcharm-branch-ctx-hover';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `[data-ctx-item]:hover { background: var(--vscode-menu-selectionBackground) !important; color: var(--vscode-menu-selectionForeground) !important; }`;
    document.head.appendChild(s);
  }, []);

  function toggle(key: SectionKey) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function setFoldersCollapsed(keys: string[], collapse: boolean) {
    setCollapsed(prev => {
      const next = new Set(prev);
      for (const key of keys) {
        if (collapse) next.add(key); else next.delete(key);
      }
      return next;
    });
  }

  // Folders default to collapsed. Computed from the unfiltered branch list (not `filtered`
  // below) so typing into the search box never re-triggers this — otherwise a folder the user
  // expanded would re-collapse the moment the filter made it briefly disappear from the tree.
  const knownFolderKeysRef = useRef<Set<SectionKey>>(new Set());
  useEffect(() => {
    const allLocal = sortMerged(buildMergedBranches(branches.filter(b => !b.isRemote && b.name !== 'HEAD'), defaultBranchByRepo));
    const localKeys = collectFolderPaths(buildBranchTree(splitPinned(allLocal).rest, m => m.baseName)).map(p => `folder:local:${p}`);
    const remoteByName = new Map<string, BranchInfo[]>();
    for (const b of branches.filter(b => b.isRemote && stripRemotePrefix(b.name) !== 'HEAD')) {
      const rName = b.remoteName ?? b.name.split('/')[0] ?? 'remote';
      if (!remoteByName.has(rName)) remoteByName.set(rName, []);
      remoteByName.get(rName)!.push(b);
    }
    const remoteKeys = Array.from(remoteByName.entries()).flatMap(([name, bs]) => {
      const sectionKey = `remote:${name}`;
      const allMerged = sortMerged(buildMergedBranches(bs, defaultBranchByRepo));
      return collectFolderPaths(buildBranchTree(splitPinned(allMerged).rest, m => m.baseName)).map(p => `folder:${sectionKey}:${p}`);
    });
    const allMergedTags = buildMergedTags(tags);
    const tagKeys = collectFolderPaths(buildBranchTree(allMergedTags, mt => mt.name)).map(p => `folder:tags:${p}`);
    const allKeys = [...localKeys, ...remoteKeys, ...tagKeys];
    const newKeys = allKeys.filter(k => !knownFolderKeysRef.current.has(k));
    if (newKeys.length > 0) {
      // Except for the folder(s) that already hold the current branch — collapsing them
      // by default would hide the branch you're actually on.
      const currentLocal = allLocal.find(m => m.isHead);
      const expandedByDefault = currentLocal
        ? ancestorFolderPaths(currentLocal.baseName).map(p => `folder:local:${p}`)
        : [];
      const toCollapse = newKeys.filter(k => !expandedByDefault.includes(k));
      knownFolderKeysRef.current = new Set([...knownFolderKeysRef.current, ...allKeys]);
      setCollapsed(prev => new Set([...prev, ...toCollapse]));
    } else {
      knownFolderKeysRef.current = new Set(allKeys);
    }
  }, [branches, tags, defaultBranchByRepo]);

  const filtered = filter
    ? branches.filter(b => b.name.toLowerCase().includes(filter.toLowerCase()))
    : branches;

  // Exclude detached HEAD pseudo-branch from Local list — it shows up as a tag row instead
  const localMerged = sortMerged(buildMergedBranches(filtered.filter(b => !b.isRemote && b.name !== 'HEAD'), defaultBranchByRepo));
  const localFolderPaths = collectFolderPaths(buildBranchTree(splitPinned(localMerged).rest, m => m.baseName))
    .map(p => `folder:local:${p}`);

  // Group remote branches by remote name (e.g. "origin", "upstream"), sorted alphabetically
  const remoteBranches = filtered.filter(b => b.isRemote && stripRemotePrefix(b.name) !== 'HEAD');
  const remoteGroupsMap = new Map<string, BranchInfo[]>();
  for (const b of remoteBranches) {
    const rName = b.remoteName ?? b.name.split('/')[0] ?? 'remote';
    if (!remoteGroupsMap.has(rName)) remoteGroupsMap.set(rName, []);
    remoteGroupsMap.get(rName)!.push(b);
  }
  const remoteGroups: { name: string; merged: MergedBranch[]; folderPaths: string[] }[] = Array.from(remoteGroupsMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bs]) => {
      const merged = sortMerged(buildMergedBranches(bs, defaultBranchByRepo));
      const sectionKey = `remote:${name}`;
      const folderPaths = collectFolderPaths(buildBranchTree(splitPinned(merged).rest, m => m.baseName))
        .map(p => `folder:${sectionKey}:${p}`);
      return { name, merged, folderPaths };
    });

  // Active detached tag name(s) — shown as "current" in the Tags section
  const activeDetachedTags = new Set(branches.filter(b => b.detachedTag).map(b => b.detachedTag!));

  const mergedTags = buildMergedTags(
    filter ? tags.filter(t => t.name.toLowerCase().includes(filter.toLowerCase())) : tags
  );
  const tagFolderPaths = collectFolderPaths(buildBranchTree(mergedTags, mt => mt.name))
    .map(p => `folder:tags:${p}`);

  const repoColorMap = Object.fromEntries(repos.map(r => [r.id, r.color]));
  const multiRepo = repos.length > 1;

  function primaryInstance(merged: MergedBranch): BranchInfo {
    return merged.instances.find(i => i.isHead) ?? merged.instances[0];
  }

  function focusInstance(merged: MergedBranch): BranchInfo | undefined {
    const candidates = merged.instances.filter(instance => !!instance.lastCommitHash);
    const activeInstance = activeRepoId ? candidates.find(instance => instance.repoId === activeRepoId) : undefined;
    if (activeInstance) return activeInstance;

    const repoNames = new Map(repos.map(repo => [repo.id, repo.name]));
    return [...candidates].sort((a, b) => {
      const aTimestamp = Date.parse(a.lastCommitDate ?? '');
      const bTimestamp = Date.parse(b.lastCommitDate ?? '');
      const dateDifference = (Number.isNaN(bTimestamp) ? 0 : bTimestamp) - (Number.isNaN(aTimestamp) ? 0 : aTimestamp);
      if (dateDifference !== 0) return dateDifference;
      return (repoNames.get(a.repoId) ?? a.repoId).localeCompare(repoNames.get(b.repoId) ?? b.repoId);
    })[0];
  }

  return (
    <div ref={ref} style={hidden ? { ...styles.container, display: 'none' } : styles.container} onClick={() => { setContextMenu(null); setTagContextMenu(null); }}>
      {/* Sticky header: search + repo list */}
      <div style={styles.stickyHeader}>
        <div style={styles.searchBox}>
          <div style={styles.searchInputWrap}>
            <Codicon name="filter" style={styles.searchIcon} />
            <input
              style={styles.searchInput}
              value={filter}
              onChange={e => onFilterChange(e.target.value)}
              placeholder={l10n.t('Filter branches & tags...')}
            />
          </div>
          <button style={styles.collapseBtn} onClick={onCollapse} title={l10n.t('Collapse sidebar')}>
            <div data-top-action-btn="" style={styles.collapseBtnInner}>
              <Codicon name="layout-sidebar-left" style={{ fontSize: '14px' }} />
            </div>
          </button>
        </div>
      </div>

      <ScrollArea style={{ flex: 1, minHeight: 0 }} scrollRef={navScrollRef} onKeyDown={handleNavKeyDown}>
      {/* LOCAL section */}
      <SectionHeader
        icon="git-branch"
        label={l10n.t({ message: 'Local', comment: ['Branch sidebar section header: local branches'] })}
        count={localMerged.length}
        sectionKey="local"
        collapsed={collapsed}
        onToggleSection={toggle}
        folderPaths={localFolderPaths}
        onSetFoldersCollapsed={setFoldersCollapsed}
      />
      {!collapsed.has('local') && (
        <BranchList
          merged={localMerged}
          keyPrefix="folder:local"
          collapsed={collapsed}
          onToggleFolder={toggle}
          repoColorMap={repoColorMap}
          multiRepo={multiRepo}
          selectedBranchFilter={selectedBranchFilter}
          contextMenu={contextMenu}
          setContextMenu={setContextMenu}
          primaryInstance={primaryInstance}
          focusInstance={focusInstance}
          onBranchFocus={onBranchFocus}
          onBranchFilterSelect={onBranchFilterSelect}
          forceExpanded={!!filter}
        />
      )}

      {/* REMOTE sections — one per remote name (origin, upstream, …) */}
      {remoteGroups.map(({ name, merged, folderPaths }, idx) => {
        const sectionKey = `remote:${name}`;
        // The section immediately above (Local, or the previous remote group) suppresses its
        // own separator only when it's expanded and non-empty — mirror that here so we don't
        // end up with neither border (gap) or both (double line).
        const prevExpandedNonEmpty = idx === 0
          ? localMerged.length > 0 && !collapsed.has('local')
          : remoteGroups[idx - 1].merged.length > 0 && !collapsed.has(`remote:${remoteGroups[idx - 1].name}`);
        return (
          <React.Fragment key={sectionKey}>
            <SectionHeader
              icon="cloud"
              label={name.charAt(0).toUpperCase() + name.slice(1)}
              count={merged.length}
              sectionKey={sectionKey}
              collapsed={collapsed}
              onToggleSection={toggle}
              topBorder={prevExpandedNonEmpty}
              folderPaths={folderPaths}
              onSetFoldersCollapsed={setFoldersCollapsed}
            />
            {!collapsed.has(sectionKey) && (
              <BranchList
                merged={merged}
                keyPrefix={`folder:${sectionKey}`}
                collapsed={collapsed}
                onToggleFolder={toggle}
                repoColorMap={repoColorMap}
                multiRepo={multiRepo}
                selectedBranchFilter={selectedBranchFilter}
                contextMenu={contextMenu}
                setContextMenu={setContextMenu}
                primaryInstance={primaryInstance}
                focusInstance={focusInstance}
                onBranchFocus={onBranchFocus}
                onBranchFilterSelect={onBranchFilterSelect}
                forceExpanded={!!filter}
              />
            )}
          </React.Fragment>
        );
      })}

      {/* TAGS section */}
      {mergedTags.length > 0 && (() => {
        const lastRemote = remoteGroups[remoteGroups.length - 1];
        const prevExpandedNonEmpty = lastRemote
          ? lastRemote.merged.length > 0 && !collapsed.has(`remote:${lastRemote.name}`)
          : localMerged.length > 0 && !collapsed.has('local');
        return (
        <>
          <SectionHeader
            icon="tag"
            label={l10n.t('Tags')}
            count={mergedTags.length}
            sectionKey="tags"
            collapsed={collapsed}
            onToggleSection={toggle}
            topBorder={prevExpandedNonEmpty}
            folderPaths={tagFolderPaths}
            onSetFoldersCollapsed={setFoldersCollapsed}
          />
          {!collapsed.has('tags') && (
            <TagList
              mergedTags={mergedTags}
              keyPrefix="folder:tags"
              collapsed={collapsed}
              onToggleFolder={toggle}
              repoColorMap={repoColorMap}
              multiRepo={multiRepo}
              activeDetachedTags={activeDetachedTags}
              tagContextMenu={tagContextMenu}
              setTagContextMenu={setTagContextMenu}
              forceExpanded={!!filter}
            />
          )}
        </>
        );
      })()}

      </ScrollArea>

      {/* Branch context menu */}
      {contextMenu && (() => {
        const inst = primaryInstance(contextMenu.merged);
        // Merging or rebasing in the repo where this branch is already checked out
        // does nothing — target a repo where it is not the current branch.
        const opInst = contextMenu.merged.instances.find(i => !i.isHead) ?? inst;
        const localInstances = contextMenu.merged.instances.filter(instance => !instance.isRemote);
        const localRepoIds = localInstances.map(instance => instance.repoId);
        return (
          <ContextMenu
            merged={contextMenu.merged}
            x={contextMenu.x}
            y={contextMenu.y}
            canDelete={!contextMenu.merged.isHead && !(inst.isRemote && contextMenu.merged.isPrimary)}
            onClose={() => setContextMenu(null)}
            onCheckout={() => { onCheckout(contextMenu.merged.repoIds, inst.name); setContextMenu(null); }}
            onMerge={() => { onMerge(opInst.repoId, opInst.name); setContextMenu(null); }}
            onRebase={() => { onRebase(opInst.repoId, opInst.name); setContextMenu(null); }}
            onRename={localRepoIds.length > 0 ? () => { onRename(localRepoIds, contextMenu.merged.baseName); setContextMenu(null); } : undefined}
            onDelete={() => { onDelete(contextMenu.merged.repoIds, inst.name); setContextMenu(null); }}
            onPull={localRepoIds.length > 0 ? () => { onPull(localRepoIds, contextMenu.merged.baseName); setContextMenu(null); } : undefined}
            onPush={localRepoIds.length > 0 ? () => { onPush(localRepoIds, contextMenu.merged.baseName); setContextMenu(null); } : undefined}
          />
        );
      })()}

      {/* Tag context menu */}
      {tagContextMenu && (
        <TagContextMenu
          mergedTag={tagContextMenu.mergedTag}
          x={tagContextMenu.x}
          y={tagContextMenu.y}
          canDelete={!activeDetachedTags.has(tagContextMenu.mergedTag.name)}
          onClose={() => setTagContextMenu(null)}
          onCheckout={() => { onCheckoutTag(tagContextMenu.mergedTag.repoIds, tagContextMenu.mergedTag.name); setTagContextMenu(null); }}
          onMerge={() => { onMergeTag(tagContextMenu.mergedTag.repoIds, tagContextMenu.mergedTag.name); setTagContextMenu(null); }}
          onPush={() => { onPushTag(tagContextMenu.mergedTag.repoIds[0], tagContextMenu.mergedTag.name); setTagContextMenu(null); }}
          onDelete={() => { onDeleteTag(tagContextMenu.mergedTag.repoIds, tagContextMenu.mergedTag.name); setTagContextMenu(null); }}
        />
      )}
    </div>
  );
});

function BranchRow({ merged, repoColorMap, multiRepo, isFilterSelected, isCtxActive, onContextMenu, onClick, onDoubleClick, depth = 0, displayName }: {
  merged: MergedBranch;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  isFilterSelected: boolean;
  isCtxActive: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onClick: () => void;
  onDoubleClick: () => void;
  depth?: number;
  displayName?: string;
}) {
  const { baseName, isPrimary, isHead, repoIds } = merged;
  const isRemote = merged.instances[0].isRemote;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const primaryColor = primaryBranchColor();
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
  }, []);

  return (
    <div
      data-nav-row=""
      tabIndex={-1}
      style={styles.branchRow(isHead, isFilterSelected, hovered, isCtxActive, depth, focused)}
      onMouseEnter={(e) => { setHovered(true); focusOnHover(e.currentTarget); }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onContextMenu={onContextMenu}
      onClick={() => {
        if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
        clickTimerRef.current = setTimeout(() => {
          clickTimerRef.current = null;
          onClick();
        }, 300);
      }}
      onDoubleClick={() => {
        if (clickTimerRef.current) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        onDoubleClick();
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      title={`${baseName}\n${l10n.t('Click to focus branch head · Double-click to filter · Right-click for git actions')}`}
    >
      <span style={styles.chevronSpacer} />
      <Codicon
        name={isPrimary ? 'star-full' : isRemote ? 'cloud' : 'git-branch'}
        style={styles.branchIcon(isPrimary, isHead, primaryColor)}
      />

      <span style={styles.branchName(isHead, isPrimary, primaryColor)} title={baseName}>{displayName ?? baseName}</span>

      {multiRepo && (
        <span style={styles.dotGroup}>
          {repoIds.map(id => (
            <span key={id} style={styles.repoDot(repoColorMap[id] ?? '#888')} />
          ))}
        </span>
      )}

      {merged.instances[0].aheadBehind && (merged.instances[0].aheadBehind.ahead > 0 || merged.instances[0].aheadBehind.behind > 0) && (
        <span style={styles.aheadBehind}>
          {merged.instances[0].aheadBehind.ahead > 0 && <span>↑{merged.instances[0].aheadBehind.ahead}</span>}
          {merged.instances[0].aheadBehind.behind > 0 && <span>↓{merged.instances[0].aheadBehind.behind}</span>}
        </span>
      )}

      {!isRemote && merged.instances.some(i => i.upstreamGone) && (
        <span style={styles.orphanBadge} title={l10n.t('Remote branch no longer exists (likely deleted after a merge)')}>
          <Codicon name="cloud-offline" style={{ fontSize: '12px' }} />
        </span>
      )}
    </div>
  );
}

// A section header (Local / a remote name / Tags): a chevron to collapse the whole section,
// an icon, a label, a count, and — only when the section has at least one folder — an
// expand/collapse-all button that appears on hover of the header.
function SectionHeader({ icon, label, count, sectionKey, collapsed, onToggleSection, topBorder, folderPaths, onSetFoldersCollapsed }: {
  icon: string;
  label: string;
  count: number;
  sectionKey: SectionKey;
  collapsed: Set<SectionKey>;
  onToggleSection: (key: SectionKey) => void;
  topBorder?: boolean;
  folderPaths?: string[];
  onSetFoldersCollapsed?: (paths: string[], collapse: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [actionHovered, setActionHovered] = useState(false);
  const hasFolders = !!folderPaths && folderPaths.length > 0;
  const allCollapsed = hasFolders && folderPaths!.every(p => collapsed.has(p));

  return (
    <div
      style={styles.sectionHeader(topBorder)}
      onClick={() => onToggleSection(sectionKey)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={styles.chevron}>{collapsed.has(sectionKey) ? '▶' : '▼'}</span>
      <Codicon name={icon} style={styles.sectionIcon} />
      <span style={styles.sectionLabel}>{label}</span>
      {hasFolders && hovered && (
        <button
          style={styles.sectionActionBtn(actionHovered)}
          title={allCollapsed ? l10n.t('Expand all folders') : l10n.t('Collapse all folders')}
          onMouseEnter={() => setActionHovered(true)}
          onMouseLeave={() => setActionHovered(false)}
          onClick={(e) => {
            e.stopPropagation();
            onSetFoldersCollapsed!(folderPaths!, !allCollapsed);
          }}
        >
          <Codicon name={allCollapsed ? 'expand-all' : 'collapse-all'} style={{ fontSize: '13px' }} />
        </button>
      )}
      <span style={styles.count}>{count}</span>
    </div>
  );
}

// A section's full branch list: the current branch and primary branch (e.g. "main") pinned
// at the top — current first — followed by the tree view of everything else, folders and
// branches merged into one alphabetical-by-name list.
function BranchList({
  merged, keyPrefix, collapsed, onToggleFolder,
  repoColorMap, multiRepo, selectedBranchFilter, contextMenu, setContextMenu,
  primaryInstance, focusInstance, onBranchFocus, onBranchFilterSelect, forceExpanded,
}: {
  merged: MergedBranch[];
  keyPrefix: string;
  collapsed: Set<SectionKey>;
  onToggleFolder: (key: SectionKey) => void;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  selectedBranchFilter: string;
  contextMenu: { merged: MergedBranch; x: number; y: number } | null;
  setContextMenu: (v: { merged: MergedBranch; x: number; y: number } | null) => void;
  primaryInstance: (m: MergedBranch) => BranchInfo;
  focusInstance: (m: MergedBranch) => BranchInfo | undefined;
  onBranchFocus: (branch: BranchInfo) => void;
  onBranchFilterSelect: (branchName: string) => void;
  forceExpanded?: boolean;
}) {
  const { pinned, rest } = splitPinned(merged);

  const renderLeaf = (m: MergedBranch, depth: number) => (
    <BranchRow
      key={m.baseName}
      merged={m}
      depth={depth}
      displayName={m.baseName.split('/').pop()}
      repoColorMap={repoColorMap}
      multiRepo={multiRepo}
      isFilterSelected={selectedBranchFilter === primaryInstance(m).name}
      isCtxActive={contextMenu?.merged.baseName === m.baseName}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ merged: m, x: e.clientX, y: e.clientY });
      }}
      onClick={() => {
        const instance = focusInstance(m);
        if (instance) onBranchFocus(instance);
      }}
      onDoubleClick={() => onBranchFilterSelect(primaryInstance(m).name)}
    />
  );

  return (
    <>
      {pinned.map(m => renderLeaf(m, 0))}
      <BranchTree
        node={buildBranchTree(rest, m => m.baseName)}
        depth={0}
        keyPrefix={keyPrefix}
        collapsedKeys={collapsed}
        onToggleFolder={onToggleFolder}
        renderLeaf={renderLeaf}
        getLeafName={m => m.baseName.split('/').pop() ?? m.baseName}
        getRepoIds={m => m.repoIds}
        getAheadBehind={m => m.instances[0].aheadBehind}
        repoColorMap={repoColorMap}
        multiRepo={multiRepo}
        forceExpanded={forceExpanded}
      />
    </>
  );
}

// A tag section's full list, mirroring BranchList: a tree view where folders and tags are
// merged into one alphabetical-by-name list at each level.
function TagList({
  mergedTags, keyPrefix, collapsed, onToggleFolder,
  repoColorMap, multiRepo, activeDetachedTags, tagContextMenu, setTagContextMenu, forceExpanded,
}: {
  mergedTags: MergedTag[];
  keyPrefix: string;
  collapsed: Set<SectionKey>;
  onToggleFolder: (key: SectionKey) => void;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  activeDetachedTags: Set<string>;
  tagContextMenu: { mergedTag: MergedTag; x: number; y: number } | null;
  setTagContextMenu: (v: { mergedTag: MergedTag; x: number; y: number } | null) => void;
  forceExpanded?: boolean;
}) {
  const renderLeaf = (mt: MergedTag, depth: number) => (
    <TagRow
      key={mt.name}
      mergedTag={mt}
      depth={depth}
      displayName={mt.name.split('/').pop()}
      repoColorMap={repoColorMap}
      multiRepo={multiRepo}
      isActive={activeDetachedTags.has(mt.name)}
      isCtxActive={tagContextMenu?.mergedTag.name === mt.name}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setTagContextMenu({ mergedTag: mt, x: e.clientX, y: e.clientY });
      }}
    />
  );

  return (
    <BranchTree
      node={buildBranchTree(mergedTags, mt => mt.name)}
      depth={0}
      keyPrefix={keyPrefix}
      collapsedKeys={collapsed}
      onToggleFolder={onToggleFolder}
      renderLeaf={renderLeaf}
      getLeafName={mt => mt.name.split('/').pop() ?? mt.name}
      getRepoIds={mt => mt.repoIds}
      repoColorMap={repoColorMap}
      multiRepo={multiRepo}
      forceExpanded={forceExpanded}
    />
  );
}

function FolderRow({ name, fullPath, depth, collapsed, onToggle, repoIds, repoColorMap, multiRepo, aheadBehind }: {
  name: string;
  fullPath: string;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
  repoIds: string[];
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  aheadBehind?: { ahead: number; behind: number };
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <div
      data-nav-row=""
      tabIndex={-1}
      style={styles.folderRow(depth, hovered, focused)}
      onMouseEnter={(e) => { setHovered(true); focusOnHover(e.currentTarget); }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    >
      <span style={styles.chevron}>{collapsed ? '▶' : '▼'}</span>
      <Codicon name={collapsed ? 'folder' : 'folder-opened'} style={styles.branchIcon(false, false, primaryBranchColor())} />
      <span style={styles.folderName} title={fullPath}>{name}</span>
      {multiRepo && (
        <span style={styles.dotGroup}>
          {repoIds.map(id => (
            <span key={id} style={styles.repoDot(repoColorMap[id] ?? '#888')} />
          ))}
        </span>
      )}
      {aheadBehind && (aheadBehind.ahead > 0 || aheadBehind.behind > 0) && (
        <span style={styles.aheadBehind} title={l10n.t('{0} to push, {1} to pull (total for branches in this folder)', aheadBehind.ahead, aheadBehind.behind)}>
          {aheadBehind.ahead > 0 && <span>↑{aheadBehind.ahead}</span>}
          {aheadBehind.behind > 0 && <span>↓{aheadBehind.behind}</span>}
        </span>
      )}
    </div>
  );
}

// Renders a branch (or tag) tree recursively: at each level, folders and leaves are merged
// into one alphabetically-sorted-by-name list (like a typical file explorer), each level
// indented by `depth`. Pinned branches (current / main) are handled by the caller, which
// omits them from the tree entirely and renders them above it instead.
function BranchTree<T>({ node, depth, keyPrefix, collapsedKeys, onToggleFolder, renderLeaf, getLeafName, getRepoIds, getAheadBehind, repoColorMap, multiRepo, forceExpanded }: {
  node: BranchTreeFolder<T>;
  depth: number;
  keyPrefix: string;
  collapsedKeys: Set<SectionKey>;
  onToggleFolder: (key: SectionKey) => void;
  renderLeaf: (leaf: T, depth: number) => React.ReactNode;
  getLeafName: (leaf: T) => string;
  getRepoIds: (leaf: T) => string[];
  getAheadBehind?: (leaf: T) => { ahead: number; behind: number } | undefined;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  // While searching, folders holding a match must stay visible regardless of their saved
  // collapsed state — the user is looking for a result, not browsing the tree.
  forceExpanded?: boolean;
}) {
  // Folders always precede leaves at a given level — both sorted by name — rather than being
  // interleaved alphabetically, so the tree reads like a typical file explorer: folders first.
  type Entry = { name: string; folder?: BranchTreeFolder<T>; leaf?: T };
  const entries: Entry[] = [
    ...node.folders.map(folder => ({ name: folder.name, folder })).sort((a, b) => a.name.localeCompare(b.name)),
    ...node.leaves.map(leaf => ({ name: getLeafName(leaf), leaf })).sort((a, b) => a.name.localeCompare(b.name)),
  ];

  return (
    <>
      {entries.map(entry => {
        if (entry.leaf) return renderLeaf(entry.leaf, depth);
        const folder = entry.folder!;
        const key = `${keyPrefix}:${folder.path}`;
        const isCollapsed = !forceExpanded && collapsedKeys.has(key);
        return (
          <React.Fragment key={key}>
            <FolderRow
              name={folder.name}
              fullPath={folder.path}
              depth={depth}
              collapsed={isCollapsed}
              onToggle={() => onToggleFolder(key)}
              repoIds={collectRepoIds(folder, getRepoIds)}
              repoColorMap={repoColorMap}
              multiRepo={multiRepo}
              aheadBehind={getAheadBehind ? collectAheadBehind(folder, getAheadBehind) : undefined}
            />
            {!isCollapsed && (
              <BranchTree
                node={folder}
                depth={depth + 1}
                keyPrefix={keyPrefix}
                collapsedKeys={collapsedKeys}
                onToggleFolder={onToggleFolder}
                renderLeaf={renderLeaf}
                getLeafName={getLeafName}
                getRepoIds={getRepoIds}
                getAheadBehind={getAheadBehind}
                repoColorMap={repoColorMap}
                multiRepo={multiRepo}
                forceExpanded={forceExpanded}
              />
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

function TagRow({ mergedTag, repoColorMap, multiRepo, isActive, isCtxActive, onContextMenu, depth = 0, displayName }: {
  mergedTag: MergedTag;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  isActive: boolean;
  isCtxActive: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  depth?: number;
  displayName?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const primaryColor = primaryBranchColor();

  return (
    <div
      data-nav-row=""
      tabIndex={-1}
      style={styles.branchRow(isActive, false, hovered, isCtxActive, depth, focused)}
      onMouseEnter={(e) => { setHovered(true); focusOnHover(e.currentTarget); }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onContextMenu={onContextMenu}
      title={`${isActive ? l10n.t('Tag: {0} (current)', mergedTag.name) : l10n.t('Tag: {0}', mergedTag.name)}\n${l10n.t('Right-click for actions')}`}
    >
      <span style={styles.chevronSpacer} />
      <Codicon name="tag" style={styles.branchIcon(false, isActive, primaryColor)} />
      <span style={styles.branchName(isActive, false, primaryColor)} title={mergedTag.name}>{displayName ?? mergedTag.name}</span>
      {multiRepo && (
        <span style={styles.dotGroup}>
          {mergedTag.repoIds.map(id => (
            <span key={id} style={styles.repoDot(repoColorMap[id] ?? '#888')} />
          ))}
        </span>
      )}
    </div>
  );
}

function useClampedPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number }>({ left: x, top: y });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;
    const left = rect.right > vw ? Math.max(margin, x - (rect.right - vw) - margin) : x;
    let top = y;
    let maxHeight: number | undefined;
    if (y + rect.height + margin > vh) {
      const topIfUp = y - rect.height;
      if (topIfUp >= margin) {
        top = topIfUp;
      } else {
        top = margin;
        maxHeight = vh - margin * 2;
      }
    }
    setPos({ left, top, maxHeight });
  }, []);
  return { ref, pos };
}

type MenuItem = { icon: string; label: string; action: () => void; danger?: boolean } | { sep: true };

function MenuItemRow({ item }: { item: MenuItem }) {
  if ('sep' in item) return <div style={styles.separator} />;
  return (
    <div data-ctx-item="" style={styles.menuItem(item.danger)} onClick={item.action}>
      <Codicon name={item.icon} style={styles.menuIcon} />
      {item.label}
    </div>
  );
}

function TagContextMenu({ mergedTag, x, y, canDelete, onClose, onCheckout, onMerge, onPush, onDelete }: {
  mergedTag: MergedTag;
  x: number; y: number;
  canDelete: boolean;
  onClose: () => void;
  onCheckout: () => void;
  onMerge: () => void;
  onPush: () => void;
  onDelete: () => void;
}) {
  const { ref, pos } = useClampedPosition(x, y);
  useEffect(() => {
    const onBlur = () => onClose();
    const onMouseDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKeyDown = (e: KeyboardEvent) => { if (isImeComposing(e)) return; if (e.key === 'Escape') onClose(); };
    window.addEventListener('blur', onBlur);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);
  const items: MenuItem[] = [
    { icon: 'arrow-right', label: l10n.t('Checkout "{0}"', mergedTag.name), action: onCheckout },
    { sep: true },
    { icon: 'git-merge', label: l10n.t('Merge into current'), action: onMerge },
    { icon: 'cloud-upload', label: l10n.t('Push to remote...'), action: onPush },
    ...(canDelete ? [{ sep: true as const }, { icon: 'trash', label: l10n.t('Delete tag'), action: onDelete, danger: true }] : []),
  ];

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div ref={ref} style={styles.contextMenu(pos.left, pos.top, pos.maxHeight)}>
        {items.map((item, i) => <MenuItemRow key={i} item={item} />)}
      </div>
    </>
  );
}

function ContextMenu({ merged, x, y, canDelete, onClose, onCheckout, onMerge, onRebase, onRename, onDelete, onPull, onPush }: {
  merged: MergedBranch;
  x: number; y: number;
  canDelete: boolean;
  onClose: () => void;
  onCheckout: () => void;
  onMerge: () => void;
  onRebase: () => void;
  onRename?: () => void;
  onDelete: () => void;
  onPull?: () => void;
  onPush?: () => void;
}) {
  const { ref, pos } = useClampedPosition(x, y);
  useEffect(() => {
    const onBlur = () => onClose();
    const onMouseDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKeyDown = (e: KeyboardEvent) => { if (isImeComposing(e)) return; if (e.key === 'Escape') onClose(); };
    window.addEventListener('blur', onBlur);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);
  const copyName = () => {
    navigator.clipboard.writeText(merged.baseName).catch(() => {});
    onClose();
  };
  const items: MenuItem[] = [
    { icon: 'arrow-right', label: l10n.t('Checkout "{0}"', merged.baseName), action: onCheckout },
    { sep: true },
    { icon: 'git-merge', label: l10n.t('Merge into current'), action: onMerge },
    { icon: 'repo-forked', label: l10n.t('Rebase onto "{0}"', merged.baseName), action: onRebase },
    ...(onPull || onPush ? [
      { sep: true as const },
      ...(onPull ? [{ icon: 'cloud-download', label: l10n.t('Pull "{0}"', merged.baseName), action: onPull }] : []),
      ...(onPush ? [{ icon: 'cloud-upload', label: l10n.t('Push "{0}"...', merged.baseName), action: onPush }] : []),
    ] : []),
    { sep: true },
    ...(onRename ? [{ icon: 'edit', label: l10n.t('Rename…'), action: onRename }] : []),
    { icon: 'copy', label: l10n.t('Copy Branch Name'), action: copyName },
    ...(canDelete ? [{ sep: true as const }, { icon: 'trash', label: l10n.t('Delete branch'), action: onDelete, danger: true }] : []),
  ];

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div ref={ref} style={styles.contextMenu(pos.left, pos.top, pos.maxHeight)}>
        {items.map((item, i) => <MenuItemRow key={i} item={item} />)}
      </div>
    </>
  );
}


const styles = {
  container: {
    width: '250px',
    flexShrink: 0,
    borderRight: '1px solid var(--vscode-panel-border)',
    overflow: 'hidden' as const,
    background: 'var(--vscode-sideBar-background)',
    display: 'flex',
    flexDirection: 'column' as const,
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    position: 'relative' as const,
    userSelect: 'none' as const,
  },
  stickyHeader: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 10,
    background: 'var(--vscode-sideBar-background)',
  },
  searchBox: {
    borderBottom: '1px solid var(--vscode-panel-border)',
    display: 'flex',
    alignItems: 'stretch',
    height: '28px',
  },
  searchInputWrap: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    background: 'var(--vscode-sideBar-background)',
    paddingLeft: '8px',
    gap: '5px',
  } as React.CSSProperties,
  searchIcon: {
    fontSize: '13px',
    opacity: 0.5,
    flexShrink: 0,
    color: 'var(--vscode-input-foreground)',
  } as React.CSSProperties,
  searchInput: {
    flex: 1,
    minWidth: 0,
    padding: '0 6px 0 0',
    background: 'transparent',
    color: 'var(--vscode-input-foreground)',
    border: 'none',
    fontSize: '12px',
    outline: 'none',
    height: '100%',
    boxSizing: 'border-box' as const,
  },
  collapseBtn: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    borderLeft: '1px solid var(--vscode-panel-border)',
    cursor: 'pointer',
    padding: '0 5px',
    borderRadius: 0,
    color: 'var(--vscode-foreground)',
    opacity: 0.6,
  } as React.CSSProperties,
  collapseBtnInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3px 3px',
    borderRadius: '3px',
  } as React.CSSProperties,
  repoDot: (color: string): React.CSSProperties => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    padding: '1px 2px',
    opacity: 0.6,
    display: 'flex',
    alignItems: 'center',
  } as React.CSSProperties,
  sectionActionBtn: (hovered = false): React.CSSProperties => ({
    background: hovered ? 'var(--vscode-toolbar-hoverBackground)' : 'transparent',
    border: 'none',
    outline: 'none',
    font: 'inherit',
    fontSize: 0,
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    padding: 0,
    margin: 0,
    width: '18px',
    height: '18px',
    lineHeight: '18px',
    boxSizing: 'border-box' as const,
    borderRadius: '3px',
    opacity: hovered ? 1 : 0.75,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  }),
  sectionHeader: (topBorder?: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '5px 8px',
    height: '26px',
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    userSelect: 'none' as const,
    background: 'var(--vscode-sideBarSectionHeader-background)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    ...(topBorder ? { borderTop: '1px solid var(--vscode-panel-border)' } : {}),
    color: 'var(--vscode-foreground)',
    minWidth: 0,
  }),
  chevron: {
    fontSize: '9px',
    opacity: 0.5,
    width: '10px',
    flexShrink: 0,
  },
  chevronSpacer: {
    width: '10px',
    flexShrink: 0,
  } as React.CSSProperties,
  sectionIcon: {
    fontSize: '13px',
    opacity: 0.7,
    flexShrink: 0,
  } as React.CSSProperties,
  sectionLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '11px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--vscode-foreground)',
  },
  count: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px',
    padding: '0 5px',
    fontSize: '10px',
    flexShrink: 0,
  },
  branchRow: (isHead: boolean, isFilterSelected: boolean, hovered = false, ctxActive = false, depth = 0, keyboardFocused = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: `2px 8px 2px ${8 + depth * 14}px`,
    cursor: 'pointer',
    minWidth: 0,
    background: keyboardFocused
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : isFilterSelected
        ? 'var(--vscode-list-hoverBackground)'
        : ctxActive
          ? 'var(--vscode-list-inactiveSelectionBackground)'
          : hovered
            ? 'var(--vscode-list-hoverBackground)'
            : 'transparent',
    color: 'var(--vscode-foreground)',
    fontSize: '12px',
    minHeight: '22px',
    outline: isFilterSelected ? '1px solid var(--vscode-focusBorder)' : 'none',
    outlineOffset: '-1px',
  }),
  branchIcon: (isPrimary: boolean, isHead: boolean, primaryColor: string): React.CSSProperties => ({
    fontSize: '13px',
    flexShrink: 0,
    color: isHead ? primaryColor : 'var(--vscode-foreground)',
    opacity: isHead ? 1 : 0.55,
  }),
  branchName: (isHead: boolean, isPrimary: boolean, primaryColor: string): React.CSSProperties => ({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontWeight: isHead ? 'bold' : 'normal',
    color: isHead ? primaryColor : undefined,
  }),
  dotGroup: {
    display: 'flex',
    gap: '2px',
    alignItems: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  aheadBehind: {
    display: 'flex',
    gap: '2px',
    fontSize: '10px',
    opacity: 0.65,
    flexShrink: 0,
  },
  orphanBadge: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    opacity: 0.75,
    color: 'var(--vscode-editorWarning-foreground, #cca700)',
  } as React.CSSProperties,
  folderRow: (depth: number, hovered = false, keyboardFocused = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: `2px 8px 2px ${8 + depth * 14}px`,
    cursor: 'pointer',
    userSelect: 'none' as const,
    minHeight: '22px',
    minWidth: 0,
    outline: 'none',
    background: keyboardFocused
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : hovered
        ? 'var(--vscode-list-hoverBackground)'
        : 'transparent',
    color: 'var(--vscode-foreground)',
    fontSize: '12px',
  }),
  folderName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    opacity: 0.85,
  },
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 100,
  },
  contextMenu: (x: number, y: number, maxHeight?: number): React.CSSProperties => ({
    position: 'fixed',
    left: x,
    top: y,
    zIndex: 101,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border)',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    minWidth: '180px',
    padding: '4px 0',
    fontSize: '12px',
    ...(maxHeight ? { maxHeight, overflowY: 'auto' as const } : {}),
  }),
  menuItem: (danger?: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    cursor: 'pointer',
    color: danger ? 'var(--vscode-errorForeground)' : 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  }),
  menuIcon: {
    fontSize: '14px',
    flexShrink: 0,
    opacity: 0.8,
  } as React.CSSProperties,
  menuItemDisabled: {
    padding: '4px 12px',
    color: 'var(--vscode-disabledForeground)',
    whiteSpace: 'nowrap' as const,
    fontSize: '11px',
  } as React.CSSProperties,
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground)',
    margin: '4px 0',
  } as React.CSSProperties,
};
