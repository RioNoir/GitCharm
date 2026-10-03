import * as vscode from 'vscode';

/**
 * Kinds of confirmation the user can turn off (`gitcharm.confirm.*`). Only confirmations with a single action are
 * covered — where skipping the question can't mean choosing for the user. Force pushes, resets, tag deletions
 * (local, remote or both) and forge actions always ask.
 */
export type ConfirmKind = 'discardChanges' | 'dropStashesAndShelves' | 'commitOperations' | 'deleteBranches';

/**
 * vscode.window.showWarningMessage for a modal confirmation of `kind`: with that kind turned off, answers with
 * the action (the first item) straight away, without asking.
 */
export async function confirmAction(kind: ConfirmKind, message: string, options: vscode.MessageOptions, ...items: string[]): Promise<string | undefined> {
  if (!vscode.workspace.getConfiguration('gitcharm.confirm').get<boolean>(kind, true)) return items[0];
  return vscode.window.showWarningMessage(message, options, ...items);
}
