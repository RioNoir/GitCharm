import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Codicon } from '../../shared/Codicon';
import { getVsCodeApi } from '../../shared/vscodeApi';
import type { HostToLogMsg } from '../../../host/types/messages';

interface Props {
  repoId: string;
  hash: string;
  modelLabel: string;
  autoExplain: boolean;
}

/** Ported from the old vanilla-JS "Full Detail" panel's `.ai-section` — collapsible header,
 * Generate/Regenerate button, loading spinner, error box, explanation text. */
export function AiExplainSection({ repoId, hash, modelLabel, autoExplain }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [everGenerated, setEverGenerated] = useState(false);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToLogMsg>) => {
      const msg = event.data;
      if (msg?.type !== 'LOG_EXPLAIN_COMMIT_RESULT') return;
      setLoading(false);
      if (msg.error) {
        setError(msg.error);
        setExplanation(null);
      } else {
        setExplanation(msg.explanation ?? '');
        setError(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const triggerExplain = useCallback(() => {
    setExpanded(true);
    setLoading(true);
    setError(null);
    setExplanation(null);
    setEverGenerated(true);
    getVsCodeApi().postMessage({ type: 'COMMITFULLDETAIL_EXPLAIN', repoId, hash });
  }, [repoId, hash]);

  const autoTriggeredRef = useRef(false);
  useEffect(() => {
    if (autoExplain && !autoTriggeredRef.current) {
      autoTriggeredRef.current = true;
      triggerExplain();
    }
  }, [autoExplain, triggerExplain]);

  return (
    <div style={styles.section}>
      <div
        style={styles.header}
        onClick={() => { if (everGenerated) setExpanded(v => !v); }}
      >
        <Codicon name="sparkle" style={{ fontSize: '13px', opacity: 0.7 }} />
        <span style={styles.title}>AI Explanation</span>
        <span style={styles.modelLabel}>{modelLabel}</span>
        <button
          style={styles.toggleBtn}
          title="Generate AI explanation"
          onClick={e => { e.stopPropagation(); triggerExplain(); }}
          disabled={loading}
        >
          <Codicon name="sparkle" style={{ fontSize: '12px' }} />
          <span>{loading ? 'Generating…' : everGenerated ? 'Regenerate' : 'Generate'}</span>
        </button>
      </div>
      {expanded && (
        <div style={styles.body}>
          {loading && (
            <div style={styles.loading}>
              <Codicon name="loading" className="codicon-modifier-spin" style={{ fontSize: '13px' }} />
              <span>Generating explanation…</span>
            </div>
          )}
          {!loading && error && <div style={styles.error}>{error}</div>}
          {!loading && !error && explanation && <div style={styles.text}>{explanation}</div>}
        </div>
      )}
    </div>
  );
}

const styles = {
  section: {
    borderBottom: '1px solid var(--vscode-panel-border)',
    flexShrink: 0,
  } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '8px 16px', cursor: 'pointer', userSelect: 'none' as const,
  } as React.CSSProperties,
  title: {
    flex: 1, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase' as const, letterSpacing: '0.06em', opacity: 0.6,
  } as React.CSSProperties,
  modelLabel: {
    fontSize: '10px', opacity: 0.5,
    whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
    maxWidth: '160px',
  } as React.CSSProperties,
  toggleBtn: {
    display: 'flex', alignItems: 'center', gap: '5px',
    border: 'none', cursor: 'pointer',
    padding: '5px 10px', borderRadius: '4px', fontSize: '12px',
    color: 'var(--vscode-button-foreground)',
    background: 'var(--vscode-button-background)',
    opacity: 0.9, flexShrink: 0,
  } as React.CSSProperties,
  body: {
    padding: '0 16px 14px', fontSize: '12px', lineHeight: 1.65,
    maxHeight: '240px', overflowY: 'auto' as const,
  } as React.CSSProperties,
  loading: {
    display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.6, fontSize: '12px',
  } as React.CSSProperties,
  error: { fontSize: '12px', color: 'var(--vscode-errorForeground)' },
  text: { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const },
};
