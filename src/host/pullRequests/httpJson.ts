export class HttpJsonError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function httpJson<T>(url: string, init: RequestInit): Promise<{ data: T; headers: Headers }> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpJsonError(res.status, `HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  const data = (await res.json()) as T;
  return { data, headers: res.headers };
}
