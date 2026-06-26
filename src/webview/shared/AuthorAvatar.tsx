import React, { useState, useEffect, useRef } from 'react';
import { Codicon } from './Codicon';

interface Props {
  authorName: string;
  authorEmail: string;
  size?: number;
  isYou?: boolean;
}

async function gravatarUrl(email: string, size: number): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `https://gravatar.com/avatar/${hash}?s=${size * 2}&d=404`;
}

function githubAvatarUrl(email: string, size: number): string | null {
  if (!email.toLowerCase().endsWith('@users.noreply.github.com')) return null;
  const local = email.split('@')[0] ?? '';
  const username = local.includes('+') ? local.split('+')[1] : local;
  return username ? `https://avatars.githubusercontent.com/${username}?size=${size * 2}` : null;
}

function avatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(p => /^[a-zA-ZÀ-ÿ]/.test(p));
  if (parts.length === 0) return '?';
  if (parts.length === 1) { const w = parts[0] ?? ''; return (w.length > 1 ? w[0] + w[1] : w[0] ?? '?').toUpperCase(); }
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

// Fetches the image as a blob, draws it on an offscreen canvas, and checks
// whether all sampled pixels are nearly identical (blank/default avatar).
function loadImagePixels(url: string, sampleSize = 8): Promise<boolean> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(false); return; }
        ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
        const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);
        const unique = new Set<number>();
        for (let i = 0; i < data.length; i += 4) {
          const r = Math.round((data[i]!)   / 16);
          const g = Math.round((data[i+1]!) / 16);
          const b = Math.round((data[i+2]!) / 16);
          unique.add((r << 8) | (g << 4) | b);
        }
        resolve(unique.size <= 3);
      } catch {
        // Canvas tainted (CORS) — assume not blank
        resolve(false);
      }
    };

    img.onerror = () => resolve(true); // 404 or network error → treat as blank
    img.src = url;
  });
}

async function resolveAvatarUrl(email: string, size: number): Promise<string | null> {
  const github = githubAvatarUrl(email, size);
  if (github) {
    const blank = await loadImagePixels(github);
    return blank ? null : github;
  }

  const gravatar = await gravatarUrl(email, size);
  const blank = await loadImagePixels(gravatar);
  return blank ? null : gravatar;
}

export function AuthorAvatar({ authorName, authorEmail, size = 20, isYou = false }: Props) {
  const [url, setUrl] = useState<string | null | 'loading'>('loading');
  const prevEmailRef = useRef(authorEmail);

  useEffect(() => {
    prevEmailRef.current = authorEmail;
    setUrl('loading');

    let cancelled = false;
    resolveAvatarUrl(authorEmail, size).then(resolved => {
      if (!cancelled) setUrl(resolved);
    });
    return () => { cancelled = true; };
  }, [authorEmail, size]);

  if (isYou) {
    return (
      <div
        style={{
          width: size,
          height: size,
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
        title="You"
      >
        <Codicon name="person" style={{ fontSize: size * 0.6, lineHeight: 1 }} />
      </div>
    );
  }

  const containerStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: size * 0.38,
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none',
    border: '1px solid rgba(128,128,128,0.35)',
    boxSizing: 'border-box' as const,
  };

  if (url === null) {
    return (
      <div
        style={{ ...containerStyle, background: avatarColor(authorEmail), color: '#fff' }}
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
        style={{ ...containerStyle, background: avatarColor(authorEmail), color: '#fff', opacity: 0.4 }}
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
