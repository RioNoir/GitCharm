import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGit } from '../git/gitClient';
import { buildPrompt, getAiLanguage } from '../ai/prompts';
import { getBranchNameModels } from '../utils/branchNamePrompt';
import type { IssueComment, IssueDetail, LinkedPullRequest } from './types';

/** A file the AI proposes to change. `before` is the file as it is now (empty for a new file), `after` as proposed (empty when deleted). */
export interface ProposedChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  before: string;
  after: string;
}

export interface IssueContext {
  detail: IssueDetail;
  comments: IssueComment[];
  linkedPullRequests: LinkedPullRequest[];
}

const MAX_COMMENTS = 30;
const MAX_COMMENT_CHARS = 2000;

/** The issue as prompt context: title, state, labels, description, discussion and linked pull requests. */
export function issueContextSections({ detail, comments, linkedPullRequests }: IssueContext): string[] {
  const sections = [
    `## Issue #${detail.number}: ${detail.title}`,
    `State: ${detail.state}${detail.stateReason ? ` (${detail.stateReason})` : ''}, opened by ${detail.authorName}`,
  ];
  if (detail.labels.length > 0) sections.push(`Labels: ${detail.labels.map(l => l.name).join(', ')}`);
  if (detail.assignees.length > 0) sections.push(`Assignees: ${detail.assignees.map(a => a.username).join(', ')}`);
  sections.push(`## Description\n${detail.description.trim().slice(0, 8000) || '(no description)'}`);
  if (comments.length > 0) {
    const shown = comments.slice(-MAX_COMMENTS);
    sections.push(`## Discussion${comments.length > shown.length ? ` (last ${shown.length} of ${comments.length} comments)` : ''}`);
    for (const c of shown) sections.push(`**${c.authorName}** (${c.createdAt.slice(0, 10)}):\n${c.body.trim().slice(0, MAX_COMMENT_CHARS)}`);
  }
  if (linkedPullRequests.length > 0) {
    sections.push('## Linked pull requests');
    for (const pr of linkedPullRequests) sections.push(`- #${pr.number} ${pr.title} (${pr.state}${pr.willClose ? ', closes the issue' : ''})`);
  }
  return sections;
}

