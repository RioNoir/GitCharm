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
