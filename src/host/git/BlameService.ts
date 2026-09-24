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

  async getBlame(filePath: string, rootPath: string): Promise<BlameLine[]> {
    if (this.cache.has(filePath)) return this.cache.get(filePath)!;

    const git = createGit(rootPath);
    const relPath = path.relative(rootPath, filePath);

    let raw: string;
    try {
      raw = await git.raw(['blame', '--porcelain', relPath]);
    } catch {
      return [];
    }

    const result = this.parsePorcelain(raw);
    this.cache.set(filePath, result);
    return result;
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
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
