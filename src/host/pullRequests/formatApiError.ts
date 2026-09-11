import { HttpJsonError } from './httpJson';

interface GitHubErrorBody {
  message?: string;
  errors?: Array<{ resource?: string; field?: string; code?: string; message?: string }>;
}

interface GitLabErrorBody {
  message?: string | string[] | Record<string, string[]>;
}

interface BitbucketErrorBody {
  type?: string;
  error?: { message?: string; detail?: string | Record<string, unknown>; fields?: Record<string, string[]> };
}

interface GiteaErrorBody {
  message?: string;
  url?: string;
}

/** One entry from GitHub's `errors[]` — most codes carry no `message` of their own, so build a readable
 * phrase from `field`/`code` instead (the GitHub REST docs list `code` as one of missing/missing_field/
 * invalid/already_exists/custom — only "custom" reliably includes its own `message`). */
function formatGitHubErrorItem(item: NonNullable<GitHubErrorBody['errors']>[number]): string {
  if (item.message) return item.message;
  const field = item.field ? `'${item.field}'` : 'field';
  switch (item.code) {
    case 'missing': return `${field} is missing`;
    case 'missing_field': return `${field} is required`;
    case 'invalid': return `${field} is invalid`;
    case 'already_exists': return `${field} already exists`;
    default: return `${field}: ${item.code ?? 'invalid'}`;
  }
}

function flattenGitLabMessage(message: GitLabErrorBody['message']): string | undefined {
  if (!message) return undefined;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');
  // { field: [errors] } — join as "field errors" pairs, same shape ActiveRecord validation errors take.
  return Object.entries(message).map(([field, errs]) => `${field} ${errs.join(', ')}`).join('; ');
}

/** Turns a caught error from any of the four forge providers into a message worth showing the user — parses
 * each forge's own structured validation-error body (GitHub's `errors[]`, GitLab's `message` variants,
 * Bitbucket's `error.message`, Gitea's `message`) instead of surfacing the raw `HTTP 422 ...: {...}` string
 * that `httpJson` builds for logging/debugging. Falls back to that raw string when the body isn't recognized
 * or isn't JSON (e.g. an HTML error page, a network failure). */
export function formatApiError(err: unknown): string {
  if (!(err instanceof HttpJsonError) || err.body === undefined || typeof err.body !== 'object' || err.body === null) {
    return err instanceof Error ? err.message : String(err);
  }
  const body = err.body as GitHubErrorBody & GitLabErrorBody & BitbucketErrorBody & GiteaErrorBody;

  // Bitbucket: { type: "error", error: { message, ... } }
  if (body.type === 'error' && body.error?.message) {
    return body.error.message;
  }

  // GitHub: { message, errors: [{ resource, field, code, message? }] }
  if (Array.isArray(body.errors) && body.errors.length > 0 && body.errors.every(e => typeof e === 'object' && e && 'code' in e)) {
    const details = body.errors.map(formatGitHubErrorItem).join('; ');
    return body.message ? `${body.message}: ${details}` : details;
  }

  // GitLab validation-style: { message: string | string[] | { field: string[] } }
  if (body.message && typeof body.message !== 'string') {
    const flattened = flattenGitLabMessage(body.message);
    if (flattened) return flattened;
  }

  // Gitea, and GitLab's plain-string case: { message: string }
  if (typeof body.message === 'string' && body.message) {
    return body.message;
  }

  return err.message;
}
