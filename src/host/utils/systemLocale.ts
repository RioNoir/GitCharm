import * as vscode from 'vscode';

// Dates follow the OS regional format (e.g. a user running VS Code in English with an Italian
// region wants 28/09/2026), while text — relative times, "today", plurals — follows
// vscode.env.language. Neither VS Code's API nor the webview's navigator.language (the display
// language) exposes the regional format, so resolve it here from the platform.

let cached: string | undefined;

/** BCP 47 tag of the OS regional format, for absolute date/time formatting. */
export function getSystemLocale(): string {
  if (cached === undefined) {
    const candidates = platformCandidates();
    candidates.push(vscode.env.language);
    cached = candidates.map(canonicalize).find((l): l is string => !!l) ?? 'en';
  }
  return cached;
}

function platformCandidates(): (string | undefined)[] {
  switch (process.platform) {
    case 'win32':
      // Node's ICU reads the user's regional format (GetUserDefaultLocaleName) on Windows.
      return [Intl.DateTimeFormat().resolvedOptions().locale];
    case 'darwin':
      // GUI apps don't get LANG from the region settings (the extension host often sees C.UTF-8),
      // so use the system language VS Code resolved, which carries the region (e.g. "it-it").
      return [nlsOsLocale()];
    default:
      return [posixLocale(), nlsOsLocale(), Intl.DateTimeFormat().resolvedOptions().locale];
  }
}

function posixLocale(): string | undefined {
  const raw = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG;
  if (!raw) return undefined;
  // "it_IT.UTF-8" → "it-IT"; C/POSIX carry no regional preference.
  const tag = raw.split(/[.@]/)[0].replace(/_/g, '-');
  return tag === 'C' || tag === 'POSIX' ? undefined : tag;
}

/** The OS language VS Code resolved at startup (Electron's preferred system languages). */
function nlsOsLocale(): string | undefined {
  try {
    const osLocale = JSON.parse(process.env.VSCODE_NLS_CONFIG ?? '{}').osLocale;
    return typeof osLocale === 'string' ? osLocale : undefined;
  } catch {
    return undefined;
  }
}

/** "it-it" → "it-IT"; undefined for tags Intl can't format. */
function canonicalize(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    return canonical && Intl.DateTimeFormat.supportedLocalesOf([canonical]).length > 0 ? canonical : undefined;
  } catch {
    return undefined;
  }
}
