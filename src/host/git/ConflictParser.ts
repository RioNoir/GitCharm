import type { ConflictBlock, MergeConflictFile } from '../types/git';
import * as fs from 'fs';
import * as path from 'path';

const OURS_START = /^<{7} (.+)$/m;
const BASE_START = /^\|{7} (.+)$/m;
const SEPARATOR = /^={7}$/m;
const THEIRS_END = /^>{7} (.+)$/m;

export function hasConflictMarkers(content: string): boolean {
  return OURS_START.test(content) && THEIRS_END.test(content);
}

export function parseConflictFile(absolutePath: string, repoId: string): MergeConflictFile | null {
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }

  if (!hasConflictMarkers(content)) return null;

  const lines = content.split('\n');
  const conflicts: ConflictBlock[] = [];

  let state: 'normal' | 'ours' | 'base' | 'theirs' = 'normal';
  let currentBlock: Partial<ConflictBlock> | null = null;
  let oursLabel = 'OURS';
  let theirsLabel = 'THEIRS';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const oursMatch = line.match(OURS_START);
    const baseMatch = line.match(BASE_START);
    const theirsMatch = line.match(THEIRS_END);

    if (oursMatch && state === 'normal') {
      oursLabel = oursMatch[1];
      state = 'ours';
      currentBlock = {
        index: conflicts.length,
        oursLabel: oursMatch[1],
        theirsLabel: '',
        oursLines: [],
        baseLines: [],
        theirsLines: [],
        startLine: i,
      };
    } else if (baseMatch && state === 'ours') {
      state = 'base';
    } else if (line.match(SEPARATOR) && (state === 'ours' || state === 'base')) {
      state = 'theirs';
    } else if (theirsMatch && state === 'theirs') {
      theirsLabel = theirsMatch[1];
      currentBlock!.theirsLabel = theirsMatch[1];
      currentBlock!.endLine = i;
      conflicts.push(currentBlock as ConflictBlock);
      currentBlock = null;
      state = 'normal';
    } else {
      if (!currentBlock) continue;
      if (state === 'ours') currentBlock.oursLines!.push(line);
      else if (state === 'base') currentBlock.baseLines!.push(line);
      else if (state === 'theirs') currentBlock.theirsLines!.push(line);
    }
  }

  return {
    absolutePath,
    relativePath: path.basename(absolutePath),
    repoId,
    conflicts,
    oursLabel,
    theirsLabel,
  };
}
