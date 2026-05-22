import React, { useEffect, useRef } from 'react';
import type { RepoMeta, RepoStatus } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';

interface Props {
  message: string;
  repoStatuses: RepoStatus[];
  repoMetas: RepoMeta[];
  amendFlags: Record<string, boolean>;
  loading: boolean;
  getSelectedFilesForRepo: (repoId: string) => string[];
  onMessageChange: (msg: string) => void;
  onAmendToggle: (repoId: string) => void;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onShelve: () => void;
  onPush: (repoId: string) => void;
  onPushAll: () => void;
  onAutopilot: () => void;
  generatingMessage: boolean;
}

export function UnifiedCommitForm({
  message, repoStatuses, repoMetas, amendFlags,
  loading, getSelectedFilesForRepo, onMessageChange, onAmendToggle, onCommit, onCommitAndPush, onShelve,
  onPush, onPushAll, onAutopilot, generatingMessage,
}: Props) {
  const metaMap = new Map(repoMetas.map(m => [m.id, m]));

  // Repos that have at least one file selected (= will commit something)
  const commitTargets = repoStatuses.map(r => ({
    ...r,
    selectedCount: getSelectedFilesForRepo(r.repoId).length,
  })).filter(r => r.selectedCount > 0);

  const canCommit = message.trim().length > 0 && commitTargets.length > 0 && !loading;
  const multiRepo = repoStatuses.length > 1;

  // Repos with unpushed commits (ahead > 0)
  const pushableRepos = repoStatuses.filter(r => (r.branch.aheadBehind?.ahead ?? 0) > 0);
  const canPushAll = pushableRepos.length > 0 && !loading;

  const commitLabel = 'Commit';
  const pushLabel = 'Commit & Push';

  const showAmend = commitTargets.length === 1;
  const amendRepoId = commitTargets[0]?.repoId;
  const amend = amendFlags[amendRepoId ?? ''] ?? false;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [message]);

  return (
    <div style={styles.container}>
      {/* Commit targets summary (multi-repo only) */}
      {multiRepo && (
        <div style={styles.targets}>
          {commitTargets.length === 0 ? (
            <span style={styles.noTargets}>No files selected</span>
          ) : (
            commitTargets.map(r => {
              const meta = metaMap.get(r.repoId);
              return (
                <span key={r.repoId} style={styles.targetPill(meta?.color ?? '#4ec9b0')}>
                  {meta?.name ?? r.repoId.split('/').pop()}
                  <span style={styles.pillCount}>{r.selectedCount}</span>
                </span>
              );
            })
          )}
        </div>
      )}

      {/* Amend toggle — shown above textarea when a single repo is selected */}
      {showAmend && (
        <label style={styles.amendLabel} title="Modify the last commit instead of creating a new one. Rewrites history — avoid on shared branches.">
          <input
            type="checkbox"
            checked={amend}
            onChange={() => onAmendToggle(amendRepoId!)}
            style={{ marginRight: '4px' }}
          />
          Amend last commit
        </label>
      )}

      {/* Message textarea — auto-height */}
      <div style={styles.textareaWrap}>
        <textarea
          ref={textareaRef}
          style={styles.textarea}
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Commit message (Cmd+Enter to commit)"
          rows={2}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCommit) {
              e.preventDefault();
              onCommit();
            }
          }}
        />
        <button
          style={styles.autopilotBtn(generatingMessage)}
          onClick={onAutopilot}
          disabled={generatingMessage}
          title="Generate commit message with AI"
        >
          <Codicon name={generatingMessage ? 'loading~spin' : 'sparkle'} style={{ fontSize: '16px' }} />
        </button>
      </div>

      {/* Amend + actions row */}
      <div style={styles.actionsRow}>
        <div style={styles.leftActions}>
          <button
            style={{ ...styles.stashBtn, opacity: message.trim() ? 0.75 : 0.35, cursor: message.trim() ? 'pointer' : 'default' }}
            onClick={onShelve}
            disabled={!message.trim()}
            title={message.trim() ? 'Shelve selected files using commit message as name' : 'Enter a commit message to shelve'}
          >
            <Codicon name="archive" style={{ marginRight: '4px' }} />
            Shelve
          </button>
        </div>

        <div style={styles.rightActions}>
          <button
            style={styles.commitBtn(canCommit)}
            onClick={onCommit}
            disabled={!canCommit}
            title={canCommit ? commitLabel : 'Stage files and write a message first'}
          >
            {commitLabel}
          </button>
          <button
            style={styles.commitAndPushBtn(canCommit)}
            onClick={onCommitAndPush}
            disabled={!canCommit}
            title="Commit and push"
          >
            {pushLabel}
          </button>
        </div>
      </div>
      {/* Push section — shown when any repo has unpushed commits */}
      {pushableRepos.length > 0 && (
        <div style={styles.pushSection}>
          <div style={styles.pushLabel}>
            <Codicon name="cloud-upload" style={{ fontSize: '12px', opacity: 0.7 }} />
            <span>Unpushed commits</span>
          </div>
          <div style={styles.pushRepos}>
            {multiRepo ? (
              <>
                {pushableRepos.map(r => {
                  const meta = metaMap.get(r.repoId);
                  const ahead = r.branch.aheadBehind?.ahead ?? 0;
                  return (
                    <div key={r.repoId} style={styles.pushRow}>
                      <span style={styles.pushDot(meta?.color ?? '#888')} />
                      <span style={styles.pushRepoName}>{meta?.name ?? r.repoId.split('/').pop()}</span>
                      <span style={styles.pushAhead}>↑{ahead}</span>
                      <button
                        style={styles.pushBtn(true)}
                        onClick={() => onPush(r.repoId)}
                        disabled={loading}
                        title={`Push ${meta?.name}`}
                      >
                        Push
                      </button>
                    </div>
                  );
                })}
                {pushableRepos.length > 1 && (
                  <div style={styles.pushRow}>
                    <button
                      style={{ ...styles.pushBtn(canPushAll), flex: 1 }}
                      onClick={onPushAll}
                      disabled={!canPushAll}
                    >
                      Push All
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={styles.pushRow}>
                <span style={styles.pushAhead}>↑{pushableRepos[0].branch.aheadBehind?.ahead ?? 0} commit{(pushableRepos[0].branch.aheadBehind?.ahead ?? 0) !== 1 ? 's' : ''}</span>
                <button
                  style={styles.pushBtn(canPushAll)}
                  onClick={() => onPush(pushableRepos[0].repoId)}
                  disabled={!canPushAll}
                >
                  <Codicon name="cloud-upload" style={{ marginRight: '4px', fontSize: '11px' }} />
                  Push
                </button>
              </div>
            )}
          </div>
        </div>
      )}

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
    background: 'var(--vscode-editor-background)',
  },
  targets: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
    minHeight: '20px',
  },
  noTargets: {
    fontSize: '11px',
    opacity: 0.5,
    fontStyle: 'italic' as const,
  },
  targetPill: (color: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 7px',
    borderRadius: '10px',
    fontSize: '11px',
    background: color + '28',
    color,
    border: `1px solid ${color}60`,
  }),
  pillCount: {
    background: 'rgba(255,255,255,0.15)',
    borderRadius: '8px',
    padding: '0 4px',
    fontSize: '10px',
  },
  textareaWrap: {
    position: 'relative' as const,
  },
  textarea: {
    width: '100%',
    resize: 'none' as const,
    overflow: 'hidden',
    minHeight: '52px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '3px',
    padding: '5px 28px 5px 7px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    lineHeight: '1.5',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  autopilotBtn: (spinning: boolean): React.CSSProperties => ({
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    background: 'transparent',
    border: 'none',
    cursor: spinning ? 'default' : 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: spinning ? 0.5 : 0.7,
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
    lineHeight: 1,
  }),
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap' as const,
    gap: '6px',
  },
  leftActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  rightActions: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
  },
  stashBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '3px 8px',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    border: '1px solid var(--vscode-button-border, rgba(128,128,128,0.35))',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'var(--vscode-font-family)',
    opacity: 0.75,
  } as React.CSSProperties,
  amendLabel: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '11px',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: 0.75,
    userSelect: 'none' as const,
  } as React.CSSProperties,
  commitBtn: (enabled: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: '12px',
    opacity: enabled ? 1 : 0.5,
    fontWeight: 'bold',
  }),
  commitAndPushBtn: (enabled: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    background: 'var(--vscode-button-secondaryBackground, #5a5a5a)',
    color: 'var(--vscode-button-secondaryForeground, #ffffff)',
    border: '1px solid var(--vscode-button-border, rgba(255,255,255,0.15))',
    borderRadius: '3px',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: '12px',
    opacity: enabled ? 1 : 0.5,
    fontWeight: 'bold',
  }),
  pushSection: {
    borderTop: '1px solid var(--vscode-panel-border)',
    paddingTop: '6px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  pushLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '11px',
    opacity: 0.6,
    userSelect: 'none' as const,
  },
  pushRepos: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '3px',
  },
  pushRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  pushDot: (color: string): React.CSSProperties => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  pushRepoName: {
    flex: 1,
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  pushAhead: {
    fontSize: '11px',
    opacity: 0.65,
    flexShrink: 0,
    fontFamily: 'monospace',
  },
  pushBtn: (enabled: boolean): React.CSSProperties => ({
    padding: '2px 10px',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: '11px',
    opacity: enabled ? 1 : 0.5,
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  }),
};
