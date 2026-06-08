import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ChangelistData, RepoStatus } from '../types/git';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../types/git';

const FOLDER_CHANGELISTS_FILE = '.vscode/gitcharm-changelists.json';

interface ChangelistsJson {
  changelists: ChangelistData[];
}

// Shape of a .code-workspace file (only the keys we care about)
interface WorkspaceFileJson {
  folders?: unknown[];
  settings?: Record<string, unknown>;
  extensions?: unknown;
  gitcharm?: { changelists?: ChangelistData[] };
  [key: string]: unknown;
}

function makeDefaultChangelists(): ChangelistData[] {
  return [
    { id: CHANGELIST_DEFAULT_ID, name: 'Changes', fileAssignments: {} },
    { id: CHANGELIST_UNVERSIONED_ID, name: 'Unversioned Files', fileAssignments: {} },
  ];
}

export class ChangelistService {
  private changelists: ChangelistData[];

  /**
   * @param workspaceFolderPath  fsPath of the first workspace folder (always provided)
   * @param workspaceFilePath    fsPath of the .code-workspace file, if the user opened one
   * @param isChangelistMode     whether the current view mode is 'changelists'
   */
  constructor(
    private readonly workspaceFolderPath: string,
    private readonly workspaceFilePath?: string,
    private isChangelistMode: boolean = false,
  ) {
    this.changelists = this.load();
  }

  setChangelistMode(enabled: boolean): void {
    this.isChangelistMode = enabled;
  }

  // ── Storage mode ─────────────────────────────────────────────────────────────

