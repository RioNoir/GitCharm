import { create } from 'zustand';
import type { MergeConflictFile } from '../../shared/types';

export type Resolution = 'ours' | 'theirs' | 'both' | 'unresolved';

interface MergeState {
  file: MergeConflictFile | null;
  resultContent: string;
  resolutions: Record<number, Resolution>;
  savedOk: boolean;
  saving: boolean;
  error: string | null;

  setFile: (file: MergeConflictFile) => void;
  setResultContent: (content: string) => void;
  resolveBlock: (index: number, resolution: Resolution) => void;
  setSaving: (v: boolean) => void;
  setSavedOk: (v: boolean) => void;
  setError: (err: string | null) => void;
  unresolvedCount: () => number;
}

export const useMergeStore = create<MergeState>((set, get) => ({
  file: null,
  resultContent: '',
  resolutions: {},
  savedOk: false,
  saving: false,
  error: null,

  setFile: (file) => {
    // Build initial result content (raw conflict file content)
    const resolutions: Record<number, Resolution> = {};
    file.conflicts.forEach((_, i) => { resolutions[i] = 'unresolved'; });
    set({ file, resolutions });
  },

  setResultContent: (content) => set({ resultContent: content }),

  resolveBlock: (index, resolution) => set(s => ({
    resolutions: { ...s.resolutions, [index]: resolution },
  })),

  setSaving: (v) => set({ saving: v }),
  setSavedOk: (v) => set({ savedOk: v }),
  setError: (err) => set({ error: err }),

  unresolvedCount: () => {
    const { resolutions } = get();
    return Object.values(resolutions).filter(r => r === 'unresolved').length;
  },
}));
