import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * Where author avatars come from, in order:
 *  1. the repository's own forge (GitHub, GitLab, Bitbucket, Gitea), when the repo is connected to one: it already
 *     holds the commits and their authors, so asking it shares nothing new;
 *  2. public noreply addresses (GitHub, GitLab, Codeberg), which name the account themselves;
 *  3. Gravatar — only with `gitcharm.avatars.gravatar.enabled`, off by default, because it means sending a hash
 *     of the author's email to gravatar.com, and those hashes can be reversed back to the address.
 * With `gitcharm.avatars.enabled` off, nothing is requested at all and every avatar falls back to initials.
 */

export function avatarsEnabled(): boolean {
  return vscode.workspace.getConfiguration('gitcharm').get<boolean>('avatars.enabled', true) === true;
}

export function gravatarEnabled(): boolean {
  return avatarsEnabled() && vscode.workspace.getConfiguration('gitcharm').get<boolean>('avatars.gravatar.enabled', false) === true;
}

/** Twice the largest avatar drawn (32px), for HiDPI screens. */
const SIZE = 64;

function hostIs(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/**
 * Whether GitCharm may request this URL for an avatar. Gravatar and Libravatar serve pictures by a hash of the
 * email address, which can be reversed back to it: Gravatar only when the user turned it on, Libravatar never.
 * Forges hand out such URLs too, for accounts without a picture of their own, or redirect to them.
 */
function mayRequest(url: string): boolean {
  if (!url.startsWith('https://')) return false; // the webviews' CSP only loads https images anyway
  if (hostIs(url, 'libravatar.org')) return false;
  if (hostIs(url, 'gravatar.com')) return gravatarEnabled();
  // GitLab's picture for accounts without one: initials say as much, and better.
  return !/\/no_avatar[^/]*$/.test(new URL(url).pathname);
}

const MAX_REDIRECTS = 5;

async function probe(url: string, method: 'HEAD' | 'GET'): Promise<Response | undefined> {
  try {
    const res = await fetch(url, { method, redirect: 'manual' });
    if (method === 'GET') void res.body?.cancel();
    return res;
  } catch {
    return undefined;
  }
}

/**
 * The URL the avatar image is actually served from, or null if there is none or getting there means contacting a
 * service that mayRequest() rules out. Redirects are followed one at a time and each target is checked before it
 * is requested — a forge's avatar URL can redirect to Gravatar — and the webview is given the last one, so it
 * loads the image without being redirected anywhere.
 */
async function finalAvatarUrl(url: string): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!mayRequest(current)) return null;
    let res = await probe(current, 'HEAD');
    // Some servers don't answer HEAD.
    if (res && (res.status === 405 || res.status === 501)) res = await probe(current, 'GET');
    if (!res) return null;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }
    return res.ok && (res.headers.get('content-type') ?? '').startsWith('image/') ? current : null;
  }
  return null;
}

const checked = new Map<string, Promise<string | null>>();

/**
 * An avatar URL from a forge (a PR author, reviewer, commenter…) as it may be shown — see finalAvatarUrl().
 * Null with avatars off.
 */
export function checkAvatarUrl(url: string | undefined): Promise<string | null> {
  if (!url || !avatarsEnabled()) return Promise.resolve(null);
  let promise = checked.get(url);
  if (!promise) {
    promise = finalAvatarUrl(url);
    checked.set(url, promise);
  }
  return promise;
}

export function clearCheckedAvatarUrls(): void {
  checked.clear();
}

