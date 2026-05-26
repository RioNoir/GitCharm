import React, { useEffect, useRef, useState } from 'react';
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
  onStash: () => void;
  onPush: (repoId: string) => void;
  onPushAll: () => void;
  onAutopilot: () => void;
  generatingMessage: boolean;
}

function SaveDropdown({ enabled, onShelve, onStash }: { enabled: boolean; onShelve: () => void; onStash: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [open]);

  const btnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '4px',
    padding: '4px 12px',
    background: enabled
      ? 'var(--vscode-button-secondaryBackground, rgba(100,100,100,0.2))'
      : 'var(--vscode-button-secondaryBackground, rgba(100,100,100,0.1))',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-button-border, rgba(128,128,128,0.35))',
    borderRadius: '3px',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    fontWeight: 'bold',
    opacity: enabled ? 1 : 0.4,
  };

  const dropStyle: React.CSSProperties = {
    position: 'absolute', bottom: 'calc(100% + 4px)', left: 0,
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    zIndex: 9999, minWidth: '150px', padding: '3px 0',
  };

  const itemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '5px 12px', fontSize: '12px', cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    userSelect: 'none',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        style={btnStyle}
        disabled={!enabled}
        title={enabled ? 'Shelve or stash changes' : 'Enter a commit message first'}
        onClick={() => enabled && setOpen(o => !o)}
      >
        <Codicon name="archive" style={{ fontSize: '12px' }} />
        Save
        <Codicon name="chevron-down" style={{ fontSize: '10px', opacity: 0.7 }} />
      </button>
      {open && (
        <div style={dropStyle}>
          <DropItem icon="archive" label="Shelve Changes" itemStyle={itemStyle} onSelect={() => { onShelve(); setOpen(false); }} />
          <DropItem icon="save" label="Stash Changes" itemStyle={itemStyle} onSelect={() => { onStash(); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

function DropItem({ icon, label, itemStyle, onSelect }: { icon: string; label: string; itemStyle: React.CSSProperties; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...itemStyle, background: hovered ? 'var(--vscode-menu-selectionBackground)' : 'transparent', color: hovered ? 'var(--vscode-menu-selectionForeground)' : 'var(--vscode-menu-foreground)' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      <Codicon name={icon} style={{ fontSize: '13px', flexShrink: 0 }} />
      {label}
    </div>
  );
}

export function UnifiedCommitForm({
  message, repoStatuses, repoMetas, amendFlags,
  loading, getSelectedFilesForRepo, onMessageChange, onAmendToggle, onCommit, onCommitAndPush, onShelve, onStash,
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

  const amendTarget = commitTargets.length === 1 ? commitTargets[0] : null;
  const showAmend = amendTarget !== null && (amendTarget.branch.aheadBehind?.ahead ?? 0) > 0;
  const amendRepoId = amendTarget?.repoId;
  const amend = amendFlags[amendRepoId ?? ''] ?? false;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [message]);

  useEffect(() => {
    const id = 'gs-textarea-pulse-kf';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `@keyframes gs-textarea-pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 0.35; } }`;
    document.head.appendChild(s);
  }, []);

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
          style={styles.textarea(generatingMessage)}
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder={generatingMessage ? 'Generating commit message…' : 'Commit message (Cmd+Enter to commit)'}
          readOnly={generatingMessage}
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
          <SaveDropdown
            enabled={!!message.trim() && commitTargets.length > 0}
            onShelve={onShelve}
            onStash={onStash}
          />
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
                      title="Push all repositories to remote"
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
                  title="Push commits to remote"
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
  textarea: (generating: boolean): React.CSSProperties => ({
    width: '100%',
    resize: 'none' as const,
    overflow: 'hidden',
    minHeight: '52px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: generating
      ? '1px solid var(--vscode-focusBorder)'
      : '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '3px',
    padding: '5px 28px 5px 7px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    lineHeight: '1.5',
    outline: 'none',
    boxSizing: 'border-box' as const,
    opacity: generating ? 0.6 : 1,
    cursor: generating ? 'default' : 'text',
    animation: generating ? 'gs-textarea-pulse 1.2s ease-in-out infinite' : 'none',
  }),
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
