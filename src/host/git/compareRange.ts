/**
 * Ref helpers for the Git Log compare mode. Kept free of any `vscode` import so they
 * can be exercised outside the extension host.
 */

/**
 * True when `ref` is safe to hand to git as one side of a `base..target` range: it must
 * not be parseable as an option, must not itself be a range, and must contain no
 * whitespace. Existence is checked separately (rev-parse) before use.
 */
export function isSafeCompareRef(ref: string): boolean {
  if (!ref || ref.startsWith('-')) return false;
  if (ref.includes('..')) return false;
  return !/[\s\0]/.test(ref);
}

/**
 * The local branch that stands for "the default branch" in a compare: the remote's
 * default branch name when a local branch of that name exists, else a local `main`,
 * else a local `master`. Undefined when none exist — the caller leaves the repo out.
 */
export async function pickLocalDefaultBranch(
  remoteDefault: string | undefined,
  localBranchExists: (name: string) => Promise<boolean>,
): Promise<string | undefined> {
  const candidates = [remoteDefault, 'main', 'master']
    .filter((name): name is string => !!name && isSafeCompareRef(name));
  for (const name of new Set(candidates)) {
    if (await localBranchExists(name)) return name;
  }
  return undefined;
}
