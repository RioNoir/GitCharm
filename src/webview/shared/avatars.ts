/**
 * Author avatars are opt-in (`gitcharm.avatars.enabled`, default off): resolving one sends a
 * hash of the author's email to gravatar.com, which can be reversed back to the address.
 * The host injects the flag into every webview's HTML; when it is off, no avatar image is
 * requested and callers fall back to initials.
 */
export const avatarsEnabled: boolean =
  (window as unknown as { __GITCHARM_AVATARS__?: boolean }).__GITCHARM_AVATARS__ === true;
