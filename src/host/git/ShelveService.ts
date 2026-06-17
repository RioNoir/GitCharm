import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import simpleGit, { SimpleGit } from 'simple-git';
import type { ShelveEntry } from '../types/messages';

type ChangelistAssignment = NonNullable<ShelveEntry['changelistAssignments']>[number];

const META_FILE = 'shelves.json';

interface BinaryFile {
  repoRelPath: string;   // path relative to repo root
  storeName: string;     // filename inside shelfDir
}

interface ShelfMeta {
  shelves: ShelveEntry[];
}

// Extended entry stored only internally (not in messages.ts)
interface ShelveEntryInternal extends ShelveEntry {
  binaryFiles?: BinaryFile[];
  // changelistAssignments is inherited from ShelveEntry and persisted
}

interface ShelfMetaInternal {
  shelves: ShelveEntryInternal[];
}

export class ShelveService {
  private git: SimpleGit;
  private shelfDir: string;
  private metaPath: string;

  constructor(public readonly rootPath: string, globalStorage: string) {
    this.git = simpleGit(rootPath);
    const repoHash = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
    this.shelfDir = path.join(globalStorage, 'shelves', repoHash);
    this.metaPath = path.join(this.shelfDir, META_FILE);
  }

  private ensureShelfDir(): void {
    if (!fs.existsSync(this.shelfDir)) {
      fs.mkdirSync(this.shelfDir, { recursive: true });
    }
  }

