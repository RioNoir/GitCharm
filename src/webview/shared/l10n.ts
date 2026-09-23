import * as l10n from '@vscode/l10n';

// Injected by getWebviewHtml(): the host's vscode.l10n.bundle (undefined when VS Code runs
// in English or no translation exists for its language) and vscode.env.language.
declare const window: Window & { __L10N__?: { bundle?: Record<string, string>; locale: string } };

const injected = window.__L10N__;
if (injected?.bundle) l10n.config({ contents: injected.bundle });

/** VS Code's display language (e.g. "en", "it", "pt-br"), for Intl formatters. */
export const locale: string = injected?.locale ?? 'en';

/**
 * Picks the singular message for exactly 1, the plural one otherwise. Both variants must be
 * passed through l10n.t() at the call site so l10n-dev extracts them:
 * `plural(n, l10n.t('1 file'), l10n.t('{0} files', n))`.
 * Same trade-off as src/host/utils/plural.ts: never Intl.PluralRules, whose "one" category
 * can cover counts other than 1 while singular messages hardcode "1".
 */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}

// Re-exported as a namespace on purpose: `npm run l10n:export` only extracts calls spelled
// `l10n.t(...)` (or `vscode.l10n.t(...)`) — a bare `t(...)` alias would be silently skipped.
export { l10n };
