import * as vscode from 'vscode';
import * as path from 'path';

/**
 * `gitcharm.protectedBranches`: branch names (with `*` wildcards, e.g. "release/*") that GitCharm guards. Committing
 * or pushing to one asks first; force-pushing to one is refused.
 */
export function isProtectedBranch(branch: string | undefined): boolean {
  if (!branch) return false;
  const patterns = vscode.workspace.getConfiguration('gitcharm').get<string[]>('protectedBranches', []);
  return (Array.isArray(patterns) ? patterns : []).some(p => {
    const pattern = p.trim();
    if (!pattern) return false;
    const re = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(branch);
  });
}

/** An operation the user declined, or one GitCharm refused: callers show its message like any other failure. */
export class ProtectedBranchError extends Error {}

/** A confirmation holds for the same repo and branch for a short while, so "Commit and Push" asks once. */
const CONFIRMED_FOR_MS = 60_000;
const confirmed = new Map<string, number>();

/**
 * Asks before committing or pushing to a protected branch, and refuses a force push to one. Throws a
 * ProtectedBranchError when the operation must not go ahead.
 */
export async function guardProtectedBranch(op: 'commit' | 'push' | 'forcePush', repoRoot: string, branch: string | undefined): Promise<void> {
  if (!branch || !isProtectedBranch(branch)) return;
  const repoName = path.basename(repoRoot);
  if (op === 'forcePush') {
    throw new ProtectedBranchError(vscode.l10n.t('Force push to "{0}" in {1} refused: it is a protected branch (gitcharm.protectedBranches).', branch, repoName));
  }
  const key = `${repoRoot}\n${branch}`;
  if (Date.now() - (confirmed.get(key) ?? 0) < CONFIRMED_FOR_MS) return;
  const action = op === 'commit' ? vscode.l10n.t('Commit Anyway') : vscode.l10n.t('Push Anyway');
  const message = op === 'commit'
    ? vscode.l10n.t('"{0}" is a protected branch in {1}. Commit to it anyway?', branch, repoName)
    : vscode.l10n.t('"{0}" is a protected branch in {1}. Push to it anyway?', branch, repoName);
  const pick = await vscode.window.showWarningMessage(message, { modal: true }, action);
  if (pick !== action) {
    throw new ProtectedBranchError(op === 'commit'
      ? vscode.l10n.t('Commit to protected branch "{0}" cancelled.', branch)
      : vscode.l10n.t('Push to protected branch "{0}" cancelled.', branch));
  }
  confirmed.set(key, Date.now());
}