  private readMeta(): ShelfMetaInternal {
    try {
      if (fs.existsSync(this.metaPath)) {
        return JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) as ShelfMetaInternal;
      }
    } catch { /* corrupt meta → start fresh */ }
    return { shelves: [] };
  }

  private writeMeta(meta: ShelfMetaInternal): void {
    this.ensureShelfDir();
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');
  }

  async list(): Promise<ShelveEntry[]> {
    const meta = this.readMeta();
    const valid = meta.shelves.filter(s => fs.existsSync(path.join(this.shelfDir, s.patchFile)));
    if (valid.length !== meta.shelves.length) this.writeMeta({ shelves: valid });
    // Strip internal fields before returning to webview
    return valid.map(({ binaryFiles: _b, ...rest }) => rest);
  }

  /** Returns true if a file is binary by checking for null bytes in the first 8 KB. */
  private isBinary(absPath: string): boolean {
    try {
      const buf = Buffer.alloc(8192);
      const fd = fs.openSync(absPath, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      return buf.slice(0, bytesRead).includes(0);
    } catch {
      return false;
    }
  }

  async push(name: string, paths?: string[], changelistAssignments?: ChangelistAssignment[]): Promise<ShelveEntry> {
    this.ensureShelfDir();

    const statusOutput = await this.git.status();
    const allChanged = [...new Set([
      ...statusOutput.modified,
      ...statusOutput.created,
      ...statusOutput.deleted,
      ...statusOutput.renamed.map(r => r.to),
      ...statusOutput.not_added,
    ])];

    const filesToShelve = paths
      ? allChanged.filter(f => paths.includes(f))
      : allChanged;

    if (filesToShelve.length === 0) throw new Error('No changes to shelve');

    const trackedFiles = filesToShelve.filter(f => !statusOutput.not_added.includes(f));
    const untrackedFiles = filesToShelve.filter(f => statusOutput.not_added.includes(f));

    const id = `shelf-${Date.now()}`;
    const binaryFiles: BinaryFile[] = [];

    // ── Tracked files: use git diff HEAD --binary ─────────────────────────────
    // --binary produces a complete patch including binary deltas that git apply
    // can reconstruct, with the full index line required for binary files.
    let combinedDiff = '';
    if (trackedFiles.length > 0) {
      combinedDiff = await this.git.raw(['diff', 'HEAD', '--binary', '--', ...trackedFiles]).catch(() => '');
    }

    // ── Untracked files ───────────────────────────────────────────────────────
    // Text files: synthetic new-file diff.
    // Binary files: copy them physically into the shelf dir.
    for (const f of untrackedFiles) {
      const absPath = path.join(this.rootPath, f);
      if (this.isBinary(absPath)) {
        // Store a raw copy alongside the patch
        const storeName = `${id}-${crypto.createHash('sha1').update(f).digest('hex').slice(0, 8)}${path.extname(f)}`;
        try {
          fs.copyFileSync(absPath, path.join(this.shelfDir, storeName));
          binaryFiles.push({ repoRelPath: f, storeName });
        } catch { /* skip unreadable */ }
      } else {
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          const lines = content.split('\n');
          const addedLines = lines.map(l => '+' + l).join('\n');
          combinedDiff += `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${addedLines}\n`;
        } catch { /* skip unreadable */ }
      }
    }

    if (!combinedDiff.trim() && binaryFiles.length === 0) {
      throw new Error('Nothing to shelve (diff is empty)');
    }

    // ── Write patch file ──────────────────────────────────────────────────────
    const patchFileName = `${id}.patch`;
    fs.writeFileSync(path.join(this.shelfDir, patchFileName), combinedDiff, 'utf8');

    // ── Build file list with status and stats ─────────────────────────────────
    const statusMap: Record<string, string> = {};
    for (const f of statusOutput.modified) statusMap[f] = 'modified';
    for (const f of statusOutput.created) statusMap[f] = 'added';
    for (const f of statusOutput.deleted) statusMap[f] = 'deleted';
    for (const r of statusOutput.renamed) statusMap[r.to] = 'renamed';
    for (const f of statusOutput.not_added) statusMap[f] = 'untracked';

    const numstatMap = new Map<string, { added: number; removed: number }>();
    try {
      const numstatArgs = trackedFiles.length > 0 ? ['diff', 'HEAD', '--numstat', '--', ...trackedFiles] : [];
      if (numstatArgs.length > 0) {
        const numstatRaw = await this.git.raw(numstatArgs).catch(() => '');
        for (const line of numstatRaw.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length < 3) continue;
          const a = parseInt(parts[0], 10), r = parseInt(parts[1], 10);
          if (!isNaN(a) && !isNaN(r)) numstatMap.set(parts[2].trim(), { added: a, removed: r });
        }
      }
    } catch { /* stats optional */ }

    // untracked files: count lines as additions
    for (const f of untrackedFiles) {
      try {
        const content = require('fs').readFileSync(require('path').join(this.rootPath, f), 'utf8') as string;
        numstatMap.set(f, { added: content.split('\n').length, removed: 0 });
      } catch { /* skip */ }
    }

    const fileList: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
    for (const f of filesToShelve) {
      const s = numstatMap.get(f);
      fileList.push({ path: f, status: statusMap[f] ?? 'modified', ...(s ? { added: s.added, removed: s.removed } : {}) });
    }
    const totalAdded   = fileList.reduce((sum, f) => sum + (f.added   ?? 0), 0);
    const totalRemoved = fileList.reduce((sum, f) => sum + (f.removed ?? 0), 0);

    const entry: ShelveEntryInternal = {
      id,
      name,
      date: new Date().toISOString(),
      files: fileList,
      patchFile: patchFileName,
      totalAdded:   totalAdded   > 0 ? totalAdded   : undefined,
      totalRemoved: totalRemoved > 0 ? totalRemoved : undefined,
      binaryFiles: binaryFiles.length > 0 ? binaryFiles : undefined,
      changelistAssignments: changelistAssignments && changelistAssignments.length > 0 ? changelistAssignments : undefined,
    };

    const meta = this.readMeta();
    meta.shelves.unshift(entry);
    this.writeMeta(meta);

    // ── Revert shelved files ──────────────────────────────────────────────────
    for (const f of trackedFiles) {
      // git restore --staged --worktree restores both index and working tree from HEAD.
      // For deleted files (staged or unstaged) this recreates the file.
      const ok = await this.git.raw(['restore', '--staged', '--worktree', '--', f]).then(() => true).catch(() => false);
      if (!ok) {
        // Older git: restore staged first (index ← HEAD), then worktree (file ← index)
        await this.git.raw(['restore', '--staged', '--', f]).catch(() => {});
        await this.git.raw(['restore', '--', f]).catch(() => {});
      }
    }
    for (const f of untrackedFiles) {
      const abs = path.join(this.rootPath, f);
      try { fs.unlinkSync(abs); } catch { /* already gone */ }
    }

    return entry;
  }

  async apply(shelveId: string, paths?: string[]): Promise<ChangelistAssignment[] | undefined> {
    const meta = this.readMeta();
    const entry = meta.shelves.find(s => s.id === shelveId);
    if (!entry) throw new Error(`Shelve "${shelveId}" not found`);

    const patchAbs = path.join(this.shelfDir, entry.patchFile);
    if (!fs.existsSync(patchAbs)) throw new Error('Patch file not found on disk');

    // ── Apply text/binary patch ───────────────────────────────────────────────
    const fullPatch = fs.readFileSync(patchAbs, 'utf8');

    // When applying a subset of files, extract only their chunks into a temp patch.
    let applyAbs = patchAbs;
    let tmpPath: string | undefined;
    if (paths && paths.length > 0 && fullPatch.trim()) {
      const chunks = fullPatch.split(/(?=^diff --git )/m);
      const selected = chunks.filter(c =>
        paths.some(p => c.includes(`a/${p}`) || c.includes(`b/${p}`))
      );
      if (selected.length > 0) {
        tmpPath = path.join(this.shelfDir, `_tmp_${Date.now()}.patch`);
        fs.writeFileSync(tmpPath, selected.join(''), 'utf8');
        applyAbs = tmpPath;
      }
    }

    try {
      if (fullPatch.trim()) {
        try {
          // --binary: allow binary patch reconstruction; --3way: leave conflict markers
          await this.git.raw(['apply', '--binary', '--3way', '--whitespace=fix', applyAbs]);
        } catch (e) {
          const conflictCheck = await this.git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
          if (conflictCheck.trim()) {
            throw Object.assign(new Error('SHELVE_CONFLICT'), {
              code: 'SHELVE_CONFLICT',
              conflictFiles: conflictCheck.trim().split('\n').filter(Boolean),
            });
          }
          // Fallback without --3way (older git)
          await this.git.raw(['apply', '--binary', '--whitespace=fix', applyAbs]).catch(() => {
            throw new Error(`Failed to apply patch: ${e}`);
          });
        }
      }

      // ── Restore physically-stored binary untracked files ────────────────────
      const binaryToRestore = paths
        ? (entry.binaryFiles ?? []).filter(bf => paths.includes(bf.repoRelPath))
        : (entry.binaryFiles ?? []);
      for (const bf of binaryToRestore) {
        const src = path.join(this.shelfDir, bf.storeName);
        const dst = path.join(this.rootPath, bf.repoRelPath);
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        } catch { /* skip */ }
      }
    } finally {
      if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }

    // Return changelist assignments so caller can restore them
    if (!paths && entry.changelistAssignments?.length) return entry.changelistAssignments;
    if (paths && entry.changelistAssignments?.length) {
      const pathSet = new Set(paths);
      const filtered = entry.changelistAssignments.filter(a => pathSet.has(a.path));
      return filtered.length > 0 ? filtered : undefined;
    }
    return undefined;
  }

  drop(shelveId: string): void {
    const meta = this.readMeta();
    const idx = meta.shelves.findIndex(s => s.id === shelveId);
    if (idx === -1) throw new Error(`Shelve "${shelveId}" not found`);
    const entry = meta.shelves[idx];
    // Delete patch file
    try { fs.unlinkSync(path.join(this.shelfDir, entry.patchFile)); } catch { /* already gone */ }
    // Delete any stored binary copies
    for (const bf of entry.binaryFiles ?? []) {
      try { fs.unlinkSync(path.join(this.shelfDir, bf.storeName)); } catch { /* already gone */ }
    }
    meta.shelves.splice(idx, 1);
    this.writeMeta(meta);
  }

  rename(shelveId: string, newName: string): void {
    const meta = this.readMeta();
    const entry = meta.shelves.find(s => s.id === shelveId);
    if (!entry) throw new Error(`Shelve "${shelveId}" not found`);
    entry.name = newName;
    this.writeMeta(meta);
  }

  getFileDiff(shelveId: string, filePath: string): string {
    const meta = this.readMeta();
    const entry = meta.shelves.find(s => s.id === shelveId);
    if (!entry) throw new Error(`Shelve "${shelveId}" not found`);

    const patchAbs = path.join(this.shelfDir, entry.patchFile);
    if (!fs.existsSync(patchAbs)) return '';

    const fullPatch = fs.readFileSync(patchAbs, 'utf8');
    const chunks = fullPatch.split(/(?=^diff --git )/m);
    const chunk = chunks.find(c => c.includes(`b/${filePath}`) || c.includes(`a/${filePath}`));
    return chunk?.trim() ?? '';
  }
}
