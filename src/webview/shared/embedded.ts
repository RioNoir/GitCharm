/**
 * Set by a host bundle that mounts other webview apps as components (the undocked
 * panel), so their entry modules export their App without also mounting it on #root.
 */
type EmbeddedWindow = Window & { __GITCHARM_EMBEDDED__?: boolean };

export function markEmbedded(): void {
  (window as EmbeddedWindow).__GITCHARM_EMBEDDED__ = true;
}

export function isEmbedded(): boolean {
  return (window as EmbeddedWindow).__GITCHARM_EMBEDDED__ === true;
}
