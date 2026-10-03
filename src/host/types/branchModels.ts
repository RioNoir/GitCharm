// Branch name models (gitcharm.branchNameModels), shared by the host's branch prompt and the settings page,
// so both store and show the same prefixes. No vscode import: the webview bundles this file too.

/**
 * Normalizes a user-entered branch model into the stored `*`-suffixed standard,
 * e.g. "feature/" -> "feature/*", "feature" -> "feature/*", "revert-" -> "revert-*".
 * Entries that already contain a wildcard (e.g. "feature/**", "revert-*") are kept as-is.
 */
export function normalizeBranchModel(raw: string): string | undefined {
  const pattern = raw.trim().replace(/\\/g, '/');
  if (!pattern) return undefined;
  if (pattern.includes('*')) return pattern;

  if (pattern.endsWith('/') || pattern.endsWith('-') || pattern.endsWith('_')) {
    return `${pattern}*`;
  }
  return `${pattern}/*`;
}

/** The setting's entries normalized, without duplicates, sorted — the list the branch prompt offers. */
export function normalizeBranchModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = normalizeBranchModel(entry);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      models.push(normalized);
    }
  }
  return models.sort((a, b) => a.localeCompare(b));
}

/** Strips a trailing "*" or "**" from a stored model to get the literal prefix to prepend. */
export function modelPrefix(model: string): string {
  return model.replace(/\*+$/, '');
}
