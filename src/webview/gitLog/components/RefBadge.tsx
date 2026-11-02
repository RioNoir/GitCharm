import React from 'react';
import type { BranchInfo } from '../../shared/types';
import type { RefGroup } from '../utils/refs';

type Props = Omit<React.HTMLAttributes<HTMLSpanElement>, 'onContextMenu'> & {
  onBranchContextMenu?: React.MouseEventHandler<HTMLSpanElement>;
};

/** Ref markers must never fall through to the surrounding commit's context menu. */
export function RefBadge({ onBranchContextMenu, ...props }: Props) {
  return <span {...props} onContextMenu={event => {
    event.preventDefault();
    event.stopPropagation();
    onBranchContextMenu?.(event);
  }} />;
}

/** Resolve against current metadata so a stale decoration cannot target another ref. */
export function getBadgeBranches(group: RefGroup | undefined, repoId: string, branches: BranchInfo[]): BranchInfo[] {
  if (!group || group.isTag || group.isDetached || group.isRemoteHead) return [];
  const isRemote = group.isRemote && !group.isLocal;
  const remoteNames = group.remoteName.split(' & ');
  return branches.filter(branch => branch.repoId === repoId && branch.isRemote === isRemote && (isRemote
    ? remoteNames.some(remote => branch.name === `${remote}/${group.label}`)
    : branch.name === group.label));
}
