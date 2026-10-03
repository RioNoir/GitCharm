import '../shared/l10n';
import * as l10n from '@vscode/l10n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getVsCodeApi, notifyHostReady } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import { renderMarkdown } from '../shared/renderMarkdown';
import type { HostToIssueResolveMsg, IssueResolveFile, IssueResolvePhase, IssueResolveToHostMsg } from '../../host/types/messages';

type StepId = 'preparing' | 'selectingFiles' | 'readingFiles' | 'generating' | 'agentWorking' | 'collecting';

function steps(mode: 'agent' | 'text'): { id: StepId; label: string }[] {
  return mode === 'agent'
    ? [
        { id: 'preparing', label: l10n.t('Reading the issue and its discussion') },
        { id: 'agentWorking', label: l10n.t('The agent explores the code and makes the changes (in a scratch copy)') },
        { id: 'collecting', label: l10n.t('Collecting the changes') },
      ]
    : [
        { id: 'preparing', label: l10n.t('Reading the issue and its discussion') },
        { id: 'selectingFiles', label: l10n.t('Choosing the files to read') },
        { id: 'readingFiles', label: l10n.t('Reading the files') },
        { id: 'generating', label: l10n.t('Working out the fix') },
        { id: 'collecting', label: l10n.t('Preparing the proposal') },
      ];
}

const RUNNING: IssueResolvePhase[] = ['preparing', 'selectingFiles', 'readingFiles', 'generating', 'agentWorking', 'collecting'];

const STATUS: Record<IssueResolveFile['status'], { letter: string; color: string }> = {
  added: { letter: 'A', color: '#3fb950' },
  modified: { letter: 'M', color: '#d29922' },
  deleted: { letter: 'D', color: '#f85149' },
};

