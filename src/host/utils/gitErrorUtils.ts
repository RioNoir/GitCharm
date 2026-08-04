import { GitErrorCodes } from '../git/git.d';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const FRIENDLY_MESSAGES: Partial<Record<GitErrorCodes, string>> = {
  [GitErrorCodes.PushRejected]: 'Push rejected — the remote has commits you don\'t have locally. Pull or fetch first.',
  [GitErrorCodes.ForcePushWithLeaseRejected]: 'Force push rejected — the remote branch changed since you last fetched.',
  [GitErrorCodes.ForcePushWithLeaseIfIncludesRejected]: 'Force push rejected — the remote branch changed since you last fetched.',
  [GitErrorCodes.AuthenticationFailed]: 'Authentication failed — check your git credentials.',
  [GitErrorCodes.RemoteConnectionError]: 'Could not connect to the remote repository.',
  [GitErrorCodes.CantAccessRemote]: 'Could not access the remote repository.',
  [GitErrorCodes.RepositoryNotFound]: 'Remote repository not found.',
  [GitErrorCodes.RepositoryIsLocked]: 'Repository is locked by another git process.',
  [GitErrorCodes.DirtyWorkTree]: 'You have uncommitted changes — commit or stash them first.',
  [GitErrorCodes.NoUpstreamBranch]: 'The current branch has no upstream branch.',
  [GitErrorCodes.NoUserNameConfigured]: 'Git user.name is not configured.',
  [GitErrorCodes.NoUserEmailConfigured]: 'Git user.email is not configured.',
  [GitErrorCodes.Conflict]: 'Merge conflict — resolve conflicting files before continuing.',
  [GitErrorCodes.StashConflict]: 'Applying the stash caused a conflict.',
  [GitErrorCodes.UnmergedChanges]: 'You have unmerged changes.',
  [GitErrorCodes.LocalChangesOverwritten]: 'Local changes would be overwritten — commit or stash them first.',
  [GitErrorCodes.BranchNotFullyMerged]: 'Branch is not fully merged.',
  [GitErrorCodes.PermissionDenied]: 'Permission denied.',
};

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

// git/tooling output often has noisy leading lines (warnings, sync progress); keep the
// most relevant ones so notifications don't drown the actual error in scroll noise.
function meaningfulLines(text: string, maxLines: number): string {
  const lines = stripAnsi(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length <= maxLines) return lines.join('\n');
  const errorLines = lines.filter(line => /error|fatal|rejected|failed/i.test(line));
  const picked = errorLines.length > 0 ? errorLines : lines.slice(-maxLines);
  return picked.slice(-maxLines).join('\n');
}

/**
 * Formats an error thrown by a git operation (either VS Code's built-in git API or
 * simple-git) into a single human-readable line, stripping ANSI codes and mapping
 * known gitErrorCode values to friendlier text.
 */
export function formatGitError(e: unknown, maxLines = 3): string {
  if (!(e instanceof Error) && typeof e !== 'object') return String(e);
  const err = e as { gitErrorCode?: string; stderr?: string; stdout?: string; message?: string };

  const friendly = err.gitErrorCode ? FRIENDLY_MESSAGES[err.gitErrorCode as GitErrorCodes] : undefined;
  if (friendly) return friendly;

  const stderr = err.stderr?.trim();
  if (stderr) return meaningfulLines(stderr, maxLines);

  if (err.gitErrorCode) return err.gitErrorCode;

  const message = err.message?.trim();
  if (message) return meaningfulLines(message, maxLines);

  return String(e);
}
