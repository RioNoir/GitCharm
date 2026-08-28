import React, { useState } from 'react';

interface Props {
  repoId: string;
  repoName: string;
  repoColor: string;
  message: string;
  amend: boolean;
  stagedCount: number;
  branchName: string;
  aheadBehind?: { ahead: number; behind: number };
  onMessageChange: (msg: string) => void;
  onAmendChange: (v: boolean) => void;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onPull: () => void;
  loading: boolean;
}

export function CommitForm({
  repoId, repoName, repoColor, message, amend, stagedCount, branchName, aheadBehind,
  onMessageChange, onAmendChange, onCommit, onCommitAndPush, onPull, loading,
}: Props) {
  const canCommit = (message.trim().length > 0 || amend) && (stagedCount > 0 || amend);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.dot(repoColor)} />
        <span style={styles.repoName}>{repoName}</span>
        <span style={styles.branch}>
          <span style={styles.branchIcon}>⎇</span>
          {branchName}
        </span>
        {aheadBehind && (aheadBehind.ahead > 0 || aheadBehind.behind > 0) && (
          <span style={styles.aheadBehind}>
            {aheadBehind.ahead > 0 && <span title="Commits ahead">↑{aheadBehind.ahead}</span>}
            {aheadBehind.behind > 0 && <span title="Commits behind">↓{aheadBehind.behind}</span>}
          </span>
        )}
        <button
          style={styles.pullBtn}
          onClick={onPull}
          disabled={loading}
          title="Pull from remote"
        >
          ↓ Pull
        </button>
      </div>

      <textarea
        style={styles.textarea}
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        placeholder="Commit message"
        rows={3}
        disabled={loading}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (canCommit) onCommit();
          }
        }}
      />

      <div style={styles.amendRow}>
        <label style={styles.amendLabel}>
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => onAmendChange(e.target.checked)}
            disabled={loading}
            style={{ marginRight: '5px' }}
          />
          Amend last commit
        </label>
        <span style={styles.stagedCount}>
          {stagedCount} file{stagedCount !== 1 ? 's' : ''} staged
        </span>
      </div>

      <div style={styles.buttons}>
        <button
          style={styles.commitBtn(canCommit && !loading, false)}
          onClick={onCommit}
          disabled={!canCommit || loading}
          title="Commit staged changes (⌘Enter)"
        >
          Commit
        </button>
        <button
          style={styles.commitBtn(canCommit && !loading, true)}
          onClick={onCommitAndPush}
          disabled={!canCommit || loading}
          title="Commit and push to remote"
        >
          Commit &amp; Push
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    padding: '8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
  },
  dot: (color: string) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  repoName: {
    fontWeight: 'bold' as const,
    fontSize: '12px',
  },
  branch: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
    fontSize: '11px',
  },
  branchIcon: {
    fontSize: '13px',
  },
  aheadBehind: {
    display: 'flex',
    gap: '4px',
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
    opacity: 0.7,
  },
  pullBtn: {
    marginLeft: 'auto',
    padding: '2px 8px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
  },
  textarea: {
    resize: 'none' as const,
    width: '100%',
    padding: '6px 8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '3px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  amendRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
    opacity: 0.8,
  },
  amendLabel: {
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
  },
  stagedCount: {
    fontSize: '11px',
    opacity: 0.6,
  },
  buttons: {
    display: 'flex',
    gap: '6px',
  },
  commitBtn: (enabled: boolean, isPrimary: boolean) => ({
    flex: 1,
    padding: '5px 12px',
    background: enabled
      ? (isPrimary ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)')
      : 'var(--vscode-button-background)',
    color: enabled
      ? (isPrimary ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)')
      : 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.4,
    fontSize: '12px',
    fontWeight: isPrimary ? 'bold' as const : 'normal' as const,
  }),
};
