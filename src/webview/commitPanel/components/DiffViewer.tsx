import React, { useEffect, useRef, useState } from 'react';
import type { FileDiff } from '../../shared/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerDarkModernTheme(monaco: any) {
  // Full Dark Modern token rules: dark_vs.json + dark_plus.json + dark_modern.json colors
  monaco.editor.defineTheme('dark-modern', {
    base: 'vs-dark',
    inherit: false,
    rules: [
      // ── dark_vs base rules ──
      { token: 'emphasis',                          fontStyle: 'italic' },
      { token: 'strong',                            fontStyle: 'bold' },
      { token: 'header',                            foreground: '000080' },
      { token: 'comment',                           foreground: '6A9955' },
      { token: 'constant.language',                 foreground: '569cd6' },
      { token: 'constant.numeric',                  foreground: 'b5cea8' },
      { token: 'variable.other.enummember',         foreground: 'b5cea8' },
      { token: 'keyword.operator.plus.exponent',    foreground: 'b5cea8' },
      { token: 'keyword.operator.minus.exponent',   foreground: 'b5cea8' },
      { token: 'constant.regexp',                   foreground: '646695' },
      { token: 'entity.name.tag',                   foreground: '569cd6' },
      { token: 'entity.name.tag.css',               foreground: 'd7ba7d' },
      { token: 'entity.name.tag.less',              foreground: 'd7ba7d' },
      { token: 'entity.other.attribute-name',       foreground: '9cdcfe' },
      { token: 'entity.other.attribute-name.class.css',          foreground: 'd7ba7d' },
      { token: 'entity.other.attribute-name.id.css',             foreground: 'd7ba7d' },
      { token: 'entity.other.attribute-name.parent-selector.css',foreground: 'd7ba7d' },
      { token: 'entity.other.attribute-name.pseudo-class',       foreground: 'd7ba7d' },
      { token: 'entity.other.attribute-name.pseudo-element.css', foreground: 'd7ba7d' },
      { token: 'entity.other.attribute-name.scss',               foreground: 'd7ba7d' },
      { token: 'invalid',                           foreground: 'f44747' },
      { token: 'markup.underline',                  fontStyle: 'underline' },
      { token: 'markup.bold',                       fontStyle: 'bold', foreground: '569cd6' },
      { token: 'markup.heading',                    fontStyle: 'bold', foreground: '569cd6' },
      { token: 'markup.italic',                     fontStyle: 'italic', foreground: 'C586C0' },
      { token: 'markup.strikethrough',              fontStyle: 'strikethrough' },
      { token: 'markup.inserted',                   foreground: 'b5cea8' },
      { token: 'markup.deleted',                    foreground: 'ce9178' },
      { token: 'markup.changed',                    foreground: '569cd6' },
      { token: 'punctuation.definition.quote.begin.markdown', foreground: '6A9955' },
      { token: 'punctuation.definition.list.begin.markdown',  foreground: '6796e6' },
      { token: 'markup.inline.raw',                 foreground: 'ce9178' },
      { token: 'punctuation.definition.tag',        foreground: '808080' },
      { token: 'meta.preprocessor',                 foreground: '569cd6' },
      { token: 'entity.name.function.preprocessor', foreground: '569cd6' },
      { token: 'meta.preprocessor.string',          foreground: 'ce9178' },
      { token: 'meta.preprocessor.numeric',         foreground: 'b5cea8' },
      { token: 'meta.structure.dictionary.key.python', foreground: '9cdcfe' },
      { token: 'meta.diff.header',                  foreground: '569cd6' },
      { token: 'storage',                           foreground: '569cd6' },
      { token: 'storage.type',                      foreground: '569cd6' },
      { token: 'storage.modifier',                  foreground: '569cd6' },
      { token: 'keyword.operator.noexcept',         foreground: '569cd6' },
      { token: 'string',                            foreground: 'ce9178' },
      { token: 'meta.embedded.assembly',            foreground: 'ce9178' },
      { token: 'string.tag',                        foreground: 'ce9178' },
      { token: 'string.value',                      foreground: 'ce9178' },
      { token: 'string.regexp',                     foreground: 'd16969' },
      { token: 'punctuation.definition.template-expression.begin', foreground: '569cd6' },
      { token: 'punctuation.definition.template-expression.end',   foreground: '569cd6' },
      { token: 'punctuation.section.embedded',      foreground: '569cd6' },
      { token: 'meta.template.expression',          foreground: 'd4d4d4' },
      { token: 'support.type.vendored.property-name', foreground: '9cdcfe' },
      { token: 'support.type.property-name',        foreground: '9cdcfe' },
      { token: 'source.css.variable',               foreground: '9cdcfe' },
      { token: 'source.coffee.embedded',            foreground: '9cdcfe' },
      { token: 'keyword',                           foreground: '569cd6' },
      { token: 'keyword.control',                   foreground: '569cd6' },
      { token: 'keyword.operator',                  foreground: 'd4d4d4' },
      { token: 'keyword.operator.new',              foreground: '569cd6' },
      { token: 'keyword.operator.expression',       foreground: '569cd6' },
      { token: 'keyword.operator.cast',             foreground: '569cd6' },
      { token: 'keyword.operator.sizeof',           foreground: '569cd6' },
      { token: 'keyword.operator.alignof',          foreground: '569cd6' },
      { token: 'keyword.operator.typeid',           foreground: '569cd6' },
      { token: 'keyword.operator.alignas',          foreground: '569cd6' },
      { token: 'keyword.operator.instanceof',       foreground: '569cd6' },
      { token: 'keyword.operator.logical.python',   foreground: '569cd6' },
      { token: 'keyword.operator.wordlike',         foreground: '569cd6' },
      { token: 'keyword.other.unit',                foreground: 'b5cea8' },
      { token: 'punctuation.section.embedded.begin.php', foreground: '569cd6' },
      { token: 'punctuation.section.embedded.end.php',   foreground: '569cd6' },
      { token: 'support.function.git-rebase',       foreground: '9cdcfe' },
      { token: 'constant.sha.git-rebase',           foreground: 'b5cea8' },
      { token: 'storage.modifier.import.java',      foreground: 'd4d4d4' },
      { token: 'variable.language.wildcard.java',   foreground: 'd4d4d4' },
      { token: 'storage.modifier.package.java',     foreground: 'd4d4d4' },
      { token: 'variable.language',                 foreground: '569cd6' },
      // ── dark_plus additional rules ──
      { token: 'entity.name.function',              foreground: 'DCDCAA' },
      { token: 'support.function',                  foreground: 'DCDCAA' },
      { token: 'support.constant.handlebars',       foreground: 'DCDCAA' },
      { token: 'source.powershell.variable.other.member', foreground: 'DCDCAA' },
      { token: 'entity.name.operator.custom-literal', foreground: 'DCDCAA' },
      { token: 'support.class',                     foreground: '4EC9B0' },
      { token: 'support.type',                      foreground: '4EC9B0' },
      { token: 'entity.name.type',                  foreground: '4EC9B0' },
      { token: 'entity.name.namespace',             foreground: '4EC9B0' },
      { token: 'entity.other.attribute',            foreground: '4EC9B0' },
      { token: 'entity.name.scope-resolution',      foreground: '4EC9B0' },
      { token: 'entity.name.class',                 foreground: '4EC9B0' },
      { token: 'storage.type.numeric.go',           foreground: '4EC9B0' },
      { token: 'storage.type.byte.go',              foreground: '4EC9B0' },
      { token: 'storage.type.boolean.go',           foreground: '4EC9B0' },
      { token: 'storage.type.string.go',            foreground: '4EC9B0' },
      { token: 'storage.type.uintptr.go',           foreground: '4EC9B0' },
      { token: 'storage.type.error.go',             foreground: '4EC9B0' },
      { token: 'storage.type.rune.go',              foreground: '4EC9B0' },
      { token: 'storage.type.cs',                   foreground: '4EC9B0' },
      { token: 'storage.type.generic.cs',           foreground: '4EC9B0' },
      { token: 'storage.type.modifier.cs',          foreground: '4EC9B0' },
      { token: 'storage.type.variable.cs',          foreground: '4EC9B0' },
      { token: 'meta.type.cast.expr',               foreground: '4EC9B0' },
      { token: 'meta.type.new.expr',                foreground: '4EC9B0' },
      { token: 'support.constant.math',             foreground: '4EC9B0' },
      { token: 'support.constant.dom',              foreground: '4EC9B0' },
      { token: 'support.constant.json',             foreground: '4EC9B0' },
      { token: 'entity.other.inherited-class',      foreground: '4EC9B0' },
      { token: 'keyword.control',                   foreground: 'C586C0' },
      { token: 'source.cpp.keyword.operator.new',   foreground: 'C586C0' },
      { token: 'keyword.operator.delete',           foreground: 'C586C0' },
      { token: 'keyword.other.using',               foreground: 'C586C0' },
      { token: 'keyword.other.directive.using',     foreground: 'C586C0' },
      { token: 'keyword.other.operator',            foreground: 'C586C0' },
      { token: 'entity.name.operator',              foreground: 'C586C0' },
      { token: 'variable',                          foreground: '9CDCFE' },
      { token: 'meta.definition.variable.name',     foreground: '9CDCFE' },
      { token: 'support.variable',                  foreground: '9CDCFE' },
      { token: 'entity.name.variable',              foreground: '9CDCFE' },
      { token: 'constant.other.placeholder',        foreground: '9CDCFE' },
      { token: 'variable.other.constant',           foreground: '4FC1FF' },
      { token: 'variable.other.enummember',         foreground: '4FC1FF' },
      { token: 'meta.object-literal.key',           foreground: '9CDCFE' },
      { token: 'support.constant.property-value',   foreground: 'CE9178' },
      { token: 'support.constant.font-name',        foreground: 'CE9178' },
      { token: 'support.constant.media-type',       foreground: 'CE9178' },
      { token: 'support.constant.media',            foreground: 'CE9178' },
      { token: 'constant.other.color.rgb-value',    foreground: 'CE9178' },
      { token: 'constant.other.rgb-value',          foreground: 'CE9178' },
      { token: 'support.constant.color',            foreground: 'CE9178' },
      { token: 'punctuation.definition.group.regexp',           foreground: 'CE9178' },
      { token: 'punctuation.definition.group.assertion.regexp', foreground: 'CE9178' },
      { token: 'punctuation.definition.character-class.regexp', foreground: 'CE9178' },
      { token: 'punctuation.character.set.begin.regexp',        foreground: 'CE9178' },
      { token: 'punctuation.character.set.end.regexp',          foreground: 'CE9178' },
      { token: 'keyword.operator.negation.regexp',              foreground: 'CE9178' },
      { token: 'support.other.parenthesis.regexp',              foreground: 'CE9178' },
      { token: 'constant.character.character-class.regexp',     foreground: 'd16969' },
      { token: 'constant.other.character-class.set.regexp',     foreground: 'd16969' },
      { token: 'constant.other.character-class.regexp',         foreground: 'd16969' },
      { token: 'constant.character.set.regexp',                 foreground: 'd16969' },
      { token: 'keyword.operator.or.regexp',        foreground: 'DCDCAA' },
      { token: 'keyword.control.anchor.regexp',     foreground: 'DCDCAA' },
      { token: 'keyword.operator.quantifier.regexp',foreground: 'd7ba7d' },
      { token: 'constant.character',               foreground: '569cd6' },
      { token: 'constant.other.option',            foreground: '569cd6' },
      { token: 'constant.character.escape',        foreground: 'd7ba7d' },
      { token: 'entity.name.label',                foreground: 'C8C8C8' },
    ],
    colors: {
      // ── dark_vs base colors ──
      'editor.background':                    '#1F1F1F',
      'editor.foreground':                    '#CCCCCC',
      'editor.inactiveSelectionBackground':   '#3A3D41',
      'editorIndentGuide.background1':        '#404040',
      'editorIndentGuide.activeBackground1':  '#707070',
      'editor.selectionHighlightBackground':  '#ADD6FF26',
      // ── dark_modern overrides ──
      'editorLineNumber.foreground':          '#6E7681',
      'editorLineNumber.activeForeground':    '#CCCCCC',
      'editorGutter.addedBackground':         '#2EA043',
      'editorGutter.deletedBackground':       '#F85149',
      'editorGutter.modifiedBackground':      '#0078D4',
      'focusBorder':                          '#0078D4',
      // diff editor highlighting
      'diffEditor.insertedTextBackground':    '#2ea04326',
      'diffEditor.removedTextBackground':     '#f8514926',
      'diffEditor.insertedLineBackground':    '#2ea04314',
      'diffEditor.removedLineBackground':     '#f8514914',
      'diffEditor.diagonalFill':              '#3C3C3C',
    },
  });
}

