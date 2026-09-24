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

// Deliberately NOT re-exporting l10n: `npm run l10n:export` only extracts `l10n.t(...)` calls
// whose `l10n` is imported straight from '@vscode/l10n' (it follows the import, not the name).
// Components must `import * as l10n from '@vscode/l10n'`; this module only has to be imported
// once, first, by each webview entry point so the bundle is configured before rendering.
