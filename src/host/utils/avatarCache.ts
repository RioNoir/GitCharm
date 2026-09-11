import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Resolves and caches a small avatar image, for use as a `vscode.QuickPickItem.iconPath`
 * (which needs a local file/data Uri — QuickPick items are plain synchronous objects, so
 * this must run and settle before `showQuickPick` is called). Mirrors the resolution order
 * used by the webview's `AuthorAvatar` component (GitHub noreply avatar, else Gravatar), but
 * fetches and persists to disk with Node's `fetch`/`crypto` instead of the DOM APIs.
 */

const CACHE_SUBDIR = 'avatars';
/** Same size class used elsewhere for small inline avatars; QuickPick icons render around 16px. */
const SIZE = 20;

function githubNoreplyAvatarUrl(email: string): string | null {
  if (!email.toLowerCase().endsWith('@users.noreply.github.com')) return null;
  const local = email.split('@')[0] ?? '';
  const username = local.includes('+') ? local.split('+')[1] : local;
  return username ? `https://avatars.githubusercontent.com/${username}?size=${SIZE * 2}` : null;
}

function gravatarUrl(email: string): string {
  const normalized = email.trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `https://gravatar.com/avatar/${hash}?s=${SIZE * 2}&d=404`;
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function extensionFor(url: string): string {
  return url.includes('githubusercontent.com') || url.includes('github.com') ? '.png' : '.jpg';
}

const inFlight = new Map<string, Promise<vscode.Uri | undefined>>();

/** Tries each candidate URL in order, caching the first one that resolves to a real image under `cacheKey`. */
async function resolveCached(cacheKey: string, candidates: string[], cacheDir: string): Promise<vscode.Uri | undefined> {
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const dir = path.join(cacheDir, CACHE_SUBDIR);
    const idHash = crypto.createHash('sha256').update(cacheKey).digest('hex');

    try {
      const entries = await fs.promises.readdir(dir);
      const cached = entries.find(f => f.startsWith(idHash));
      if (cached) return vscode.Uri.file(path.join(dir, cached));
    } catch {
      // Cache dir doesn't exist yet — fall through to fetch.
    }

    for (const url of candidates) {
      const data = await download(url);
      if (!data) continue;
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `${idHash}${extensionFor(url)}`);
        await fs.promises.writeFile(filePath, data);
        return vscode.Uri.file(filePath);
      } catch {
        return undefined;
      }
    }
    return undefined;
  })();

  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(cacheKey);
  }
}

/**
 * Returns a file Uri to a cached avatar image for this email (GitHub-noreply avatar, else
 * Gravatar), downloading it on first use. Returns undefined when no avatar could be resolved
 * (blank/404, no network, etc.) — callers should fall back to a codicon in that case.
 */
export async function resolveAvatarIconPath(email: string, cacheDir: string): Promise<vscode.Uri | undefined> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  const candidates = [githubNoreplyAvatarUrl(normalized), gravatarUrl(normalized)].filter((u): u is string => !!u);
  return resolveCached(`email:${normalized}`, candidates, cacheDir);
}

/** Returns a file Uri to a cached avatar for a GitHub username, via GitHub's public `<user>.png` endpoint. */
export async function resolveGitHubUsernameAvatarIconPath(username: string, cacheDir: string): Promise<vscode.Uri | undefined> {
  const normalized = username.trim();
  if (!normalized) return undefined;
  const url = `https://github.com/${encodeURIComponent(normalized)}.png?size=${SIZE * 2}`;
  return resolveCached(`github-user:${normalized.toLowerCase()}`, [url], cacheDir);
}
