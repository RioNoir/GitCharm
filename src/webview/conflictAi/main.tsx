import { plural } from '../shared/l10n';
import * as l10n from '@vscode/l10n';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Codicon } from '../shared/Codicon';
import { getVsCodeApi, notifyHostReady } from '../shared/vscodeApi';
import type { ConflictAiToHostMsg, HostToConflictAiMsg } from '../../host/types/messages';

// The live view of an AI conflict resolution (see host/panels/ConflictAiPanel.ts): per file, each conflict with
// the model's explanation and resolved lines as they're written, and both original sides for comparison.

type HunkStatus = 'running' | 'done' | 'failed';

interface HunkView {
  index: number;
  line: number;
  currentLabel: string;
  incomingLabel: string;
  current: string;
  incoming: string;
  base?: string;
  status: HunkStatus;
  explanation: string;
  resolution: string;
  error?: string;
}

interface FileView {
  key: string;
  path: string;
  hunks: HunkView[];
  done?: { resolved: number; failed: number; staged: boolean; error?: string };
}

function send(msg: ConflictAiToHostMsg): void {
  getVsCodeApi().postMessage(msg);
}

function App() {
  const [modelLabel, setModelLabel] = useState('');
  const [files, setFiles] = useState<FileView[]>([]);
  const [finished, setFinished] = useState<{ cancelled: boolean } | null>(null);

  useEffect(() => {
    const updateHunk = (fileKey: string, index: number, patch: Partial<HunkView>) =>
      setFiles(fs => fs.map(f => (f.key !== fileKey ? f : { ...f, hunks: f.hunks.map(h => (h.index === index ? { ...h, ...patch } : h)) })));
    const handler = (event: MessageEvent<HostToConflictAiMsg>) => {
      const msg = event.data;
      switch (msg?.type) {
        case 'CONFLICTAI_RESET':
          setModelLabel(msg.modelLabel);
          setFiles([]);
          setFinished(null);
          break;
        case 'CONFLICTAI_FILE':
          setFiles(fs => [...fs.filter(f => f.key !== msg.fileKey), { key: msg.fileKey, path: msg.path, hunks: [] }]);
          break;
        case 'CONFLICTAI_HUNK_START':
          setFiles(fs => fs.map(f => (f.key !== msg.fileKey ? f : {
            ...f,
            hunks: [...f.hunks.filter(h => h.index !== msg.index), {
              index: msg.index, line: msg.line, currentLabel: msg.currentLabel, incomingLabel: msg.incomingLabel,
              current: msg.current, incoming: msg.incoming, base: msg.base, status: 'running' as const, explanation: '', resolution: '',
            }].sort((a, b) => a.index - b.index),
          })));
          break;
        case 'CONFLICTAI_HUNK_PROGRESS':
          updateHunk(msg.fileKey, msg.index, { explanation: msg.explanation, resolution: msg.resolution });
          break;
        case 'CONFLICTAI_HUNK_DONE':
          updateHunk(msg.fileKey, msg.index, { status: 'done', explanation: msg.explanation, resolution: msg.resolution });
          break;
        case 'CONFLICTAI_HUNK_FAILED':
          updateHunk(msg.fileKey, msg.index, { status: 'failed', error: msg.error });
          break;
        case 'CONFLICTAI_FILE_DONE':
          setFiles(fs => fs.map(f => (f.key !== msg.fileKey ? f : { ...f, done: { resolved: msg.resolved, failed: msg.failed, staged: msg.staged, error: msg.error } })));
          break;
        case 'CONFLICTAI_RUN_DONE':
          setFinished({ cancelled: msg.cancelled });
          break;
      }
    };
    window.addEventListener('message', handler);
    notifyHostReady();
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div className="ca-page">
      <header className="ca-header">
        <Codicon name="sparkle" />
        <span className="ca-title">{l10n.t('AI Conflict Resolution')}</span>
        {modelLabel && <span className="ca-model">{modelLabel}</span>}
      </header>
      {files.length === 0 && (
        <div className="ca-empty"><Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t('Reading the conflicts…')}</div>
      )}
      {files.map(file => <FileSection key={file.key} file={file} />)}
      {finished && (
        <div className="ca-finished">
          <Codicon name={finished.cancelled ? 'circle-slash' : 'check-all'} />
          {finished.cancelled ? l10n.t('Cancelled.') : l10n.t('Done.')}
        </div>
      )}
    </div>
  );
}

function FileSection({ file }: { file: FileView }) {
  const done = file.done;
  return (
    <section className="ca-file">
      <div className="ca-file-head">
        <Codicon name="file" />
        <span className="ca-file-path">{file.path}</span>
        {!done && <span className="ca-badge running"><Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t('Resolving…')}</span>}
        {done?.error && <span className="ca-badge failed"><Codicon name="error" /> {done.error}</span>}
        {done && !done.error && done.staged && <span className="ca-badge ok"><Codicon name="pass" /> {l10n.t('Resolved and staged')}</span>}
        {done && !done.error && !done.staged && done.failed > 0 && (
          <span className="ca-badge failed"><Codicon name="warning" /> {plural(done.failed, l10n.t('1 conflict left'), l10n.t('{0} conflicts left', done.failed))}</span>
        )}
        {done && !done.error && !done.staged && done.failed === 0 && done.resolved > 0 && (
          <span className="ca-badge ok"><Codicon name="pass" /> {l10n.t('Resolved — other conflicts remain in the file')}</span>
        )}
      </div>
      {file.hunks.map(h => <HunkCard key={h.index} file={file} hunk={h} />)}
    </section>
  );
}