function getDiffTheme(): string {
  const body = document.body;
  if (body.classList.contains('vscode-high-contrast-light')) return 'hc-light';
  if (body.classList.contains('vscode-high-contrast')) return 'hc-black';
  if (body.classList.contains('vscode-light')) return 'vs';
  return 'dark-modern';
}

interface Props {
  diff: FileDiff | null;
  loading: boolean;
}

const LANG_MAP: Record<string, string> = {
  typescript: 'typescript', javascript: 'javascript',
  php: 'php', python: 'python', go: 'go',
  css: 'css', scss: 'scss', html: 'html', json: 'json',
  markdown: 'markdown', shell: 'shell', sql: 'sql',
  rust: 'rust', java: 'java', csharp: 'csharp', ruby: 'ruby',
};

export function DiffViewer({ diff, loading }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [MonacoLoaded, setMonacoLoaded] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [DiffEditorComponent, setDiffEditorComponent] = useState<React.ComponentType<any> | null>(null);

  useEffect(() => {
    import('@monaco-editor/react').then(async (mod) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const monaco = await (mod as any).loader.init();
        if (monaco) registerDarkModernTheme(monaco);
      } catch { /* theme registration is best-effort */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDiffEditorComponent(mod.DiffEditor as React.ComponentType<any>);
      setMonacoLoaded(true);
    }).catch(console.error);
  }, []);

  if (loading) {
    return (
      <div style={styles.placeholder}>
        <span style={styles.loadingText}>Loading diff...</span>
      </div>
    );
  }

  if (!diff) {
    return (
      <div style={styles.placeholder}>
        <span style={styles.hintText}>Select a file to view the diff</span>
      </div>
    );
  }

  if (diff.isBinary) {
    return (
      <div style={styles.placeholder}>
        <span style={styles.hintText}>Binary file — no diff available</span>
      </div>
    );
  }

  if (!MonacoLoaded || !DiffEditorComponent) {
    return (
      <div style={styles.placeholder}>
        <span style={styles.loadingText}>Loading editor...</span>
      </div>
    );
  }

  const DC = DiffEditorComponent;

  return (
    <div style={styles.container} ref={containerRef}>
      <div style={styles.pathBar}>
        <span style={styles.pathText}>{diff.newPath || diff.oldPath}</span>
        {diff.isNew && <span style={styles.badge(true, false, false)}>NEW</span>}
        {diff.isDeleted && <span style={styles.badge(false, true, false)}>DELETED</span>}
      </div>
      <DC
        original={diff.originalContent ?? ''}
        modified={diff.modifiedContent ?? ''}
        language={LANG_MAP[diff.language ?? ''] ?? 'plaintext'}
        theme={getDiffTheme()}
        height="calc(100% - 28px)"
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineNumbers: 'on',
          folding: false,
          renderLineHighlight: 'none',
          scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
          diffWordWrap: 'off',
          wordWrap: 'off',
          formatOnPaste: false,
          formatOnType: false,
          autoIndent: 'none',
          glyphMargin: false,
          ignoreTrimWhitespace: false,
          'semanticHighlighting.enabled': true,
        }}
      />
    </div>
  );
}

const styles = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    borderTop: '1px solid var(--vscode-panel-border)',
  },
  pathBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    background: 'var(--vscode-editor-background)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    minHeight: '28px',
  },
  pathText: {
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
    opacity: 0.7,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  badge: (isNew: boolean, isDeleted: boolean, _isModified: boolean) => ({
    fontSize: '10px',
    padding: '1px 4px',
    borderRadius: '3px',
    background: isNew
      ? 'var(--vscode-gitDecoration-addedResourceForeground)'
      : isDeleted
        ? 'var(--vscode-gitDecoration-deletedResourceForeground)'
        : 'var(--vscode-gitDecoration-modifiedResourceForeground)',
    color: '#fff',
    fontWeight: 'bold' as const,
  }),
  placeholder: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--vscode-editor-background)',
    borderTop: '1px solid var(--vscode-panel-border)',
  },
  hintText: {
    color: 'var(--vscode-foreground)',
    opacity: 0.4,
    fontSize: '13px',
  },
  loadingText: {
    color: 'var(--vscode-foreground)',
    opacity: 0.6,
    fontSize: '13px',
  },
};
