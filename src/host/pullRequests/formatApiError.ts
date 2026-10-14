import * as vscode from 'vscode';
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
  const field = item.field ? `'${item.field}'` : vscode.l10n.t('field');
  switch (item.code) {
    case 'missing': return vscode.l10n.t('{0} is missing', field);
    case 'missing_field': return vscode.l10n.t('{0} is required', field);
    case 'invalid': return vscode.l10n.t('{0} is invalid', field);
    case 'already_exists': return vscode.l10n.t('{0} already exists', field);
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

/**
 * A forge refusing a repository's list request because of the account it's made with, as a
 * message that says so — instead of e.g. GitHub's raw `HTTP 404 Not Found: {...}`, its answer
 * for a private repository the account can't see. Undefined for any other error, rate limits
 * (GitHub answers those with a 403 too) included.
 */
export function describeAccessError(err: unknown, repoFullName: string): string | undefined {
  if (!(err instanceof HttpJsonError)) return undefined;
  const bodyMessage = typeof (err.body as { message?: unknown } | undefined)?.message === 'string'
    ? (err.body as { message: string }).message
    : '';
  if (/rate limit/i.test(bodyMessage) || /rate limit/i.test(err.message)) return undefined;
  switch (err.status) {
    case 401:
      return vscode.l10n.t('The account\'s credentials were rejected: the token may be expired or revoked. Sign in again or switch account.');
    case 403:
      return vscode.l10n.t('The account doesn\'t have permission to access {0}. Switch to an account that does.', repoFullName);
    case 422:
      // GitHub's search API (filtered lists) on a repo the account can't see.
      if (!/cannot be searched/i.test(err.message)) return undefined;
      // falls through
    case 404:
      return vscode.l10n.t('{0} wasn\'t found, or the account can\'t see it: a private repository needs an account with access to it.', repoFullName);
    default:
      return undefined;
  }
}
