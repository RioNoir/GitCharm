import { isPrimaryBranch } from '../../shared/branchUtils';
import { currentPalette as _currentPalette } from '../../shared/branchColors';
export {
  primaryBranchColor,
  headColor,
  tagColor,
  currentPalette,
  branchPaletteIndex,
  branchColor,
  normalizeBranchName,
  isDarkTheme,
} from '../../shared/branchColors';

export interface RefGroup {
  key: string;
  label: string;
  remoteName: string;    // name of the remote (e.g. "upstream", "origin"); empty for local
  isHead: boolean;       // this is the current HEAD branch
  isLocal: boolean;      // has a local branch
  isRemote: boolean;     // has a remote counterpart
  isTag: boolean;
  isDetached: boolean;   // HEAD is detached (on this tag or commit)
  isRemoteHead: boolean; // this is <remote>/HEAD (symbolic remote pointer)
}

export function groupRefs(refs: string[]): RefGroup[] {
  const headBranch = refs.find(r => r.startsWith('HEAD -> '))?.slice('HEAD -> '.length) ?? null;
  const isDetached = refs.includes('HEAD') && headBranch === null;

  // For remote refs: map branch name → {remoteName, fullRef}
  // e.g. "upstream/main" → { remoteName: "upstream", name: "main" }
  const remotes = new Map<string, string>(); // name → remoteName
  const locals = new Set<string>();
  const tags: string[] = [];
  let remoteHeadRemoteName: string | null = null;

  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) {
      locals.add(ref.slice('HEAD -> '.length));
    } else if (ref === 'HEAD') {
      // handled via isDetached above
    } else if (ref.startsWith('tag: ')) {
      tags.push(ref.slice('tag: '.length));
    } else if (ref.includes('/')) {
      const slash = ref.indexOf('/');
      const remoteName = ref.slice(0, slash);
      const name = ref.slice(slash + 1);
      if (name.toUpperCase() === 'HEAD') {
        // <remote>/HEAD symbolic pointer — track the remote name
        remoteHeadRemoteName = remoteName;
      } else {
        remotes.set(name, remoteName);
      }
    } else {
      locals.add(ref);
    }
  }

  const tagSet = new Set(tags);
  for (const t of tagSet) locals.delete(t);

  const groups: RefGroup[] = [];

  // Detached HEAD: show a HEAD badge on this commit
  if (isDetached) {
    groups.push({
      key: 'HEAD',
      label: 'HEAD',
      remoteName: '',
      isHead: true,
      isLocal: false,
      isRemote: false,
      isTag: false,
      isDetached: true,
      isRemoteHead: false,
    });
  }

  // <remote>/HEAD symbolic pointer
  if (remoteHeadRemoteName !== null) {
    groups.push({
      key: `${remoteHeadRemoteName}/HEAD`,
      label: 'HEAD',
      remoteName: remoteHeadRemoteName,
      isHead: false,
      isLocal: false,
      isRemote: true,
      isTag: false,
      isDetached: false,
      isRemoteHead: true,
    });
  }

  for (const local of locals) {
    const remoteEntry = remotes.get(local);
    const synced = remoteEntry !== undefined;
    groups.push({
      key: local,
      label: local,
      remoteName: '',
      isHead: local === headBranch,
      isLocal: true,
      isRemote: false,
      isTag: false,
      isDetached: false,
      isRemoteHead: false,
    });
    if (synced) {
      groups.push({
        key: `remote:${local}`,
        label: local,
        remoteName: remoteEntry,
        isHead: false,
        isLocal: false,
        isRemote: true,
        isTag: false,
        isDetached: false,
        isRemoteHead: false,
      });
      remotes.delete(local);
    }
  }

  for (const [name, remoteName] of remotes) {
    groups.push({
      key: `remote:${name}`,
      label: name,
      remoteName,
      isHead: false,
      isLocal: false,
      isRemote: true,
      isTag: false,
      isDetached: false,
      isRemoteHead: false,
    });
  }

  for (const tag of tags) {
    groups.push({
      key: `tag:${tag}`,
      label: tag,
      remoteName: '',
      isHead: false,
      isLocal: false,
      isRemote: false,
      isTag: true,
      isDetached: isDetached,
      isRemoteHead: false,
    });
  }

  groups.sort((a, b) => {
    // HEAD (detached or remote) always first
    if (a.isRemoteHead !== b.isRemoteHead) return a.isRemoteHead ? -1 : 1;
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    if (a.isTag !== b.isTag) return a.isTag ? 1 : -1;
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return 0;
  });

  return groups;
}

// Color for graph lanes with no associated branch name.
export function anonymousLaneColor(laneIndex: number): string {
  const p = _currentPalette();
  return p[laneIndex % p.length];
}
