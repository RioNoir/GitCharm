import React, { useState, useEffect } from 'react';
import { Codicon } from './Codicon';
import { avatarsEnabled, avatarColor, initials, initialsFontSize, resolveAuthorAvatar } from './avatars';
import * as l10n from '@vscode/l10n';

interface Props {
  authorName: string;
  authorEmail: string;
  size?: number;
  isYou?: boolean;
  /** The repository the commit is in: the host asks its forge for the author first. */
  repoId?: string;
  /** The commit, when it's on the forge (pushed) — some forges match authors by commit. */
  sha?: string;
}

export function AuthorAvatar({ authorName, authorEmail, size = 20, isYou = false, repoId, sha }: Props) {
  const [url, setUrl] = useState<string | null | 'loading'>(avatarsEnabled ? 'loading' : null);

  useEffect(() => {
    // With avatars off, stay on initials and make no request.
    if (!avatarsEnabled) return;
    setUrl('loading');

    let cancelled = false;
    resolveAuthorAvatar(authorEmail, repoId, sha).then(resolved => {
      if (!cancelled) setUrl(resolved);
    });
    return () => { cancelled = true; };
  }, [authorEmail, repoId, sha]);

  if (isYou) {
    return (
      <div
        style={{
          width: size,
          height: size,
          minWidth: size,
          minHeight: size,
          borderRadius: '50%',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--vscode-badge-background)',
          color: 'var(--vscode-badge-foreground)',
          border: '1px solid rgba(128,128,128,0.35)',
          boxSizing: 'border-box' as const,
        }}
        title={l10n.t({ message: 'You', comment: ['Tooltip on the avatar of the current user'] })}
      >
        <Codicon name="person" style={{ fontSize: size * 0.6, lineHeight: 1 }} />
      </div>
    );
  }

  const containerStyle: React.CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
    borderRadius: '50%',
    flexShrink: 0,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: initialsFontSize(size),
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none',
    border: '1px solid rgba(128,128,128,0.35)',
    boxSizing: 'border-box' as const,
  };

  if (url === null) {
    return (
      <div
        style={{ ...containerStyle, background: avatarColor(authorName), color: '#fff' }}
        title={`${authorName} <${authorEmail}>`}
      >
        {initials(authorName)}
      </div>
    );
  }

  if (url === 'loading') {
    // Show initials as placeholder while fetching
    return (
      <div
        style={{ ...containerStyle, background: avatarColor(authorName), color: '#fff', opacity: 0.4 }}
        title={`${authorName} <${authorEmail}>`}
      >
        {initials(authorName)}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={authorName}
      title={`${authorName} <${authorEmail}>`}
      width={size}
      height={size}
      style={{ ...containerStyle, objectFit: 'cover' }}
      onError={() => setUrl(null)}
    />
  );
}
