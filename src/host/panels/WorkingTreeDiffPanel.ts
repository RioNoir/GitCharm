import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { openWorkingTreeFileChanges, workingTreeChangesTitle, workingTreeFileDiff } from './CompareWithCommand';
import { showGitError } from '../utils/gitErrorUtils';

export interface BranchDiffFile { path: string; status: string; oldPath?: string }
export interface BranchDiffGroup { repoId: string; ref: string; files: BranchDiffFile[] }

/** Changed files per repository. `null` when a repository could not be read (already reported). */
export async function loadBranchDiffGroups(
  manager: WorkspaceGitManager,
  refs: { repoId: string; ref: string }[],
): Promise<BranchDiffGroup[] | null> {
  const groups: BranchDiffGroup[] = [];
  let failed = false;
  const seen = new Set<string>();
  for (const target of refs) {
    if (seen.has(target.repoId)) continue;
    seen.add(target.repoId);
    const repo = manager.getRepo(target.repoId);
    if (!repo) {
      failed = true;
      vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
      continue;
    }
    try {
      await repo.resolveRef(target.ref);
      const files = (await repo.getRefVsWorkingTreeFiles(target.ref, '')).filter(file => file.status !== 'U');
      if (files.length > 0) groups.push({ repoId: target.repoId, ref: target.ref, files });
    } catch (e: unknown) {
      failed = true;
      showGitError('diffWithWorkingTree', e);
    }
  }
  if (groups.length === 0 && failed) return null;
  return groups;
}

export async function showBranchFileDiff(
  manager: WorkspaceGitManager,
  file: { repoId: string; ref: string; filePath: string; status: string; oldPath?: string },
): Promise<void> {
  const repo = manager.getRepo(file.repoId);
  if (!repo) {
    vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
    return;
  }
  await enqueue(async () => {
    try {
      await openReplacingFileDiff(repo, file.filePath, file.ref, file);
    } catch (e: unknown) {
      showGitError('diffWithWorkingTree', e);
    }
  });
}

export async function showBranchDirDiff(
  manager: WorkspaceGitManager,
  dir: { repoId: string; ref: string; dirPath: string; files: BranchDiffFile[] },
  titleLabel: string,
): Promise<void> {
  const repo = manager.getRepo(dir.repoId);
  if (!repo) {
    vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
    return;
  }
  try {
    if (dir.files.length === 1) {
      const file = dir.files[0];
      await enqueue(() => openReplacingFileDiff(repo, file.path, dir.ref, file));
      return;
    }
    const title = workingTreeChangesTitle(dir.dirPath, titleLabel || dir.ref);
    const before = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
    await openWorkingTreeFileChanges(repo, dir.ref, dir.files, title);
    const added = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !before.has(tab));
    openChanges = { dirPath: dir.dirPath, label: added[0]?.label ?? title };
  } catch (e: unknown) {
    showGitError('diffWithWorkingTree', e);
  }
}

/** Asks, then makes the working tree match the branch for these files. Returns whether it ran. */
export async function takeBranchFiles(
  manager: WorkspaceGitManager,
  target: { repoId: string; ref: string; label: string; files: BranchDiffFile[]; targetPath: string; changesTitle?: string },
): Promise<boolean> {
  const repo = manager.getRepo(target.repoId);
  if (!repo) {
    vscode.window.showErrorMessage(vscode.l10n.t('Repository not found.'));
    return false;
  }
  if (target.files.length === 0) return false;
  const replace = vscode.l10n.t('Get from Branch');
  const prompt = target.files.length === 1
    ? vscode.l10n.t('Update "{0}" to match "{1}"? Changes to this file in the working tree will be lost.', target.files[0].path, target.label)
    : vscode.l10n.t('Update {0} files under "{1}" to match "{2}"? Changes to these files in the working tree will be lost.', target.files.length, target.targetPath, target.label);
  const choice = await vscode.window.showWarningMessage(prompt, { modal: true }, replace);
  if (choice !== replace) return false;
  try {
    const paths = target.files.flatMap(file => file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path]);
    await repo.takePathsFromRef(target.ref, paths);
    await enqueue(() => closeDiffTabs(repo, target.ref, target.files, target.changesTitle, target.changesTitle ? target.targetPath : undefined));
    return true;
  } catch (e: unknown) {
    showGitError('diffWithWorkingTree', e);
    return false;
  }
}

