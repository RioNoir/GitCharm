import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { avatarResolver, avatarsEnabled, gravatarEnabled } from './avatarResolver';

/**
 * Resolves and caches a small avatar image, for use as a `vscode.QuickPickItem.iconPath`
 * (which needs a local file/data Uri — QuickPick items are plain synchronous objects, so
 * this must run and settle before `showQuickPick` is called). The image is the one the
 * webviews show (see avatarResolver.ts), fetched and persisted to disk with Node's `fetch`.
 */

const CACHE_SUBDIR = 'avatars';
/** Same size class used elsewhere for small inline avatars; QuickPick icons render around 16px. */
const SIZE = 20;

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
 * Returns a file Uri to a cached avatar image for this email (see avatarResolver.ts for where it comes
 * from), downloading it on first use. Returns undefined when no avatar could be resolved (none found,
 * no network, etc.) — callers should fall back to a codicon in that case.
 */
export async function resolveAvatarIconPath(email: string, cacheDir: string, repoId?: string): Promise<vscode.Uri | undefined> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  const url = await avatarResolver.resolve({ email: normalized, repoId });
  if (!url) return undefined;
  // The source is part of the key, so turning Gravatar off stops a picture cached from it being shown.
  return resolveCached(`email:${gravatarEnabled() ? 'g' : 'n'}:${repoId ?? ''}:${normalized}`, [url], cacheDir);
}

/** Returns a file Uri to a cached avatar for a GitHub username, via GitHub's public `<user>.png` endpoint. */
export async function resolveGitHubUsernameAvatarIconPath(username: string, cacheDir: string): Promise<vscode.Uri | undefined> {
  if (!avatarsEnabled()) return undefined;
  const normalized = username.trim();
  if (!normalized) return undefined;
  const url = `https://github.com/${encodeURIComponent(normalized)}.png?size=${SIZE * 2}`;
  return resolveCached(`github-user:${normalized.toLowerCase()}`, [url], cacheDir);
}
