import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Codicon } from '../shared/Codicon';
import { renderMarkdown } from '../shared/renderMarkdown';
import type { HostToAiExplainMsg } from '../../host/types/messages';

function App() {
  const [subjectKind, setSubjectKind] = useState<'commit' | 'pull-request' | null>(null);
  const [subjectTitle, setSubjectTitle] = useState('');
  const [subjectSubtitle, setSubjectSubtitle] = useState<string | undefined>();
  const [modelLabel, setModelLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToAiExplainMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'AIEXPLAIN_INIT':
          setSubjectKind(msg.subjectKind);
          setSubjectTitle(msg.subjectTitle);
          setSubjectSubtitle(msg.subjectSubtitle);
          setModelLabel(msg.modelLabel);
          setLoading(true);
          setExplanation(null);
          setError(null);
          break;
        case 'AIEXPLAIN_RESULT':
          setLoading(false);
          if (msg.error) {
            setError(msg.error);
            setExplanation(null);
          } else {
            setExplanation(msg.explanation ?? '');
            setError(null);
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const html = useMemo(() => (explanation ? renderMarkdown(explanation) : ''), [explanation]);

  return (
    <div style={css.page}>
      <div style={css.header}>
        <Codicon name={subjectKind === 'pull-request' ? 'git-pull-request' : 'git-commit'} style={{ fontSize: '14px', opacity: 0.7 }} />
        <div style={css.headerText}>
          <div style={css.subjectTitle}>{subjectTitle}</div>
          {subjectSubtitle && <div style={css.subjectSubtitle}>{subjectSubtitle}</div>}
        </div>
      </div>
      <div style={css.modelRow}>
        <Codicon name="sparkle" style={{ fontSize: '12px', opacity: 0.6 }} />
        <span>AI Explanation</span>
        {modelLabel && <span style={css.modelLabel}>{modelLabel}</span>}
      </div>
      <div style={css.body}>
        {loading && (
          <div style={css.loading}>
            <Codicon name="loading" className="codicon-modifier-spin" style={{ fontSize: '14px' }} />
            <span>Generating explanation…</span>
          </div>
        )}
        {!loading && error && <div style={css.error}>{error}</div>}
        {!loading && !error && explanation && (
          <div className="markdown-body" style={css.text} dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}

const css = {
  page: {
    display: 'flex', flexDirection: 'column' as const, height: '100vh', boxSizing: 'border-box' as const,
    background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)',
    fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size, 13px)',
    padding: '20px 24px',
  } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'flex-start', gap: '10px', paddingBottom: '14px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  headerText: { display: 'flex', flexDirection: 'column' as const, gap: '2px', minWidth: 0 },
  subjectTitle: { fontSize: '14px', fontWeight: 600, wordBreak: 'break-word' as const },
  subjectSubtitle: { fontSize: '12px', opacity: 0.6, fontFamily: 'var(--vscode-editor-font-family)' },
  modelRow: {
    display: 'flex', alignItems: 'center', gap: '6px', marginTop: '14px',
    fontSize: '11px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', opacity: 0.6, fontWeight: 600,
  } as React.CSSProperties,
  modelLabel: {
    marginLeft: 'auto', textTransform: 'none' as const, letterSpacing: 'normal', fontWeight: 'normal' as const, opacity: 0.8,
  } as React.CSSProperties,
  body: { marginTop: '12px', flex: 1, overflow: 'auto' },
  loading: {
    display: 'flex', alignItems: 'center', gap: '8px', opacity: 0.6, fontSize: '13px',
  } as React.CSSProperties,
  error: {
    fontSize: '13px', color: 'var(--vscode-inputValidation-errorForeground)',
    background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)',
    borderRadius: '4px', padding: '10px 12px',
  } as React.CSSProperties,
  text: { fontSize: '13px', lineHeight: 1.7 },
};

createRoot(document.getElementById('root')!).render(<App />);
