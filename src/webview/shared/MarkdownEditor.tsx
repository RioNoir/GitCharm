import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { Codicon } from './Codicon';
import { focusableFieldStyle } from './inputStyles';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
  /** Drops the outer border/focus-ring, for when the editor is nested inside a container that already has its
   * own border (e.g. editing a comment in place) — the editor then fills that container edge-to-edge instead
   * of visually doubling up on borders. */
  bare?: boolean;
}

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });

function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) return '';
  return marked.parse(markdown, { async: false, breaks: true, silent: true }).toString();
}

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

function ToolbarButton({ icon, title, active, disabled, onClick }: { icon: string; title: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
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
      <Codicon name={icon} style={{ fontSize: '13px' }} />
    </button>
  );
}

export function MarkdownEditor({ value, onChange, placeholder, minHeight = '180px', bare = false }: Props) {
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
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
    ],
    content: markdownToHtml(value),
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
    },
    // Empty deps: the editor instance must be created exactly once. `useEditor` recreates the whole
    // ProseMirror instance (dropping selection, undo history, and any in-progress stored marks) whenever its
    // `deps` array changes — and since this component re-renders on every keystroke/selection change (the
    // onTransaction/onSelectionUpdate handlers above force that), leaving `deps` at its default meant the editor
    // was being torn down and rebuilt on nearly every interaction. That's what caused marks like bold to appear
    // to toggle themselves on a plain click: the click landed mid-rebuild, on a fresh instance replaying stale
    // stored marks from the just-discarded one.
  }, []);

  useEffect(() => {
    if (!editor) return;
    if (lastSeenGeneration.current === ownUpdateGeneration.current && ownUpdateGeneration.current > 0) return;
    lastSeenGeneration.current = ownUpdateGeneration.current;
    editor.commands.setContent(markdownToHtml(value), { emitUpdate: false });
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

  if (!editor) return <div style={{ ...css.editorLoading, minHeight }}>Loading editor…</div>;

  return (
    <div style={{
      ...focusableFieldStyle(focused),
      ...(bare ? { border: 'none', borderRadius: 0, boxShadow: 'none', borderBottom: '1px solid var(--vscode-panel-border)' } : null),
      ...css.fieldGroup,
    }}>
      <div style={css.toolbar}>
        <div style={css.toolbarGroup}>
          <ToolbarButton icon="bold" title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
          <ToolbarButton icon="italic" title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <ToolbarButton icon="code" title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} />
        </div>
        <div style={css.toolbarDivider} />
        <div style={css.toolbarGroup}>
          <ToolbarButton icon="list-unordered" title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <ToolbarButton icon="list-ordered" title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          <ToolbarButton icon="quote" title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
          <ToolbarButton icon="file-code" title="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
        </div>
        <div style={css.toolbarDivider} />
        <div style={css.toolbarGroup}>
          <ToolbarButton icon="link" title="Link" active={editor.isActive('link') || linkPromptOpen} onClick={openLinkPrompt} />
        </div>
      </div>

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
              if (e.key === 'Enter') applyLink();
              if (e.key === 'Escape') setLinkPromptOpen(false);
            }}
          />
          <button type="button" style={css.linkApplyBtn} onClick={applyLink}>Apply</button>
          <button type="button" style={css.linkCancelBtn} onClick={() => setLinkPromptOpen(false)}>Cancel</button>
        </div>
      )}

      <div style={{ ...css.editorFrame, minHeight }}>
        <EditorContent editor={editor} />
      </div>
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
  toolBtnDisabled: { opacity: 0.35, cursor: 'default' } as React.CSSProperties,
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
  linkCancelBtn: {
    fontSize: '11px', padding: '4px 10px', borderRadius: '3px', cursor: 'pointer',
    background: 'transparent', color: 'inherit', border: '1px solid var(--vscode-button-border, var(--vscode-panel-border))',
  } as React.CSSProperties,
  editorFrame: {
    maxHeight: '420px', overflow: 'auto', cursor: 'text',
    padding: '6px 8px', fontSize: '13px',
  } as React.CSSProperties,
  editorLoading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', opacity: 0.5,
  } as React.CSSProperties,
};
