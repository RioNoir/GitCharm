import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import { TableKit } from '@tiptap/extension-table';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { Codicon } from './Codicon';
import { focusableFieldStyle, generatingFieldStyle } from './inputStyles';
import * as l10n from '@vscode/l10n';
import { isImeComposing } from './ime';
import { decorateMentions, useMentionCandidates, type MentionCandidate } from './mentions';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
  /** Drops the outer border/focus-ring, for when the editor is nested inside a container that already has its
   * own border (e.g. editing a comment in place) — the editor then fills that container edge-to-edge instead
   * of visually doubling up on borders. */
  bare?: boolean;
  /** Rendered inside the text area's top-right corner (e.g. the AI generate button), like the commit message's. */
  inlineAction?: React.ReactNode;
  /** Blocks typing and toolbar actions, e.g. while the content is being generated. */
  readOnly?: boolean;
  /** AI is writing the content: read-only, plus the commit message's generating look (focus border, pulsing text). */
  generating?: boolean;
}

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
// A mention node serializes back to the forge's own mention text (`@octocat`, `@{account_id}`) — never through
// turndown's text escaping, which would otherwise turn `@some_user` into `@some\_user`.
turndown.addRule('mention', {
  filter: node => node.nodeName === 'SPAN' && node.getAttribute('data-type') === 'mention',
  replacement: (content, node) => (node as HTMLElement).getAttribute('data-id') ?? content,
});

// Tiptap tables → GFM pipe tables. Turndown has no table support of its own, and GFM has no way to express
// a table without a header row or a multi-line cell — so the first row always becomes the header, and a
// cell's paragraphs/line breaks are joined with <br> (which every forge renders inside a table cell).
function tableCellToMarkdown(cell: Element): string {
  const text = turndown.turndown(cell.innerHTML).trim()
    .split(/\n+/).map(line => line.trim()).filter(Boolean).join('<br>');
  return text.replace(/\|/g, '\\|') || ' ';
}

turndown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => {
    const rows = Array.from((node as HTMLTableElement).rows)
      .map(row => Array.from(row.cells).map(tableCellToMarkdown))
      .filter(cells => cells.length > 0);
    if (rows.length === 0) return '';
    const width = Math.max(...rows.map(r => r.length));
    const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill(' ')].join(' | ')} |`;
    const [header, ...body] = rows;
    return `\n\n${[line(header), line(Array(width).fill('---')), ...body.map(line)].join('\n')}\n\n`;
  },
});

function markdownToHtml(markdown: string, mentions: MentionCandidate[]): string {
  if (!markdown.trim()) return '';
  return decorateMentions(marked.parse(markdown, { async: false, breaks: true, silent: true }).toString(), 'editor', mentions);
}

// Block-level syntax at a line start, or unambiguous inline syntax anywhere. Plain prose that happens to
// contain a `*` or `_` (file_names, 2 * 3) shouldn't be reinterpreted, so single-character emphasis alone
// doesn't count.
const MARKDOWN_BLOCK_RE = /^(#{1,6}\s|\s*[-*+]\s+\S|\s*\d+[.)]\s+\S|>\s?|```|~~~|\s*\|.*\|\s*$|\s*[-*_]{3,}\s*$)/m;
const MARKDOWN_INLINE_RE = /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|!?\[[^\]\n]+\]\([^)\s]+\)/;

function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_BLOCK_RE.test(text) || MARKDOWN_INLINE_RE.test(text);
}

const MAX_SUGGESTIONS = 8;

function filterCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.toLowerCase();
  if (!q) return candidates.slice(0, MAX_SUGGESTIONS);
  const prefix: MentionCandidate[] = [];
  const contains: MentionCandidate[] = [];
  for (const c of candidates) {
    const label = c.label.toLowerCase();
    const token = c.token.toLowerCase();
    if (label.startsWith(q) || token.startsWith(`@${q}`)) prefix.push(c);
    else if (label.includes(q)) contains.push(c);
  }
  return [...prefix, ...contains].slice(0, MAX_SUGGESTIONS);
}

interface SuggestionState {
  items: MentionCandidate[];
  rect: DOMRect | null;
  command: (attrs: { id: string; label: string }) => void;
}

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