function HunkCard({ file, hunk }: { file: FileView; hunk: HunkView }) {
  const [showSides, setShowSides] = useState(false);
  return (
    <article className={`ca-hunk ${hunk.status}`}>
      <div className="ca-hunk-head">
        {hunk.status === 'running' && <Codicon name="loading" className="codicon-modifier-spin" />}
        {hunk.status === 'done' && <Codicon name="pass" className="ca-ok" />}
        {hunk.status === 'failed' && <Codicon name="error" className="ca-err" />}
        <span className="ca-hunk-title">{l10n.t('Conflict at line {0}', hunk.line + 1)}</span>
        <button type="button" className="ca-link" onClick={() => send({ type: 'CONFLICTAI_OPEN_FILE', path: file.key, line: hunk.line })}>
          <Codicon name="go-to-file" /> {l10n.t('Open')}
        </button>
      </div>

      {(hunk.explanation || hunk.status !== 'failed') && (
        <>
          <div className="ca-section-label"><Codicon name="lightbulb" /> {l10n.t('Reasoning')}</div>
          <p className="ca-explanation">
            {hunk.explanation || (hunk.status === 'running'
              ? <span className="ca-muted">{l10n.t('Thinking…')}</span>
              : <span className="ca-muted">{l10n.t('No explanation given.')}</span>)}
            {hunk.status === 'running' && hunk.explanation && !hunk.resolution && <span className="ca-caret" />}
          </p>
        </>
      )}

      {hunk.status === 'failed' ? (
        <div className="ca-error">{hunk.error}</div>
      ) : (hunk.resolution || hunk.status === 'done') && (
        <>
          <div className="ca-section-label"><Codicon name="check" /> {l10n.t('Resolution')}</div>
          <pre className="ca-code resolution">{hunk.resolution || ' '}{hunk.status === 'running' && <span className="ca-caret" />}</pre>
        </>
      )}

      <button type="button" className="ca-toggle" aria-expanded={showSides} onClick={() => setShowSides(s => !s)}>
        <Codicon name={showSides ? 'chevron-down' : 'chevron-right'} /> {l10n.t('Original sides')}
      </button>
      {showSides && (
        <div className="ca-sides">
          <div>
            <div className="ca-side-label current">{l10n.t('Current')}{hunk.currentLabel && ` · ${hunk.currentLabel}`}</div>
            <pre className="ca-code current">{hunk.current || ' '}</pre>
          </div>
          <div>
            <div className="ca-side-label incoming">{l10n.t('Incoming')}{hunk.incomingLabel && ` · ${hunk.incomingLabel}`}</div>
            <pre className="ca-code incoming">{hunk.incoming || ' '}</pre>
          </div>
          {hunk.base !== undefined && (
            <div className="ca-side-base">
              <div className="ca-side-label">{l10n.t('Common ancestor')}</div>
              <pre className="ca-code">{hunk.base || ' '}</pre>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

const CSS = `
.ca-page { height: 100vh; overflow-y: auto; box-sizing: border-box; padding: 16px 20px 32px; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
.ca-header { display: flex; align-items: center; gap: 8px; padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.ca-title { font-size: 14px; font-weight: 600; }
.ca-model { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
.ca-empty, .ca-finished { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); padding: 8px 0; }
.ca-file { margin-bottom: 18px; }
.ca-file-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ca-file-path { font-weight: 600; font-family: var(--vscode-editor-font-family); font-size: 12px; }
.ca-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); }
.ca-badge.ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #89d185) 50%, transparent); }
.ca-badge.failed { color: var(--vscode-errorForeground); border-color: color-mix(in srgb, var(--vscode-errorForeground) 50%, transparent); }
.ca-badge.running { color: var(--vscode-descriptionForeground); }
.ca-hunk { border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35)); border-radius: 4px; padding: 10px 12px; margin-bottom: 8px; background: var(--vscode-input-background); }
.ca-hunk.running { border-color: color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent); }
.ca-hunk-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.ca-hunk-title { font-weight: 600; flex: 1; }
.ca-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.ca-err { color: var(--vscode-errorForeground); }
.ca-link, .ca-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: none; background: none; font: inherit; font-size: 12px; cursor: pointer; }
.ca-link { color: var(--vscode-textLink-foreground); }
.ca-link:hover { color: var(--vscode-textLink-activeForeground); }
.ca-toggle { color: var(--vscode-descriptionForeground); margin-top: 8px; }
.ca-toggle:hover { color: var(--vscode-foreground); }
.ca-section-label { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin: 6px 0 4px; }
.ca-explanation { margin: 0 0 4px; line-height: 1.5; white-space: pre-wrap; }
.ca-muted { color: var(--vscode-descriptionForeground); font-style: italic; }
.ca-code { margin: 0; padding: 8px 10px; border-radius: 3px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.5; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12)); white-space: pre; }
.ca-code.resolution { border-left: 2px solid var(--vscode-testing-iconPassed, var(--vscode-charts-green, #89d185)); }
.ca-code.current { border-left: 2px solid var(--vscode-merge-currentHeaderBackground, #4fc3f7); }
.ca-code.incoming { border-left: 2px solid var(--vscode-merge-incomingHeaderBackground, #ba68c8); }
.ca-sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin-top: 6px; }
.ca-side-base { grid-column: 1 / -1; }
.ca-side-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
.ca-error { font-size: 12px; padding: 6px 8px; border-radius: 3px; color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground)); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
.ca-caret { display: inline-block; width: 1px; height: 1em; margin-left: 1px; vertical-align: text-bottom; background: var(--vscode-editorCursor-foreground, var(--vscode-foreground)); animation: ca-blink 1s steps(1) infinite; }
@keyframes ca-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .ca-caret { animation: none; } }
`;

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
