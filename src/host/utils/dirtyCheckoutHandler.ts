import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import { logInfo } from './Logger';

interface DirtyCheckoutOptions {
  /** Performs the actual (non-force) checkout. Defaults to `repo.checkout(branchName)`. */
  checkout?: () => Promise<void>;
  /** Performs the force checkout. Defaults to `repo.checkoutForce(branchName)`. */
  checkoutForce?: () => Promise<void>;
}

export interface DirtyCheckoutResult {
  /** True when originalError matched the dirty-tree pattern and the recovery menu was shown. */
  matched: boolean;
  /** True only when the user picked an action that actually completed a checkout (stash/migrate/force) — false for Cancel or a dismissed menu, even though `matched` is true. */
  succeeded: boolean;
}

/**
 * Recovery menu for the "Your local changes ... would be overwritten by checkout" error.
 * `vsRepo.checkout()` sets `gitErrorCode: 'DirtyWorkTree'`, but the simple-git fallback path
 * (and some vscode.git versions) only ever surface git's raw stderr, so we match on that
 * wording too. Returns `matched: false` when `originalError` isn't this error, so the caller
 * falls back to its normal error display. Callers that run further steps after the checkout
 * (e.g. a merge) must check `succeeded`, not just `matched` — the user may cancel the menu.
 */
export async function handleDirtyCheckout(
  repo: GitService,
  repoLabel: string,
  branchName: string,
  originalError: unknown,
  options?: DirtyCheckoutOptions,
): Promise<DirtyCheckoutResult> {
  const code = (originalError as { gitErrorCode?: string })?.gitErrorCode;
  const msg = String(originalError);
  if (code !== 'DirtyWorkTree'
    && !msg.includes('Your local changes')
    && !msg.includes('local changes')
    && !msg.includes('overwritten by checkout')) {
    return { matched: false, succeeded: false };
  }

  const doCheckout = options?.checkout ?? (() => repo.checkout(branchName));
  const doCheckoutForce = options?.checkoutForce ?? (() => repo.checkoutForce(branchName));

  type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> };
  const cancelItem: ActionItem = {
    label: `$(close) ${vscode.l10n.t('Cancel')}`,
    detail: '',
    action: async () => { /* no-op */ },
  };
  const items: ActionItem[] = [
    {
      label: `$(archive) ${vscode.l10n.t('Stash and checkout')}`,
      detail: vscode.l10n.t('Save changes to stash, then switch to the branch'),
      action: async () => {
        await repo.stashPush(`WIP before checkout to ${branchName}`);
        await doCheckout();
        vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: changes stashed, switched to "{1}"', repoLabel, branchName));
        logInfo(`checkout:${repoLabel}`, `[${repoLabel}]: changes stashed, switched to "${branchName}"`);
      },
    },
    {
      label: `$(arrow-right) ${vscode.l10n.t('Bring changes to new branch')}`,
      detail: vscode.l10n.t('Carry uncommitted changes into the new branch'),
      action: async () => {
        await repo.stashPush(`WIP migrating to ${branchName}`);
        await doCheckout();
        await repo.stashPop();
        vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: changes migrated to "{1}"', repoLabel, branchName));
        logInfo(`checkout:${repoLabel}`, `[${repoLabel}]: changes migrated to "${branchName}"`);
      },
    },
    {
      label: `$(warning) ${vscode.l10n.t('Force checkout')}`,
      detail: vscode.l10n.t('Discard local changes and switch to the branch'),
      action: async () => {
        await doCheckoutForce();
        vscode.window.showInformationMessage(vscode.l10n.t('[{0}]: force checkout to "{1}" (changes discarded)', repoLabel, branchName));
        logInfo(`checkout:${repoLabel}`, `[${repoLabel}]: force checkout to "${branchName}" (changes discarded)`);
      },
    },
    cancelItem,
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('[{0}]: Uncommitted changes', repoLabel),
    placeHolder: vscode.l10n.t('Choose how to handle local changes before switching to "{0}"', branchName),
    ignoreFocusOut: true,
  });

  if (!pick || pick === cancelItem) return { matched: true, succeeded: false };
  await pick.action();
  return { matched: true, succeeded: true };
}
