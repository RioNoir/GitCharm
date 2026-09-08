import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PullRequestUser } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';

interface PeopleFieldProps {
  label: string;
  icon: string;
  showHeader?: boolean;
  people: PullRequestUser[];
  candidates: PullRequestUser[];
  candidatesLoading: boolean;
  canEdit: boolean;
  updating: boolean;
  onRequestCandidates: () => void;
  onUpdate: (userIds: string[]) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function CandidateRow({ candidate, selected, onToggle }: { candidate: PullRequestUser; selected: boolean; onToggle: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...css.candidateRow, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onToggle}
    >
      <Codicon name={selected ? 'check' : 'blank'} style={{ fontSize: '13px', flexShrink: 0 }} />
      {candidate.avatarUrl
        ? <img src={candidate.avatarUrl} alt={candidate.username} style={css.chipAvatarImg} />
        : <span style={css.chipAvatarFallback}>{initials(candidate.username)}</span>
      }
      {candidate.username}
    </div>
  );
}

function PersonChip({ person }: { person: PullRequestUser }) {
  return (
    <span style={css.chip} title={person.username}>
      {person.avatarUrl
        ? <img src={person.avatarUrl} alt={person.username} style={css.chipAvatarImg} />
        : <span style={css.chipAvatarFallback}>{initials(person.username)}</span>
      }
      {person.username}
    </span>
  );
}

function EditPopoverButton({
  label, candidates, candidatesLoading, updating, selectedIds, onRequestCandidates, onToggle,
}: {
  label: string; candidates: PullRequestUser[]; candidatesLoading: boolean; updating: boolean;
  selectedIds: Set<string>; onRequestCandidates: () => void; onToggle: (userId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [open]);

  const filtered = useMemo(
    () => candidates.filter(c => c.username.toLowerCase().includes(filter.toLowerCase())),
    [candidates, filter],
  );

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={css.editIconBtn} onClick={() => { setOpen(o => !o); if (!open) onRequestCandidates(); }} title={`Edit ${label.toLowerCase()}`} disabled={updating}>
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
                <CandidateRow key={c.id} candidate={c} selected={selectedIds.has(c.id)} onToggle={() => onToggle(c.id)} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PeopleField({ label, icon, showHeader = true, people, candidates, candidatesLoading, canEdit, updating, onRequestCandidates, onUpdate }: PeopleFieldProps) {
  const selectedIds = useMemo(() => new Set(people.map(p => p.id)), [people]);

  const toggle = (userId: string) => {
    const next = selectedIds.has(userId) ? people.filter(p => p.id !== userId).map(p => p.id) : [...people.map(p => p.id), userId];
    onUpdate(next);
  };

  const editButton = canEdit && (
    <EditPopoverButton
      label={label}
      candidates={candidates}
      candidatesLoading={candidatesLoading}
      updating={updating}
      selectedIds={selectedIds}
      onRequestCandidates={onRequestCandidates}
      onToggle={toggle}
    />
  );

  return (
    <div style={css.field}>
      {showHeader && (
        <div style={css.fieldHeader}>
          <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.6 }} />
          <span style={css.fieldLabel}>{label}</span>
          {editButton && <div style={{ marginLeft: 'auto' }}>{editButton}</div>}
        </div>
      )}
      <div style={css.chipsRow}>
        {people.length === 0
          ? <span style={css.emptyText}>No one</span>
          : people.map(p => <PersonChip key={p.id} person={p} />)
        }
        {!showHeader && editButton}
      </div>
    </div>
  );
}

const css = {
  field: { display: 'flex', flexDirection: 'column' as const, gap: '6px', minWidth: '180px' } as React.CSSProperties,
  fieldHeader: { display: 'flex', alignItems: 'center', gap: '6px' } as React.CSSProperties,
  fieldLabel: {
    fontSize: '11px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', opacity: 0.6, fontWeight: 600,
  } as React.CSSProperties,
  editIconBtn: {
    background: 'transparent', border: 'none', color: 'inherit', opacity: 0.6, cursor: 'pointer',
    display: 'flex', alignItems: 'center', padding: '2px',
  } as React.CSSProperties,
  chipsRow: { display: 'flex', flexWrap: 'wrap' as const, gap: '8px', alignItems: 'center' } as React.CSSProperties,
  emptyText: { fontSize: '13px', opacity: 0.5, fontStyle: 'italic' as const },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '4px 12px 4px 4px', borderRadius: '999px',
    fontSize: '13px', background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
  } as React.CSSProperties,
  chipAvatarImg: { width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0 } as React.CSSProperties,
  chipAvatarFallback: {
    width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '10px', fontWeight: 'bold' as const, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
  popover: {
    position: 'absolute' as const, top: 'calc(100% + 4px)', right: 0, zIndex: 50, width: '220px',
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
