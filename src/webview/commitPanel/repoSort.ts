import type { RepoMeta, RepoStatus } from '../shared/types';
import type { RepoSortMode } from '../../host/types/settings';

const collator = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

export function sortRepos<T extends RepoStatus>(repos: T[], mode: RepoSortMode, repoMetas: RepoMeta[]): T[] {
  const metaMap = new Map(repoMetas.map(m => [m.id, m]));

  if (mode === 'discovery') {
    const discoveryIndex = new Map(repoMetas.map((m, i) => [m.id, i]));
    return [...repos].sort((a, b) => (discoveryIndex.get(a.repoId) ?? Number.MAX_SAFE_INTEGER) - (discoveryIndex.get(b.repoId) ?? Number.MAX_SAFE_INTEGER));
  }

  const key = mode === 'name' ? 'name' : 'rootPath';
  return [...repos].sort((a, b) => collator(metaMap.get(a.repoId)?.[key] ?? '', metaMap.get(b.repoId)?.[key] ?? ''));
}
