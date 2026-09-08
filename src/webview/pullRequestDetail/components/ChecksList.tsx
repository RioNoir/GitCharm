import React from 'react';
import type { CiCheck } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { SkeletonList } from '../../shared/Skeleton';
import { formatRelativeTime } from '../formatRelativeTime';

interface Props {
  checks: CiCheck[];
  loading: boolean;
}

function stateInfo(state: CiCheck['state']): { icon: string; color: string } {
  switch (state) {
    case 'success': return { icon: 'pass-filled', color: '#3fb950' };
    case 'failure': return { icon: 'error', color: 'var(--vscode-errorForeground)' };
    case 'pending': return { icon: 'sync', color: 'var(--vscode-descriptionForeground)' };
    default: return { icon: 'question', color: 'var(--vscode-descriptionForeground)' };
  }
}

function formatDuration(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt || !completedAt) return undefined;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function CheckRow({ check }: { check: CiCheck }) {
  const { icon, color } = stateInfo(check.state);
  const duration = formatDuration(check.startedAt, check.completedAt);
  return (
    <div style={css.row}>
      <Codicon name={icon} style={{ fontSize: '15px', color, flexShrink: 0 }} />
      <span style={css.name}>{check.name}</span>
      <span style={css.meta}>
        {duration && <span>{duration}</span>}
        {check.completedAt && (
          <span title={new Date(check.completedAt).toLocaleString()}>{formatRelativeTime(check.completedAt)}</span>
        )}
      </span>
      {check.url && (
        <a href={check.url} style={css.link} title="View details">
          <Codicon name="link-external" style={{ fontSize: '13px' }} />
        </a>
      )}
    </div>
  );
}

export function ChecksList({ checks, loading }: Props) {
  if (loading) return <SkeletonList rows={5} withAvatar={false} />;
  if (checks.length === 0) return <div style={css.empty}>No checks reported for this pull request.</div>;

  return (
    <div style={css.root}>
      {checks.map(c => <CheckRow key={c.id} check={c} />)}
    </div>
  );
}

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, border: '1px solid var(--vscode-panel-border)', borderRadius: '4px', overflow: 'hidden' },
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const, padding: '4px 0' },
  row: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', fontSize: '13px',
    borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
  } as React.CSSProperties,
  name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  meta: {
    display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, fontSize: '11px', opacity: 0.65,
  } as React.CSSProperties,
  link: {
    display: 'inline-flex', alignItems: 'center', color: 'inherit', opacity: 0.6, flexShrink: 0,
  } as React.CSSProperties,
};
