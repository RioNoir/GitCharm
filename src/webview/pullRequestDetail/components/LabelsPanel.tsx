import React from 'react';
import type { PullRequestLabel } from '../../../host/types/messages';

/** Picks readable text color (black/white) for a given hex background, same heuristic forges themselves use for label text. */
function contrastColor(hexColor: string): string {
  const hex = hexColor.replace(/^#/, '');
  if (hex.length !== 6) return '#000000';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#000000' : '#ffffff';
}

/** GitLab "scoped labels" use `scope::value` syntax (e.g. `type::bug`) and render as a two-tone pill: the scope half is solid-colored, the value half sits on the panel's default background with colored text, both ringed by a thin border in the label's color — mirrors GitLab's own `gl-label-scoped` component, which has only one real color (the API never returns a second one). Exported for reuse anywhere else a label needs to render exactly like it does here (e.g. the Activity timeline). */
export function LabelChip({ label }: { label: PullRequestLabel }) {
  const separatorIndex = label.name.indexOf('::');
  if (separatorIndex === -1) {
    return (
      <span style={css.chip(label.color, contrastColor(label.color))} title={label.name}>
        {label.name}
      </span>
    );
  }
  const scope = label.name.slice(0, separatorIndex);
  const value = label.name.slice(separatorIndex + 2);
  const color = `#${label.color.replace(/^#/, '')}`;
  return (
    <span style={css.scopedChip(color)} title={label.name}>
      <span style={css.scopedChipScope(color, contrastColor(label.color))}>{scope}</span>
      <span style={css.scopedChipValue(color)}>{value}</span>
    </span>
  );
}

interface Props {
  labels: PullRequestLabel[];
  hasLabels: boolean;
}

export function LabelsPanel({ labels, hasLabels }: Props) {
  if (!hasLabels) return null;

  return (
    <div style={css.chipsRow}>
      {labels.length === 0
        ? <span style={css.emptyText}>None yet</span>
        : labels.map(l => <LabelChip key={l.id} label={l} />)
      }
    </div>
  );
}

const css = {
  chipsRow: { display: 'flex', flexWrap: 'wrap' as const, gap: '8px', alignItems: 'center' } as React.CSSProperties,
  emptyText: { fontSize: '13px', opacity: 0.5, fontStyle: 'italic' as const },
  chip: (bg: string, fg: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: '999px',
    fontSize: '12px', fontWeight: 600, background: `#${bg.replace(/^#/, '')}`, color: fg,
  }),
  scopedChip: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'stretch', borderRadius: '999px', overflow: 'hidden',
    fontSize: '12px', fontWeight: 600, boxShadow: `inset 0 0 0 1.5px ${color}`,
    background: 'var(--vscode-editor-background)',
  }),
  scopedChipScope: (bg: string, fg: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', padding: '3px 8px 3px 10px', background: bg, color: fg,
  }),
  scopedChipValue: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', padding: '3px 10px 3px 8px', color,
  }),
  swatch: (color: string): React.CSSProperties => ({
    width: '12px', height: '12px', borderRadius: '50%', flexShrink: 0, background: `#${color.replace(/^#/, '')}`,
  }),
};
