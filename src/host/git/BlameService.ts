import { createGit } from './gitClient';
import * as path from 'path';

export interface BlameLine {
  lineNumber: number; // 0-indexed
  hash: string;
  author: string;
  date: Date;
  summary: string;
  isUncommitted: boolean;
}

export class BlameService {
  private cache = new Map<string, BlameLine[]>();
  /** Blames still running, shared by the callers that ask for the same file meanwhile (ghost text and status bar). */
  private inflight = new Map<string, Promise<BlameLine[]>>();

  getBlame(filePath: string, rootPath: string): Promise<BlameLine[]> {
    const cached = this.cache.get(filePath);
    if (cached) return Promise.resolve(cached);
    const inflight = this.inflight.get(filePath);
    if (inflight) return inflight;
    // Only the latest request caches its result: one that a save invalidated while it ran
    // would cache the blame of the file as it was before the save.
    const pending: Promise<BlameLine[]> = this.runBlame(filePath, rootPath).then(result => {
      const current = this.inflight.get(filePath) === pending;
      if (current) this.inflight.delete(filePath);
      if (!result) return [];
      if (current) this.cache.set(filePath, result);
      return result;
    });
    this.inflight.set(filePath, pending);
    return pending;
  }

  /** The file's blame, or null when git fails (not cached, so the next request retries). */
  private async runBlame(filePath: string, rootPath: string): Promise<BlameLine[] | null> {
    const git = createGit(rootPath);
    const relPath = path.relative(rootPath, filePath);
    try {
      return this.parsePorcelain(await git.raw(['blame', '--porcelain', relPath]));
    } catch {
      return null;
    }
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
    this.inflight.delete(filePath);
  }

  private parsePorcelain(raw: string): BlameLine[] {
    const lines = raw.split('\n');
    const commitMeta = new Map<string, { author: string; date: Date; summary: string }>();
    const result: BlameLine[] = [];

    let i = 0;
    while (i < lines.length) {
      const headerLine = lines[i];
      if (!headerLine || !/^[0-9a-f]{40} /.test(headerLine)) {
        i++;
        continue;
      }

      const parts = headerLine.split(' ');
      const hash = parts[0];
      const finalLine = parseInt(parts[2], 10); // 1-indexed in git output

      i++;

      const isNew = !commitMeta.has(hash);
      let author = '';
      let timestamp = 0;
      let summary = '';

      while (i < lines.length && !lines[i].startsWith('\t')) {
        const l = lines[i];
        if (isNew) {
          if (l.startsWith('author ')) author = l.slice(7);
          else if (l.startsWith('author-time ')) timestamp = parseInt(l.slice(12), 10);
          else if (l.startsWith('summary ')) summary = l.slice(8);
        }
        i++;
      }

      if (isNew) {
        commitMeta.set(hash, { author, date: new Date(timestamp * 1000), summary });
      }

      if (i < lines.length) i++; // skip the \t-prefixed line content

      const meta = commitMeta.get(hash)!;
      result.push({
        lineNumber: finalLine - 1, // convert to 0-indexed
        hash,
        author: meta.author,
        date: meta.date,
        summary: meta.summary,
        isUncommitted: hash.startsWith('0000000'),
      });
    }

    return result;
  }
}
