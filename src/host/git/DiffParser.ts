import type { DiffHunk, FileDiff } from '../types/git';
import * as path from 'path';

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  php: 'php', py: 'python', go: 'go', java: 'java', rs: 'rust',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', xml: 'xml', svg: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  md: 'markdown', sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', graphql: 'graphql', vue: 'html',
  c: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby', swift: 'swift',
  kt: 'kotlin', dart: 'dart',
};

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return LANG_MAP[ext] ?? 'plaintext';
}

export function parseDiff(rawDiff: string, repoId: string): FileDiff[] {
  const results: FileDiff[] = [];
  if (!rawDiff.trim()) return results;

  const fileChunks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    const headerLine = lines[0];

    const aMatch = headerLine.match(/a\/(.+?) b\//);
    const bMatch = headerLine.match(/b\/(.+?)$/);
    const oldPath = aMatch?.[1] ?? '';
    const newPath = bMatch?.[1] ?? oldPath;

    let isBinary = false;
    let isNew = false;
    let isDeleted = false;
    let hunkStart = -1;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('Binary files')) { isBinary = true; break; }
      if (line.startsWith('new file mode')) isNew = true;
      if (line.startsWith('deleted file mode')) isDeleted = true;
      if (line.startsWith('@@')) { hunkStart = i; break; }
    }

    const hunks: DiffHunk[] = isBinary ? [] : parseHunks(lines.slice(hunkStart >= 0 ? hunkStart : lines.length));

    results.push({
      repoId,
      oldPath,
      newPath,
      isBinary,
      isNew,
      isDeleted,
      hunks,
      language: detectLanguage(newPath || oldPath),
    });
  }

  return results;
}

function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkMatch) {
      if (current) hunks.push(current);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      const ranges = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      current = {
        header: line,
        oldStart: parseInt(ranges?.[1] ?? '0', 10),
        oldLines: parseInt(ranges?.[2] ?? '1', 10),
        newStart: parseInt(ranges?.[3] ?? '0', 10),
        newLines: parseInt(ranges?.[4] ?? '1', 10),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', content: line.slice(1), newLineNo: newLine++ });
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'remove', content: line.slice(1), oldLineNo: oldLine++ });
    } else if (line.startsWith(' ') || line === '') {
      current.lines.push({ type: 'context', content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

export function buildMonacoContents(hunks: DiffHunk[]): { original: string; modified: string } {
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        originalLines.push(line.content);
        modifiedLines.push(line.content);
      } else if (line.type === 'remove') {
        originalLines.push(line.content);
      } else if (line.type === 'add') {
        modifiedLines.push(line.content);
      }
    }
  }

  return {
    original: originalLines.join('\n'),
    modified: modifiedLines.join('\n'),
  };
}
