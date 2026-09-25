import * as vscode from 'vscode';

/**
 * Every AI prompt GitCharm sends, in one place.
 *
 * A prompt is made of two parts:
 * - the **instructions** (defined here, overridable per prompt by the user through the
 *   `gitcharm.ai.prompts.<id>` setting — an empty setting means "use the default below");
 * - the **context** (diff, changed files, commits…), built by each caller and always appended after the
 *   instructions, so a custom prompt can never lose the data the model needs.
 *
 * Instructions may use the `{language}` placeholder (the configured `gitcharm.ai.language`, else VS Code's
 * display language). Anything that only applies to some requests (an existing PR title, a PR template…) is
 * phrased conditionally ("if … is included below") so the instructions stay static text a user can edit.
 */
export type AiPromptId =
  | 'commitMessage'
  | 'pullRequestTitle'
  | 'pullRequestDescription'
  | 'explainCommit'
  | 'explainPullRequest';

export const AI_PROMPT_IDS: readonly AiPromptId[] = [
  'commitMessage', 'pullRequestTitle', 'pullRequestDescription', 'explainCommit', 'explainPullRequest',
];

export const DEFAULT_PROMPTS: Record<AiPromptId, string> = {
  commitMessage: [
    'You are a git commit message writer. Analyze the following changes and write a commit message.',
    '',
    'Rules:',
    '- Write the commit message in this language: {language}',
    '- First line: imperative mood, max 72 characters (e.g. "Add user authentication")',
    '- Leave a blank line after the first line',
    '- Body: 2-4 bullet points explaining WHAT changed and WHY, each starting with "- "',
    '- Be specific and technical, reference file names or module names when relevant',
    '- Output ONLY the commit message, no explanations, no markdown fences',
  ].join('\n'),

  pullRequestTitle: [
    'You are writing the title of a pull request. Analyze the commits and changes below.',
    '',
    'Rules:',
    '- Write in this language: {language}',
    '- One line only: imperative mood, max 72 characters, no trailing period, no prefix like "Title:", no quotes',
    '- If the pull request description is included below, the title must summarize it',
    '- Output ONLY the title',
  ].join('\n'),

  pullRequestDescription: [
    'You are writing the description of a pull request. Analyze the commits and changes below.',
    '',
    'Rules:',
    '- Write in this language: {language}',
    '- If the pull request title is included below, the description must be consistent with it',
    '- Start with a short summary paragraph of what the PR does and why, then a "- " bullet list of the main changes',
    '- The description is Markdown: use it where it helps (inline code for identifiers and file names, bold sparingly)',
    '- If a pull request template for this repository is included below, fill in its sections instead of using the structure above, keep its headings, and leave checklists unchecked unless the changes clearly satisfy them',
    '- Do not repeat the title as a heading',
    '- Be specific and technical, but do not invent anything that is not supported by the changes',
    '- Output ONLY the description, no preamble, no code fences around the answer',
  ].join('\n'),

  explainCommit: [
    'You are a code reviewer explaining a git commit to a developer.',
    '',
    'Rules:',
    '- Write the explanation in this language: {language}',
    '- Start with a one-sentence summary of what this commit does',
    '- Then explain the key changes: what was modified and why',
    '- Be specific: reference file names, function names, or module names when relevant',
    '- Keep it concise but complete (3-8 sentences or bullet points)',
    '- The output is rendered as Markdown: use it (bold, lists, inline code) where it helps readability',
    '- Output ONLY the explanation, no code fences wrapping the whole response, no preamble',
  ].join('\n'),

  explainPullRequest: [
    'You are a senior code reviewer explaining a pull request to a developer before it gets merged.',
    '',
    'Rules:',
    '- Write the explanation in this language: {language}',
    '- Start with a one-sentence summary of what this PR does',
    '- Then explain the key changes: what was modified and why, referencing specific files/functions where relevant',
    '- Finish with a short "Merge considerations" section: flag anything risky about merging this into the target branch',
    '  (conflicts, failing/pending CI, incomplete-looking changes, missing tests, breaking changes, anything that looks unsafe to merge as-is).',
    '  If nothing looks risky, say so briefly — do not invent problems.',
    '- Be concise but complete',
    '- The output is rendered as Markdown: use it (bold, lists, headings, inline code) where it helps readability',
    '- Output ONLY the explanation, no code fences wrapping the whole response, no preamble',
  ].join('\n'),
};

export function promptSettingKey(id: AiPromptId): string {
  return `ai.prompts.${id}`;
}

/** The configured `gitcharm.ai.language`, else VS Code's display language. */
export function getAiLanguage(cfg: vscode.WorkspaceConfiguration): string {
  const configured: string = cfg.get('ai.language', '');
  return configured.trim() || vscode.env.language || 'en';
}

/** The user's custom instructions for `id`, or undefined when the setting is empty/whitespace. */
export function getCustomPrompt(cfg: vscode.WorkspaceConfiguration, id: AiPromptId): string | undefined {
  const custom = cfg.get<string>(promptSettingKey(id), '');
  return custom.trim() ? custom.trim() : undefined;
}

/** Instructions (custom or default, `{language}` filled in) followed by the caller's context sections. */
export function buildPrompt(id: AiPromptId, contextSections: Array<string | false | undefined | null>, cfg = vscode.workspace.getConfiguration('gitcharm')): string {
  const instructions = (getCustomPrompt(cfg, id) ?? DEFAULT_PROMPTS[id]).replace(/\{language\}/g, getAiLanguage(cfg));
  const context = contextSections.filter((s): s is string => !!s).join('\n');
  return `${instructions}\n\n${context}`;
}
