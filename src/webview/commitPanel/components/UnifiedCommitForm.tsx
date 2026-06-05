import React, { useEffect, useRef, useState } from 'react';
import type { RepoMeta, RepoStatus } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';

interface Props {
  message: string;
  repoStatuses: RepoStatus[];
  repoMetas: RepoMeta[];
  amendFlags: Record<string, boolean>;
  loading: boolean;
  changesViewMode?: 'simplified' | 'changelists' | 'vscode';
  vscodeSelectedRepos?: Set<string>;
  getSelectedFilesForRepo: (repoId: string) => string[];
  onDeselectRepo: (repoId: string) => void;
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

interface DropdownButtonItem { icon: string; label: string; onSelect: () => void; }
interface DropdownButtonProps {
  enabled: boolean;
  icon: string;
  label: string;
  title?: string;
  disabledTitle?: string;
  variant: 'primary' | 'secondary';
  fullWidth?: boolean;
  dropdownAlign?: 'left' | 'right';
  items: DropdownButtonItem[];
  onMainClick: () => void;
}

function DropdownButton({ enabled, icon, label, title, disabledTitle, variant, fullWidth, dropdownAlign = 'left', items, onMainClick }: DropdownButtonProps) {
  const [open, setOpen] = useState(false);
  const [hoverMain, setHoverMain] = useState(false);
  const [hoverChevron, setHoverChevron] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [open]);