/** The AI's branch name, cleaned to something git accepts — the branch prompt still sanitizes it on top. */
export function cleanBranchName(raw: string): string {
  const line = raw.split('\n').map(l => l.trim()).find(l => l) ?? '';
  return line
    .replace(/^branch( name)?\s*:\s*/i, '')
    .replace(/^["'`]+|["'`.]+$/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9/_.-]/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 80);
}

/** The prompt for a short branch name tied to the issue, telling the model about the branch prefixes in use. */
export function buildBranchNamePrompt(context: IssueContext, cfg: vscode.WorkspaceConfiguration): string {
  const prefixes = getBranchNameModels();
  const template = vscode.workspace.getConfiguration('gitcharm.issues').get<string>('branchNameTemplate', '{number}-{title}');
  return buildPrompt('issueBranchName', [
    prefixes.length > 0 && `## Branch prefixes used in this repository\n${prefixes.join(', ')}`,
    template && template !== '{number}-{title}' && `## Naming convention\n${template} ({number}: the issue number, {title}: a few words describing it, {user}: the developer)`,
    ...issueContextSections({ ...context, comments: context.comments.slice(0, 5) }),
  ], cfg);
}

// ─── Resolve with AI: text mode ──────────────────────────────────────────────
// For providers that only return text: the model first picks the files it needs from the repository's file list,
// then gets their content and answers with a plan plus edit blocks, which are applied here to build the proposal.

const MAX_LISTED_FILES = 4000;
const MAX_SELECTED_FILES = 15;
const MAX_FILE_BYTES = 200_000;
const MAX_CONTEXT_CHARS = 160_000;

const SKIPPED_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|tgz|jar|woff2?|ttf|otf|eot|mp[34]|mov|avi|wasm|exe|dll|so|dylib|bin|lock|min\.js|min\.css|map)$/i;

/** The repository's tracked files, minus binaries, lockfiles and minified bundles nobody edits by hand. */
export async function listRepositoryFiles(repoRoot: string): Promise<{ files: string[]; truncated: boolean }> {
  const out = await createGit(repoRoot).raw(['ls-files']);
  const files = out.split('\n').map(f => f.trim()).filter(f => f && !SKIPPED_FILE.test(f));
  return { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES };
}

export function buildFileSelectionPrompt(context: IssueContext, files: string[], truncated: boolean, cfg: vscode.WorkspaceConfiguration): string {
  return [
    'You are about to resolve the issue below in a code repository. First, choose the files you need to read:',
    'the ones you will probably change, plus the ones needed to understand them (types, callers, tests next to them).',
    '',
    'Rules:',
    `- Reply with ONLY a JSON array of file paths taken from the list below, at most ${MAX_SELECTED_FILES}, most important first`,
    '- No explanations, no code fences',
    '',
    ...issueContextSections(context),
    '',
    `## Repository files${truncated ? ` (first ${files.length})` : ''}`,
    files.join('\n'),
    '',
    `(Language for any text you would write: ${getAiLanguage(cfg)})`,
  ].join('\n');
}

/** The paths the model picked, keeping only real files of the list. */
export function parseFileSelection(answer: string, files: string[]): string[] {
  const known = new Set(files);
  const match = answer.match(/\[[\s\S]*\]/);
  let picked: unknown = [];
  if (match) {
    try { picked = JSON.parse(match[0]); } catch { picked = []; }
  }
  const list = Array.isArray(picked)
    ? picked.filter((p): p is string => typeof p === 'string')
    : answer.split('\n').map(l => l.replace(/^[\s\-*"'`]+|[\s"'`,]+$/g, ''));
  return [...new Set(list.map(p => p.replace(/^\.\//, '')).filter(p => known.has(p)))].slice(0, MAX_SELECTED_FILES);
}

/** Reads the selected files within a total size budget; files over it are left out. */
export async function readSelectedFiles(repoRoot: string, paths: string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  let total = 0;
  for (const p of paths) {
    try {
      const abs = path.join(repoRoot, p);
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      const text = await fs.readFile(abs, 'utf8');
      if (text.includes('\0')) continue;
      if (total + text.length > MAX_CONTEXT_CHARS) break;
      total += text.length;
      contents.set(p, text);
    } catch { /* deleted or unreadable since listing — skip it */ }
  }
  return contents;
}

const TEXT_FORMAT = [
  '## Output format',
  'Answer in exactly this format, with nothing before PLAN: and nothing after the last block:',
  '',
  'PLAN:',
  'A short Markdown explanation of the cause and of the change you make.',
  '',
  'CHANGES:',
  'One block per change. To edit a file shown above, give one or more search/replace pairs — the part before ======= must be copied exactly from the current file (whitespace included) and be long enough to be unique:',
  '<<<<<<< EDIT path/to/file',
  'exact current lines',
  '=======',
  'replacement lines',
  '>>>>>>> END',
  'To create a new file, or rewrite a file completely:',
  '<<<<<<< FILE path/to/file',
  'the whole new content',
  '>>>>>>> END',
  'To delete a file:',
  '<<<<<<< DELETE path/to/file',
  '>>>>>>> END',
  'Never wrap blocks in code fences. If the issue cannot be resolved, write only PLAN: with the reason and an empty CHANGES: section.',
].join('\n');

export function buildResolveTextPrompt(context: IssueContext, files: Map<string, string>, cfg: vscode.WorkspaceConfiguration): string {
  const fileSections = [...files].map(([p, text]) => `### ${p}\n\`\`\`\n${text}\n\`\`\``);
  return buildPrompt('resolveIssue', [
    ...issueContextSections(context),
    '',
    `## Files from the repository (${files.size})`,
    ...fileSections,
    '',
    TEXT_FORMAT,
  ], cfg);
}

type Block = { kind: 'edit'; path: string; search: string; replace: string } | { kind: 'file'; path: string; content: string } | { kind: 'delete'; path: string };

/** Splits the answer into its plan and its edit blocks. */
export function parseResolveAnswer(answer: string): { plan: string; blocks: Block[] } {
  const lines = answer.replace(/\r\n/g, '\n').split('\n');
  const changesAt = lines.findIndex(l => /^\s*CHANGES:\s*$/.test(l));
  const firstBlock = lines.findIndex(l => /^<{7} (EDIT|FILE|DELETE) /.test(l));
  const planEnd = changesAt !== -1 ? changesAt : firstBlock !== -1 ? firstBlock : lines.length;
  const plan = lines.slice(0, planEnd).join('\n').replace(/^\s*PLAN:\s*/, '').trim();

  const blocks: Block[] = [];
  for (let i = planEnd; i < lines.length; i++) {
    const head = /^<{7} (EDIT|FILE|DELETE) (.+?)\s*$/.exec(lines[i]);
    if (!head) continue;
    const [, kind, rawPath] = head;
    const filePath = rawPath.replace(/^\.\//, '').trim();
    const end = lines.findIndex((l, j) => j > i && /^>{7} END\s*$/.test(l));
    const body = lines.slice(i + 1, end === -1 ? lines.length : end);
    i = end === -1 ? lines.length : end;
    if (kind === 'DELETE') {
      blocks.push({ kind: 'delete', path: filePath });
    } else if (kind === 'FILE') {
      blocks.push({ kind: 'file', path: filePath, content: body.join('\n') });
    } else {
      const sep = body.findIndex(l => /^={7}\s*$/.test(l));
      if (sep === -1) continue;
      blocks.push({ kind: 'edit', path: filePath, search: body.slice(0, sep).join('\n'), replace: body.slice(sep + 1).join('\n') });
    }
  }
  return { plan, blocks };
}

/** Replaces `search` in `text`: exactly first, then ignoring trailing whitespace on each line. */
function applyEdit(text: string, search: string, replace: string): string | undefined {
  if (!search) return undefined;
  const at = text.indexOf(search);
  if (at !== -1) return text.slice(0, at) + replace + text.slice(at + search.length);
  const lines = text.split('\n');
  const wanted = search.split('\n').map(l => l.trimEnd());
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (wanted.every((w, j) => lines[i + j].trimEnd() === w)) {
      return [...lines.slice(0, i), ...replace.split('\n'), ...lines.slice(i + wanted.length)].join('\n');
    }
  }
  return undefined;
}

/** Applies the blocks to the files (read from disk when the model edits one it wasn't shown). */
export async function buildTextProposal(repoRoot: string, blocks: Block[], shown: Map<string, string>): Promise<{ changes: ProposedChange[]; warnings: string[] }> {
  const original = new Map<string, string | null>();
  const current = new Map<string, string | null>();
  const warnings: string[] = [];
  const load = async (p: string): Promise<string | null> => {
    if (!original.has(p)) {
      let text: string | null = shown.get(p) ?? null;
      if (text === null) text = await fs.readFile(path.join(repoRoot, p), 'utf8').catch(() => null);
      original.set(p, text);
      current.set(p, text);
    }
    return current.get(p) ?? null;
  };
  for (const block of blocks) {
    if (path.isAbsolute(block.path) || block.path.split('/').includes('..')) {
      warnings.push(vscode.l10n.t('Skipped a change outside the repository: {0}', block.path));
      continue;
    }
    const text = await load(block.path);
    if (block.kind === 'delete') {
      current.set(block.path, null);
    } else if (block.kind === 'file') {
      current.set(block.path, block.content.endsWith('\n') || !block.content ? block.content : `${block.content}\n`);
    } else if (text === null) {
      warnings.push(vscode.l10n.t('{0}: the file to edit does not exist', block.path));
    } else {
      const edited = applyEdit(text, block.search, block.replace);
      if (edited === undefined) warnings.push(vscode.l10n.t('{0}: one edit did not match the current file and was left out', block.path));
      else current.set(block.path, edited);
    }
  }
  const changes: ProposedChange[] = [];
  for (const [p, before] of original) {
    const after = current.get(p) ?? null;
    if (before === after) continue;
    if (before === null && after === null) continue;
    changes.push({
      path: p,
      status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
      before: before ?? '',
      after: after ?? '',
    });
  }
  return { changes, warnings };
}

// ─── Resolve with AI: agent mode ─────────────────────────────────────────────
// Claude Code / Codex edit files themselves. They work in a throwaway worktree of HEAD, so the user's working tree
// is untouched until the proposal is applied — exactly like the text mode.

const AGENT_INSTRUCTIONS = [
  '## How to work',
  'You are in a checkout of the repository at its current commit. Explore the code you need and make the changes directly in the files.',
  'Do not commit, do not create branches, do not run git or any other command: only read and edit files.',
  'When you are done, reply with a short Markdown summary of the cause and of what you changed (or of why the issue cannot be resolved).',
].join('\n');

export function buildResolveAgentPrompt(context: IssueContext, cfg: vscode.WorkspaceConfiguration): string {
  return buildPrompt('resolveIssue', [...issueContextSections(context), '', AGENT_INSTRUCTIONS], cfg);
}

/** A detached worktree of HEAD in the temp directory, for the agent to work in. */
export async function createScratchWorktree(repoRoot: string, label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `gitcharm-resolve-${label.replace(/[^A-Za-z0-9-]/g, '-')}-${Date.now()}`);
  await createGit(repoRoot).raw(['worktree', 'add', '--detach', dir, 'HEAD']);
  return dir;
}

export async function removeScratchWorktree(repoRoot: string, dir: string): Promise<void> {
  const git = createGit(repoRoot);
  await git.raw(['worktree', 'remove', '--force', dir]).catch(() => fs.rm(dir, { recursive: true, force: true }));
  await git.raw(['worktree', 'prune']).catch(() => undefined);
}

/** What the agent changed in the worktree, against HEAD. Binary files are left out. */
export async function collectWorktreeChanges(dir: string): Promise<{ changes: ProposedChange[]; warnings: string[] }> {
  const git = createGit(dir);
  await git.raw(['add', '-A']);
  const out = await git.raw(['diff', '--cached', '--name-status', '--no-renames', 'HEAD']);
  const changes: ProposedChange[] = [];
  const warnings: string[] = [];
  for (const line of out.split('\n')) {
    const [code, ...rest] = line.split('\t');
    const p = rest.join('\t').trim();
    if (!code || !p) continue;
    const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
    const before = status === 'added' ? '' : await git.show([`HEAD:${p}`]).catch(() => '');
    const after = status === 'deleted' ? '' : await fs.readFile(path.join(dir, p), 'utf8').catch(() => '');
    if (before.includes('\0') || after.includes('\0')) {
      warnings.push(vscode.l10n.t('{0}: binary file left out', p));
      continue;
    }
    changes.push({ path: p, status, before, after });
  }
  return { changes, warnings };
}

// ─── Applying a proposal ─────────────────────────────────────────────────────

/** Proposed files that also have uncommitted local changes — applying would overwrite those. */
export async function dirtyFilesAmong(repoRoot: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const out = await createGit(repoRoot).raw(['status', '--porcelain', '--', ...paths]);
  return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
}

/** Writes the proposal into the working tree. */
export async function writeProposal(repoRoot: string, changes: ProposedChange[]): Promise<void> {
  for (const change of changes) {
    const abs = path.join(repoRoot, change.path);
    if (change.status === 'deleted') {
      await fs.rm(abs, { force: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, change.after, 'utf8');
    }
  }
}
