import React, { useState } from 'react';
import { Codicon } from './Codicon';

/** Floating action button, fixed bottom-right, shared by the Commit Full Detail and Pull Request Detail
 * panels — clicking it asks the host to generate (or regenerate) an AI explanation, which the host then
 * displays (with its own loading/result state) in a separate "AI Explain Detail" panel opened beside this
 * one (see AiExplainDetailPanel.ts). This button has no persistent "generating" state of its own — the real
 * progress indicator lives in that other panel — it just briefly spins on click for immediate feedback.
 * Idles with a soft glow (`.ai-explain-fab`'s animation, defined in the shared webviewHtml.ts stylesheet —
 * real CSS keyframes, not expressible as a React inline style) and expands into a pill on hover/focus to
 * reveal the "AI Explanation" label plus the configured provider/model in small text below it. */
export function AiExplainFab({ modelLabel, onClick }: { modelLabel: string; onClick: () => void }) {
  const [pulsing, setPulsing] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleClick = () => {
    setPulsing(true);
    setTimeout(() => setPulsing(false), 600);
    onClick();
  };

  const expanded = hovered || pulsing;

  return (
    <button
      className="ai-explain-fab"
      style={{ ...styles.fab, ...(expanded ? styles.fabExpanded : undefined) }}
      title={expanded ? undefined : 'Generate an AI explanation'}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <Codicon name="sparkle" className={pulsing ? 'codicon-modifier-spin' : undefined} style={{ fontSize: '16px', flexShrink: 0 }} />
      {expanded && (
        <span style={styles.labelBlock}>
          <span style={styles.labelTitle}>AI Explanation</span>
          {modelLabel && <span style={styles.labelModel}>{modelLabel}</span>}
        </span>
      )}
    </button>
  );
}

const styles = {
  fab: {
    position: 'fixed' as const, right: '20px', bottom: '20px', zIndex: 100,
    display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'center',
    width: '44px', height: '44px', padding: 0, borderRadius: '22px', border: 'none', cursor: 'pointer',
    overflow: 'hidden',
    color: 'var(--vscode-button-foreground)', background: 'var(--vscode-button-background)',
    transition: 'width 0.18s ease, padding 0.18s ease',
  } as React.CSSProperties,
  fabExpanded: {
    width: 'auto', maxWidth: '260px', padding: '0 16px 0 14px', justifyContent: 'flex-start',
  } as React.CSSProperties,
  labelBlock: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start', gap: '1px',
    whiteSpace: 'nowrap' as const, overflow: 'hidden', lineHeight: 1.25,
  } as React.CSSProperties,
  labelTitle: { fontSize: '12px', fontWeight: 600 },
  labelModel: {
    fontSize: '10px', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '220px',
  } as React.CSSProperties,
};
