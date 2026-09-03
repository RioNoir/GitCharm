export type ForgeProvider = 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'unknown';

export interface ParsedRemote {
  provider: ForgeProvider;
  host: string;
  owner: string;
  repo: string;
  raw: string;
}

const SCP_STYLE = /^([\w.-]+)@([\w.-]+):(.+)$/;

function detectProvider(host: string): ForgeProvider {
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  if (host === 'bitbucket.org') return 'bitbucket';
  return 'unknown';
}

function splitOwnerRepo(path: string): { owner: string; repo: string } | null {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const repo = segments.pop()!;
  return { owner: segments.join('/'), repo };
}

export function parseRemoteUrl(url: string): ParsedRemote | null {
  const raw = url;
  let trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith('.git')) trimmed = trimmed.slice(0, -4);
  trimmed = trimmed.replace(/\/+$/, '');
  if (!trimmed) return null;

  let host: string;
  let path: string;

  const scpMatch = trimmed.match(SCP_STYLE);
  if (scpMatch) {
    host = scpMatch[2];
    path = scpMatch[3];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!/^https?:$|^ssh:$|^git:$/.test(parsed.protocol)) return null;
    host = parsed.hostname;
    path = parsed.pathname.replace(/^\/+/, '');
  }

  if (!host || !path) return null;
  host = host.toLowerCase();

  const ownerRepo = splitOwnerRepo(path);
  if (!ownerRepo) return null;

  return {
    provider: detectProvider(host),
    host,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    raw,
  };
}

/**
 * Applies a manual per-host override (e.g. from gitcharm.pullRequests.hostProviderOverrides)
 * on top of the host-based heuristic — needed because self-hosted GitLab/Gitea/GHES
 * instances can't be reliably distinguished from a bare hostname.
 */
export function resolveProvider(parsed: ParsedRemote, overrides: Record<string, string>): ParsedRemote {
  const override = overrides[parsed.host];
  if (!override) return parsed;
  const valid: ForgeProvider[] = ['github', 'gitlab', 'bitbucket', 'gitea'];
  if (!valid.includes(override as ForgeProvider)) return parsed;
  return { ...parsed, provider: override as ForgeProvider };
}
