import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/** Creates the shared output channel. Call once from activate(). */
export function initLogger(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel('GitCharm', { log: true });
  context.subscriptions.push(channel);
  return channel;
}

/** The shared output channel, for callers that need direct access (e.g. GitProfileService). */
export function getLogChannel(): vscode.LogOutputChannel | undefined {
  return channel;
}

export function showLogChannel(): void {
  channel?.show(true);
}

// Debug-level messages are hidden by the Output panel unless the user raises this
// channel's log level manually — use for high-frequency internal diagnostics that would
// otherwise flood the default view (e.g. profile resolution on every status refresh).
export function logDebug(context: string, message: string, detail?: string): void {
  channel?.debug(context ? `[${context}] ${message}` : message);
  if (detail?.trim()) channel?.debug(detail.trim());
}

export function logInfo(context: string, message: string, detail?: string): void {
  channel?.info(context ? `[${context}] ${message}` : message);
  if (detail?.trim()) channel?.info(detail.trim());
}

export function logWarn(context: string, message: string, detail?: string): void {
  channel?.warn(context ? `[${context}] ${message}` : message);
  if (detail?.trim()) channel?.warn(detail.trim());
}

export function logError(context: string, message: string, detail?: string): void {
  channel?.error(context ? `[${context}] ${message}` : message);
  if (detail?.trim()) channel?.error(detail.trim());
}
