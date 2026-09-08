import React from 'react';
import type { ChangedFile, IconThemeData } from '../../../host/types/messages';
import { FileTreeView } from './FileTreeView';
import { SkeletonList } from '../../shared/Skeleton';

interface Props {
  files: ChangedFile[];
  loading: boolean;
  iconTheme: IconThemeData | null;
  onOpenFile: (file: ChangedFile) => void;
}

export function ChangedFilesList({ files, loading, iconTheme, onOpenFile }: Props) {
  if (loading) return <SkeletonList rows={6} withAvatar={false} />;
  return <FileTreeView files={files} iconTheme={iconTheme} onOpenFile={onOpenFile} />;
}
