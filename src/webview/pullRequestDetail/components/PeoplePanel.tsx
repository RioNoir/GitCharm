import React from 'react';
import type { PullRequestUser } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';

interface PeopleFieldProps {
  people: PullRequestUser[];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

export function PeopleField({ people }: PeopleFieldProps) {
  return (
    <div style={css.chipsRow}>
      {people.length === 0
        ? <span style={css.emptyText}>No one</span>
        : people.map(p => <PersonChip key={p.id} person={p} />)
      }
    </div>
  );
}

export function EditFieldButton({ label, updating, onPick }: { label: string; updating: boolean; onPick: () => void }) {
  return (
    <button className="icon-btn" style={css.editIconBtn} onClick={onPick} title={`Edit ${label.toLowerCase()}`} disabled={updating}>
      <Codicon name="edit" style={{ fontSize: '12px' }} />
    </button>
  );
}

const css = {
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
};
