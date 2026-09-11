export class HttpJsonError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The response body parsed as JSON, when it was valid JSON — lets callers build a readable message from a forge's structured error shape (see formatApiError.ts) instead of only the raw-text `message`. */
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export async function httpJson<T>(url: string, init: RequestInit): Promise<{ data: T; headers: Headers }> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    let parsedBody: unknown;
    try { parsedBody = bodyText ? JSON.parse(bodyText) : undefined; } catch { parsedBody = undefined; }
    throw new HttpJsonError(res.status, `HTTP ${res.status} ${res.statusText}${bodyText ? `: ${bodyText}` : ''}`, parsedBody);
  }
  // A successful DELETE (and some other actions) commonly returns 204 No Content — no body to parse, and
  // res.json() throws "Unexpected end of JSON input" on empty text if called unconditionally.
  const bodyText = await res.text();
  const data = (bodyText ? JSON.parse(bodyText) : undefined) as T;
  return { data, headers: res.headers };
}
