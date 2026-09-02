import * as vscode from 'vscode';

/** Where the GitCharm Log opens by default when triggered by command or keybinding. */
export const GIT_LOG_LOCATIONS = ['panel', 'editorTab', 'newWindow'] as const;
export type GitLogLocation = (typeof GIT_LOG_LOCATIONS)[number];

/** Which sub-apps the undocked GitCharm Log shows. Ignored when the location is 'panel'. */
export const GIT_LOG_LAYOUTS = ['logAndCommit', 'logOnly'] as const;
export type GitLogLayout = (typeof GIT_LOG_LAYOUTS)[number];

export const DEFAULT_GIT_LOG_LOCATION: GitLogLocation = 'panel';
export const DEFAULT_GIT_LOG_LAYOUT: GitLogLayout = 'logAndCommit';

const CONFIG_SECTION = 'gitcharm';
const LOCATION_KEY = 'gitLogDefaultLocation';
const LAYOUT_KEY = 'gitLogDefaultLayout';

function isLocation(value: unknown): value is GitLogLocation {
  return typeof value === 'string' && (GIT_LOG_LOCATIONS as readonly string[]).includes(value);
}

function isLayout(value: unknown): value is GitLogLayout {
  return typeof value === 'string' && (GIT_LOG_LAYOUTS as readonly string[]).includes(value);
}

export function getGitLogDefaultLocation(): GitLogLocation {
  const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(LOCATION_KEY, DEFAULT_GIT_LOG_LOCATION);
  return isLocation(raw) ? raw : DEFAULT_GIT_LOG_LOCATION;
}

export function getGitLogDefaultLayout(): GitLogLayout {
  const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(LAYOUT_KEY, DEFAULT_GIT_LOG_LAYOUT);
  return isLayout(raw) ? raw : DEFAULT_GIT_LOG_LAYOUT;
}

/**
 * Persist the default location. Writes to the workspace when the key is already
 * overridden there, otherwise to user settings so the choice follows the user.
 */
export async function setGitLogDefault(location: GitLogLocation, layout: GitLogLayout): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const hasWorkspaceOverride =
    cfg.inspect(LOCATION_KEY)?.workspaceValue !== undefined ||
    cfg.inspect(LAYOUT_KEY)?.workspaceValue !== undefined;
  const target = hasWorkspaceOverride ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg.update(LOCATION_KEY, location, target);
  await cfg.update(LAYOUT_KEY, layout, target);
}

/** True when the default location puts the Log outside the bottom panel. */
export function isGitLogDefaultUndocked(): boolean {
  return getGitLogDefaultLocation() !== 'panel';
}

/**
 * Mirror the default location into the `gitcharm.gitLogDefaultUndocked` context
 * key, which package.json uses to hide the bottom-panel Git Log view when the
 * Log lives in an editor tab or its own window. Call this as early as possible
 * in activation, before VS Code evaluates the view's `when` clause.
 */
export function syncGitLogLocationContext(): void {
  void vscode.commands.executeCommand('setContext', 'gitcharm.gitLogDefaultUndocked', isGitLogDefaultUndocked());
}

/** Keep the context key in sync when the setting changes from the Settings UI. */
export function watchGitLogLocationContext(onChange?: (undocked: boolean) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (!e.affectsConfiguration(`${CONFIG_SECTION}.${LOCATION_KEY}`)) return;
    syncGitLogLocationContext();
    onChange?.(isGitLogDefaultUndocked());
  });
}