/** The one working-tree file diff this view opened. The next file replaces it. */
let openFileDiff: { tab: vscode.Tab; root: string; filePath: string; original: string; modified: string } | null = null;
/** Directory diff last opened from this view, so Get from Branch can close that tab. */
let openChanges: { dirPath: string; label: string } | null = null;
let tail: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = tail.then(task, task);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

function endKey(uri: vscode.Uri): string {
  return `${uri.scheme}\0${uri.path}\0${uri.query}`;
}

function tabsWithEnds(original: string, modified: string): vscode.Tab[] {
  const found: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && endKey(input.original) === original && endKey(input.modified) === modified) {
        found.push(tab);
      }
    }
  }
  return found;
}

function tabsWithLabel(label: string): vscode.Tab[] {
  const found: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.label === label) found.push(tab);
    }
  }
  return found;
}

function isOpen(tab: vscode.Tab): boolean {
  return vscode.window.tabGroups.all.some(group => group.tabs.includes(tab));
}

async function closeTabs(tabs: vscode.Tab[]): Promise<void> {
  const unique: vscode.Tab[] = [];
  const seen = new Set<vscode.Tab>();
  for (const tab of tabs) {
    if (seen.has(tab) || !isOpen(tab)) continue;
    seen.add(tab);
    unique.push(tab);
  }
  if (unique.length === 0) return;
  await vscode.window.tabGroups.close(unique, true);
}

function diffTabs(): vscode.Tab[] {
  const found: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff) found.push(tab);
    }
  }
  return found;
}

/** Opens this file's diff in the editor tab already used for the working-tree comparison. */
async function openReplacingFileDiff(
  repo: GitService,
  filePath: string,
  ref: string,
  file: { status?: string; oldPath?: string },
): Promise<void> {
  if (openFileDiff && openFileDiff.root === repo.rootPath && openFileDiff.filePath === filePath && isOpen(openFileDiff.tab)) return;
  // Close the previous file first. Closing after vscode.diff also closes the tab just opened:
  // a preview editor reuses the same tab, so the new diff matches the close set and disappears.
  if (openFileDiff) {
    const previous = openFileDiff;
    openFileDiff = null;
    await closeTabs([previous.tab, ...tabsWithEnds(previous.original, previous.modified)]);
  }
  const diff = workingTreeFileDiff(repo, filePath, ref, file);
  const before = new Set(diffTabs());
  await vscode.commands.executeCommand('vscode.diff', diff.original, diff.modified, diff.title, { preview: true });
  const added = diffTabs().filter(tab => !before.has(tab));
  const titled = tabsWithLabel(diff.title).filter(tab => tab.input instanceof vscode.TabInputTextDiff);
  const matched = tabsWithEnds(endKey(diff.original), endKey(diff.modified));
  const tab = added[added.length - 1] ?? titled[titled.length - 1] ?? matched[matched.length - 1];
  if (tab?.input instanceof vscode.TabInputTextDiff) {
    openFileDiff = {
      tab,
      root: repo.rootPath,
      filePath,
      original: endKey(tab.input.original),
      modified: endKey(tab.input.modified),
    };
  }
}

/** Closes editor tabs that still show a diff for files just taken from the branch. */
async function closeDiffTabs(
  repo: GitService,
  ref: string,
  files: BranchDiffFile[],
  changesTitle?: string,
  dirPath?: string,
): Promise<void> {
  const tabs: vscode.Tab[] = [];
  const taken = new Set(files.flatMap(file => file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path]));
  for (const file of files) {
    const diff = workingTreeFileDiff(repo, file.path, ref, file);
    tabs.push(...tabsWithEnds(endKey(diff.original), endKey(diff.modified)));
  }
  if (openFileDiff && openFileDiff.root === repo.rootPath && taken.has(openFileDiff.filePath)) {
    tabs.push(openFileDiff.tab);
  }
  if (changesTitle) tabs.push(...tabsWithLabel(changesTitle));
  if (changesTitle && openChanges && dirPath === openChanges.dirPath) tabs.push(...tabsWithLabel(openChanges.label));
  await closeTabs(tabs);
  if (openFileDiff && !isOpen(openFileDiff.tab)) openFileDiff = null;
  if (openChanges && dirPath === openChanges.dirPath) openChanges = null;
}
