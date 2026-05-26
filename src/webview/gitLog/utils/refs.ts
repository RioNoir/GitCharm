export interface RefGroup {
  key: string;
  label: string;
  isHead: boolean;   // this is the HEAD branch
  isLocal: boolean;  // has a local branch
  isRemote: boolean; // has a remote counterpart
  isTag: boolean;
}

export function groupRefs(refs: string[]): RefGroup[] {
  const headBranch = refs.find(r => r.startsWith('HEAD -> '))?.slice('HEAD -> '.length) ?? null;
  const locals = new Set<string>();
  const remotes = new Set<string>();
  const tags: string[] = [];

  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) {
      locals.add(ref.slice('HEAD -> '.length));
    } else if (ref === 'HEAD') {
      // detached HEAD — skip
    } else if (ref.startsWith('tag: ')) {
      tags.push(ref.slice('tag: '.length));
    } else if (ref.includes('/')) {
      const name = ref.slice(ref.indexOf('/') + 1);
      remotes.add(name);
    } else {
      locals.add(ref);
    }
  }

  const groups: RefGroup[] = [];

  for (const local of locals) {
    const synced = remotes.has(local);
    groups.push({
      key: local,
      label: local,
      isHead: local === headBranch,
      isLocal: true,
      isRemote: false,
      isTag: false,
    });
    if (synced) {
      groups.push({
        key: `remote:${local}`,
        label: local,
        isHead: false,
        isLocal: false,
        isRemote: true,
        isTag: false,
      });
      remotes.delete(local);
    }
  }

  for (const remote of remotes) {
    groups.push({
      key: `remote:${remote}`,
      label: remote,
      isHead: false,
      isLocal: false,
      isRemote: true,
      isTag: false,
    });
  }

  for (const tag of tags) {
    groups.push({
      key: `tag:${tag}`,
      label: tag,
      isHead: false,
      isLocal: false,
      isRemote: false,
      isTag: true,
    });
  }

  // HEAD local first, then its remote, then other locals+remotes, then tags
  groups.sort((a, b) => {
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    if (a.isTag !== b.isTag) return a.isTag ? 1 : -1;
    // group by label so remote badge stays next to local
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    // local before remote within same label
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return 0;
  });

  return groups;
}

const BADGE_PALETTE_DARK = [
  '#569cd6', '#c586c0', '#4ec9b0', '#ce9178',
  '#4fc1ff', '#dcdcaa', '#6796e6', '#cd9731',
  '#b5cea8', '#d7ba7d', '#9cdcfe', '#f44747',
];

const BADGE_PALETTE_LIGHT = [
  '#1565c0', '#6a1b9a', '#00695c', '#bf360c',
  '#0277bd', '#f57f17', '#283593', '#e65100',
  '#2e7d32', '#4e342e', '#01579b', '#b71c1c',
];

export function branchColor(name: string): string {
  const isDark = typeof document !== 'undefined' &&
    (document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast'));
  const palette = isDark ? BADGE_PALETTE_DARK : BADGE_PALETTE_LIGHT;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}
