/** Builds a compact unified-diff-style text from two full file contents, for feeding into an AI prompt.
 * Not a real patch (no hunk headers/context-line counts) — just `+`/`-`/` ` prefixed lines, good enough
 * for an LLM to read while staying dependency-free (no `diff` package in this project). Uses a standard
 * LCS line diff; guarded by `maxLines` since LCS is O(n*m) and PR files can be large. */
export function buildSimpleUnifiedDiff(before: string, after: string, maxLines = 2000): string {
  const beforeLines = before.length ? before.split('\n') : [];
  const afterLines = after.length ? after.split('\n') : [];

  if (beforeLines.length > maxLines || afterLines.length > maxLines) {
    return afterLines.length === 0
      ? '[file deleted, content omitted: too large]'
      : beforeLines.length === 0
        ? '[file added, content omitted: too large]'
        : '[diff omitted: file too large]';
  }

  const n = beforeLines.length;
  const m = afterLines.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = beforeLines[i] === afterLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      out.push(` ${beforeLines[i]}`);
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${beforeLines[i]}`);
      i++;
    } else {
      out.push(`+${afterLines[j]}`);
      j++;
    }
  }
  while (i < n) { out.push(`-${beforeLines[i]}`); i++; }
  while (j < m) { out.push(`+${afterLines[j]}`); j++; }

  return out.join('\n');
}
