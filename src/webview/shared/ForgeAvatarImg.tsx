import React from 'react';
import { useForgeAvatarUrl } from './avatars';

/**
 * An avatar from a forge's API (a PR author, reviewer, commenter…): the image once the host has checked its URL
 * may be shown, `fallback` (initials, an icon) until then and when it may not. See useForgeAvatarUrl.
 */
export function ForgeAvatarImg({ url, fallback, ...img }: { url: string | undefined; fallback: React.ReactNode } & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const checked = useForgeAvatarUrl(url);
  const [failed, setFailed] = React.useState(false);
  if (!checked || failed) return <>{fallback}</>;
  return <img {...img} src={checked} onError={() => setFailed(true)} />;
}