  const bg = variant === 'primary'
    ? 'var(--vscode-button-background)'
    : 'var(--vscode-button-secondaryBackground, rgba(100,100,100,0.2))';
  const bgHover = variant === 'primary'
    ? 'var(--vscode-button-hoverBackground)'
    : 'var(--vscode-button-secondaryHoverBackground, rgba(100,100,100,0.35))';
  const fg = variant === 'primary'
    ? 'var(--vscode-button-foreground)'
    : 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))';

  const childStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: bg,
    color: fg,
    border: 'none',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: '13px',
    fontFamily: 'var(--vscode-font-family)',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    padding: 0,
    outline: 'none',
  };

  const dropItemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '5px 12px', fontSize: '12px', cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    userSelect: 'none',
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', ...(fullWidth ? { width: '100%' } : {}), opacity: enabled ? 1 : 0.4 }}>
      <div style={{
        display: 'flex', flex: fullWidth ? 1 : undefined,
        border: '1px solid var(--vscode-button-border)',
        borderRadius: '4px',
        overflow: 'hidden',
        backgroundColor: bg,
      }}>
        <button
          style={{ ...childStyle, flex: fullWidth ? 1 : undefined, gap: '6px', padding: '5px 12px', backgroundColor: hoverMain && enabled ? bgHover : bg }}
          disabled={!enabled}
          title={enabled ? (title ?? label) : (disabledTitle ?? '')}
          onClick={() => { if (enabled) onMainClick(); }}
          onMouseEnter={() => setHoverMain(true)}
          onMouseLeave={() => setHoverMain(false)}
        >
          <Codicon name={icon} style={{ fontSize: '14px', flexShrink: 0 }} />
          <span>{label}</span>
        </button>
        <div style={{ width: '1px', alignSelf: 'stretch', padding: '4px 0', flexShrink: 0, display: 'flex', backgroundColor: 'inherit' }}>
          <div style={{ flex: 1, backgroundColor: variant === 'primary' ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))', opacity: 0.3 }} />
        </div>
        <button
          style={{ ...childStyle, padding: '5px 7px', backgroundColor: hoverChevron && enabled ? bgHover : bg }}
          disabled={!enabled}
          title="More Actions..."
          onClick={() => { if (enabled) setOpen(o => !o); }}
          onMouseEnter={() => setHoverChevron(true)}
          onMouseLeave={() => setHoverChevron(false)}
        >
          <Codicon name="chevron-down" style={{ fontSize: '12px' }} />
        </button>
      </div>
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 4px)', ...(dropdownAlign === 'right' ? { right: 0 } : { left: 0 }),
          background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
          border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
          borderRadius: '4px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          zIndex: 9999, minWidth: '150px', padding: '3px 0',
        }}>
          {items.map(item => (
            <DropItem key={item.label} icon={item.icon} label={item.label} itemStyle={dropItemStyle} onSelect={() => { item.onSelect(); setOpen(false); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function DropItem({ icon, label, itemStyle, onSelect }: { icon: string; label: string; itemStyle: React.CSSProperties; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...itemStyle, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
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
  loading, changesViewMode, vscodeSelectedRepos, getSelectedFilesForRepo, onDeselectRepo, onMessageChange, onAmendToggle, onCommit, onCommitAndPush, onShelve, onStash,
  onAutopilot, generatingMessage,
}: Props) {
  const metaMap = new Map(repoMetas.map(m => [m.id, m]));

  // In vscode mode count staged files; otherwise count selected files
  const commitTargets = repoStatuses.map(r => ({
    ...r,
    selectedCount: changesViewMode === 'vscode'
      ? (vscodeSelectedRepos === undefined || vscodeSelectedRepos.has(r.repoId) ? r.stagedFiles.length : 0)
      : getSelectedFilesForRepo(r.repoId).length,
  })).filter(r => r.selectedCount > 0);

  const canCommit = message.trim().length > 0 && commitTargets.length > 0 && !loading;
  const multiRepo = repoStatuses.length > 1;

  const amendTarget = commitTargets.length === 1 ? commitTargets[0] : null;
  const showAmend = amendTarget !== null && (amendTarget.branch.aheadBehind?.ahead ?? 0) > 0;
  const amendRepoId = amendTarget?.repoId;
  const amend = amendFlags[amendRepoId ?? ''] ?? false;

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = Math.floor(window.innerHeight / 2);
    if (el.scrollHeight > maxHeight) {
      el.style.height = `${maxHeight}px`;
      el.style.overflow = 'auto';
    } else {
      el.style.height = `${el.scrollHeight}px`;
      el.style.overflow = 'hidden';
    }
  };

  useEffect(() => { resizeTextarea(); }, [message]);

  useEffect(() => {
    window.addEventListener('resize', resizeTextarea);
    return () => window.removeEventListener('resize', resizeTextarea);
  }, []);

  useEffect(() => {
    const id = 'gs-textarea-pulse-kf';
    let s = document.getElementById(id) as HTMLStyleElement | null;
    if (!s) {
      s = document.createElement('style');
      s.id = id;
      document.head.appendChild(s);
    }
    s.textContent = `
      @keyframes gs-textarea-pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 0.35; } }
      .gs-commit-textarea::-webkit-scrollbar { width: 4px; background: transparent; }
      .gs-commit-textarea::-webkit-scrollbar-track { background: transparent; }
      .gs-commit-textarea::-webkit-scrollbar-corner { background: transparent; }
      .gs-commit-textarea::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 2px; }
      .gs-commit-textarea::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
    `;
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
              const color = meta?.color ?? '#4ec9b0';
              return (
                <span key={r.repoId} style={styles.targetPill(color)}>
                  <button
                    style={styles.pillRemove(color)}
                    title={`Remove ${meta?.name ?? r.repoId} from commit`}
                    onClick={() => onDeselectRepo(r.repoId)}
                  >
                    <Codicon name="close" style={{ fontSize: '10px' }} />
                  </button>
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
          className="gs-commit-textarea"
          style={{
            ...styles.textarea(generatingMessage),
            scrollbarWidth: 'thin',
            scrollbarColor: `var(--vscode-scrollbarSlider-background) transparent`,
          } as React.CSSProperties}
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
          <DropdownButton
            variant="secondary"
            enabled={!!message.trim() && commitTargets.length > 0}
            icon="archive"
            label="Save"
            title="Shelve or stash changes"
            disabledTitle="Enter a commit message first"
            items={[
              { icon: 'archive', label: 'Shelve Changes', onSelect: onShelve },
              { icon: 'save',    label: 'Stash Changes',  onSelect: onStash  },
            ]}
            onMainClick={onShelve}
          />
        </div>

        <div style={styles.rightActions}>
          <DropdownButton
            variant="primary"
            fullWidth
            dropdownAlign="right"
            enabled={canCommit}
            icon="check"
            label="Commit"
            title="Commit (Cmd+Enter)"
            disabledTitle="Stage files and write a message first"
            items={[
              { icon: 'check',        label: 'Commit',        onSelect: onCommit        },
              { icon: 'cloud-upload', label: 'Commit & Push', onSelect: onCommitAndPush },
            ]}
            onMainClick={onCommit}
          />
        </div>
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
    gap: '3px',
    padding: '1px 7px 1px 4px',
    borderRadius: '10px',
    fontSize: '11px',
    lineHeight: '16px',
    background: color + '28',
    color,
    border: `1px solid ${color}60`,
  }),
  pillCount: {
    background: 'rgba(255,255,255,0.15)',
    borderRadius: '7px',
    padding: '0 3px',
    fontSize: '10px',
    minWidth: '14px',
    height: '14px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
  } as React.CSSProperties,
  pillRemove: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color,
    cursor: 'pointer',
    padding: '0',
    margin: '0',
    opacity: 0.7,
    flexShrink: 0,
    lineHeight: 1,
    width: '12px',
    height: '12px',
  }),
  textareaWrap: {
    position: 'relative' as const,
  },
  textarea: (generating: boolean): React.CSSProperties => ({
    width: '100%',
    resize: 'none' as const,
    overflow: 'hidden',   // overridden dynamically by resizeTextarea
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
    gap: '6px',
  },
  leftActions: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  rightActions: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
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
};
