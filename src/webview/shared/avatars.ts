/**
 * Author avatars are opt-in (`gitcharm.avatars.enabled`, default off): resolving one sends a
 * hash of the author's email to gravatar.com, which can be reversed back to the address.
 * The host injects the flag into every webview's HTML; when it is off, no avatar image is
 * requested and callers fall back to initials.
 */
export const avatarsEnabled: boolean =
  (window as unknown as { __GITCHARM_AVATARS__?: boolean }).__GITCHARM_AVATARS__ === true;

/**
 * Stable background color for an initials avatar. Keyed by name rather than email because forges report
 * PR authors, reviewers and commenters by name only; case-insensitive so "RioNoir" and "rionoir" match.
 */
export function avatarColor(name: string): string {
  const seed = name.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

/**
 * Font size for initials inside a circle of `size` px. With `lineHeight: 1` the text is centred at
 * (size - fontSize) / 2, so the font is a whole pixel with the same parity as the circle: otherwise the
 * baseline lands on a fractional pixel, the renderer snaps it, and the letters sit visibly off-centre.
 * Pair it with `lineHeight: 1` and `fontWeight: 600`, as AuthorAvatar does.
 */
export function initialsFontSize(size: number): number {
  const rounded = Math.round(size * 0.38);
  return (size - rounded) % 2 === 0 ? rounded : rounded - 1;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/).filter(p => /^[a-zA-ZÀ-ÿ]/.test(p));
  // Usernames such as "42bot" have no word starting with a letter: use their first characters.
  if (parts.length === 0) return trimmed ? trimmed.slice(0, 2).toUpperCase() : '?';
  if (parts.length === 1) { const w = parts[0] ?? ''; return (w.length > 1 ? w[0] + w[1] : w[0] ?? '?').toUpperCase(); }
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}
