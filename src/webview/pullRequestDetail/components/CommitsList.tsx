import React, { useState } from 'react';
import type { ChangedFile, IconThemeData, PullRequestCommit } from '../../../host/types/messages';
import { FileTreeView } from '../../shared/FileTreeView';
import { CommitRow } from '../../shared/CommitRow';
import { SkeletonList } from '../../shared/Skeleton';

interface Props {
  commits: PullRequestCommit[];
  loading: boolean;
  iconTheme: IconThemeData | null;
  commitFiles: Record<string, ChangedFile[]>;
  commitFilesLoading: Record<string, boolean>;
  onRequestCommitFiles: (sha: string) => void;
  onOpenCommitFileDiff: (file: ChangedFile, commitSha: string, parentSha: string | undefined) => void;
}

export function CommitsList({ commits, loading, iconTheme, commitFiles, commitFilesLoading, onRequestCommitFiles, onOpenCommitFileDiff }: Props) {
  const [expandedSha, setExpandedSha] = useState<string | null>(null);

  if (loading) return <SkeletonList rows={5} />;
  if (commits.length === 0) return <div style={css.empty}>No commits.</div>;

  const handleToggle = (sha: string) => {
    if (expandedSha === sha) {
      setExpandedSha(null);
      return;
    }
    setExpandedSha(sha);
    if (!commitFiles[sha]) onRequestCommitFiles(sha);
  };

  return (
    <div style={css.root}>
      {commits.map((c, i) => (
        <CommitRow
          key={c.sha}
          commit={{
            hash: c.sha, shortHash: c.shortSha, message: c.message,
            authorName: c.authorName, authorAvatarUrl: c.authorAvatarUrl, authoredAt: c.authoredAt,
          }}
          expanded={expandedSha === c.sha}
          isLast={i === commits.length - 1}
          onToggle={() => handleToggle(c.sha)}
          renderFiles={() => commitFilesLoading[c.sha] ? (
            <SkeletonList rows={3} withAvatar={false} />
          ) : (
            <FileTreeView
              files={commitFiles[c.sha] ?? []}
              iconTheme={iconTheme}
              onOpenFile={f => onOpenCommitFileDiff(f, c.sha, c.parentSha)}
            />
          )}
        />
      ))}
    </div>
  );
}

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, border: '1px solid var(--vscode-panel-border)', borderRadius: '4px', overflow: 'hidden' },
  empty: { fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const, padding: '4px 0' },
};
