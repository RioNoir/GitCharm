import * as vscode from 'vscode';
import { BlameService, type BlameLine } from '../git/BlameService';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { GitLogPanelProvider } from '../panels/GitLogPanelProvider';

const GHOST_MAX_SUMMARY_LEN = 72;
const CONTEXT_KEY = 'gitcharm.annotationsVisible';
const CONFIG_SECTION = 'gitcharm';
const GIT_ANNOTATIONS_ENABLED = 'gitAnnotations.enabled';
const GIT_GHOST_TEXT_ENABLED = 'gitGhostText.enabled';

// 16-slot palette. Each slot is a separate decoration type whose `before`
// pseudo-element carries both the backgroundColor AND the per-line text
// (overridden via renderOptions.before.contentText).
// This confines the color strictly to the annotation block — not the code area.
const NUM_PALETTE = 16;
const PALETTE_HUES = Array.from({ length: NUM_PALETTE }, (_, i) => Math.round(i * 360 / NUM_PALETTE));

function formatRelativeDate(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffMonths = Math.floor(diffDays / 30.44);
  const diffYears = Math.floor(diffDays / 365.25);

  if (diffYears >= 1) return `${diffYears} year${diffYears > 1 ? 's' : ''} ago`;
  if (diffMonths >= 1) return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
  if (diffDays >= 1) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours >= 1) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffMins >= 1) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  return 'just now';
}

function formatDateFull(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateDMY(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getFullYear()}`;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function abbreviateAuthor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${parts[1][0]}.`;
  return parts[0].slice(0, 14);
}

function blameLabel(l: BlameLine): string {
  return `${formatDateDMY(l.date)}  ${abbreviateAuthor(l.author)}`;
}

function annotationAttachment(
  label: string,
  widthCh: number,
  extendsCodeLens = false,
): vscode.ThemableDecorationAttachmentRenderOptions {
  return {
    contentText: label || ' ',
    width: `${widthCh}ch`,
    height: extendsCodeLens ? 'calc(100% + 1lh + 1px)' : '100%',
    margin: extendsCodeLens ? 'calc(-1lh - 1px) 0 0 0' : undefined,
  };
}

