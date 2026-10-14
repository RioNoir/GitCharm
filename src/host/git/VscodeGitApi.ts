import * as vscode from 'vscode';
import type { API, GitExtension, Repository } from './git.d';

let _api: API | undefined;

function getApi(): API | undefined {
  if (_api) return _api;
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  const gitExt = ext.isActive ? ext.exports : undefined;
  if (!gitExt) return undefined;
  _api = gitExt.getAPI(1);
  return _api;
}

export function getVscodeGitApi(): API | undefined {
  return getApi();
}

export function getVscodeRepository(rootPath: string): Repository | undefined {
  const api = getApi();
  if (!api) return undefined;
  const repo = api.getRepository(vscode.Uri.file(rootPath));
  if (!repo) return undefined;
  // Only use this repository if its root exactly matches the requested path.
  // api.getRepository() returns the nearest ancestor repo, which may be the
  // parent repo when querying a submodule path — causing operations to run
  // against the wrong repository.
  const repoRoot = repo.rootUri.fsPath.replace(/[/\\]+$/, '');
  const requested = rootPath.replace(/[/\\]+$/, '');
  return repoRoot === requested ? repo : undefined;
}

/**
 * Like getVscodeRepository, but asks VS Code's git extension to open the repository when
 * it doesn't know it yet — e.g. a repo created with `git init` after startup, or one deeper
 * than git.repositoryScanMaxDepth that GitCharm found on its own. Network operations go
 * through it so they get VS Code's credentials (askpass, GitHub sign-in).
 */
export async function getOrOpenVscodeRepository(rootPath: string): Promise<Repository | undefined> {
  const known = getVscodeRepository(rootPath);
  if (known) return known;
  const api = getApi();
  if (!api) return undefined;
  try {
    await api.openRepository(vscode.Uri.file(rootPath));
  } catch {
    return undefined;
  }
  return getVscodeRepository(rootPath);
}
