import * as l10n from '@vscode/l10n';

// Injected by getWebviewHtml(): the host's vscode.l10n.bundle (undefined when VS Code runs
// in English or no translation exists for its language) and vscode.env.language.
declare const window: Window & { __L10N__?: { bundle?: Record<string, string>; locale: string } };

const injected = window.__L10N__;
if (injected?.bundle) l10n.config({ contents: injected.bundle });

/** VS Code's display language (e.g. "en", "it", "pt-br"), for Intl formatters. */
export const locale: string = injected?.locale ?? 'en';

const pluralRules = new Intl.PluralRules(locale);

/**
 * Picks between two already-translated messages by the language's plural rules.
 * Both variants must be passed through t() at the call site so l10n-dev extracts them:
 * `plural(n, t('1 file'), t('{0} files', n))`.
 */
export function plural(n: number, one: string, other: string): string {
  return pluralRules.select(n) === 'one' ? one : other;
}

export const t = l10n.t;
