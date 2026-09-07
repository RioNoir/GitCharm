import React from 'react';
import type { ChangedFile, IconThemeData } from '../../../host/types/messages';
import { FileTreeView } from './FileTreeView';

interface Props {
  files: ChangedFile[];
  loading: boolean;
  iconTheme: IconThemeData | null;
  onOpenFile: (file: ChangedFile) => void;
}

export function ChangedFilesList({ files, loading, iconTheme, onOpenFile }: Props) {
  if (loading) return <div style={css.empty}>Loading files…</div>;
  return <FileTreeView files={files} iconTheme={iconTheme} onOpenFile={onOpenFile} />;
}

const css = {
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
};
