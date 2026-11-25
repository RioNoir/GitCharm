import * as vscode from 'vscode';
import { GitErrorCodes } from '../git/git.d';
import { logError, notifyWithLogAction } from './Logger';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

// A function rather than a constant: vscode.l10n.t() runs per call, never at module load.
function friendlyMessages(): Partial<Record<GitErrorCodes, string>> {
  return {
    [GitErrorCodes.PushRejected]: vscode.l10n.t('Push rejected — the remote has commits you don\'t have locally. Pull or fetch first.'),
    [GitErrorCodes.ForcePushWithLeaseRejected]: vscode.l10n.t('Force push rejected — the remote branch changed since you last fetched.'),
    [GitErrorCodes.ForcePushWithLeaseIfIncludesRejected]: vscode.l10n.t('Force push rejected — the remote branch changed since you last fetched.'),
    [GitErrorCodes.AuthenticationFailed]: vscode.l10n.t('Authentication failed — check your git credentials.'),
    [GitErrorCodes.RemoteConnectionError]: vscode.l10n.t('Could not connect to the remote repository.'),
    [GitErrorCodes.CantAccessRemote]: vscode.l10n.t('Could not access the remote repository.'),
    [GitErrorCodes.RepositoryNotFound]: vscode.l10n.t('Remote repository not found.'),
    [GitErrorCodes.RepositoryIsLocked]: vscode.l10n.t('Repository is locked by another git process.'),
    [GitErrorCodes.DirtyWorkTree]: vscode.l10n.t('You have uncommitted changes — commit or stash them first.'),
    [GitErrorCodes.NoUpstreamBranch]: vscode.l10n.t('The current branch has no upstream branch.'),
    [GitErrorCodes.NoUserNameConfigured]: vscode.l10n.t('Git user.name is not configured.'),
    [GitErrorCodes.NoUserEmailConfigured]: vscode.l10n.t('Git user.email is not configured.'),
    [GitErrorCodes.Conflict]: vscode.l10n.t('Merge conflict — resolve conflicting files before continuing.'),
    [GitErrorCodes.StashConflict]: vscode.l10n.t('Applying the stash caused a conflict.'),
    [GitErrorCodes.UnmergedChanges]: vscode.l10n.t('You have unmerged changes.'),
    [GitErrorCodes.LocalChangesOverwritten]: vscode.l10n.t('Local changes would be overwritten — commit or stash them first.'),
    [GitErrorCodes.BranchNotFullyMerged]: vscode.l10n.t('Branch is not fully merged.'),
    [GitErrorCodes.PermissionDenied]: vscode.l10n.t('Permission denied.'),
  };
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

// Raw git/tool output is conventionally lowercase (e.g. "error: failed to push…");
// capitalize just the first character so it reads as a proper sentence in the UI.
function capitalizeFirst(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
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

// VS Code's built-in git extension derives `gitErrorCode` with its own heuristics over
// combined stdout/stderr, which can misclassify a failing pre-push/pre-commit hook (e.g. a
// linter) as an unrelated error like "no upstream branch". When stderr itself has clear
// signs of a hook/tooling failure, trust that raw text over the (possibly wrong) friendly
// mapping — the raw output is the actual reason the operation failed.
const HOOK_FAILURE_PATTERN = /\bhook\b|pre-(?:push|commit)|husky|lint-staged|✖\s*\d+\s*problems?/i;

// git's own words for "the remote has commits you don't". Anything else that still exits
// with "failed to push some refs" — a server hook, a TAPD status gate, a protected branch —
// is a different failure. The editor labels every one of those PushRejected.
const FAST_FORWARD_REASON = /^(?:non-fast-forward|fetch first|stale info|remote ref updated since checkout)$/i;
const REMOTE_AHEAD_HINT = /updates were rejected because (?:the tip of your current branch is behind|the remote contains work that you do|a pushed branch tip is behind)/i;

interface RefRejection {
  remote: boolean;
  reason: string;
}

function refRejectionReasons(text: string): RefRejection[] {
  const pattern = /\[(?<remote>remote )?rejected\][^\n]*\((?<reason>[^)\n]+)\)/gi;
  return [...text.matchAll(pattern)].map(match => ({
    remote: Boolean(match.groups?.remote),
    reason: (match.groups?.reason ?? '').trim(),
  }));
}

function isFastForwardReason(reason: string): boolean {
  return FAST_FORWARD_REASON.test(reason);
}

/** True only when git itself says the remote branch moved ahead. */
function isNonFastForwardRejection(text: string): boolean {
  const reasons = refRejectionReasons(text);
  if (reasons.some(reason => reason.remote || !isFastForwardReason(reason.reason))) return false;
  if (reasons.some(reason => isFastForwardReason(reason.reason))) return true;
  return REMOTE_AHEAD_HINT.test(text);
}

/** A hook or a remote policy check, as opposed to the branch being behind. */
function isHookOrPolicyRejection(text: string): boolean {
  if (HOOK_FAILURE_PATTERN.test(text)) return true;
  return refRejectionReasons(text).some(reason => reason.remote || !isFastForwardReason(reason.reason));
}

function clipLine(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

// Server hooks print the reason twice: a short one in "(Rejected by …)" and a longer
// `remote:` line. The box-drawing and "Processing pre-receive" lines around them are noise.
function remoteDetail(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^remote:/i.test(line)) continue;
    const body = line.replace(/^remote:\s*/i, '').replace(/^\|\s*/, '').trim();
    if (!body || /^processing\b/i.test(body) || /^[+\-=|_]+$/.test(body)) continue;
    return clipLine(body, 180);
  }
  return undefined;
}

