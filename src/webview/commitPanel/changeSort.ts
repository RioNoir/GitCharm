import type { GitFileStatus } from '../shared/types';
import type { ChangeSortMode } from '../../host/types/settings';
import { locale } from '../shared/l10n';

export const compareNames = (a: string, b: string) => a.localeCompare(b, locale, { sensitivity: 'base', numeric: true });

// Most urgent first: conflicts block the commit, then content changes, then new/removed files.
const STATUS_ORDER: Record<GitFileStatus, number> = {
  conflicted: 0, modified: 1, renamed: 2, copied: 3, added: 4, deleted: 5, untracked: 6, submodule: 7,
};

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Orders the flat list of changes; the tree view always sorts by path (directories first). */
export function sortChanges<F extends { path: string; status: string }>(files: F[], mode: ChangeSortMode): F[] {
  const byPath = (a: F, b: F) => compareNames(a.path, b.path);
  const compare =
    mode === 'path' ? byPath
    : mode === 'status'
      ? (a: F, b: F) => (STATUS_ORDER[a.status as GitFileStatus] ?? 99) - (STATUS_ORDER[b.status as GitFileStatus] ?? 99) || byPath(a, b)
      : (a: F, b: F) => compareNames(baseName(a.path), baseName(b.path)) || byPath(a, b);
  return [...files].sort(compare);
}