function hashPaletteIndex(hash: string): number {
  return parseInt(hash.slice(0, 6), 16) % NUM_PALETTE;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

const BEFORE_TEXT_DECORATION =
  'none; display: inline-block; box-sizing: border-box; overflow: hidden; white-space: pre; line-height: inherit; vertical-align: top; box-shadow: inset -1px 0 0 rgba(127,127,127,0.55);';
const PLACEHOLDER_TEXT_DECORATION =
  'none; display: inline-block; box-sizing: border-box; overflow: hidden; white-space: pre; line-height: inherit; vertical-align: top; box-shadow: inset -1px 0 0 rgba(127,127,127,0.55);';
const CODELENS_BEFORE_TEXT_DECORATION =
  'none; display: inline-block; box-sizing: border-box; overflow: hidden; white-space: pre; line-height: inherit; vertical-align: top; padding-top: calc(1lh + 1px); box-shadow: inset -1px 0 0 rgba(127,127,127,0.55);';
const CODELENS_PLACEHOLDER_TEXT_DECORATION =
  'none; display: inline-block; box-sizing: border-box; overflow: hidden; white-space: pre; line-height: inherit; vertical-align: top; padding-top: calc(1lh + 1px); box-shadow: inset -1px 0 0 rgba(127,127,127,0.55);';
const ANNOTATION_RANGE_BEHAVIOR = vscode.DecorationRangeBehavior.ClosedClosed;

export class FileAnnotationController implements vscode.Disposable {
  private readonly blameService = new BlameService();

  // Ghost text: end-of-line hint on the active cursor line
  private readonly ghostType: vscode.TextEditorDecorationType;

  // Neutral `before` type for uncommitted lines (no background color)
  private readonly uncommittedType: vscode.TextEditorDecorationType;
  private readonly codeLensUncommittedType: vscode.TextEditorDecorationType;

  // Invisible-content `before` type for lines with no blame data (new/unsaved lines).
  // Keeps all lines at the same visual X so the cursor always lands after the column.
  private readonly placeholderType: vscode.TextEditorDecorationType;
  private readonly codeLensPlaceholderType: vscode.TextEditorDecorationType;

  // 16 palette types — each `before` carries its own backgroundColor.
  // Per-line text is injected via renderOptions.before.contentText overrides.
  // Because backgroundColor lives on `before` (not on isWholeLine), the color
  // is strictly contained within the annotation column.
  private readonly paletteTypes: vscode.TextEditorDecorationType[];
  private readonly codeLensPaletteTypes: vscode.TextEditorDecorationType[];

  private readonly annotatedUris = new Set<string>();
  private readonly codeLensLines = new Map<string, Set<number>>();
  // Tracks the last rendered blame per URI, with line numbers adjusted for unsaved edits.
  private readonly adjustedBlame = new Map<string, { lines: BlameLine[]; repoId: string }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: WorkspaceGitManager,
    private readonly logPanel: GitLogPanelProvider,
  ) {
    this.ghostType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorLineNumber.foreground'),
        margin: '0 0 0 3em',
      },
      // ClosedClosed: do not expand the range when the user types at its endpoints,
      // so the ghost text stays on the correct line after pressing Enter.
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.uncommittedType = vscode.window.createTextEditorDecorationType({
      before: {
        textDecoration: BEFORE_TEXT_DECORATION,
      },
      dark:  { before: { color: 'rgba(160,160,160,0.75)' } },
      light: { before: { color: 'rgba(100,100,100,0.75)' } },
      rangeBehavior: ANNOTATION_RANGE_BEHAVIOR,
    });

    this.codeLensUncommittedType = vscode.window.createTextEditorDecorationType({
      before: {
        textDecoration: CODELENS_BEFORE_TEXT_DECORATION,
      },
      dark:  { before: { color: 'rgba(160,160,160,0.75)' } },
      light: { before: { color: 'rgba(100,100,100,0.75)' } },
      rangeBehavior: ANNOTATION_RANGE_BEHAVIOR,
    });

    this.placeholderType = vscode.window.createTextEditorDecorationType({
      before: {
        textDecoration: PLACEHOLDER_TEXT_DECORATION,
      },
      rangeBehavior: ANNOTATION_RANGE_BEHAVIOR,
    });

    this.codeLensPlaceholderType = vscode.window.createTextEditorDecorationType({
      before: {
        textDecoration: CODELENS_PLACEHOLDER_TEXT_DECORATION,
      },
      rangeBehavior: ANNOTATION_RANGE_BEHAVIOR,
    });

    // dark/light overrides let VS Code choose the right backgroundColor automatically
    // when the user switches theme — no need to snapshot isDark at startup.
    // Dark theme  → higher lightness (colors pop on dark background).
    // Light theme → lower lightness  (colors pop on white background).
    // Closed ranges keep tabs and indentation out of the decoration range. The
    // document-change listener re-renders after edits to pin the range back to col 0.
    this.paletteTypes = PALETTE_HUES.map(hue =>
      vscode.window.createTextEditorDecorationType({
        before: {
          textDecoration: BEFORE_TEXT_DECORATION,
        },
        dark: {
          before: {
            backgroundColor: `hsla(${hue}, 70%, 65%, 0.18)`,
            color: 'rgba(180,180,180,0.9)',
          },
        },
        light: {
          before: {
            backgroundColor: `hsla(${hue}, 65%, 38%, 0.14)`,
            color: 'rgba(80,80,80,0.9)',
          },
        },
        rangeBehavior: ANNOTATION_RANGE_BEHAVIOR,
      })
    );

    this.codeLensPaletteTypes = PALETTE_HUES.map(hue =>
      vscode.window.createTextEditorDecorationType({
        before: {
          textDecoration: CODELENS_BEFORE_TEXT_DECORATION,
        },
        dark: {
          before: {
            backgroundColor: `hsla(${hue}, 70%, 65%, 0.18)`,
            color: 'rgba(180,180,180,0.9)',
          },
        },
        light: {
          before: {
            backgroundColor: `hsla(${hue}, 65%, 38%, 0.14)`,
            color: 'rgba(80,80,80,0.9)',
          },
        },
        rangeBehavior: ANNOTATION_RANGE_BEHAVIOR,
      })
    );

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        this.updateGhostText(e.textEditor);
      }),

      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor) return;
        this.updateGhostText(editor);
        this.updateContextKey(editor);
        if (this.annotatedUris.has(editor.document.uri.toString())) {
          this.applyBlameDecorations(editor);
        }
      }),

      vscode.workspace.onDidSaveTextDocument(doc => {
        this.blameService.invalidate(doc.uri.fsPath);
        const uriStr = doc.uri.toString();
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.uri.toString() !== uriStr) continue;
          this.updateGhostText(editor);
          if (this.annotatedUris.has(uriStr)) {
            this.applyBlameDecorations(editor);
          }
        }
      }),

      vscode.workspace.onDidChangeTextDocument(e => {
        const uriStr = e.document.uri.toString();
        if (!this.annotatedUris.has(uriStr)) return;
        const current = this.adjustedBlame.get(uriStr);
        if (!current) return;

        const hasLineChanges = e.contentChanges.some(c =>
          c.text.includes('\n') || c.range.end.line !== c.range.start.line
        );
        const touchesLineStart = e.contentChanges.some(c =>
          c.range.start.character === 0 || c.range.end.character === 0
        );
        if (!hasLineChanges && !touchesLineStart) return;

        const nextLines = hasLineChanges
          ? this.shiftBlameLinesForChanges(current.lines, e.contentChanges)
          : current.lines;

        if (hasLineChanges) {
          this.adjustedBlame.set(uriStr, { lines: nextLines, repoId: current.repoId });
          const currentCodeLensLines = this.codeLensLines.get(uriStr);
          if (currentCodeLensLines) {
            this.codeLensLines.set(uriStr, this.shiftLineSetForChanges(currentCodeLensLines, e.contentChanges));
          }
        }

        const editor = vscode.window.visibleTextEditors.find(
          ed => ed.document.uri.toString() === uriStr,
        );
        if (editor) this.renderBlame(editor, nextLines, current.repoId);
      }),

      vscode.workspace.onDidChangeConfiguration(e => {
        const annotationsChanged = e.affectsConfiguration(`${CONFIG_SECTION}.${GIT_ANNOTATIONS_ENABLED}`);
        const ghostTextChanged = e.affectsConfiguration(`${CONFIG_SECTION}.${GIT_GHOST_TEXT_ENABLED}`);

        if (annotationsChanged) {
          if (this.areGitAnnotationsEnabled()) {
            vscode.window.visibleTextEditors.forEach(editor => this.updateContextKey(editor));
          } else {
            this.disableAllAnnotations();
          }
        }

        if (ghostTextChanged) {
          for (const editor of vscode.window.visibleTextEditors) {
            if (this.isGitGhostTextEnabled()) this.updateGhostText(editor);
            else editor.setDecorations(this.ghostType, []);
          }
        }
      }),
    );
  }

  async openAnnotations(editor: vscode.TextEditor): Promise<void> {
    if (!this.areGitAnnotationsEnabled()) {
      this.closeAnnotations(editor);
      return;
    }

    this.annotatedUris.add(editor.document.uri.toString());
    await this.applyBlameDecorations(editor);
    this.updateContextKey(editor);
  }

  closeAnnotations(editor: vscode.TextEditor): void {
    const uriStr = editor.document.uri.toString();
    this.annotatedUris.delete(uriStr);
    this.adjustedBlame.delete(uriStr);
    this.codeLensLines.delete(uriStr);
    this.clearAnnotationDecorations(editor);
    this.updateContextKey(editor);
  }

  private clearAnnotationDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.uncommittedType, []);
    editor.setDecorations(this.codeLensUncommittedType, []);
    editor.setDecorations(this.placeholderType, []);
    editor.setDecorations(this.codeLensPlaceholderType, []);
    this.paletteTypes.forEach(t => editor.setDecorations(t, []));
    this.codeLensPaletteTypes.forEach(t => editor.setDecorations(t, []));
  }

  private disableAllAnnotations(): void {
    this.annotatedUris.clear();
    this.adjustedBlame.clear();
    this.codeLensLines.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearAnnotationDecorations(editor);
      this.updateContextKey(editor);
    }
  }

  navigateToCommit(hash: string, repoId: string): void {
    this.logPanel.selectCommit(hash, repoId);
  }

  updateGhostText(editor: vscode.TextEditor): void {
    if (!this.isGitGhostTextEnabled()) {
      editor.setDecorations(this.ghostType, []);
      return;
    }

    if (editor.document.uri.scheme !== 'file') {
      editor.setDecorations(this.ghostType, []);
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const repo = this.manager.getServiceForFile(filePath);
    if (!repo) {
      editor.setDecorations(this.ghostType, []);
      return;
    }

    const cursor = editor.selection.active;

    this.blameService.getBlame(filePath, repo.rootPath).then(blameLines => {
      if (!this.isGitGhostTextEnabled()) {
        editor.setDecorations(this.ghostType, []);
        return;
      }
      if (vscode.window.activeTextEditor !== editor) return;
      if (!editor.selection.active.isEqual(cursor)) return;

      const blameLine = blameLines.find(l => l.lineNumber === cursor.line);
      if (!blameLine || blameLine.isUncommitted) {
        editor.setDecorations(this.ghostType, []);
        return;
      }

      const summary = truncate(blameLine.summary, GHOST_MAX_SUMMARY_LEN);
      const text = `${blameLine.author}, ${formatRelativeDate(blameLine.date)} · ${summary}`;
      const endOfLine = editor.document.lineAt(cursor.line).text.length;
      const range = new vscode.Range(cursor.line, endOfLine, cursor.line, endOfLine);

      editor.setDecorations(this.ghostType, [{
        range,
        renderOptions: { after: { contentText: `  ${text}` } },
      }]);
    }).catch(() => {
      editor.setDecorations(this.ghostType, []);
    });
  }

  private async applyBlameDecorations(editor: vscode.TextEditor): Promise<void> {
    if (!this.areGitAnnotationsEnabled()) {
      this.closeAnnotations(editor);
      return;
    }

    if (editor.document.uri.scheme !== 'file') return;

    const filePath = editor.document.uri.fsPath;
    const repo = this.manager.getServiceForFile(filePath);
    if (!repo) return;

    try {
      const [blameLines, codeLensLines] = await Promise.all([
        this.blameService.getBlame(filePath, repo.rootPath),
        this.getCodeLensLines(editor.document),
      ]);
      const uriStr = editor.document.uri.toString();
      if (!this.annotatedUris.has(uriStr)) return;
      this.codeLensLines.set(uriStr, codeLensLines);
      this.adjustedBlame.set(uriStr, { lines: [...blameLines], repoId: repo.repoId });
      this.renderBlame(editor, blameLines, repo.repoId);
    } catch {
      // Leave the editor usable even if blame or CodeLens providers fail.
    }
  }

  private shiftLineSetForChanges(
    lines: Set<number>,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
  ): Set<number> {
    let result = new Set(lines);
    const sorted = [...changes].sort((a, b) => b.range.start.line - a.range.start.line);

    for (const change of sorted) {
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      const insertedNewlines = (change.text.match(/\n/g) ?? []).length;
      const removedLines = endLine - startLine;
      const delta = insertedNewlines - removedLines;

      if (removedLines > 0) {
        result = new Set([...result].filter(line => line <= startLine || line > endLine));
      }

      if (delta !== 0) {
        result = new Set([...result].map(line => line > endLine ? line + delta : line));
      }
    }

    return result;
  }

  private async getCodeLensLines(document: vscode.TextDocument): Promise<Set<number>> {
    try {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        document.uri,
      );
      return new Set((lenses ?? []).map(lens => lens.range.start.line));
    } catch {
      return new Set();
    }
  }

  // Adjusts stored blame line numbers to reflect content changes made since the last git blame.
  // Processes changes bottom-to-top to avoid double-shifting when multiple changes fire at once.
  private shiftBlameLinesForChanges(
    blameLines: BlameLine[],
    changes: readonly vscode.TextDocumentContentChangeEvent[],
  ): BlameLine[] {
    let result = blameLines.map(l => ({ ...l }));
    const sorted = [...changes].sort((a, b) => b.range.start.line - a.range.start.line);

    for (const change of sorted) {
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      const insertedNewlines = (change.text.match(/\n/g) ?? []).length;
      const removedLines = endLine - startLine;
      const delta = insertedNewlines - removedLines;

      // Drop blame entries for lines that were entirely removed by this change
      // (lines strictly between startLine and endLine that no longer exist).
      if (removedLines > 0) {
        result = result.filter(l => l.lineNumber <= startLine || l.lineNumber > endLine);
      }

      // Shift all surviving lines after the change by the net line delta.
      if (delta !== 0) {
        for (const bl of result) {
          if (bl.lineNumber > endLine) bl.lineNumber += delta;
        }
      }
    }

    return result;
  }

  private renderBlame(editor: vscode.TextEditor, blameLines: BlameLine[], repoId: string): void {
    const uriStr = editor.document.uri.toString();
    if (!this.areGitAnnotationsEnabled()) {
      this.closeAnnotations(editor);
      return;
    }
    if (!this.annotatedUris.has(uriStr)) return;
    const codeLensLines = this.codeLensLines.get(uriStr) ?? new Set<number>();

    // Give every before attachment the same explicit width. Character-count padding
    // is not stable enough here: "Not committed" and date/author labels can measure
    // a little differently and shift indentation guides on modified lines.
    const maxLabelLen = blameLines
      .filter(l => !l.isUncommitted)
      .reduce((max, l) => Math.max(max, blameLabel(l).length), 13 /* 'Not committed' */);
    const annotationWidthCh = maxLabelLen + 1; // +1 visual gap before border

    // Uncommitted lines — neutral type, no background
    const uncommittedDecorations: vscode.DecorationOptions[] = [];
    const codeLensUncommittedDecorations: vscode.DecorationOptions[] = [];
    for (const l of blameLines) {
      if (!l.isUncommitted) continue;
      const extendsCodeLens = codeLensLines.has(l.lineNumber);
      const decoration = {
        range: new vscode.Range(l.lineNumber, 0, l.lineNumber, 0),
        renderOptions: { before: annotationAttachment('Not committed', annotationWidthCh, extendsCodeLens) },
      };
      if (extendsCodeLens) codeLensUncommittedDecorations.push(decoration);
      else uncommittedDecorations.push(decoration);
    }
    editor.setDecorations(this.uncommittedType, uncommittedDecorations);
    editor.setDecorations(this.codeLensUncommittedType, codeLensUncommittedDecorations);

    // Committed lines — group by palette slot; each slot type owns its color
    const paletteDecorations: vscode.DecorationOptions[][] =
      Array.from({ length: NUM_PALETTE }, () => []);
    const codeLensPaletteDecorations: vscode.DecorationOptions[][] =
      Array.from({ length: NUM_PALETTE }, () => []);

    for (const l of blameLines) {
      if (l.isUncommitted) continue;
      const extendsCodeLens = codeLensLines.has(l.lineNumber);
      const target = extendsCodeLens ? codeLensPaletteDecorations : paletteDecorations;
      target[hashPaletteIndex(l.hash)].push({
        range: new vscode.Range(l.lineNumber, 0, l.lineNumber, 0),
        hoverMessage: this.buildHoverMessage(l, repoId),
        renderOptions: { before: annotationAttachment(blameLabel(l), annotationWidthCh, extendsCodeLens) },
      });
    }

    this.paletteTypes.forEach((type, idx) => {
      editor.setDecorations(type, paletteDecorations[idx]);
    });
    this.codeLensPaletteTypes.forEach((type, idx) => {
      editor.setDecorations(type, codeLensPaletteDecorations[idx]);
    });

    // New/unsaved lines get the same measured before attachment, with no visible text.
    const blameLineNumbers = new Set(blameLines.map(l => l.lineNumber));
    const placeholderDecorations: vscode.DecorationOptions[] = [];
    const codeLensPlaceholderDecorations: vscode.DecorationOptions[] = [];
    for (let i = 0; i < editor.document.lineCount; i++) {
      if (!blameLineNumbers.has(i)) {
        const extendsCodeLens = codeLensLines.has(i);
        const decoration = {
          range: new vscode.Range(i, 0, i, 0),
          renderOptions: { before: annotationAttachment('', annotationWidthCh, extendsCodeLens) },
        };
        if (extendsCodeLens) codeLensPlaceholderDecorations.push(decoration);
        else placeholderDecorations.push(decoration);
      }
    }
    editor.setDecorations(this.placeholderType, placeholderDecorations);
    editor.setDecorations(this.codeLensPlaceholderType, codeLensPlaceholderDecorations);
  }

  private buildHoverMessage(line: BlameLine, repoId: string): vscode.MarkdownString {
    const args = encodeURIComponent(JSON.stringify([line.hash, repoId]));
    const commandUri = `command:gitcharm.navigateToAnnotationCommit?${args}`;

    const md = new vscode.MarkdownString(
      `$(git-commit) \`${line.hash.slice(0, 8)}\`\n\n` +
      `---\n\n` +
      `$(account) **${escapeMarkdown(line.author)}** &nbsp;·&nbsp; $(calendar) ${formatDateFull(line.date)}\n\n` +
      `${escapeMarkdown(line.summary)}\n\n` +
      `---\n\n` +
      `[$(history) Open in Git Log](${commandUri})`
    );
    md.isTrusted = true;
    md.supportThemeIcons = true;
    return md;
  }

  private areGitAnnotationsEnabled(): boolean {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>(GIT_ANNOTATIONS_ENABLED, true);
  }

  private isGitGhostTextEnabled(): boolean {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>(GIT_GHOST_TEXT_ENABLED, true);
  }

  private updateContextKey(editor: vscode.TextEditor): void {
    vscode.commands.executeCommand(
      'setContext',
      CONTEXT_KEY,
      this.areGitAnnotationsEnabled() && this.annotatedUris.has(editor.document.uri.toString()),
    );
  }

  dispose(): void {
    this.ghostType.dispose();
    this.uncommittedType.dispose();
    this.codeLensUncommittedType.dispose();
    this.placeholderType.dispose();
    this.codeLensPlaceholderType.dispose();
    this.paletteTypes.forEach(t => t.dispose());
    this.codeLensPaletteTypes.forEach(t => t.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}
