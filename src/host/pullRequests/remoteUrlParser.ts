import * as vscode from 'vscode';
import { resolveSshHostAlias } from './sshConfigResolver';

export type ForgeProvider = 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'azure' | 'unknown';

const FORGE_PROVIDER_LABELS: Record<ForgeProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  gitea: 'Gitea',
  azure: 'Azure DevOps',
  unknown: 'Unknown',
};

export function forgeProviderLabel(provider: ForgeProvider): string {
  return provider === 'unknown' ? vscode.l10n.t('Unknown') : FORGE_PROVIDER_LABELS[provider];
}

export interface ParsedRemote {
  provider: ForgeProvider;
  host: string;
  /** Azure DevOps: everything before the repository — `{organization}/{project}`, or `{collection path}/{project}` on a server. */
  owner: string;
  repo: string;
  raw: string;
  /** Azure DevOps only: the organization (Services) or project collection (Server) URL the REST API lives under. */
  apiBase?: string;
  /** Azure DevOps Server only: apiBase was derived from an SSH remote, so its scheme and port are a guess (https, default port). */
  apiBaseGuessed?: boolean;
}

const SCP_STYLE = /^([\w.-]+)@([\w.-]+):(.+)$/;

/** The host every Azure DevOps Services remote is normalized to — accounts and bindings are keyed by it. */
export const AZURE_DEVOPS_CLOUD_HOST = 'dev.azure.com';

function detectProvider(host: string): ForgeProvider {
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  if (host === 'bitbucket.org') return 'bitbucket';
  if (isAzureDevOpsCloudHost(host)) return 'azure';
  return 'unknown';
}

function isAzureDevOpsCloudHost(host: string): boolean {
  return host === AZURE_DEVOPS_CLOUD_HOST || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Azure DevOps remotes carry an organization (or a server's collection path) and a project before the repository:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}          git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *   https://{org}.visualstudio.com[/DefaultCollection]/{project}/_git/{repo}
 *   https://server[:port]/[tfs/]{collection}/{project}/_git/{repo}   ssh://server:22/[tfs/]{collection}/{project}/_git/{repo}
 * The project segment is omitted when it has the repository's name. `origin` is the remote's `scheme://host[:port]`,
 * undefined for SSH remotes. Services remotes are normalized to the dev.azure.com host.
 */
function parseAzureDevOps(host: string, path: string, origin: string | undefined): Omit<ParsedRemote, 'raw' | 'provider'> | null {
  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  const encode = (parts: string[]) => parts.map(encodeURIComponent).join('/');

  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    if (segments[0] === 'v3') segments.shift();
    if (segments.length !== 3) return null;
    const [org, project, repo] = segments;
    return { host: AZURE_DEVOPS_CLOUD_HOST, owner: `${org}/${project}`, repo, apiBase: `https://${AZURE_DEVOPS_CLOUD_HOST}/${encode([org])}` };
  }

  const gitIndex = segments.indexOf('_git');
  if (gitIndex < 0 || gitIndex !== segments.length - 2) return null;
  const repo = segments[gitIndex + 1];
  const before = segments.slice(0, gitIndex);

  if (host === AZURE_DEVOPS_CLOUD_HOST || host.endsWith('.visualstudio.com')) {
    let org: string;
    if (host === AZURE_DEVOPS_CLOUD_HOST) {
      org = before.shift() ?? '';
    } else {
      org = host.slice(0, -'.visualstudio.com'.length);
      if (before[0]?.toLowerCase() === 'defaultcollection') before.shift();
    }
    if (!org || before.length > 1) return null;
    const project = before[0] ?? repo;
    return { host: AZURE_DEVOPS_CLOUD_HOST, owner: `${org}/${project}`, repo, apiBase: `https://${AZURE_DEVOPS_CLOUD_HOST}/${encode([org])}` };
  }

  // Server: the collection path is everything before the project. With a single segment before `_git` it can't be
  // told apart from the project, so it's read as the collection and the project as named after the repository.
  if (before.length === 0) return null;
  const collection = before.length === 1 ? before : before.slice(0, -1);
  const project = before.length === 1 ? repo : before[before.length - 1];
  return {
    host,
    owner: [...collection, project].join('/'),
    repo,
    apiBase: `${origin ?? `https://${host}`}/${encode(collection)}`,
    apiBaseGuessed: !origin,
  };
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
  let origin: string | undefined;

  const scpMatch = trimmed.match(SCP_STYLE);
  if (scpMatch) {
    host = resolveSshHostAlias(scpMatch[2]);
    path = scpMatch[3];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!/^https?:$|^ssh:$|^git:$/.test(parsed.protocol)) return null;
    host = parsed.protocol === 'ssh:' ? resolveSshHostAlias(parsed.hostname) : parsed.hostname;
    path = parsed.pathname.replace(/^\/+/, '');
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') origin = `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  }

  if (!host || !path) return null;
  host = host.toLowerCase();

  // `_git` in the path is unique to Azure DevOps, which also identifies Azure DevOps Server on any host.
  if (isAzureDevOpsCloudHost(host) || /(^|\/)_git\//.test(path)) {
    const azure = parseAzureDevOps(host, path, origin);
    if (azure) return { provider: 'azure', raw, ...azure };
  }

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
  const valid: ForgeProvider[] = ['github', 'gitlab', 'bitbucket', 'gitea', 'azure'];
  if (!valid.includes(override as ForgeProvider)) return parsed;
  return { ...parsed, provider: override as ForgeProvider };
}
