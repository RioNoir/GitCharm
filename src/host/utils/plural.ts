/**
 * Picks the singular message for exactly 1, the plural one otherwise. Both variants must be
 * passed through vscode.l10n.t() at the call site so l10n-dev extracts them:
 * `plural(n, vscode.l10n.t('1 file'), vscode.l10n.t('{0} files', n))`.
 *
 * Deliberately not Intl.PluralRules: singular messages hardcode "1", and some languages put
 * other numbers in the "one" category (e.g. Russian 21), which would display the wrong count.
 * With only two variants per message, languages with few/many forms are approximated anyway.
 */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}
