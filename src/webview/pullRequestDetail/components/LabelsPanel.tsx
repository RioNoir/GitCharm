import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PullRequestLabel } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';

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

/** GitLab "scoped labels" use `scope::value` syntax (e.g. `type::bug`) and render as a two-tone pill: the scope half is solid-colored, the value half sits on the panel's default background with colored text, both ringed by a thin border in the label's color — mirrors GitLab's own `gl-label-scoped` component, which has only one real color (the API never returns a second one). */
function LabelChip({ label }: { label: PullRequestLabel }) {
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

function CandidateRow({ candidate, selected, onToggle }: { candidate: PullRequestLabel; selected: boolean; onToggle: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...css.candidateRow, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onToggle}
    >
      <Codicon name={selected ? 'check' : 'blank'} style={{ fontSize: '13px', flexShrink: 0 }} />
      <span style={css.swatch(candidate.color)} />
      {candidate.name}
    </div>
  );
}

interface Props {
  labels: PullRequestLabel[];
  hasLabels: boolean;
  canManageLabels: boolean;
  candidates: PullRequestLabel[];
  candidatesLoading: boolean;
  updating: boolean;
  onRequestCandidates: () => void;
  onUpdate: (labelIds: string[]) => void;
}

export function LabelsPanel({ labels, hasLabels, canManageLabels, candidates, candidatesLoading, updating, onRequestCandidates, onUpdate }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [open]);

  if (!hasLabels) return null;

  const selectedIds = new Set(labels.map(l => l.id));
  const filtered = useMemo(
    () => candidates.filter(c => c.name.toLowerCase().includes(filter.toLowerCase())),
    [candidates, filter],
  );

  const toggle = (labelId: string) => {
    const next = selectedIds.has(labelId) ? labels.filter(l => l.id !== labelId).map(l => l.id) : [...labels.map(l => l.id), labelId];
    onUpdate(next);
  };

  return (
    <div style={css.chipsRow}>
      {labels.length === 0
        ? <span style={css.emptyText}>None yet</span>
        : labels.map(l => <LabelChip key={l.id} label={l} />)
      }
      {canManageLabels && (
        <div ref={ref} style={{ position: 'relative' }}>
          <button style={css.editIconBtn} onClick={() => { setOpen(o => !o); if (!open) onRequestCandidates(); }} title="Edit labels" disabled={updating}>
            <Codicon name="edit" style={{ fontSize: '12px' }} />
          </button>
          {open && (
            <div style={css.popover}>
              <input
                autoFocus
                style={css.filterInput}
                placeholder="Filter…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
              <div style={css.candidateList}>
                {candidatesLoading ? (
                  <div style={css.candidateEmpty}>Loading…</div>
                ) : filtered.length === 0 ? (
                  <div style={css.candidateEmpty}>No matches.</div>
                ) : (
                  filtered.map(c => (
                    <CandidateRow key={c.id} candidate={c} selected={selectedIds.has(c.id)} onToggle={() => toggle(c.id)} />
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
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
  editIconBtn: {
    background: 'transparent', border: 'none', color: 'inherit', opacity: 0.6, cursor: 'pointer',
    display: 'flex', alignItems: 'center', padding: '2px',
  } as React.CSSProperties,
  popover: {
    position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, zIndex: 50, width: '220px',
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', padding: '6px',
  } as React.CSSProperties,
  filterInput: {
    width: '100%', boxSizing: 'border-box' as const, fontSize: '12px', padding: '4px 6px', marginBottom: '4px',
    background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '3px', outline: 'none',
  } as React.CSSProperties,
  candidateList: { maxHeight: '220px', overflowY: 'auto' as const } as React.CSSProperties,
  candidateEmpty: { fontSize: '12px', opacity: 0.5, padding: '6px', fontStyle: 'italic' as const },
  candidateRow: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px', borderRadius: '3px', cursor: 'pointer', fontSize: '12px',
  } as React.CSSProperties,
};
