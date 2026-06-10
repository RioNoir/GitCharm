export function formatDateTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const datePart = new Intl.DateTimeFormat(navigator.language, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
    const timePart = new Intl.DateTimeFormat(navigator.language, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
    return `${datePart} ${timePart}`;
  } catch {
    return dateStr;
  }
}

export function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const diffD = Math.floor((Date.now() - date.getTime()) / 86400000);
    return new Intl.DateTimeFormat(navigator.language, {
      month: 'short',
      day: 'numeric',
      ...(diffD > 365 ? { year: 'numeric' } : {}),
    }).format(date);
  } catch {
    return dateStr;
  }
}