function formatPolicyRejection(text: string, maxLines: number): string {
  const reason = refRejectionReasons(text).find(item => item.remote || !isFastForwardReason(item.reason))?.reason;
  const detail = remoteDetail(text);
  if (reason && detail && !detail.includes(reason)) {
    return vscode.l10n.t('Push rejected by the remote ({0}): {1}', reason, detail);
  }
  if (reason) return vscode.l10n.t('Push rejected by the remote ({0}).', reason);
  return capitalizeFirst(meaningfulLines(text, maxLines));
}

// git's wording when a remote needs credentials and GIT_TERMINAL_PROMPT=0 (or no tty) stops the prompt.
const NO_CREDENTIALS_PATTERN = /terminal prompts disabled|could not read (?:Username|Password)/i;

/**
 * Formats an error thrown by a git operation (either VS Code's built-in git API or
 * simple-git) into a single human-readable line, stripping ANSI codes and mapping
 * known gitErrorCode values to friendlier text.
 */
export function formatGitError(e: unknown, maxLines = 3): string {
  if (!(e instanceof Error) && typeof e !== 'object') return String(e);
  const err = e as { gitErrorCode?: string; stderr?: string; stdout?: string; message?: string };

  const stderr = err.stderr?.trim();
  const text = stripAnsi([stderr, err.stdout, err.message].filter(Boolean).join('\n'));
  const code = err.gitErrorCode as GitErrorCodes | undefined;

  // PushRejected means "failed to push some refs", not "you are behind". A remote hook
  // or policy check has to keep its own reason, or the UI tells the user to pull.
  if (text && isHookOrPolicyRejection(text) && !isNonFastForwardRejection(text)) {
    return formatPolicyRejection(text, maxLines);
  }
  if (text && isNonFastForwardRejection(text)
    && code !== GitErrorCodes.ForcePushWithLeaseRejected
    && code !== GitErrorCodes.ForcePushWithLeaseIfIncludesRejected) {
    return friendlyMessages()[GitErrorCodes.PushRejected] ?? '';
  }

  if (stderr && HOOK_FAILURE_PATTERN.test(stderr)) return capitalizeFirst(meaningfulLines(stderr, maxLines));

  const friendly = code ? friendlyMessages()[code] : undefined;
  if (friendly && !(code === GitErrorCodes.PushRejected && !isNonFastForwardRejection(text))) return friendly;

  // Plain git (not VS Code's API) asked for a username/password it can't prompt for.
  // simple-git puts git's stderr in the message, VS Code's API in `stderr`.
  if (NO_CREDENTIALS_PATTERN.test(stderr || err.message || '')) {
    return vscode.l10n.t('Authentication failed — git found no credentials for this remote. Set up a credential helper or use SSH.');
  }

  if (stderr) return capitalizeFirst(meaningfulLines(stderr, maxLines));

  if (err.gitErrorCode) return err.gitErrorCode;

  const message = err.message?.trim();
  if (message) return capitalizeFirst(meaningfulLines(message, maxLines));

  return capitalizeFirst(String(e));
}

/**
 * True when a push failed because the remote has commits we don't have — the case where
 * the user has to choose between pulling first and overwriting the remote branch.
 * A server hook or policy check also makes git print "failed to push some refs", and the
 * editor then sets PushRejected; that must not offer a pull or a force push.
 */
export function isPushRejected(e: unknown): boolean {
  if (!(e instanceof Error) && typeof e !== 'object') return false;
  const err = e as { gitErrorCode?: string; stderr?: string; stdout?: string; message?: string };
  const text = stripAnsi([err.stderr, err.stdout, err.message].filter(Boolean).join('\n'));
  if (text && isHookOrPolicyRejection(text) && !isNonFastForwardRejection(text)) return false;
  if (isNonFastForwardRejection(text)) return true;
  const code = err.gitErrorCode as GitErrorCodes | undefined;
  return code === GitErrorCodes.ForcePushWithLeaseRejected
    || code === GitErrorCodes.ForcePushWithLeaseIfIncludesRejected;
}

/** True when branch creation failed because a branch with that name already exists. */
export function isBranchAlreadyExistsError(e: unknown): boolean {
  if (!(e instanceof Error) && typeof e !== 'object') return false;
  const err = e as { stderr?: string; stdout?: string; message?: string };
  const text = stripAnsi([err.stderr, err.stdout, err.message].filter(Boolean).join('\n'));
  // Matches git's own wording verbatim (e.g. "fatal: a branch named 'foo' already exists")
  // rather than a loose "branch" + "already exists" combination, which could false-positive
  // on unrelated text that happens to mention both in the same combined stderr/stdout/message.
  return /a branch named .+ already exists/i.test(text);
}

/** Full, untruncated error detail (stderr/stdout/message) for the output log. */
export function getRawErrorDetail(e: unknown): string | undefined {
  if (!(e instanceof Error) && typeof e !== 'object') return undefined;
  const err = e as { gitErrorCode?: string; stderr?: string; stdout?: string; message?: string };
  const parts = [err.gitErrorCode, err.stderr, err.stdout, err.message]
    .filter((p): p is string => !!p?.trim())
    .map(stripAnsi);
  return parts.length > 0 ? [...new Set(parts)].join('\n---\n') : undefined;
}

/**
 * Shows a short error notification (via formatGitError) with a "Show Log" action that
 * reveals the full, untruncated error detail in the GitCharm output channel.
 */
export function showGitError(context: string, e: unknown, maxLines = 3): void {
  const summary = formatGitError(e, maxLines);
  logError(context, summary, getRawErrorDetail(e));
  notifyWithLogAction('error', summary);
}
