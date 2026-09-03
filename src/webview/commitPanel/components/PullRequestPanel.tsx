import React from 'react';
import type { RepoPullRequests, PullRequestSummary, ForgeProvider } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { InlineIconBtn } from '../../shared/InlineIconBtn';

interface Props {
  repos: RepoPullRequests[];
  loading: boolean;
  multiRepo: boolean;
  onOpenInBrowser: (url: string) => void;
  onConnectGitHub: (repoId: string) => void;
  onConnectPat: (repoId: string) => void;
  onRequestCreate: (repoId: string) => void;
  onRefresh: (repoId: string) => void;
  onSetHostOverride: (host: string, provider: ForgeProvider) => void;
}

const SELECTABLE_PROVIDERS: { value: ForgeProvider; label: string }[] = [
  { value: 'github', label: 'GitHub Enterprise' },
  { value: 'gitlab', label: 'GitLab (self-hosted)' },
  { value: 'bitbucket', label: 'Bitbucket Server' },
  { value: 'gitea', label: 'Gitea / Forgejo' },
];

function stateIcon(state: PullRequestSummary['state']): { icon: string; color: string; label: string } {
  switch (state) {
    case 'draft':  return { icon: 'git-pull-request-draft',  color: 'var(--vscode-descriptionForeground)', label: 'Draft' };
    case 'merged': return { icon: 'git-merge',                color: '#a371f7', label: 'Merged' };
    case 'closed': return { icon: 'git-pull-request-closed',  color: 'var(--vscode-errorForeground)', label: 'Closed' };
    default:       return { icon: 'git-pull-request',         color: '#3fb950', label: 'Open' };
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function AuthorAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const [failed, setFailed] = React.useState(false);
  if (avatarUrl && !failed) {
    return <img src={avatarUrl} alt={name} title={name} style={row.avatarImg} onError={() => setFailed(true)} />;
  }
  return <span style={row.avatarFallback} title={name}>{initials(name)}</span>;
}

function PullRequestRow({ pr, onOpenInBrowser }: { pr: PullRequestSummary; onOpenInBrowser: (url: string) => void }) {
  const [hovered, setHovered] = React.useState(false);
  const s = stateIcon(pr.state);
  return (
    <div
      style={{ ...row.header, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onOpenInBrowser(pr.url)}
      title={pr.title}
    >
      <Codicon name={s.icon} style={{ fontSize: '14px', color: s.color, flexShrink: 0 }} />
      <div style={row.info}>
        <span style={row.name}>
          <span style={row.number}>#{pr.number}</span>
          <span style={row.nameText}>{pr.title}</span>
        </span>
        <span style={row.meta}>
          <AuthorAvatar name={pr.authorName} avatarUrl={pr.authorAvatarUrl} />
          <span style={row.branch}>
            <Codicon name="git-branch" style={{ fontSize: '10px', marginRight: '3px', opacity: 0.6 }} />
            {pr.sourceBranch} → {pr.targetBranch}
          </span>
        </span>
      </div>
      {hovered && (
        <InlineIconBtn icon="link-external" title="Open in browser" visible onClick={e => { e.stopPropagation(); onOpenInBrowser(pr.url); }} />
      )}
    </div>
  );
}

function UnknownProviderPrompt({ repo, onSetHostOverride }: {
  repo: RepoPullRequests;
  onSetHostOverride: Props['onSetHostOverride'];
}) {
  const [selected, setSelected] = React.useState<ForgeProvider>('github');
  return (
    <div style={css.connectBox}>
      <Codicon name="question" style={{ fontSize: '20px', opacity: 0.5, marginBottom: '6px' }} />
      <div style={css.connectText}>Could not detect a supported Git forge for this repo's remote.</div>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <select style={css.select} value={selected} onChange={e => setSelected(e.target.value as ForgeProvider)}>
          {SELECTABLE_PROVIDERS.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <button style={css.actionBtn} onClick={() => onSetHostOverride(repo.connection.host, selected)}>
          Use this
        </button>
      </div>
    </div>
  );
}

function ConnectPrompt({ repo, onConnectGitHub, onConnectPat, onSetHostOverride }: {
  repo: RepoPullRequests;
  onConnectGitHub: Props['onConnectGitHub'];
  onConnectPat: Props['onConnectPat'];
  onSetHostOverride: Props['onSetHostOverride'];
}) {
  if (repo.connection.detectionFailed) {
    return <UnknownProviderPrompt repo={repo} onSetHostOverride={onSetHostOverride} />;
  }
  const isGitHub = repo.connection.provider === 'github';
  return (
    <div style={css.connectBox}>
      <Codicon name={isGitHub ? 'github' : 'plug'} style={{ fontSize: '20px', opacity: 0.5, marginBottom: '6px' }} />
      <div style={css.connectText}>Not connected to {repo.connection.host || repo.connection.provider}.</div>
      <button style={css.actionBtn} onClick={() => (isGitHub ? onConnectGitHub(repo.repoId) : onConnectPat(repo.repoId))}>
        <Codicon name={isGitHub ? 'github' : 'key'} style={{ marginRight: '4px', fontSize: '12px' }} />
        {isGitHub ? 'Connect to GitHub' : 'Connect with Personal Access Token'}
      </button>
    </div>
  );
}

function RepoSection({ repo, multiRepo, singleRepo, onOpenInBrowser, onConnectGitHub, onConnectPat, onRequestCreate, onRefresh, onSetHostOverride }: {
  repo: RepoPullRequests;
  multiRepo: boolean;
  singleRepo?: boolean;
  onOpenInBrowser: Props['onOpenInBrowser'];
  onConnectGitHub: Props['onConnectGitHub'];
  onConnectPat: Props['onConnectPat'];
  onRequestCreate: Props['onRequestCreate'];
  onRefresh: Props['onRefresh'];
  onSetHostOverride: Props['onSetHostOverride'];
}) {
  const connected = repo.connection.connected;
  return (
    <div style={css.repoSection}>
      {multiRepo && (
        <div style={css.repoHeader(repo.repoColor, singleRepo)}>
          {singleRepo
            ? <Codicon name="repo" style={css.repoIcon} />
            : <span style={css.dot(repo.repoColor)} />
          }
          <span style={css.repoName}>{repo.repoName}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '2px' }}>
            <InlineIconBtn icon="refresh" title="Refresh" onClick={() => onRefresh(repo.repoId)} />
            {connected && (
              <InlineIconBtn icon="add" title="New Pull Request" onClick={() => onRequestCreate(repo.repoId)} />
            )}
          </div>
        </div>
      )}
      {repo.error && (
        <div style={css.errorRow}>
          <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
          {repo.error}
        </div>
      )}
      {!connected ? (
        <ConnectPrompt repo={repo} onConnectGitHub={onConnectGitHub} onConnectPat={onConnectPat} onSetHostOverride={onSetHostOverride} />
      ) : repo.pullRequests.length === 0 ? (
        <div style={css.empty}>No open pull requests</div>
      ) : (
        repo.pullRequests.map(pr => (
          <PullRequestRow key={pr.id} pr={pr} onOpenInBrowser={onOpenInBrowser} />
        ))
      )}
      {!multiRepo && connected && (
        <div style={css.singleRepoActions}>
          <button style={css.actionBtn} onClick={() => onRefresh(repo.repoId)}>
            <Codicon name="refresh" style={{ marginRight: '4px', fontSize: '12px' }} />
            Refresh
          </button>
          <button style={css.actionBtn} onClick={() => onRequestCreate(repo.repoId)}>
            <Codicon name="add" style={{ marginRight: '4px', fontSize: '12px' }} />
            New Pull Request
          </button>
        </div>
      )}
    </div>
  );
}

export function PullRequestPanel({
  repos, loading, multiRepo,
  onOpenInBrowser, onConnectGitHub, onConnectPat, onRequestCreate, onRefresh, onSetHostOverride,
}: Props) {
  if (loading && repos.length === 0) return <div style={css.empty}>Loading…</div>;

  return (
    <div style={css.root}>
      {repos.map(repo => (
        <RepoSection
          key={repo.repoId}
          repo={repo}
          multiRepo={multiRepo}
          singleRepo={repos.length === 1}
          onOpenInBrowser={onOpenInBrowser}
          onConnectGitHub={onConnectGitHub}
          onConnectPat={onConnectPat}
          onRequestCreate={onRequestCreate}
          onRefresh={onRefresh}
          onSetHostOverride={onSetHostOverride}
        />
      ))}
    </div>
  );
}

const css = {
  root: { display: 'flex', flexDirection: 'column' as const },
  repoSection: {} as React.CSSProperties,
  repoHeader: (color: string, singleRepo?: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '6px', padding: '0 8px', height: '26px',
    background: singleRepo ? 'color-mix(in srgb, var(--vscode-foreground) 7%, transparent)' : color + '14',
    borderBottom: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box',
  }),
  dot: (color: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  repoIcon: { fontSize: '13px', opacity: 0.7, flexShrink: 0 } as React.CSSProperties,
  repoName: { fontSize: '11px', fontWeight: 'bold' as const, opacity: 0.9, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  singleRepoActions: {
    display: 'flex', gap: '4px', padding: '6px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  actionBtn: {
    display: 'flex', alignItems: 'center', fontSize: '11px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none', borderRadius: '3px', padding: '3px 8px', cursor: 'pointer',
  } as React.CSSProperties,
  empty: { padding: '16px 12px', fontSize: '12px', opacity: 0.45, textAlign: 'center' as const },
  errorRow: {
    display: 'flex', alignItems: 'flex-start', padding: '4px 8px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
  } as React.CSSProperties,
  connectBox: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
    padding: '20px 12px', textAlign: 'center' as const,
  } as React.CSSProperties,
  connectText: { fontSize: '11px', opacity: 0.6, marginBottom: '8px' } as React.CSSProperties,
  select: {
    fontSize: '11px', padding: '3px 4px', background: 'var(--vscode-dropdown-background)',
    color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-dropdown-border)', borderRadius: '3px',
  } as React.CSSProperties,
};

const row = {
  header: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '5px 8px', cursor: 'pointer', minHeight: '36px',
    borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
  } as React.CSSProperties,
  info: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0 },
  name: { fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 } as React.CSSProperties,
  number: { opacity: 0.45, flexShrink: 0 } as React.CSSProperties,
  nameText: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0, flexShrink: 1,
  } as React.CSSProperties,
  meta: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' } as React.CSSProperties,
  branch: {
    fontSize: '10px', opacity: 0.55, display: 'flex', alignItems: 'center',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  avatarImg: {
    width: '14px', height: '14px', borderRadius: '50%', flexShrink: 0,
  } as React.CSSProperties,
  avatarFallback: {
    width: '14px', height: '14px', borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '7px', fontWeight: 'bold' as const,
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
  } as React.CSSProperties,
};
