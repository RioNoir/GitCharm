import * as vscode from 'vscode';
import { generateForOperation, cleanPartialModelOutput } from '../ai/aiGenerate';
import { buildPrompt } from '../ai/prompts';
import { logError, logWarn } from '../utils/Logger';
import { buildBranchNamePrompt, cleanBranchName, issueContextSections, type IssueContext } from './issueAi';
import { issueBranchName, type IssueManager } from './IssueManager';

/** The issue with its discussion and linked pull requests, for the AI prompts. Comments/links are best-effort. */
export async function loadIssueContext(issueManager: IssueManager, repoId: string, number: number): Promise<IssueContext | { error: string }> {
  const [detail, comments, linked] = await Promise.all([
    issueManager.getIssueDetail(repoId, number),
    issueManager.listComments(repoId, number),
    issueManager.listLinkedPullRequests(repoId, number),
  ]);
  if ('error' in detail) return detail;
  return { detail, comments: comments.items, linkedPullRequests: linked.items };
}

/** A short branch name for the issue, written by the AI — falls back to gitcharm.issues.branchNameTemplate when it fails. */
export async function generateIssueBranchName(issueManager: IssueManager, repoId: string, context: IssueContext): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('gitcharm');
  try {
    const answer = await generateForOperation('issues', buildBranchNamePrompt(context, cfg), cfg);
    const name = cleanBranchName(answer);
    if (name) return name;
    logWarn('issue-ai-branch', `Unusable branch name from the AI: ${answer.slice(0, 200)}`);
  } catch (e) {
    logError('issue-ai-branch', 'Failed to generate a branch name', e instanceof Error ? e.message : String(e));
    vscode.window.showWarningMessage(vscode.l10n.t('The AI could not suggest a branch name ({0}); using the usual one instead.', e instanceof Error ? e.message : String(e)));
  }
  const username = await issueManager.getCurrentUsername(repoId).catch(() => undefined);
  return issueBranchName(context.detail, username);
}

/** The explanation shown in the AI Explain panel. */
export async function explainIssue(context: IssueContext, onProgress: (textSoFar: string) => void): Promise<{ explanation?: string; error?: string }> {
  try {
    const cfg = vscode.workspace.getConfiguration('gitcharm');
    const prompt = buildPrompt('explainIssue', issueContextSections(context), cfg);
    const explanation = await generateForOperation('explain', prompt, cfg, { onProgress: text => onProgress(cleanPartialModelOutput(text)) });
    return { explanation };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logError('issue-ai-explain', 'Failed to explain the issue', message);
    return { error: message };
  }
}
