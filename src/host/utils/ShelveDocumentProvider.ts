import * as vscode from 'vscode';

/**
 * Virtual document provider for shelved file diffs.
 * URI scheme: gitcharm-shelf
 * Content is the "after" state of the file (current content + patch applied).
 */
export class ShelveDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'gitcharm-shelf';

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private readonly store = new Map<string, string>();

  set(uri: vscode.Uri, content: string): void {
    this.store.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.toString()) ?? '';
  }

  /**
   * Build a stable URI for a shelved file.
   * The path ends with the original filename so VSCode picks up the right language.
   */
  static buildUri(repoId: string, shelveId: string, filePath: string): vscode.Uri {
    const fileName = filePath.split('/').pop() ?? filePath;
    return vscode.Uri.from({
      scheme: ShelveDocumentProvider.scheme,
      authority: 'shelf',
      path: `/${encodeURIComponent(repoId)}/${encodeURIComponent(shelveId)}/${fileName}`,
      query: encodeURIComponent(filePath),
    });
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

interface Hunk {
  oldStart: number;  // 1-based
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];   // raw diff lines including context/+/-
}

function parseHunks(diffChunk: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of diffChunk.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      continue;
    }
    if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/**
 * Apply the patch to the current file content and return the result.
 *
 * For new files (no current content, patch adds everything), the patched content
 * is built purely from the '+' lines.
 *
 * For deleted files, the result is empty string.
 *
 * For modified files, each hunk is applied in sequence.
 */
export function applyPatchToContent(diffChunk: string, currentContent: string): string {
  const isNewFile = /^--- \/dev\/null/m.test(diffChunk) || /^--- a\/dev\/null/m.test(diffChunk);
  const isDeletedFile = /^\+\+\+ \/dev\/null/m.test(diffChunk) || /^\+\+\+ b\/dev\/null/m.test(diffChunk);

  if (isDeletedFile) return '';

  const hunks = parseHunks(diffChunk);
  if (hunks.length === 0) return currentContent;

  if (isNewFile) {
    // Build content from all added lines across all hunks
    const lines: string[] = [];
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) lines.push(line.slice(1));
      }
    }
    return lines.join('\n');
  }

  // Split current content into lines (preserve empty last line logic)
  const inputLines = currentContent.split('\n');
  const output: string[] = [];
  let inputIdx = 0; // 0-based index into inputLines

  for (const hunk of hunks) {
    const hunkOldStart = hunk.oldStart - 1; // convert to 0-based

    // Copy lines before this hunk (unchanged)
    while (inputIdx < hunkOldStart) {
      output.push(inputLines[inputIdx]);
      inputIdx++;
    }

    // Apply hunk lines
    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        // Context line — advance input, emit as-is
        output.push(inputLines[inputIdx] ?? line.slice(1));
        inputIdx++;
      } else if (line.startsWith('+')) {
        // Added line — emit, don't advance input
        output.push(line.slice(1));
      } else if (line.startsWith('-')) {
        // Removed line — skip input line, don't emit
        inputIdx++;
      }
    }
  }

  // Copy any remaining lines after the last hunk
  while (inputIdx < inputLines.length) {
    output.push(inputLines[inputIdx]);
    inputIdx++;
  }

  return output.join('\n');
}