/** The account a public noreply address belongs to, and its avatar (still to be checked). */
async function noreplyAvatarUrl(email: string): Promise<string | undefined> {
  const github = /^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/.exec(email);
  if (github) {
    const [, id, user] = github;
    return id
      ? `https://avatars.githubusercontent.com/u/${id}?s=${SIZE}`
      : `https://avatars.githubusercontent.com/${encodeURIComponent(user!)}?s=${SIZE}`;
  }

  const gitlab = /^(?:\d+-)?([^@]+)@users\.noreply\.gitlab\.com$/.exec(email);
  if (gitlab) {
    try {
      const res = await fetch(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(gitlab[1]!)}`);
      if (!res.ok) return undefined;
      const users = await res.json() as { avatar_url?: string }[];
      return users[0]?.avatar_url;
    } catch {
      return undefined;
    }
  }

  const codeberg = /^([^@]+)@noreply\.codeberg\.org$/.exec(email);
  if (codeberg) {
    return `https://codeberg.org/user/avatar/${encodeURIComponent(codeberg[1]!)}/${SIZE}`;
  }
  return undefined;
}

function gravatarUrl(email: string): string {
  const hash = crypto.createHash('sha256').update(email).digest('hex');
  // d=404: no picture for this address answers 404 instead of a generated one.
  return `https://gravatar.com/avatar/${hash}?s=${SIZE}&d=404`;
}

export interface AvatarRequest {
  email: string;
  /** The repository the commit is in: its forge is asked first. */
  repoId?: string;
  /** A commit by this author that is on the forge (pushed), for forges that match by commit. */
  sha?: string;
}

type ForgeLookup = (repoId: string, email: string, sha?: string) => Promise<string | undefined>;

/** At most this many avatar lookups run at once: a Log Panel can ask for hundreds of authors in one go. */
const MAX_CONCURRENT = 4;

class AvatarResolver {
  private forgeLookup: ForgeLookup | undefined;
  /** Keyed by repo and email: a repo's forge may know an author another forge doesn't. */
  private readonly cache = new Map<string, { promise: Promise<string | null>; withSha: boolean }>();
  private running = 0;
  private readonly queue: (() => void)[] = [];

  setForgeLookup(lookup: ForgeLookup): void {
    this.forgeLookup = lookup;
  }

  clear(): void {
    this.cache.clear();
    clearCheckedAvatarUrls();
  }

  resolve(req: AvatarRequest): Promise<string | null> {
    if (!avatarsEnabled()) return Promise.resolve(null);
    const email = req.email.trim().toLowerCase();
    if (!email) return Promise.resolve(null);
    const key = `${req.repoId ?? ''}|${email}`;
    const cached = this.cache.get(key);
    // An answer found without a commit to ask the forge about is redone once one comes along.
    if (cached && (cached.withSha || !req.sha)) return cached.promise;
    const promise = this.limit(() => this.lookup({ ...req, email }));
    this.cache.set(key, { promise, withSha: !!req.sha });
    return promise;
  }

  private async lookup({ email, repoId, sha }: AvatarRequest): Promise<string | null> {
    if (repoId && this.forgeLookup) {
      const fromForge = await checkAvatarUrl(await this.forgeLookup(repoId, email, sha).catch(() => undefined));
      if (fromForge) return fromForge;
    }
    const fromNoreply = await checkAvatarUrl(await noreplyAvatarUrl(email));
    if (fromNoreply) return fromNoreply;
    if (gravatarEnabled()) return checkAvatarUrl(gravatarUrl(email));
    return null;
  }

  private async limit<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT) await new Promise<void>(resolve => this.queue.push(resolve));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

export const avatarResolver = new AvatarResolver();

/**
 * Webviews ask for avatars in batches with this message, and get each one back in an AVATAR_RESOLVED as soon as
 * it's found: a commit author's, or the checked form of a URL a forge's API gave.
 */
export interface AvatarResolveMsg {
  type: 'AVATAR_RESOLVE';
  requests: ((AvatarRequest | { url: string }) & { id: string })[];
}

/**
 * Answers a webview's AVATAR_RESOLVE messages. Added as its own listener, next to the panel's: the panel's
 * handler ignores the message type, and the undocked panel's two sub-apps share the one listener.
 */
export function attachAvatarResolver(webview: vscode.Webview): vscode.Disposable {
  return webview.onDidReceiveMessage((msg: { type?: string }) => {
    if (msg?.type !== 'AVATAR_RESOLVE') return;
    for (const r of (msg as AvatarResolveMsg).requests) {
      void ('url' in r ? checkAvatarUrl(r.url) : avatarResolver.resolve(r)).then(url => webview.postMessage({ type: 'AVATAR_RESOLVED', id: r.id, url }), () => undefined);
    }
  });
}
