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

// Normalize a single raw ref token from %D --decorate=full output.
// Returns null if the token should be ignored.
function normalizeRef(raw: string): { kind: 'head-pointer'; branch: string }
  | { kind: 'detached-head' }
  | { kind: 'local'; name: string }
  | { kind: 'remote'; remoteName: string; name: string }
  | { kind: 'tag'; name: string }
  | null {
  // HEAD -> refs/heads/main  OR  HEAD -> main  (old format, no --decorate=full)
  if (raw.startsWith('HEAD -> ')) {
    const target = raw.slice('HEAD -> '.length);
    const branch = target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : target;
    return { kind: 'head-pointer', branch };
  }
  if (raw === 'HEAD') return { kind: 'detached-head' };
  // Full-form: refs/heads/<name>
  if (raw.startsWith('refs/heads/')) return { kind: 'local', name: raw.slice('refs/heads/'.length) };
  // Full-form: refs/remotes/<remote>/<name>  OR  refs/remotes/<remote>/HEAD
  if (raw.startsWith('refs/remotes/')) {
    const rest = raw.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const remoteName = rest.slice(0, slash);
    const name = rest.slice(slash + 1);
    return { kind: 'remote', remoteName, name };
  }
  // Full-form tag: refs/tags/<name>  OR  tag: <name>
  if (raw.startsWith('refs/tags/')) return { kind: 'tag', name: raw.slice('refs/tags/'.length) };
  if (raw.startsWith('tag: ')) {
    const n = raw.slice('tag: '.length);
    return { kind: 'tag', name: n.startsWith('refs/tags/') ? n.slice('refs/tags/'.length) : n };
  }
  // Fallback: short-form (old git / no --decorate=full).
  // A ref with a slash is ambiguous (could be remote/branch or local feature/foo).
  // Without a full prefix we can't tell, so treat it as a remote ref — this was
  // the old behaviour and is correct for the common case where locals rarely have slashes.
  if (raw.includes('/')) {
    const slash = raw.indexOf('/');
    return { kind: 'remote', remoteName: raw.slice(0, slash), name: raw.slice(slash + 1) };
  }
  return { kind: 'local', name: raw };
}

export function groupRefs(refs: string[]): RefGroup[] {
  const remotes = new Map<string, string>(); // branchName → remoteName
  const locals = new Set<string>();
  const tags: string[] = [];
  let headBranch: string | null = null;
  let isDetached = false;
  let remoteHeadRemoteName: string | null = null;

  for (const ref of refs) {
    const parsed = normalizeRef(ref);
    if (!parsed) continue;
    switch (parsed.kind) {
      case 'head-pointer':
        headBranch = parsed.branch;
        locals.add(parsed.branch);
        break;
      case 'detached-head':
        isDetached = true;
        break;
      case 'local':
        locals.add(parsed.name);
        break;
      case 'remote':
        if (parsed.name.toUpperCase() === 'HEAD') {
          remoteHeadRemoteName = parsed.remoteName;
        } else {
          // Last remote wins if multiple remotes track the same branch name — shouldn't happen in practice.
          remotes.set(parsed.name, parsed.remoteName);
        }
        break;
      case 'tag':
        tags.push(parsed.name);
        break;
    }
  }

  // HEAD is detached only when there is no HEAD -> branch pointer
  if (headBranch !== null) isDetached = false;

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
