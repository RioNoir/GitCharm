import React, { useState, useRef, useLayoutEffect, useEffect, forwardRef } from 'react';
import type { BranchInfo, RepoMeta, TagInfo } from '../../shared/types';
import { isPrimaryBranch } from '../../shared/branchUtils';
import { Codicon } from '../../shared/Codicon';

interface Props {
  repos: RepoMeta[];
  branches: BranchInfo[];
  tags: TagInfo[];
  filter: string;
  selectedBranchFilter: string;
  onFilterChange: (v: string) => void;
  onBranchFilterSelect: (branchName: string) => void;
  onCheckout: (repoIds: string[], branchName: string) => void;
  onMerge: (repoId: string, from: string) => void;
  onRebase: (repoId: string, onto: string) => void;
  onDelete: (repoIds: string[], branchName: string) => void;
  onFetchRepo: (repoId: string) => void;
  onPull: (repoId: string) => void;
  onPush: (repoId: string) => void;
  onCheckoutTag: (repoIds: string[], tagName: string) => void;
  onMergeTag: (repoIds: string[], tagName: string) => void;
  onPushTag: (repoId: string, tagName: string) => void;
  onDeleteTag: (repoIds: string[], tagName: string) => void;
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

function buildMergedBranches(branches: BranchInfo[]): MergedBranch[] {
  const map = new Map<string, MergedBranch>();
  for (const b of branches) {
    const baseName = stripRemotePrefix(b.name);
    const existing = map.get(baseName);
    if (existing) {
      existing.instances.push(b);
      if (!existing.repoIds.includes(b.repoId)) existing.repoIds.push(b.repoId);
      if (b.isHead) existing.isHead = true;
    } else {
      map.set(baseName, {
        baseName,
        isPrimary: isPrimaryBranch(baseName),
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
  repos, branches, tags, filter, selectedBranchFilter, onFilterChange, onBranchFilterSelect,
  onCheckout, onMerge, onRebase, onDelete, onFetchRepo, onPull, onPush,
  onCheckoutTag, onMergeTag, onPushTag, onDeleteTag,
}, ref) {
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ merged: MergedBranch; x: number; y: number } | null>(null);
  const [tagContextMenu, setTagContextMenu] = useState<{ mergedTag: MergedTag; x: number; y: number } | null>(null);

  function toggle(key: SectionKey) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const filtered = filter
    ? branches.filter(b => b.name.toLowerCase().includes(filter.toLowerCase()))
    : branches;

  // Exclude detached HEAD pseudo-branch from Local list — it shows up as a tag row instead
  const localMerged = sortMerged(buildMergedBranches(filtered.filter(b => !b.isRemote && b.name !== 'HEAD')));

  // Group remote branches by remote name (e.g. "origin", "upstream"), sorted alphabetically
  const remoteBranches = filtered.filter(b => b.isRemote && stripRemotePrefix(b.name) !== 'HEAD');
  const remoteGroupsMap = new Map<string, MergedBranch[]>();
  for (const b of remoteBranches) {
    const rName = b.remoteName ?? b.name.split('/')[0] ?? 'remote';
    if (!remoteGroupsMap.has(rName)) remoteGroupsMap.set(rName, []);
    remoteGroupsMap.get(rName)!.push(b);
  }
  const remoteGroups: { name: string; merged: MergedBranch[] }[] = Array.from(remoteGroupsMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bs]) => ({ name, merged: sortMerged(buildMergedBranches(bs)) }));

  // Active detached tag name(s) — shown as "current" in the Tags section
  const activeDetachedTags = new Set(branches.filter(b => b.detachedTag).map(b => b.detachedTag!));

  const mergedTags = buildMergedTags(
    filter ? tags.filter(t => t.name.toLowerCase().includes(filter.toLowerCase())) : tags
  );

  const repoColorMap = Object.fromEntries(repos.map(r => [r.id, r.color]));
  const multiRepo = repos.length > 1;

  function primaryInstance(merged: MergedBranch): BranchInfo {
    return merged.instances.find(i => i.isHead) ?? merged.instances[0];
  }

  return (
    <div ref={ref} style={styles.container} onClick={() => { setContextMenu(null); setTagContextMenu(null); }}>
      {/* Sticky header: search + repo list */}
      <div style={styles.stickyHeader}>
        <div style={styles.searchBox}>
          <input
            style={styles.searchInput}
            value={filter}
            onChange={e => onFilterChange(e.target.value)}
            placeholder="Filter branches & tags..."
          />
        </div>

        {repos.length > 1 && (
          <div style={styles.repoList}>
            {repos.map(repo => {
              const headBranch = repo.isWorktree
                ? branches.find(b => b.repoId === repo.id && b.isHead)
                : undefined;
              const wtBranch = headBranch
                ? (headBranch.detachedTag ?? headBranch.detachedHash ?? headBranch.name)
                : undefined;
              const displayName = wtBranch
                ? `${repo.mainWorktreePath?.split('/').pop() ?? repo.name} (${wtBranch})`
                : repo.name;
              return (
                <div key={repo.id} style={styles.repoRow}>
                  <span style={styles.repoDot(repo.color)} />
                  <span style={styles.repoName}>{displayName}</span>
                  {repo.isSubmodule && (
                    <span style={styles.submoduleBadge} title={repo.submodulePath ? `Submodule: ${repo.submodulePath}` : 'Submodule'}>
                      SUB
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* LOCAL section */}
      <div style={styles.sectionHeader} onClick={() => toggle('local')}>
        <span style={styles.chevron}>{collapsed.has('local') ? '▶' : '▼'}</span>
        <Codicon name="git-branch" style={styles.sectionIcon} />
        <span style={styles.sectionLabel}>Local</span>
        <span style={styles.count}>{localMerged.length}</span>
      </div>
      {!collapsed.has('local') && localMerged.map(m => (
        <BranchRow
          key={m.baseName}
          merged={m}
          repoColorMap={repoColorMap}
          multiRepo={multiRepo}
          isFilterSelected={selectedBranchFilter === m.baseName}
          isCtxActive={contextMenu?.merged.baseName === m.baseName}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ merged: m, x: e.clientX, y: e.clientY });
          }}
          onDoubleClick={() => onBranchFilterSelect(m.baseName)}
        />
      ))}

      {/* REMOTE sections — one per remote name (origin, upstream, …) */}
      {remoteGroups.map(({ name, merged }) => {
        const sectionKey = `remote:${name}`;
        return (
          <React.Fragment key={sectionKey}>
            <div style={styles.sectionHeader} onClick={() => toggle(sectionKey)}>
              <span style={styles.chevron}>{collapsed.has(sectionKey) ? '▶' : '▼'}</span>
              <Codicon name="cloud" style={styles.sectionIcon} />
              <span style={styles.sectionLabel}>{name.charAt(0).toUpperCase() + name.slice(1)}</span>
              <span style={styles.count}>{merged.length}</span>
            </div>
            {!collapsed.has(sectionKey) && merged.map(m => (
              <BranchRow
                key={m.baseName}
                merged={m}
                repoColorMap={repoColorMap}
                multiRepo={multiRepo}
                isFilterSelected={selectedBranchFilter === m.baseName}
                isCtxActive={contextMenu?.merged.baseName === m.baseName}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ merged: m, x: e.clientX, y: e.clientY });
                }}
                onDoubleClick={() => onBranchFilterSelect(m.baseName)}
              />
            ))}
          </React.Fragment>
        );
      })}

      {/* TAGS section */}
      {mergedTags.length > 0 && (
        <>
          <div style={styles.sectionHeader} onClick={() => toggle('tags')}>
            <span style={styles.chevron}>{collapsed.has('tags') ? '▶' : '▼'}</span>
            <Codicon name="tag" style={styles.sectionIcon} />
            <span style={styles.sectionLabel}>Tags</span>
            <span style={styles.count}>{mergedTags.length}</span>
          </div>
          {!collapsed.has('tags') && mergedTags.map(mt => (
            <TagRow
              key={mt.name}
              mergedTag={mt}
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
          ))}
        </>
      )}

      {/* Branch context menu */}
      {contextMenu && (() => {
        const inst = primaryInstance(contextMenu.merged);
        return (
          <ContextMenu
            merged={contextMenu.merged}
            x={contextMenu.x}
            y={contextMenu.y}
            canDelete={!contextMenu.merged.isHead}
            onClose={() => setContextMenu(null)}
            onCheckout={() => { onCheckout(contextMenu.merged.repoIds, inst.name); setContextMenu(null); }}
            onMerge={() => { onMerge(inst.repoId, inst.name); setContextMenu(null); }}
            onRebase={() => { onRebase(inst.repoId, inst.name); setContextMenu(null); }}
            onDelete={() => { onDelete(contextMenu.merged.repoIds, inst.name); setContextMenu(null); }}
            onPull={() => { onPull(inst.repoId); setContextMenu(null); }}
            onPush={() => { onPush(inst.repoId); setContextMenu(null); }}
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

function BranchRow({ merged, repoColorMap, multiRepo, isFilterSelected, isCtxActive, onContextMenu, onDoubleClick }: {
  merged: MergedBranch;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  isFilterSelected: boolean;
  isCtxActive: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const { baseName, isPrimary, isHead, repoIds } = merged;
  const isRemote = merged.instances[0].isRemote;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={styles.branchRow(isHead, isFilterSelected, hovered, isCtxActive)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      title={`${baseName}\nDouble-click to filter by this branch · Right-click for git actions`}
    >
      <Codicon
        name={isPrimary ? 'git-branch' : isRemote ? 'cloud' : 'git-branch'}
        style={styles.branchIcon(isPrimary, isHead)}
      />

      <span style={styles.branchName(isHead, isPrimary)}>{baseName}</span>

      {multiRepo && (
        <span style={styles.dotGroup}>
          {repoIds.map(id => (
            <span key={id} style={styles.repoDot(repoColorMap[id] ?? '#888')} />
          ))}
        </span>
      )}

      {merged.instances[0].aheadBehind && (
        <span style={styles.aheadBehind}>
          {merged.instances[0].aheadBehind.ahead > 0 && <span>↑{merged.instances[0].aheadBehind.ahead}</span>}
          {merged.instances[0].aheadBehind.behind > 0 && <span>↓{merged.instances[0].aheadBehind.behind}</span>}
        </span>
      )}
    </div>
  );
}

function TagRow({ mergedTag, repoColorMap, multiRepo, isActive, isCtxActive, onContextMenu }: {
  mergedTag: MergedTag;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  isActive: boolean;
  isCtxActive: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={styles.branchRow(isActive, false, hovered, isCtxActive)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={onContextMenu}
      title={`Tag: ${mergedTag.name}${isActive ? ' (current)' : ''}\nRight-click for actions`}
    >
      <Codicon
        name="tag"
        style={{
          ...styles.branchIcon(false, isActive),
          color: isActive
            ? 'var(--vscode-gitDecoration-addedResourceForeground)'
            : 'var(--vscode-gitDecoration-modifiedResourceForeground)',
          opacity: 1,
        }}
      />
      <span style={styles.branchName(isActive, false)}>{mergedTag.name}</span>
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
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = rect.right > vw ? Math.max(0, x - (rect.right - vw) - 4) : x;
    const top = rect.bottom > vh ? Math.max(0, y - (rect.bottom - vh) - 4) : y;
    if (left !== x || top !== y) setPos({ left, top });
  }, []);
  return { ref, pos };
}

type MenuItem = { icon: string; label: string; action: () => void; danger?: boolean } | { sep: true };

function MenuItemRow({ item }: { item: MenuItem }) {
  if ('sep' in item) return <div style={styles.separator} />;
  return (
    <div style={styles.menuItem(item.danger)} onClick={item.action}>
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
    window.addEventListener('blur', onClose);
    return () => window.removeEventListener('blur', onClose);
  }, [onClose]);
  const items: MenuItem[] = [
    { icon: 'arrow-right', label: `Checkout "${mergedTag.name}"`, action: onCheckout },
    { sep: true },
    { icon: 'git-merge', label: 'Merge into current', action: onMerge },
    { icon: 'cloud-upload', label: 'Push to remote...', action: onPush },
    ...(canDelete ? [{ sep: true as const }, { icon: 'trash', label: 'Delete tag', action: onDelete, danger: true }] : []),
  ];

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div ref={ref} style={styles.contextMenu(pos.left, pos.top)}>
        {items.map((item, i) => <MenuItemRow key={i} item={item} />)}
      </div>
    </>
  );
}

function ContextMenu({ merged, x, y, canDelete, onClose, onCheckout, onMerge, onRebase, onDelete, onPull, onPush }: {
  merged: MergedBranch;
  x: number; y: number;
  canDelete: boolean;
  onClose: () => void;
  onCheckout: () => void;
  onMerge: () => void;
  onRebase: () => void;
  onDelete: () => void;
  onPull: () => void;
  onPush: () => void;
}) {
  const { ref, pos } = useClampedPosition(x, y);
  useEffect(() => {
    window.addEventListener('blur', onClose);
    return () => window.removeEventListener('blur', onClose);
  }, [onClose]);
  const items: MenuItem[] = [
    { icon: 'arrow-right', label: `Checkout "${merged.baseName}"`, action: onCheckout },
    { sep: true },
    { icon: 'git-merge', label: 'Merge into current', action: onMerge },
    { icon: 'repo-forked', label: `Rebase onto "${merged.baseName}"`, action: onRebase },
    { sep: true },
    { icon: 'cloud-download', label: 'Pull', action: onPull },
    { icon: 'cloud-upload', label: 'Push...', action: onPush },
    ...(canDelete ? [{ sep: true as const }, { icon: 'trash', label: 'Delete branch', action: onDelete, danger: true }] : []),
  ];

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div ref={ref} style={styles.contextMenu(pos.left, pos.top)}>
        {items.map((item, i) => <MenuItemRow key={i} item={item} />)}
      </div>
    </>
  );
}


const styles = {
  container: {
    width: '220px',
    flexShrink: 0,
    borderRight: '1px solid var(--vscode-panel-border)',
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
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
    padding: '6px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  searchInput: {
    width: '100%',
    padding: '4px 6px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '3px',
    fontSize: '11px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  repoList: {
    borderBottom: '1px solid var(--vscode-panel-border)',
    padding: '3px 0',
  },
  repoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 8px',
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
  },
  repoName: {
    flex: 1,
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    fontSize: '10px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  repoDot: (color: string): React.CSSProperties => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  submoduleBadge: {
    fontSize: '9px',
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--vscode-badge-foreground)',
    background: 'var(--vscode-badge-background)',
    borderRadius: '3px',
    padding: '1px 4px',
    flexShrink: 0,
    opacity: 0.75,
    marginLeft: '4px',
  } as React.CSSProperties,
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
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 8px',
    cursor: 'pointer',
    userSelect: 'none' as const,
    background: 'var(--vscode-sideBarSectionHeader-background)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    color: 'var(--vscode-foreground)',
  },
  chevron: {
    fontSize: '9px',
    opacity: 0.5,
    width: '10px',
    flexShrink: 0,
  },
  sectionIcon: {
    fontSize: '13px',
    opacity: 0.7,
    flexShrink: 0,
  } as React.CSSProperties,
  sectionLabel: {
    flex: 1,
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
  branchRow: (isHead: boolean, isFilterSelected: boolean, hovered = false, ctxActive = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 8px 2px 14px',
    cursor: 'pointer',
    background: isHead
      ? 'var(--vscode-list-activeSelectionBackground)'
      : isFilterSelected
        ? 'var(--vscode-list-hoverBackground)'
        : ctxActive
          ? 'var(--vscode-list-inactiveSelectionBackground)'
          : hovered
            ? 'var(--vscode-list-hoverBackground)'
            : 'transparent',
    color: isHead ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    fontSize: '12px',
    minHeight: '22px',
    outline: isFilterSelected ? '1px solid var(--vscode-focusBorder)' : 'none',
    outlineOffset: '-1px',
  }),
  branchIcon: (isPrimary: boolean, isHead: boolean): React.CSSProperties => ({
    fontSize: '13px',
    flexShrink: 0,
    color: isPrimary
      ? 'var(--vscode-gitDecoration-untrackedResourceForeground)'
      : isHead
        ? 'var(--vscode-gitDecoration-addedResourceForeground)'
        : 'var(--vscode-foreground)',
    opacity: isPrimary ? 1 : isHead ? 1 : 0.55,
  }),
  branchName: (isHead: boolean, isPrimary: boolean): React.CSSProperties => ({
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontWeight: (isHead || isPrimary) ? 'bold' : 'normal',
    color: isPrimary && !isHead
      ? 'var(--vscode-gitDecoration-untrackedResourceForeground)'
      : undefined,
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
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 100,
  },
  contextMenu: (x: number, y: number) => ({
    position: 'fixed' as const,
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
    fontStyle: 'italic',
    fontSize: '11px',
  } as React.CSSProperties,
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground)',
    margin: '4px 0',
  } as React.CSSProperties,
};