/** `label` replaces the icon with short text, for actions codicons have no glyph for (heading levels). */
function ToolbarButton({ icon, label, title, active, disabled, onClick }: { icon?: string; label?: string; title: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      style={{ ...css.toolBtn, ...(active ? css.toolBtnActive : null), ...(disabled ? css.toolBtnDisabled : null) }}
      title={title}
      disabled={disabled}
      // Toolbar clicks must not steal focus/selection from the editor before the command runs.
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
    >
      {label ? <span style={css.toolBtnLabel}>{label}</span> : <Codicon name={icon ?? ''} style={{ fontSize: '13px' }} />}
    </button>
  );
}

function TableBarButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-btn" style={css.tableBarBtn} onMouseDown={e => e.preventDefault()} onClick={onClick}>
      <Codicon name={icon} style={{ fontSize: '11px' }} />
      {label}
    </button>
  );
}

export function MarkdownEditor({ value, onChange, placeholder, minHeight = '180px', bare = false, inlineAction, readOnly: readOnlyProp = false, generating = false }: Props) {
  const readOnly = readOnlyProp || generating;
  // Read lazily by the Placeholder extension, so a changed placeholder (e.g. "Generating…") shows without recreating the editor.
  const placeholderRef = useRef(placeholder ?? '');
  placeholderRef.current = placeholder ?? '';
  const mentionCandidates = useMentionCandidates();
  // The editor is created once (see useEditor's empty deps below), so everything its callbacks read that can
  // change afterwards goes through a ref.
  const mentionCandidatesRef = useRef(mentionCandidates);
  mentionCandidatesRef.current = mentionCandidates;
  const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const suggestionRef = useRef<{ state: SuggestionState | null; index: number }>({ state: null, index: 0 });
  suggestionRef.current = { state: suggestion, index: suggestionIndex };

  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [focused, setFocused] = useState(false);
  const [, forceToolbarUpdate] = useState(0);

  // `value` (markdown) is the prop-level source of truth, but round-tripping it through the editor
  // (markdown -> HTML -> ProseMirror doc -> HTML -> markdown) on every keystroke is not loss-less byte-for-byte
  // (turndown's output can shift slightly even for an unchanged doc), so comparing strings to detect "did this
  // change come from us" is unreliable. A generation counter sidesteps that: every change this component itself
  // emits bumps it, and the resync effect only ever pushes `value` into the editor when it changes for a reason
  // OTHER than our own emit.
  const ownUpdateGeneration = useRef(0);
  const lastSeenGeneration = useRef(0);

  // onChange is read through a ref inside onUpdate below (see the empty deps array on useEditor) — without this,
  // stale closures wouldn't be a correctness problem for onChange specifically (the parent always passes a fresh
  // callback), but keeping the editor instance itself stable is what matters here.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      // All six levels are accepted so an existing `####` survives an edit; the toolbar only offers the first three.
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      Link.configure({ openOnClick: false, autolink: true }),
      // Shown while read-only too, so "Generating…" appears while AI writes the content.
      Placeholder.configure({ placeholder: () => placeholderRef.current, showOnlyWhenEditable: false }),
      // Not resizable: column widths have no markdown representation, they'd be lost on save anyway.
      TableKit.configure({ table: { resizable: false } }),
      Mention.configure({
        HTMLAttributes: { class: 'pr-mention' },
        suggestion: {
          char: '@',
          items: ({ query }) => filterCandidates(mentionCandidatesRef.current, query),
          render: () => {
            const show = (props: SuggestionProps<MentionCandidate, { id: string; label: string }>) => {
              setSuggestion(props.items.length > 0 ? { items: props.items, rect: props.clientRect?.() ?? null, command: props.command } : null);
            };
            return {
              onStart: props => { setSuggestionIndex(0); show(props); },
              onUpdate: props => { setSuggestionIndex(0); show(props); },
              onExit: () => setSuggestion(null),
              onKeyDown: ({ event }: SuggestionKeyDownProps) => {
                const { state, index } = suggestionRef.current;
                if (!state) return false;
                if (event.key === 'ArrowDown') { setSuggestionIndex((index + 1) % state.items.length); return true; }
                if (event.key === 'ArrowUp') { setSuggestionIndex((index - 1 + state.items.length) % state.items.length); return true; }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  const item = state.items[index];
                  if (item) state.command({ id: item.token, label: item.label });
                  return true;
                }
                if (event.key === 'Escape') { setSuggestion(null); return true; }
                return false;
              },
            };
          },
        },
      }),
    ],
    content: markdownToHtml(value, mentionCandidates),
    onUpdate: ({ editor: e }) => {
      ownUpdateGeneration.current += 1;
      lastSeenGeneration.current = ownUpdateGeneration.current;
      onChangeRef.current(htmlToMarkdown(e.getHTML()));
    },
    // isActive()/getAttributes() don't trigger a React re-render on their own — this forces the toolbar to
    // reflect selection/mark changes (e.g. cursor moving into a bold run) without re-running onUpdate's logic.
    onSelectionUpdate: () => forceToolbarUpdate(n => n + 1),
    onTransaction: () => forceToolbarUpdate(n => n + 1),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    editorProps: {
      attributes: { class: 'markdown-body gitcharm-tiptap-content' },
      // Markdown copied as plain text (from a .md file in VS Code, a terminal, a chat…) would otherwise land as
      // literal `**`/`#`/`-` characters. Rich HTML from a web page is left to Tiptap, which already keeps its
      // formatting — except VS Code's own clipboard HTML, which is just syntax-highlighted source code.
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        const text = data?.getData('text/plain');
        if (!data || !text) return false;
        if (view.state.selection.$from.parent.type.spec.code) return false;
        const fromVsCode = data.types.includes('vscode-editor-data');
        if (data.getData('text/html') && !fromVsCode) return false;
        if (!looksLikeMarkdown(text)) return false;
        const html = markdownToHtml(text, mentionCandidatesRef.current);
        if (!html) return false;
        editorRef.current?.chain().focus().insertContent(html).run();
        return true;
      },
    },
    // Empty deps: the editor instance must be created exactly once. `useEditor` recreates the whole
    // ProseMirror instance (dropping selection, undo history, and any in-progress stored marks) whenever its
    // `deps` array changes — and since this component re-renders on every keystroke/selection change (the
    // onTransaction/onSelectionUpdate handlers above force that), leaving `deps` at its default meant the editor
    // was being torn down and rebuilt on nearly every interaction. That's what caused marks like bold to appear
    // to toggle themselves on a plain click: the click landed mid-rebuild, on a fresh instance replaying stale
    // stored marks from the just-discarded one.
  }, []);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    if (!editor || editor.isEditable === !readOnly) return;
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  // Placeholder decorations are only recomputed on a transaction — dispatch an empty one when the text changes.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('placeholderRefresh', true));
  }, [editor, placeholder]);

  useEffect(() => {
    if (!editor) return;
    if (lastSeenGeneration.current === ownUpdateGeneration.current && ownUpdateGeneration.current > 0) return;
    lastSeenGeneration.current = ownUpdateGeneration.current;
    editor.commands.setContent(markdownToHtml(value, mentionCandidatesRef.current), { emitUpdate: false });
  }, [value, editor]);

  const openLinkPrompt = useCallback(() => {
    const previousUrl = editor?.getAttributes('link').href as string | undefined;
    setLinkUrl(previousUrl ?? '');
    setLinkPromptOpen(true);
  }, [editor]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    const url = linkUrl.trim();
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    else editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkPromptOpen(false);
  }, [editor, linkUrl]);

  if (!editor) return <div style={{ ...css.editorLoading, minHeight }}>{l10n.t('Loading editor…')}</div>;

  const inTable = editor.isActive('table');

  return (
    <div style={{
      ...focusableFieldStyle(focused),
      ...(bare ? { border: 'none', borderRadius: 0, boxShadow: 'none', borderBottom: '1px solid var(--vscode-panel-border)' } : null),
      ...(generating && !bare ? { border: '1px solid var(--vscode-focusBorder)', boxShadow: 'none', animation: 'gs-ai-generating-border-pulse 1.2s ease-in-out infinite' } : null),
      ...css.fieldGroup,
    }}>
      <div style={{ ...css.toolbar, ...(readOnly ? { pointerEvents: 'none', opacity: 0.5 } : null) }}>
        <div style={css.toolbarGroup}>
          {([1, 2, 3] as const).map(level => (
            <ToolbarButton
              key={level}
              label={`H${level}`}
              title={l10n.t('Heading {0}', level)}
              active={editor.isActive('heading', { level })}
              disabled={inTable}
              onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
            />
          ))}
        </div>
        <div style={css.toolbarDivider} />
        <div style={css.toolbarGroup}>
          <ToolbarButton icon="bold" title={l10n.t('Bold (Ctrl+B)')} active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
          <ToolbarButton icon="italic" title={l10n.t('Italic (Ctrl+I)')} active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <ToolbarButton icon="code" title={l10n.t('Inline code')} active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} />
        </div>
        <div style={css.toolbarDivider} />
        <div style={css.toolbarGroup}>
          <ToolbarButton icon="list-unordered" title={l10n.t('Bulleted list')} active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <ToolbarButton icon="list-ordered" title={l10n.t('Numbered list')} active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          <ToolbarButton icon="quote" title={l10n.t({ message: 'Quote', comment: ['Markdown toolbar: block quote'] })} active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
          <ToolbarButton icon="file-code" title={l10n.t('Code block')} active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
        </div>
        <div style={css.toolbarDivider} />
        <div style={css.toolbarGroup}>
          <ToolbarButton icon="link" title={l10n.t({ message: 'Link', comment: ['Markdown toolbar: insert/edit hyperlink'] })} active={editor.isActive('link') || linkPromptOpen} onClick={openLinkPrompt} />
          <ToolbarButton
            icon="table"
            title={l10n.t('Insert table')}
            active={inTable}
            disabled={inTable || editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          />
        </div>
      </div>

      {inTable && (
        <div style={css.tableBar}>
          <Codicon name="table" style={{ fontSize: '12px', opacity: 0.6, flexShrink: 0 }} />
          <TableBarButton label={l10n.t('Row above')} icon="add" onClick={() => editor.chain().focus().addRowBefore().run()} />
          <TableBarButton label={l10n.t('Row below')} icon="add" onClick={() => editor.chain().focus().addRowAfter().run()} />
          <TableBarButton label={l10n.t('Column left')} icon="add" onClick={() => editor.chain().focus().addColumnBefore().run()} />
          <TableBarButton label={l10n.t('Column right')} icon="add" onClick={() => editor.chain().focus().addColumnAfter().run()} />
          <div style={css.toolbarDivider} />
          <TableBarButton label={l10n.t('Delete row')} icon="remove" onClick={() => editor.chain().focus().deleteRow().run()} />
          <TableBarButton label={l10n.t('Delete column')} icon="remove" onClick={() => editor.chain().focus().deleteColumn().run()} />
          <TableBarButton label={l10n.t('Delete table')} icon="trash" onClick={() => editor.chain().focus().deleteTable().run()} />
        </div>
      )}

      {linkPromptOpen && (
        <div style={css.linkPrompt}>
          <Codicon name="link" style={{ fontSize: '12px', opacity: 0.6, flexShrink: 0 }} />
          <input
            autoFocus
            style={css.linkInput}
            value={linkUrl}
            placeholder="https://…"
            onChange={e => setLinkUrl(e.target.value)}
            onKeyDown={e => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') applyLink();
              if (e.key === 'Escape') setLinkPromptOpen(false);
            }}
          />
          <button type="button" style={css.linkApplyBtn} onClick={applyLink}>{l10n.t('Apply')}</button>
          <button type="button" className="gc-btn-secondary" style={css.linkCancelBtn} onClick={() => setLinkPromptOpen(false)}>{l10n.t('Cancel')}</button>
        </div>
      )}

      <div style={{ position: 'relative' }}>
        <div style={{ ...css.editorFrame, minHeight, ...(inlineAction ? { paddingRight: '30px' } : null), ...(generating ? { cursor: 'default', animation: generatingFieldStyle().animation } : readOnly ? { opacity: 0.6, cursor: 'default' } : null) }}>
          <EditorContent editor={editor} />
        </div>
        {inlineAction && <div style={css.inlineAction}>{inlineAction}</div>}
      </div>

      {suggestion?.rect && (
        <div style={{ ...css.suggestionList, top: suggestion.rect.bottom + 4, left: suggestion.rect.left }} role="listbox">
          {suggestion.items.map((item, i) => (
            <div
              key={item.token}
              role="option"
              aria-selected={i === suggestionIndex}
              style={{ ...css.suggestionItem, ...(i === suggestionIndex ? css.suggestionItemActive : null) }}
              onMouseDown={e => { e.preventDefault(); suggestion.command({ id: item.token, label: item.label }); }}
              onMouseEnter={() => setSuggestionIndex(i)}
            >
              {item.avatarUrl
                ? <img src={item.avatarUrl} alt="" style={css.suggestionAvatar} />
                : <Codicon name="account" style={{ fontSize: '14px', opacity: 0.7 }} />}
              <span style={css.suggestionLabel}>{item.label}</span>
              {item.token !== `@${item.label}` && !item.token.startsWith('@{') && <span style={css.suggestionToken}>{item.token}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const css = {
  // The border/focus-ring wraps the toolbar and the editor together as one visual field, matching the other
  // inputs' focusableFieldStyle — the toolbar and text area are two sections of the same control, not two
  // separate boxes stacked with a gap.
  fieldGroup: {
    display: 'flex', flexDirection: 'column' as const, overflow: 'hidden',
  } as React.CSSProperties,
  toolbar: {
    display: 'flex', alignItems: 'center', gap: '2px', flexWrap: 'wrap' as const,
    padding: '4px 6px', borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'color-mix(in srgb, var(--vscode-foreground) 4%, transparent)',
  } as React.CSSProperties,
  toolbarGroup: { display: 'flex', alignItems: 'center', gap: '1px' } as React.CSSProperties,
  toolbarDivider: { width: '1px', height: '16px', background: 'var(--vscode-panel-border)', margin: '0 5px' } as React.CSSProperties,
  toolBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px',
    background: 'transparent', border: '1px solid transparent', borderRadius: '4px', cursor: 'pointer',
    color: 'var(--vscode-icon-foreground, inherit)', opacity: 0.8, transition: 'background 0.1s ease, opacity 0.1s ease',
  } as React.CSSProperties,
  toolBtnActive: {
    background: 'var(--vscode-toolbar-activeBackground)', opacity: 1,
    color: 'var(--vscode-focusBorder)',
  } as React.CSSProperties,
  toolBtnLabel: { fontSize: '11px', fontWeight: 700, lineHeight: 1 } as React.CSSProperties,
  toolBtnDisabled: { opacity: 0.35, cursor: 'default' } as React.CSSProperties,
  tableBar: {
    display: 'flex', alignItems: 'center', gap: '2px', flexWrap: 'wrap' as const, padding: '3px 6px',
    background: 'color-mix(in srgb, var(--vscode-foreground) 4%, transparent)', borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  tableBarBtn: {
    display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '2px 6px', borderRadius: '3px',
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.85,
  } as React.CSSProperties,
  linkPrompt: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px',
    background: 'color-mix(in srgb, var(--vscode-foreground) 4%, transparent)', borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  linkInput: {
    flex: 1, fontSize: '12px', padding: '4px 6px', background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '3px', outline: 'none',
  } as React.CSSProperties,
  linkApplyBtn: {
    fontSize: '11px', padding: '4px 10px', borderRadius: '3px', border: 'none', cursor: 'pointer',
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
  } as React.CSSProperties,
  linkCancelBtn: { fontSize: '11px', padding: '4px 10px' } as React.CSSProperties,
  inlineAction: { position: 'absolute' as const, top: '4px', right: '4px' } as React.CSSProperties,
  editorFrame: {
    maxHeight: '420px', overflow: 'auto', cursor: 'text',
    padding: '6px 8px', fontSize: '13px',
  } as React.CSSProperties,
  suggestionList: {
    position: 'fixed' as const, zIndex: 1000, minWidth: '200px', maxWidth: '320px', padding: '4px',
    background: 'var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background))',
    border: '1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border))', borderRadius: '4px',
    boxShadow: '0 4px 12px var(--vscode-widget-shadow, rgba(0,0,0,0.3))',
  } as React.CSSProperties,
  suggestionItem: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', borderRadius: '3px', cursor: 'pointer',
    fontSize: '12px', color: 'var(--vscode-editorSuggestWidget-foreground, inherit)',
  } as React.CSSProperties,
  suggestionItemActive: {
    background: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground))',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground))',
  } as React.CSSProperties,
  suggestionAvatar: { width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0 } as React.CSSProperties,
  suggestionLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  suggestionToken: { marginLeft: 'auto', fontSize: '11px', opacity: 0.6, flexShrink: 0 } as React.CSSProperties,
  editorLoading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', opacity: 0.5,
  } as React.CSSProperties,
};
