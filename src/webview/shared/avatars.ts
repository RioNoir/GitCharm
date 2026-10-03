import { useEffect, useState } from 'react';
import { getVsCodeApi } from './vscodeApi';

/**
 * `gitcharm.avatars.enabled` (default on). The host injects the flag into every webview's HTML; with it off, no
 * avatar image is requested and callers fall back to initials. Which avatars may be shown — and so whether
 * Gravatar may be contacted — is decided by the host: see host/utils/avatarResolver.ts.
 */
export const avatarsEnabled: boolean =
  (window as unknown as { __GITCHARM_AVATARS__?: boolean }).__GITCHARM_AVATARS__ === true;

// ── Resolved by the host, in batches ─────────────────────────────────────────

type Request = { email: string; repoId?: string; sha?: string } | { url: string };

const waiting = new Map<string, (url: string | null) => void>();
let batch: (Request & { id: string })[] = [];
let nextId = 0;
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as { type?: string; id?: string; url?: string | null };
    if (msg?.type !== 'AVATAR_RESOLVED' || !msg.id) return;
    waiting.get(msg.id)?.(msg.url ?? null);
    waiting.delete(msg.id);
  });
}

/** Requests made in the same frame (a list rendering) go to the host as one message. */
function ask(req: Request): Promise<string | null> {
  listen();
  const id = String(nextId++);
  const promise = new Promise<string | null>(resolve => waiting.set(id, resolve));
  if (batch.length === 0) {
    setTimeout(() => {
      getVsCodeApi().postMessage({ type: 'AVATAR_RESOLVE', requests: batch });
      batch = [];
    }, 0);
  }
  batch.push({ ...req, id });
  return promise;
}

const authorCache = new Map<string, { promise: Promise<string | null>; withSha: boolean }>();

/**
 * The avatar URL of a commit author, or null for initials. `repoId` lets the host ask that repo's forge;
 * `sha` is a commit of theirs already on the forge (pushed), which GitHub, Gitea and Bitbucket match by.
 */
export function resolveAuthorAvatar(email: string, repoId?: string, sha?: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!avatarsEnabled || !normalized) return Promise.resolve(null);
  const key = `${repoId ?? ''}|${normalized}`;
  const cached = authorCache.get(key);
  // Asked without a commit, an author may still be found once one comes along: ask again then.
  if (cached && (cached.withSha || !sha)) return cached.promise;
  const promise = ask({ email: normalized, repoId, sha });
  authorCache.set(key, { promise, withSha: !!sha });
  return promise;
}

const urlCache = new Map<string, Promise<string | null>>();

/**
 * An avatar URL a forge's API gave (PR authors, reviewers, commenters…), as the host lets it be shown: forges
 * hand out Gravatar URLs for accounts without a picture of their own, or redirect to them, and the host follows
 * the redirects to check. Undefined while it checks, and when it may not be shown.
 */
export function useForgeAvatarUrl(url: string | undefined): string | undefined {
  const [checked, setChecked] = useState<string | undefined>(undefined);
  useEffect(() => {
    setChecked(undefined);
    if (!url || !avatarsEnabled) return;
    let promise = urlCache.get(url);
    if (!promise) {
      promise = ask({ url });
      urlCache.set(url, promise);
    }
    let cancelled = false;
    void promise.then(result => { if (!cancelled) setChecked(result ?? undefined); });
    return () => { cancelled = true; };
  }, [url]);
  return checked;
}

/**
 * Stable background color for an initials avatar. Keyed by name rather than email because forges report
 * PR authors, reviewers and commenters by name only; case-insensitive so "RioNoir" and "rionoir" match.
 */
export function avatarColor(name: string): string {
  const seed = name.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

/**
 * Font size for initials inside a circle of `size` px. With `lineHeight: 1` the text is centred at
 * (size - fontSize) / 2, so the font is a whole pixel with the same parity as the circle: otherwise the
 * baseline lands on a fractional pixel, the renderer snaps it, and the letters sit visibly off-centre.
 * Pair it with `lineHeight: 1` and `fontWeight: 600`, as AuthorAvatar does.
 */
export function initialsFontSize(size: number): number {
  const rounded = Math.round(size * 0.38);
  return (size - rounded) % 2 === 0 ? rounded : rounded - 1;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/).filter(p => /^[a-zA-ZÀ-ÿ]/.test(p));
  // Usernames such as "42bot" have no word starting with a letter: use their first characters.
  if (parts.length === 0) return trimmed ? trimmed.slice(0, 2).toUpperCase() : '?';
  if (parts.length === 1) { const w = parts[0] ?? ''; return (w.length > 1 ? w[0] + w[1] : w[0] ?? '?').toUpperCase(); }
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

/** The commit to give resolveAuthorAvatar for a Log Panel entry: only one the forge has — not unpushed, a stash or the working tree. */
export function forgeSha(commit: { hash: string; unpushed?: boolean; isStash?: boolean; isWorkingTree?: boolean }): string | undefined {
  return commit.unpushed || commit.isStash || commit.isWorkingTree ? undefined : commit.hash;
}
