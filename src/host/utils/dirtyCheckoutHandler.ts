import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import { logInfo } from './Logger';

/**
 * Recovery menu for the "Your local changes ... would be overwritten by checkout" error.
 * `vsRepo.checkout()` sets `gitErrorCode: 'DirtyWorkTree'`, but the simple-git fallback path
 * (and some vscode.git versions) only ever surface git's raw stderr, so we match on that
 * wording too. Returns false when `originalError` isn't this error, so the caller falls
 * back to its normal error display.
 */
export async function handleDirtyCheckout(
  repo: GitService,
  repoLabel: string,
  branchName: string,
  originalError: unknown
): Promise<boolean> {
  const code = (originalError as { gitErrorCode?: string })?.gitErrorCode;
  const msg = String(originalError);
  if (code !== 'DirtyWorkTree'
    && !msg.includes('Your local changes')
    && !msg.includes('local changes')
    && !msg.includes('overwritten by checkout')) {
    return false;
  }

  type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> };
  const items: ActionItem[] = [
    {
      label: '$(archive) Stash and checkout',
      detail: 'Save changes to stash, then switch to the branch',
      action: async () => {
        await repo.stashPush(`WIP before checkout to ${branchName}`);
        await repo.checkout(branchName);
        const doneMsg = `[${repoLabel}]: changes stashed, switched to "${branchName}"`;
        vscode.window.showInformationMessage(doneMsg);
        logInfo(`checkout:${repoLabel}`, doneMsg);
      },
    },
    {
      label: '$(arrow-right) Bring changes to new branch',
      detail: 'Carry uncommitted changes into the new branch',
      action: async () => {
        await repo.stashPush(`WIP migrating to ${branchName}`);
        await repo.checkout(branchName);
        await repo.stashPop();
        const doneMsg = `[${repoLabel}]: changes migrated to "${branchName}"`;
        vscode.window.showInformationMessage(doneMsg);
        logInfo(`checkout:${repoLabel}`, doneMsg);
      },
    },
    {
      label: '$(warning) Force checkout',
      detail: 'Discard local changes and switch to the branch',
      action: async () => {
        await repo.checkoutForce(branchName);
        const doneMsg = `[${repoLabel}]: force checkout to "${branchName}" (changes discarded)`;
        vscode.window.showInformationMessage(doneMsg);
        logInfo(`checkout:${repoLabel}`, doneMsg);
      },
    },
    {
      label: '$(close) Cancel',
      detail: '',
      action: async () => { /* no-op */ },
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: `[${repoLabel}]: Uncommitted changes`,
    placeHolder: `Choose how to handle local changes before switching to "${branchName}"`,
    ignoreFocusOut: true,
  });

  if (pick) await pick.action();
  return true;
}