function App() {
  const [init, setInit] = useState<{ repoName: string; number: number; title: string; mode: 'agent' | 'text'; modelLabel: string } | null>(null);
  const [phase, setPhase] = useState<IssueResolvePhase>('preparing');
  /** The last step reached — after a failure or a cancel, the steps before it still show as done. */
  const [lastStep, setLastStep] = useState<IssueResolvePhase>('preparing');
  const [filesRead, setFilesRead] = useState<string[]>([]);
  const [progress, setProgress] = useState('');
  const [summary, setSummary] = useState('');
  const [files, setFiles] = useState<IssueResolveFile[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [branchName, setBranchName] = useState<string | undefined>();
  const [showOutput, setShowOutput] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);

  const send = useCallback((msg: IssueResolveToHostMsg) => getVsCodeApi().postMessage(msg), []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToIssueResolveMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'ISSUERESOLVE_INIT':
          setInit({ repoName: msg.repoName, number: msg.number, title: msg.title, mode: msg.mode, modelLabel: msg.modelLabel });
          setFilesRead([]);
          setProgress('');
          setSummary('');
          setFiles([]);
          setWarnings([]);
          setError(undefined);
          setShowOutput(true);
          break;
        case 'ISSUERESOLVE_PHASE':
          setPhase(msg.phase);
          if (RUNNING.includes(msg.phase)) setLastStep(msg.phase);
          if (msg.phase === 'ready') setShowOutput(false);
          break;
        case 'ISSUERESOLVE_FILES_READ':
          setFilesRead(msg.paths);
          break;
        case 'ISSUERESOLVE_PROGRESS':
          setProgress(msg.text);
          break;
        case 'ISSUERESOLVE_RESULT':
          setSummary(msg.summary);
          setFiles(msg.files);
          setWarnings(msg.warnings);
          break;
        case 'ISSUERESOLVE_ERROR':
          setError(msg.error);
          break;
        case 'ISSUERESOLVE_APPLIED':
          setBranchName(msg.branchName);
          break;
      }
    };
    window.addEventListener('message', handler);
    notifyHostReady();
    return () => window.removeEventListener('message', handler);
  }, []);

  // Keeps the newest output in view while it streams.
  useEffect(() => {
    const el = outputRef.current;
    if (el && RUNNING.includes(phase)) el.scrollTop = el.scrollHeight;
  }, [progress, phase]);

  const summaryHtml = useMemo(() => renderMarkdown(summary), [summary]);

  if (!init) {
    return <div style={css.loading}><Codicon name="loading" className="codicon-modifier-spin" /></div>;
  }

  const running = RUNNING.includes(phase);
  const stepList = steps(init.mode);
  const currentIndex = stepList.findIndex(s => s.id === phase);
  const done = !running;

  return (
    <div style={css.page} className="pr-detail-root">
      <div style={css.header}>
        <Codicon name="sparkle" style={css.headerIcon} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={css.headerTitle}>{l10n.t('Resolve issue #{0} with AI', init.number)}</div>
          <div style={css.headerSub} title={init.title}>{init.title} · {init.repoName}</div>
        </div>
        <span style={css.modeChip} title={init.mode === 'agent'
          ? l10n.t('Agent: edits files itself in a scratch copy of the repository')
          : l10n.t('Proposal: reads the relevant files and answers with the changes')}>
          <Codicon name={init.mode === 'agent' ? 'robot' : 'file-code'} style={{ fontSize: '12px' }} />
          {init.mode === 'agent' ? l10n.t('Agent') : l10n.t('Proposal')} · {init.modelLabel}
        </span>
      </div>

      <div style={css.body}>
        <section style={css.section}>
          {stepList.map((step, i) => {
            const state = phase === 'failed' || phase === 'cancelled'
              ? (i < stepList.findIndex(s => s.id === lastStep) ? 'done' : 'idle')
              : done || i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'idle';
            return (
              <div key={step.id} style={css.step(state)}>
                <Codicon
                  name={state === 'done' ? 'pass-filled' : state === 'active' ? 'loading' : 'circle-large-outline'}
                  className={state === 'active' ? 'codicon-modifier-spin' : undefined}
                  style={{ fontSize: '14px', color: state === 'done' ? '#3fb950' : undefined, flexShrink: 0 }}
                />
                <span>{step.label}</span>
                {step.id === 'readingFiles' && filesRead.length > 0 && (
                  <span style={css.stepDetail} title={filesRead.join('\n')}>{l10n.t('{0} files', filesRead.length)}</span>
                )}
              </div>
            );
          })}
        </section>

        {error && (
          <div style={css.alertError}>
            <Codicon name="error" style={{ fontSize: '14px', flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}
        {phase === 'cancelled' && <div style={css.note}>{l10n.t('Cancelled. Nothing was changed.')}</div>}

        {progress && (
          <section style={css.section}>
            <button className="icon-btn" style={css.sectionHeader} onClick={() => setShowOutput(o => !o)}>
              <Codicon name={showOutput ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '13px', opacity: 0.6 }} />
              <h3 style={css.sectionTitle}>{init.mode === 'agent' ? l10n.t('Agent activity') : l10n.t('AI output')}</h3>
            </button>
            {showOutput && <pre ref={outputRef} style={css.output}>{progress}</pre>}
          </section>
        )}

        {phase !== 'failed' && done && summary && (
          <section style={css.section}>
            <div style={css.sectionHeader}>
              <Codicon name="lightbulb" style={{ fontSize: '13px', opacity: 0.6 }} />
              <h3 style={css.sectionTitle}>{l10n.t('Proposed fix')}</h3>
            </div>
            <div className="markdown-body" style={css.summary} dangerouslySetInnerHTML={{ __html: summaryHtml }} />
          </section>
        )}

        {warnings.length > 0 && (
          <div style={css.alertWarning}>
            <Codicon name="warning" style={{ fontSize: '14px', flexShrink: 0 }} />
            <div>{warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
          </div>
        )}

        {(phase === 'ready' || phase === 'applying' || phase === 'applied') && (
          <section style={css.section}>
            <div style={css.sectionHeader}>
              <Codicon name="diff" style={{ fontSize: '13px', opacity: 0.6 }} />
              <h3 style={css.sectionTitle}>{l10n.t('Changed files')}</h3>
              {files.length > 0 && (
                <button className="gc-btn-secondary" style={{ ...css.smallBtn, marginLeft: 'auto' }} onClick={() => send({ type: 'ISSUERESOLVE_VIEW_ALL' })}>
                  <Codicon name="diff-multiple" style={{ fontSize: '13px' }} />
                  {l10n.t('View all changes')}
                </button>
              )}
            </div>
            {files.length === 0 ? (
              <div style={css.note}>{l10n.t('The AI proposed no changes.')}</div>
            ) : (
              <div style={css.fileList}>
                {files.map(f => (
                  <button key={f.path} className="icon-btn" style={css.fileRow} onClick={() => send({ type: 'ISSUERESOLVE_OPEN_DIFF', path: f.path })} title={l10n.t('Open the diff')}>
                    <span style={{ ...css.statusLetter, color: STATUS[f.status].color }}>{STATUS[f.status].letter}</span>
                    <span style={css.filePath}>{f.path}</span>
                    {f.additions > 0 && <span style={css.additions}>+{f.additions}</span>}
                    {f.deletions > 0 && <span style={css.deletions}>−{f.deletions}</span>}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {phase === 'applied' && branchName && (
          <div style={css.alertSuccess}>
            <Codicon name="pass-filled" style={{ fontSize: '14px', flexShrink: 0 }} />
            <span>{l10n.t('The changes are on the new branch "{0}", not committed yet: review them and commit from the Commit Panel.', branchName)}</span>
          </div>
        )}
      </div>

      <div style={css.footer}>
        {running && (
          <button className="gc-btn-secondary" style={css.footerBtn} onClick={() => send({ type: 'ISSUERESOLVE_CANCEL' })}>
            <Codicon name="debug-stop" style={{ fontSize: '13px' }} />
            {l10n.t('Cancel')}
          </button>
        )}
        {(phase === 'ready' || phase === 'failed' || phase === 'cancelled') && (
          <>
            <button className="gc-btn-secondary" style={css.footerBtn} onClick={() => send({ type: 'ISSUERESOLVE_DISCARD' })}>
              <Codicon name="close" style={{ fontSize: '13px' }} />
              {l10n.t('Discard')}
            </button>
            <button className="gc-btn-secondary" style={css.footerBtn} onClick={() => send({ type: 'ISSUERESOLVE_RETRY' })}>
              <Codicon name="refresh" style={{ fontSize: '13px' }} />
              {l10n.t('Try Again')}
            </button>
          </>
        )}
        {(phase === 'ready' || phase === 'applying') && (
          <button
            style={{ ...css.primaryBtn, opacity: files.length > 0 && phase === 'ready' ? 1 : 0.5 }}
            disabled={files.length === 0 || phase !== 'ready'}
            onClick={() => send({ type: 'ISSUERESOLVE_APPLY' })}
            title={l10n.t('Creates a branch from the current HEAD and writes the changes to it, without committing')}
          >
            <Codicon name={phase === 'applying' ? 'loading~spin' : 'git-branch'} style={{ fontSize: '13px' }} />
            {phase === 'applying' ? l10n.t('Applying…') : l10n.t('Apply on New Branch')}
          </button>
        )}
        {phase === 'applied' && (
          <>
            <button className="gc-btn-secondary" style={css.footerBtn} onClick={() => send({ type: 'ISSUERESOLVE_DISCARD' })}>
              {l10n.t('Close')}
            </button>
            <button style={css.primaryBtn} onClick={() => send({ type: 'ISSUERESOLVE_OPEN_COMMIT_PANEL' })}>
              <Codicon name="git-commit" style={{ fontSize: '13px' }} />
              {l10n.t('Open Commit Panel')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const css = {
  loading: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6 } as React.CSSProperties,
  page: {
    display: 'flex', flexDirection: 'column' as const, height: '100vh',
    background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)',
    fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size, 13px)',
  } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '16px 24px 12px',
    borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0,
  } as React.CSSProperties,
  headerIcon: { fontSize: '18px', color: '#bc4c9c' } as React.CSSProperties,
  headerTitle: { fontSize: '15px', fontWeight: 600 },
  headerSub: { fontSize: '12px', opacity: 0.6, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  modeChip: {
    display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '3px 9px', borderRadius: '999px', flexShrink: 0,
    background: 'color-mix(in srgb, #8957e5 18%, transparent)', color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  body: { flex: 1, overflow: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column' as const, gap: '16px' } as React.CSSProperties,
  section: { display: 'flex', flexDirection: 'column' as const, gap: '8px' } as React.CSSProperties,
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: '6px', background: 'transparent', border: 'none', padding: 0,
    color: 'inherit', textAlign: 'left' as const,
  } as React.CSSProperties,
  sectionTitle: { fontSize: '11px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', opacity: 0.6, fontWeight: 600, margin: 0 } as React.CSSProperties,
  step: (state: 'done' | 'active' | 'idle'): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '2px 0',
    opacity: state === 'idle' ? 0.45 : 1, fontWeight: state === 'active' ? 600 : 'normal',
  }),
  stepDetail: { fontSize: '11px', opacity: 0.6 } as React.CSSProperties,
  output: {
    margin: 0, maxHeight: '320px', overflow: 'auto', padding: '10px 12px', borderRadius: '6px', fontSize: '11px', lineHeight: 1.5,
    whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const, fontFamily: 'var(--vscode-editor-font-family, monospace)',
    background: 'var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-foreground) 6%, transparent))',
    border: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  summary: { border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', padding: '12px 14px', fontSize: '13px', lineHeight: 1.6 } as React.CSSProperties,
  fileList: { display: 'flex', flexDirection: 'column' as const, border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', overflow: 'hidden' } as React.CSSProperties,
  fileRow: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', fontSize: '12px', width: '100%',
    background: 'transparent', border: 'none', borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
    color: 'inherit', textAlign: 'left' as const, cursor: 'pointer',
  } as React.CSSProperties,
  statusLetter: { fontWeight: 700, width: '12px', flexShrink: 0, fontFamily: 'var(--vscode-editor-font-family, monospace)' } as React.CSSProperties,
  filePath: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontFamily: 'var(--vscode-editor-font-family, monospace)' } as React.CSSProperties,
  additions: { color: '#3fb950', fontSize: '11px', flexShrink: 0 } as React.CSSProperties,
  deletions: { color: '#f85149', fontSize: '11px', flexShrink: 0 } as React.CSSProperties,
  note: { fontSize: '12px', opacity: 0.6, fontStyle: 'italic' as const } as React.CSSProperties,
  alertError: {
    display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)', whiteSpace: 'pre-wrap' as const,
  } as React.CSSProperties,
  alertWarning: {
    display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: 'var(--vscode-inputValidation-warningForeground)', background: 'var(--vscode-inputValidation-warningBackground)',
    border: '1px solid var(--vscode-inputValidation-warningBorder)',
  } as React.CSSProperties,
  alertSuccess: {
    display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: '#3fb950', background: 'color-mix(in srgb, #3fb950 10%, transparent)', border: '1px solid color-mix(in srgb, #3fb950 25%, transparent)',
  } as React.CSSProperties,
  smallBtn: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', padding: '3px 8px' } as React.CSSProperties,
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
    padding: '12px 24px 16px', borderTop: '1px solid var(--vscode-panel-border)', flexShrink: 0,
  } as React.CSSProperties,
  footerBtn: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 14px' } as React.CSSProperties,
  primaryBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 16px', borderRadius: '3px',
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', cursor: 'pointer',
  } as React.CSSProperties,
};

createRoot(document.getElementById('root')!).render(<App />);
