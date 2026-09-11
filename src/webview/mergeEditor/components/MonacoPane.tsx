import React, { useEffect, useState } from 'react';
import { getVsCodeMonacoTheme } from '../../shared/Codicon';

interface Props {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  language?: string;
  label: string;
  labelColor?: string;
  height?: string;
}

export function MonacoPane({ value, onChange, readOnly = false, language = 'plaintext', label, labelColor, height = '100%' }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [Editor, setEditor] = useState<React.ComponentType<any> | null>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    import('@monaco-editor/react').then(mod => setEditor(mod.Editor as React.ComponentType<any>)).catch(console.error);
  }, []);

  return (
    <div style={styles.container(height)}>
      <div style={styles.label(labelColor)}>{label}</div>
      <div style={styles.editorWrapper}>
        {Editor ? (
          <Editor
            value={value}
            onChange={readOnly ? undefined : (val: string | undefined) => onChange?.(val ?? '')}
            language={language}
            theme={getVsCodeMonacoTheme()}
            height="100%"
            options={{
              readOnly,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              lineNumbers: 'on',
              folding: false,
              renderLineHighlight: readOnly ? 'none' : 'line',
              scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
              wordWrap: 'on',
              glyphMargin: !readOnly,
            }}
          />
        ) : (
          <div style={styles.loading}>Loading editor...</div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: (height: string) => ({
    display: 'flex',
    flexDirection: 'column' as const,
    height,
    overflow: 'hidden',
    flex: 1,
    minWidth: 0,
  }),
  label: (color?: string) => ({
    padding: '4px 8px',
    fontSize: '11px',
    fontWeight: 'bold' as const,
    background: 'var(--vscode-editor-background)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    color: color ?? 'var(--vscode-foreground)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    flexShrink: 0,
  }),
  editorWrapper: {
    flex: 1,
    overflow: 'hidden',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: '12px',
    opacity: 0.6,
    color: 'var(--vscode-foreground)',
  },
};
