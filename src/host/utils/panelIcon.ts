import * as vscode from 'vscode';

/**
 * Light/dark SVG pair from media/icons for a webview panel's tab icon.
 *
 * WebviewPanel.iconPath only accepts a ThemeIcon since VS Code 1.108; the extension still
 * supports 1.93, so tab icons ship as `<name>-light.svg` / `<name>-dark.svg` copies of the codicons.
 */
export function panelIcon(extensionUri: vscode.Uri, name: string): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${name}-light.svg`),
    dark:  vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${name}-dark.svg`),
  };
}
