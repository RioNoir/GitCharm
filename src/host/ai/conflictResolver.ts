import * as vscode from 'vscode';
import * as path from 'path';
import { generateForOperation } from './aiGenerate';
import { buildPrompt, getAiLanguage } from './prompts';
import { CONFLICT_MARKER_LINE, hasConflictMarkers, parseConflicts, type ConflictHunk } from '../git/ConflictParser';
import { logWarn } from '../utils/Logger';

/** Lines of surrounding code sent with each conflict, so the model sees what the hunk belongs to. */
const CONTEXT_LINES = 25;
/** Conflicts of one file resolved at the same time. */
const CONCURRENCY = 3;

export interface ConflictResolution {
  /** Conflicts the AI resolved (and that were written to the file). */
  resolved: number;
  /** Conflicts left as they were: the AI failed, or answered with conflict markers. */
  failed: number;
  errors: string[];
}

/** What happens to each conflict, for the live view (ConflictAiPanel). */
export type HunkEvent =
  | { kind: 'start'; index: number; hunk: ConflictHunk }
  | { kind: 'progress'; index: number; explanation: string; resolution: string }
  | { kind: 'done'; index: number; explanation: string; resolution: string }
  | { kind: 'failed'; index: number; error: string };

export interface ResolveOptions {
  /** Only these conflicts (indexes from parseConflicts); all of them otherwise. */
  hunks?: number[];
  /** Save the file even when some conflicts are left. A file without conflicts left is always saved. */
  save?: boolean;
  token?: vscode.CancellationToken;
  onHunk?: (event: HunkEvent) => void;
}

export interface FileResolution extends ConflictResolution {
  total: number;
  /** No conflict markers left in the file, which was saved: it can be staged to mark it resolved. */
  clean: boolean;
}

/**
 * Resolves the conflicts of a file with the AI and writes the result into its document (one undoable edit).
 *
 * The conflicts are read from the document; if it has none but the file on disk does, the file is open in VS
 * Code's merge editor (whose result isn't the marked-up text) and the disk version is resolved instead, then
 * written into the document — which is the merge editor's result.
 */
export async function resolveConflictsInFile(uri: vscode.Uri, options: ResolveOptions = {}): Promise<FileResolution> {
  const doc = await vscode.workspace.openTextDocument(uri);
  let text = doc.getText();
  if (!hasConflictMarkers(text)) {
    const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    if (!hasConflictMarkers(disk)) return { total: 0, resolved: 0, failed: 0, errors: [], clean: false };
    text = disk;
  }
  const version = doc.version;
  const hunks = parseConflicts(text);
  const selected = (options.hunks ?? hunks.map((_, i) => i)).filter(i => i >= 0 && i < hunks.length);
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const relPath = vscode.workspace.asRelativePath(uri, false);

  const results = new Map<number, string[]>();
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < selected.length && !options.token?.isCancellationRequested) {
      const index = selected[next++];
      options.onHunk?.({ kind: 'start', index, hunk: hunks[index] });
      try {
        const answer = await resolveHunk(hunks[index], lines, relPath, doc.languageId,
          partial => options.onHunk?.({ kind: 'progress', index, ...partial }));
        results.set(index, answer.resolution === '' ? [] : answer.resolution.split(/\r?\n/));
        options.onHunk?.({ kind: 'done', index, ...answer });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${path.basename(uri.fsPath)}:${hunks[index].startLine + 1} — ${message}`);
        logWarn('ai-resolve-conflict', `${relPath}:${hunks[index].startLine + 1}`, message);
        options.onHunk?.({ kind: 'failed', index, error: message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

  const failed = selected.length - results.size;
  if (results.size === 0 || options.token?.isCancellationRequested) {
    return { total: selected.length, resolved: 0, failed: selected.length, errors, clean: false };
  }
  // The model took seconds: don't overwrite edits made in the meantime.
  if (doc.version !== version) {
    throw new Error(vscode.l10n.t('{0} changed while the conflicts were being resolved. Try again.', path.basename(uri.fsPath)));
  }

  // Bottom-up, so earlier line numbers stay valid.
  const out = [...lines];
  for (const index of [...results.keys()].sort((a, b) => b - a)) {
    const hunk = hunks[index];
    out.splice(hunk.startLine, hunk.endLine - hunk.startLine + 1, ...results.get(index)!);
  }
  const newText = out.join(eol);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
  if (!await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t('Could not write the resolved conflicts to {0}.', path.basename(uri.fsPath)));
  const clean = !hasConflictMarkers(newText);
  if (clean || options.save) await doc.save();
  return { total: selected.length, resolved: results.size, failed, errors, clean };
}

/** Pulls the explanation and the resolved lines out of an answer, complete or still streaming. */
function parseAnswer(text: string): { explanation: string; resolution: string; tagged: boolean } {
  const section = (tag: string) => {
    const open = text.indexOf(`<${tag}>`);
    if (open < 0) return undefined;
    const from = open + tag.length + 2;
    const close = text.indexOf(`</${tag}>`, from);
    return text.slice(from, close < 0 ? undefined : close);
  };
  const explanation = section('explanation')?.trim() ?? '';
  const resolution = section('resolution');
  if (resolution === undefined) return { explanation, resolution: '', tagged: explanation !== '' };
  // One line break after <resolution> and before </resolution> belongs to the tags; a fence around the code doesn't belong at all.
  let code = resolution.replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '');
  const fenced = /^\s*(```|~~~)[\w-]*\r?\n([\s\S]*?)\r?\n\s*\1\s*$/.exec(code);
  if (fenced) code = fenced[2];
  return { explanation, resolution: code, tagged: true };
}

