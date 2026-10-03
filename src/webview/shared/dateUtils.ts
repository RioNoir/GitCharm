// The OS regional format rather than navigator.language (VS Code's display language).
import * as l10n from '@vscode/l10n';
import { dateLocale, locale } from './l10n';

/**
 * gitcharm.dateFormat, injected by the host into every webview: 'auto' keeps each view's own style (absolute in
 * the Log Panel, relative elsewhere for recent dates), 'absolute' and 'relative' use one everywhere.
 */
export const dateFormatMode: 'auto' | 'absolute' | 'relative' = (() => {
  const v = (window as unknown as { __GITCHARM_DATE_FORMAT__?: string }).__GITCHARM_DATE_FORMAT__;
  return v === 'absolute' || v === 'relative' ? v : 'auto';
})();

// Intl phrases relative times natively for every display language (e.g. "3天前", "2 ore fa").
const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
const rtfNarrow = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });

/** "3 days ago", "just now"…, whatever gitcharm.dateFormat says. */
function relative(dateStr: string, narrow = false): string {
  const f = narrow ? rtfNarrow : rtf;
  const diffSec = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return l10n.t('just now');
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return f.format(-diffMin, 'minute');
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return f.format(-diffHour, 'hour');
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return f.format(-diffDay, 'day');
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return f.format(-diffMonth, 'month');
  return f.format(-Math.round(diffMonth / 12), 'year');
}

/** A relative time ("3 days ago") — or the date and time with gitcharm.dateFormat set to 'absolute'. */
export function formatRelativeTime(isoDate: string): string {
  if (dateFormatMode === 'absolute') return absoluteDateTime(isoDate);
  return relative(isoDate);
}

/**
 * Dates in lists (Sync, Stash, Shelf): relative for the last week, then the date — or one style throughout with
 * gitcharm.dateFormat set.
 */
export function formatListDate(iso: string): string {
  try {
    if (dateFormatMode === 'absolute') return absoluteDateTime(iso);
    if (dateFormatMode === 'relative') return relative(iso, true);
    const d = new Date(iso);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return l10n.t('just now');
    if (diffMin < 60) return rtfNarrow.format(-diffMin, 'minute');
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return rtfNarrow.format(-diffH, 'hour');
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return rtfNarrow.format(-diffD, 'day');
    return d.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: diffD > 365 ? 'numeric' : undefined });
  } catch { return iso; }
}

/** The Log Panel's dates: absolute — or relative with gitcharm.dateFormat set to 'relative'. */
export function formatDateTime(dateStr: string): string {
  if (dateFormatMode === 'relative') return relative(dateStr);
  return absoluteDateTime(dateStr);
}

function absoluteDateTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const datePart = new Intl.DateTimeFormat(dateLocale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
    const timePart = new Intl.DateTimeFormat(dateLocale, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
    return `${datePart} ${timePart}`;
  } catch {
    return dateStr;
  }
}

export function formatDateOnly(dateStr: string): string {
  if (dateFormatMode === 'relative') return relative(dateStr);
  try {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat(dateLocale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return dateStr;
  }
}

export function formatDateCompact(dateStr: string): string {
  if (dateFormatMode === 'relative') return relative(dateStr, true);
  try {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat(dateLocale, {
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return dateStr;
  }
}

export function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const diffD = Math.floor((Date.now() - date.getTime()) / 86400000);
    return new Intl.DateTimeFormat(dateLocale, {
      month: 'short',
      day: 'numeric',
      ...(diffD > 365 ? { year: 'numeric' } : {}),
    }).format(date);
  } catch {
    return dateStr;
  }
}