  private get isWorkspaceFile(): boolean {
    return !!this.workspaceFilePath;
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private get folderFilePath(): string {
    return path.join(this.workspaceFolderPath, FOLDER_CHANGELISTS_FILE);
  }

  private load(): ChangelistData[] {
    try {
      if (this.isWorkspaceFile) {
        return this.loadFromWorkspaceFile();
      }
      return this.loadFromFolderFile();
    } catch {
      return makeDefaultChangelists();
    }
  }

  private loadFromFolderFile(): ChangelistData[] {
    const raw = fs.readFileSync(this.folderFilePath, 'utf8');
    const parsed = JSON.parse(raw) as ChangelistsJson;
    return this.ensureFixedChangelists(parsed.changelists ?? []);
  }

  private loadFromWorkspaceFile(): ChangelistData[] {
    const raw = fs.readFileSync(this.workspaceFilePath!, 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceFileJson;
    return this.ensureFixedChangelists(parsed.gitcharm?.changelists ?? []);
  }

  private ensureFixedChangelists(data: ChangelistData[]): ChangelistData[] {
    if (!data.find(c => c.id === CHANGELIST_DEFAULT_ID)) {
      data.unshift({ id: CHANGELIST_DEFAULT_ID, name: 'Changes', fileAssignments: {} });
    }
    if (!data.find(c => c.id === CHANGELIST_UNVERSIONED_ID)) {
      const idx = data.findIndex(c => c.id === CHANGELIST_DEFAULT_ID);
      data.splice(idx + 1, 0, { id: CHANGELIST_UNVERSIONED_ID, name: 'Unversioned Files', fileAssignments: {} });
    }
    return data;
  }

  private save(): void {
    try {
      if (this.isWorkspaceFile) {
        this.saveToWorkspaceFile();
      } else {
        this.saveToFolderFile();
      }
    } catch {
      // Non-critical — silently fail
    }
  }

  private saveToFolderFile(): void {
    if (!this.isChangelistMode) return;
    const dir = path.dirname(this.folderFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.folderFilePath, JSON.stringify({ changelists: this.changelists }, null, 2), 'utf8');
    this.ensureGlobalGitignore();
  }

  private saveToWorkspaceFile(): void {
    const raw = fs.readFileSync(this.workspaceFilePath!, 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceFileJson;
    parsed.gitcharm = { ...parsed.gitcharm, changelists: this.changelists };
    fs.writeFileSync(this.workspaceFilePath!, JSON.stringify(parsed, null, '\t'), 'utf8');
  }

  private ensureGlobalGitignore(): void {
    try {
      const entry = '.vscode/gitcharm-changelists.json';
      const globalIgnorePath = this.getGlobalGitignorePath();
      if (fs.existsSync(globalIgnorePath)) {
        const content = fs.readFileSync(globalIgnorePath, 'utf8');
        if (content.includes(entry)) return;
        const newContent = content.endsWith('\n') ? content + entry + '\n' : content + '\n' + entry + '\n';
        fs.writeFileSync(globalIgnorePath, newContent, 'utf8');
      } else {
        fs.writeFileSync(globalIgnorePath, entry + '\n', 'utf8');
      }
    } catch {
      // Non-critical
    }
  }

  private getGlobalGitignorePath(): string {
    try {
      const result = execSync('git config --global core.excludesFile', { encoding: 'utf8' }).trim();
      if (result) return result.startsWith('~') ? path.join(os.homedir(), result.slice(1)) : result;
    } catch { /* fall through */ }
    // Default path when core.excludesFile is not set
    return path.join(os.homedir(), '.gitignore_global');
  }

  // ── Reconciliation ───────────────────────────────────────────────────────────

  /**
   * Reconcile changelists against current git status.
   * - Removes assignments for files that no longer exist in the repo status.
   * - New staged/modified files (not untracked) → assigned to "Changes" if unassigned.
   * - New untracked files → assigned to "Unversioned Files" if unassigned.
   */
  reconcile(repos: RepoStatus[]): void {
    // Tracked files only (staged + non-untracked unstaged).
    // Unversioned Files (untracked) are always computed live from git status in the view layer
    // and are never persisted in fileAssignments.
    const trackedFiles = new Map<string, Set<string>>();
    for (const r of repos) {
      const tracked = new Set<string>();
      for (const f of r.stagedFiles) tracked.add(f.path);
      for (const f of r.unstagedFiles) {
        if (f.status !== 'untracked') tracked.add(f.path);
      }
      trackedFiles.set(r.repoId, tracked);
    }

    // Clear any stale unversioned assignments (legacy data migration)
    const untrackedCl = this.changelists.find(c => c.id === CHANGELIST_UNVERSIONED_ID);
    if (untrackedCl) untrackedCl.fileAssignments = {};

    // Build reverse map: repoId+path → changelistId (excluding unversioned)
    const assigned = new Map<string, string>();
    for (const cl of this.changelists) {
      if (cl.id === CHANGELIST_UNVERSIONED_ID) continue;
      for (const [repoId, paths] of Object.entries(cl.fileAssignments)) {
        for (const p of paths) assigned.set(`${repoId}::${p}`, cl.id);
      }
    }

    // Prune stale assignments and assign new tracked files to "Changes"
    const defaultCl = this.changelists.find(c => c.id === CHANGELIST_DEFAULT_ID)!;
    for (const cl of this.changelists) {
      if (cl.id === CHANGELIST_UNVERSIONED_ID) continue;
      for (const repoId of Object.keys(cl.fileAssignments)) {
        const repoTracked = trackedFiles.get(repoId);
        if (!repoTracked) { delete cl.fileAssignments[repoId]; continue; }
        cl.fileAssignments[repoId] = cl.fileAssignments[repoId].filter(p => repoTracked.has(p));
        if (cl.fileAssignments[repoId].length === 0) delete cl.fileAssignments[repoId];
      }
    }

    for (const r of repos) {
      const repoId = r.repoId;
      for (const filePath of trackedFiles.get(repoId) ?? []) {
        if (assigned.has(`${repoId}::${filePath}`)) continue;
        if (!defaultCl.fileAssignments[repoId]) defaultCl.fileAssignments[repoId] = [];
        defaultCl.fileAssignments[repoId].push(filePath);
        assigned.set(`${repoId}::${filePath}`, CHANGELIST_DEFAULT_ID);
      }
    }

    this.save();
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  getAll(): ChangelistData[] {
    const unversioned = this.changelists.find(c => c.id === CHANGELIST_UNVERSIONED_ID);
    if (!unversioned || this.changelists[this.changelists.length - 1]?.id === CHANGELIST_UNVERSIONED_ID) {
      return this.changelists;
    }
    return [
      ...this.changelists.filter(c => c.id !== CHANGELIST_UNVERSIONED_ID),
      unversioned,
    ];
  }

  create(name: string): ChangelistData {
    const id = `cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const cl: ChangelistData = { id, name, fileAssignments: {} };
    this.changelists.push(cl);
    this.save();
    return cl;
  }

  rename(id: string, name: string): void {
    if (id === CHANGELIST_DEFAULT_ID || id === CHANGELIST_UNVERSIONED_ID) return;
    const cl = this.changelists.find(c => c.id === id);
    if (cl) { cl.name = name; this.save(); }
  }

  delete(id: string): void {
    if (id === CHANGELIST_DEFAULT_ID || id === CHANGELIST_UNVERSIONED_ID) return;
    const cl = this.changelists.find(c => c.id === id);
    if (!cl) return;

    // Move files back to default changelist
    const defaultCl = this.changelists.find(c => c.id === CHANGELIST_DEFAULT_ID)!;
    for (const [repoId, paths] of Object.entries(cl.fileAssignments)) {
      if (!defaultCl.fileAssignments[repoId]) defaultCl.fileAssignments[repoId] = [];
      defaultCl.fileAssignments[repoId].push(...paths);
    }

    this.changelists = this.changelists.filter(c => c.id !== id);
    this.save();
  }

  moveFiles(assignments: Array<{ repoId: string; path: string; changelistId: string }>): void {
    // Remove files from all changelists first
    for (const { repoId, path: filePath } of assignments) {
      for (const cl of this.changelists) {
        if (cl.fileAssignments[repoId]) {
          cl.fileAssignments[repoId] = cl.fileAssignments[repoId].filter(p => p !== filePath);
          if (cl.fileAssignments[repoId].length === 0) delete cl.fileAssignments[repoId];
        }
      }
    }
    // Assign to target changelists
    for (const { repoId, path: filePath, changelistId } of assignments) {
      const target = this.changelists.find(c => c.id === changelistId);
      if (!target) continue;
      if (!target.fileAssignments[repoId]) target.fileAssignments[repoId] = [];
      if (!target.fileAssignments[repoId].includes(filePath)) {
        target.fileAssignments[repoId].push(filePath);
      }
    }
    this.save();
  }
}