async function resolveHunk(
  hunk: ConflictHunk,
  lines: string[],
  relPath: string,
  languageId: string,
  onProgress: (partial: { explanation: string; resolution: string }) => void,
): Promise<{ explanation: string; resolution: string }> {
  const before = lines.slice(Math.max(0, hunk.startLine - CONTEXT_LINES), hunk.startLine);
  const after = lines.slice(hunk.endLine + 1, hunk.endLine + 1 + CONTEXT_LINES);
  const block = (title: string, body: string[]) => `## ${title}\n\`\`\`\n${body.join('\n')}\n\`\`\``;
  const cfg = vscode.workspace.getConfiguration('gitcharm');
  const prompt = buildPrompt('resolveConflicts', [
    `## File\n${relPath} (${languageId})`,
    before.length > 0 && block('Lines before the conflict', before),
    block(`Current side${hunk.currentLabel ? ` (${hunk.currentLabel})` : ''}`, hunk.current),
    hunk.base && block('Common ancestor', hunk.base),
    block(`Incoming side${hunk.incomingLabel ? ` (${hunk.incomingLabel})` : ''}`, hunk.incoming),
    after.length > 0 && block('Lines after the conflict', after),
    // Always added, also after a custom prompt: GitCharm shows the explanation and writes only the resolution.
    [
      '## Answer format',
      `First explain in one to three sentences, in this language: ${getAiLanguage(cfg)}, how you combined the two sides, inside <explanation></explanation>.`,
      'Then write the lines that replace the whole conflict inside <resolution></resolution>, exactly as they go in the file, with their indentation.',
    ].join('\n'),
  ], cfg);

  const answer = await generateForOperation('resolveConflicts', prompt, cfg, {
    preserveIndentation: true,
    onProgress: text => { const p = parseAnswer(text); onProgress({ explanation: p.explanation, resolution: p.resolution }); },
  });
  const parsed = parseAnswer(answer);
  // A custom prompt may ask for the bare lines: then the whole answer is the resolution.
  const result = parsed.tagged ? parsed : { explanation: '', resolution: answer };
  if (parsed.tagged && !result.resolution.trim() && !/<resolution>\s*<\/resolution>/.test(answer)) {
    throw new Error(vscode.l10n.t('The AI answer has no resolution.'));
  }
  if (CONFLICT_MARKER_LINE.test(result.resolution)) throw new Error(vscode.l10n.t('The AI answer still contains conflict markers.'));
  return result;
}
