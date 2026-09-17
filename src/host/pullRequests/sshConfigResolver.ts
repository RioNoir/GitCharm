import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface SshHostBlock {
  patterns: string[];
  hostName?: string;
}

/** Minimal `~/.ssh/config` reader: only extracts `Host`/`HostName`/`Include`, enough to resolve an SSH alias (e.g. `github-personal`) to the real hostname it forwards to (e.g. `github.com`). */
function parseSshConfig(filePath: string, seen: Set<string>): SshHostBlock[] {
  const resolved = path.resolve(filePath);
  if (seen.has(resolved)) return [];
  seen.add(resolved);

  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch {
    return [];
  }

  const blocks: SshHostBlock[] = [];
  let current: SshHostBlock | undefined;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(\S+)\s+(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === 'host') {
      current = { patterns: value.split(/\s+/).filter(Boolean) };
      blocks.push(current);
    } else if (key === 'hostname' && current) {
      current.hostName = value.replace(/^["']|["']$/g, '');
    } else if (key === 'include') {
      const dir = path.dirname(resolved);
      for (const pattern of value.split(/\s+/).filter(Boolean)) {
        const expanded = pattern.startsWith('~') ? path.join(os.homedir(), pattern.slice(1)) : pattern;
        const absolute = path.isAbsolute(expanded) ? expanded : path.join(dir, expanded);
        for (const included of globSimple(absolute)) {
          blocks.push(...parseSshConfig(included, seen));
        }
      }
    }
  }

  return blocks;
}

/** Supports only a trailing `*` wildcard in the final path segment — the common case for `Include config.d/*`. */
function globSimple(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  if (base !== '*' && !base.endsWith('*')) return [pattern];
  try {
    const prefix = base.slice(0, -1);
    return fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return host === pattern;
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return regex.test(host);
}

let cachedBlocks: SshHostBlock[] | undefined;

function loadBlocks(): SshHostBlock[] {
  if (!cachedBlocks) {
    cachedBlocks = parseSshConfig(path.join(os.homedir(), '.ssh', 'config'), new Set());
  }
  return cachedBlocks;
}

/** Test-only: forces the next call to re-read `~/.ssh/config` from disk. */
export function resetSshConfigCache(): void {
  cachedBlocks = undefined;
}

/**
 * Resolves an SSH host alias (as found in a `git@host:owner/repo.git` remote) to the real
 * hostname it connects to, per `~/.ssh/config`'s `Host`/`HostName` directives. Falls back to
 * the input unchanged when there's no config, no match, or no explicit `HostName` (identity aliases).
 */
export function resolveSshHostAlias(host: string): string {
  for (const block of loadBlocks()) {
    if (block.hostName && block.patterns.some(p => hostMatchesPattern(host, p))) {
      return block.hostName;
    }
  }
  return host;
}
