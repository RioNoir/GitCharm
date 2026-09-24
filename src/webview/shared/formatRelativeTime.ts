import * as l10n from '@vscode/l10n';
import { locale } from './l10n';

// Intl phrases relative times natively for every display language (e.g. "3天前", "2 ore fa").
const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 60) return l10n.t('just now');
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return rtf.format(-diffMin, 'minute');
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return rtf.format(-diffHour, 'hour');
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return rtf.format(-diffDay, 'day');
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return rtf.format(-diffMonth, 'month');
  const diffYear = Math.round(diffMonth / 12);
  return rtf.format(-diffYear, 'year');
}
