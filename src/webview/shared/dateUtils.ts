// VS Code's display language rather than navigator.language, so dates match the rest of the UI.
import { locale } from './l10n';

export function formatDateTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const datePart = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
    const timePart = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
    return `${datePart} ${timePart}`;
  } catch {
    return dateStr;
  }
}

export function formatDateOnly(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return dateStr;
  }
}

export function formatDateCompact(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat(locale, {
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
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      ...(diffD > 365 ? { year: 'numeric' } : {}),
    }).format(date);
  } catch {
    return dateStr;
  }
}
