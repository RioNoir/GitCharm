import { plural } from '../shared/l10n';
import * as l10n from '@vscode/l10n';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Codicon } from '../shared/Codicon';
import { getVsCodeApi, notifyHostReady } from '../shared/vscodeApi';
import { formatListDate, formatDateTime } from '../shared/dateUtils';
import { isImeComposing } from '../shared/ime';
import type { HostToRebaseMsg, RebaseAction, RebaseCommit, RebasePlanEntry, RebaseToHostMsg } from '../../host/types/messages';

// The interactive rebase editor (see host/panels/InteractiveRebasePanel.ts). Commits are listed newest first,
// as in the log; git replays them bottom-up, so squash and fixup fold a commit into the one below it.

type Init = Extract<HostToRebaseMsg, { type: 'REBASE_INIT' }>;

interface Row {
  hash: string;
  action: RebaseAction;
}

const ACTIONS: Array<{ action: RebaseAction; key: string; icon: string }> = [
  { action: 'pick', key: 'p', icon: 'check' },
  { action: 'reword', key: 'r', icon: 'edit' },
  { action: 'edit', key: 'e', icon: 'debug-pause' },
  { action: 'squash', key: 's', icon: 'fold-down' },
  { action: 'fixup', key: 'f', icon: 'combine' },
  { action: 'drop', key: 'd', icon: 'trash' },
];

function actionLabel(action: RebaseAction): string {
  switch (action) {
    case 'pick': return l10n.t({ message: 'Pick', comment: ['Interactive rebase action: the git rebase todo keyword'] });
    case 'reword': return l10n.t({ message: 'Reword', comment: ['Interactive rebase action: the git rebase todo keyword'] });
    case 'edit': return l10n.t({ message: 'Edit', comment: ['Interactive rebase action: the git rebase todo keyword'] });
    case 'squash': return l10n.t({ message: 'Squash', comment: ['Interactive rebase action: the git rebase todo keyword'] });
    case 'fixup': return l10n.t({ message: 'Fixup', comment: ['Interactive rebase action: the git rebase todo keyword'] });
    case 'drop': return l10n.t({ message: 'Drop', comment: ['Interactive rebase action: the git rebase todo keyword'] });
  }
}

function actionHint(action: RebaseAction): string {
  switch (action) {
    case 'pick': return l10n.t('Keep the commit as it is');
    case 'reword': return l10n.t('Keep the commit, with a new message');
    case 'edit': return l10n.t('Stop at the commit to amend it');
    case 'squash': return l10n.t('Fold the commit into the one below, joining their messages');
    case 'fixup': return l10n.t('Fold the commit into the one below, keeping only that message');
    case 'drop': return l10n.t('Remove the commit');
  }
}

function send(msg: RebaseToHostMsg): void {
  getVsCodeApi().postMessage(msg);
}

/**
 * The groups of the plan: each commit that stays a commit of its own (a head) and the squash/fixup commits
 * folded into it. Squash and fixup with nothing below them to fold into are invalid.
 */
function analyse(rows: Row[]) {
  const members = new Map<string, Row[]>();
  const headOf = new Map<string, string>();
  const invalid = new Set<string>();
  let head: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.action === 'drop') continue;
    if (row.action === 'squash' || row.action === 'fixup') {
      if (head === null) { invalid.add(row.hash); continue; }
      headOf.set(row.hash, head);
      members.get(head)!.push(row);
    } else {
      head = row.hash;
      headOf.set(row.hash, head);
      members.set(head, []);
    }
  }
  return { members, headOf, invalid };
}

function moveBy(rows: Row[], selected: ReadonlySet<string>, delta: -1 | 1): Row[] {
  const indexes = rows.map((r, i) => (selected.has(r.hash) ? i : -1)).filter(i => i >= 0);
  if (indexes.length === 0) return rows;
  if (delta < 0 ? indexes[0] === 0 : indexes[indexes.length - 1] === rows.length - 1) return rows;
  const next = [...rows];
  for (const i of delta < 0 ? indexes : [...indexes].reverse()) {
    [next[i + delta], next[i]] = [next[i], next[i + delta]];
  }
  return next;
}

function moveTo(rows: Row[], moving: ReadonlySet<string>, target: string, after: boolean): Row[] {
  if (moving.has(target)) return rows;
  const moved = rows.filter(r => moving.has(r.hash));
  const rest = rows.filter(r => !moving.has(r.hash));
  const at = rest.findIndex(r => r.hash === target) + (after ? 1 : 0);
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

function App() {
  const [init, setInit] = useState<Init | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  /** New messages, by group head: reworded, or the message of a squash. */
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ target: string; after: boolean } | null>(null);
  const dragging = useRef<ReadonlySet<string> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    const handler = (event: MessageEvent<HostToRebaseMsg>) => {
      const msg = event.data;
      switch (msg?.type) {
        case 'REBASE_INIT': {
          setInit(msg);
          // Newest first: the reverse of git's order.
          const initial = msg.commits.map((c, i) => ({ hash: c.hash, action: msg.actions?.[i] ?? 'pick' })).reverse();
          setRows(initial);
          setMessages({});
          setError(null);
          const first = initial[0]?.hash ?? null;
          setSelected(new Set(first ? [first] : []));
          setFocus(first);
          setAnchor(first);
          requestAnimationFrame(() => listRef.current?.focus());
          break;
        }
        case 'REBASE_BUSY':
          setBusy(msg.busy);
          break;
        case 'REBASE_ERROR':
          setError(msg.error);
          break;
      }
    };
    window.addEventListener('message', handler);
    notifyHostReady();
    return () => window.removeEventListener('message', handler);
  }, []);

  const commits = useMemo(() => new Map((init?.commits ?? []).map(c => [c.hash, c])), [init]);
  const managed = init?.mode === 'managed';
  const { members, headOf, invalid } = useMemo(() => analyse(rows), [rows]);

  const original = (hash: string) => commits.get(hash)?.message ?? '';
  const needsMessage = (head: string) =>
    managed && (rows.find(r => r.hash === head)?.action === 'reword' || (members.get(head) ?? []).some(m => m.action === 'squash'));
  const defaultMessage = (head: string) => {
    const squashed = (members.get(head) ?? []).filter(m => m.action === 'squash');
    return [original(head), ...squashed.map(m => original(m.hash))].map(m => m.trim()).join('\n\n');
  };
  const messageOf = (head: string) => messages[head] ?? defaultMessage(head);

  const initialRows = useMemo(
    () => (init?.commits ?? []).map((c, i) => ({ hash: c.hash, action: init?.actions?.[i] ?? 'pick' })).reverse(),
    [init],
  );
  const changed = Object.keys(messages).length > 0
    || rows.length !== initialRows.length || rows.some((r, i) => r.hash !== initialRows[i].hash || r.action !== initialRows[i].action);

  const problems: string[] = [];
  if (invalid.size > 0) problems.push(l10n.t('Squash and fixup fold a commit into the one below it: the oldest commit kept cannot be one.'));
  if (rows.length > 0 && rows.every(r => r.action === 'drop')) problems.push(l10n.t('Every commit is dropped. Reset the branch instead.'));
  if ([...members.keys()].some(h => needsMessage(h) && !messageOf(h).trim())) problems.push(l10n.t('A commit message cannot be empty.'));

  const setAction = (hashes: Iterable<string>, action: RebaseAction) => {
    const set = new Set(hashes);
    setRows(rs => rs.map(r => (set.has(r.hash) ? { ...r, action } : r)));
  };

  const select = (hash: string, e?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (e?.shiftKey && anchor) {
      const a = rows.findIndex(r => r.hash === anchor);
      const b = rows.findIndex(r => r.hash === hash);
      const [from, to] = a < b ? [a, b] : [b, a];
      setSelected(new Set(rows.slice(from, to + 1).map(r => r.hash)));
    } else if (e && (e.metaKey || e.ctrlKey)) {
      const next = new Set(selected);
      if (next.has(hash) && next.size > 1) next.delete(hash); else next.add(hash);
      setSelected(next);
      setAnchor(hash);
    } else {
      setSelected(new Set([hash]));
      setAnchor(hash);
    }
    setFocus(hash);
  };

  useEffect(() => {
    if (focus) rowRefs.current.get(focus)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const start = () => {
    if (busy || problems.length > 0 || !init) return;
    const plan: RebasePlanEntry[] = [...rows].reverse().map(r => {
      const entry: RebasePlanEntry = { hash: r.hash, action: r.action };
      if (members.has(r.hash) && needsMessage(r.hash)) {
        const message = messageOf(r.hash).trim();
        const squashes = (members.get(r.hash) ?? []).some(m => m.action === 'squash');
        if (squashes || message !== original(r.hash).trim()) entry.message = message;
        else entry.action = 'pick'; // reworded to the same message
      }
      return entry;
    });
    setError(null);
    send({ type: 'REBASE_START', plan });
  };

  const reset = () => {
    setRows(initialRows);
    setMessages({});
  };

  // Ctrl/Cmd+Enter starts the rebase from anywhere, the message box included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isImeComposing(e)) {
        e.preventDefault();
        start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (isImeComposing(e) || busy) return;
    const index = rows.findIndex(r => r.hash === focus);
    const step = (delta: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
      if (next) select(next.hash, { shiftKey: e.shiftKey, metaKey: false, ctrlKey: false });
    };
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setRows(rs => moveBy(rs, selected, e.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); step(-1); return;
      case 'ArrowDown': e.preventDefault(); step(1); return;
      case 'Home': e.preventDefault(); step(-rows.length); return;
      case 'End': e.preventDefault(); step(rows.length); return;
      case 'Delete':
      case 'Backspace': e.preventDefault(); setAction(selected, 'drop'); return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(rows.map(r => r.hash)));
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const shortcut = ACTIONS.find(a => a.key === e.key.toLowerCase());
    if (shortcut) {
      e.preventDefault();
      setAction(selected, shortcut.action);
    }
  };

  if (!init) {
    return <div className="ir-loading"><Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t('Loading…')}</div>;
  }

  const pushedCount = managed ? init.commits.filter(c => c.pushed).length : 0;
  const counts = ACTIONS.filter(a => a.action !== 'pick')
    .map(a => ({ ...a, n: rows.filter(r => r.action === a.action).length }))
    .filter(a => a.n > 0);
  const focusRow = rows.find(r => r.hash === focus) ?? null;

  return (
    <div className="ir-page">
      <header className="ir-header">
        <Codicon name="list-ordered" />
        <div className="ir-heading">
          <div className="ir-title">{l10n.t('Interactive Rebase')}</div>
          <div className="ir-subtitle">
            {init.onto
              ? l10n.t('{0} · rebasing "{1}" onto {2}', init.repoName, init.branch, init.onto)
              : l10n.t('{0} · rebasing "{1}" from its first commit', init.repoName, init.branch)}
          </div>
        </div>
      </header>

      {error && (
        <div className="ir-banner error" role="alert">
          <Codicon name="error" />
          <span className="ir-banner-text">{error}</span>
          <button type="button" className="ir-icon-btn" title={l10n.t('Dismiss')} aria-label={l10n.t('Dismiss')} onClick={() => setError(null)}>
            <Codicon name="close" />
          </button>
        </div>
      )}
      {pushedCount > 0 && (
        <div className="ir-banner warning">
          <Codicon name="cloud-upload" />
          <span className="ir-banner-text">
            {plural(pushedCount,
              l10n.t('1 commit has already been pushed: rewriting it means force pushing the branch.'),
              l10n.t('{0} commits have already been pushed: rewriting them means force pushing the branch.', pushedCount))}
            {init.protectedBranch && ' ' + l10n.t('"{0}" is a protected branch, which GitCharm will not force push.', init.branch)}
          </span>
        </div>
      )}
      {init.mergeCount > 0 && (
        <div className="ir-banner warning">
          <Codicon name="git-merge" />
          <span className="ir-banner-text">
            {plural(init.mergeCount,
              l10n.t('The range has 1 merge commit. The rebase flattens it: only the commits it brought in are replayed.'),
              l10n.t('The range has {0} merge commits. The rebase flattens them: only the commits they brought in are replayed.', init.mergeCount))}
          </span>
        </div>
      )}

      <div className="ir-toolbar" role="toolbar" aria-label={l10n.t('Actions')}>
        {ACTIONS.map(a => (
          <button
            key={a.action}
            type="button"
            className={`ir-tool action-${a.action}`}
            disabled={busy || selected.size === 0}
            title={`${actionHint(a.action)} (${a.key.toUpperCase()})`}
            onClick={() => setAction(selected, a.action)}
          >
            <Codicon name={a.icon} /> {actionLabel(a.action)}
          </button>
        ))}
        <span className="ir-tool-sep" />
        <button type="button" className="ir-tool" disabled={busy} title={l10n.t('Move Up (Alt+Up)')} aria-label={l10n.t('Move Up')}
          onClick={() => setRows(rs => moveBy(rs, selected, -1))}>
          <Codicon name="arrow-up" />
        </button>
        <button type="button" className="ir-tool" disabled={busy} title={l10n.t('Move Down (Alt+Down)')} aria-label={l10n.t('Move Down')}
          onClick={() => setRows(rs => moveBy(rs, selected, 1))}>
          <Codicon name="arrow-down" />
        </button>
        <span className="ir-tool-sep" />
        <button type="button" className="ir-tool" disabled={busy || !changed} title={l10n.t('Undo all changes to the plan')} onClick={reset}>
          <Codicon name="discard" /> {l10n.t('Reset')}
        </button>
      </div>

      <div className="ir-body">
        <div
          ref={listRef}
          className="ir-list"
          role="listbox"
          aria-multiselectable="true"
          aria-label={l10n.t('Commits, newest first')}
          aria-activedescendant={focus ? `row-${focus}` : undefined}
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {rows.map(row => {
            const commit = commits.get(row.hash);
            const head = headOf.get(row.hash);
            const isMember = row.action === 'squash' || row.action === 'fixup';
            const hasNewMessage = !isMember && members.has(row.hash) && needsMessage(row.hash) && messageOf(row.hash).trim() !== original(row.hash).trim();
            const subject = hasNewMessage ? messageOf(row.hash).trim().split('\n')[0] : commit?.subject ?? '';
            const into = isMember && head ? commits.get(head)?.shortHash : undefined;
            const isSelected = selected.has(row.hash);
            const dropMark = drag?.target === row.hash ? (drag.after ? ' drop-after' : ' drop-before') : '';
            return (
              <div
                key={row.hash}
                id={`row-${row.hash}`}
                ref={el => { if (el) rowRefs.current.set(row.hash, el); else rowRefs.current.delete(row.hash); }}
                role="option"
                aria-selected={isSelected}
                className={`ir-row action-${row.action}${isSelected ? ' selected' : ''}${focus === row.hash ? ' focused' : ''}${invalid.has(row.hash) ? ' invalid' : ''}${dropMark}`}
                draggable={!busy}
                onMouseDown={e => { if ((e.target as HTMLElement).closest('select')) return; select(row.hash, e); }}
                onDoubleClick={() => { if (managed) send({ type: 'REBASE_OPEN_COMMIT', hash: row.hash }); }}
                onDragStart={e => {
                  dragging.current = isSelected ? selected : new Set([row.hash]);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', row.hash);
                }}
                onDragOver={e => {
                  if (!dragging.current) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > rect.top + rect.height / 2;
                  if (drag?.target !== row.hash || drag.after !== after) setDrag({ target: row.hash, after });
                }}
                onDrop={e => {
                  e.preventDefault();
                  if (dragging.current && drag) setRows(rs => moveTo(rs, dragging.current!, drag.target, drag.after));
                  dragging.current = null;
                  setDrag(null);
                }}
                onDragEnd={() => { dragging.current = null; setDrag(null); }}
              >
                <Codicon name="gripper" className="ir-grip" />
                <select
                  className="ir-action"
                  value={row.action}
                  disabled={busy}
                  aria-label={l10n.t('Action for {0}', commit?.shortHash ?? row.hash)}
                  title={actionHint(row.action)}
                  onChange={e => setAction(isSelected ? selected : [row.hash], e.target.value as RebaseAction)}
                >
                  {ACTIONS.map(a => <option key={a.action} value={a.action}>{actionLabel(a.action)}</option>)}
                </select>
                <span className="ir-hash">{commit?.shortHash ?? row.hash.slice(0, 8)}</span>
                <span className="ir-subject" title={subject}>
                  {isMember && <Codicon name="arrow-small-down" className="ir-into" title={into ? l10n.t('Folded into {0}', into) : undefined} />}
                  {subject}
                  {hasNewMessage && <span className="ir-tag">{l10n.t('new message')}</span>}
                </span>
                {commit?.pushed && managed && <Codicon name="cloud" className="ir-pushed" title={l10n.t('Pushed')} />}
                <span className="ir-author">{commit?.authorName}</span>
                <span className="ir-date" title={commit?.authorDate ? formatDateTime(commit.authorDate) : undefined}>
                  {commit?.authorDate ? formatListDate(commit.authorDate) : ''}
                </span>
              </div>
            );
          })}
        </div>

        <aside className="ir-details" aria-label={l10n.t('Commit details')}>
          {focusRow && selected.size === 1
            ? <Details
                row={focusRow}
                commit={commits.get(focusRow.hash)}
                headCommit={commits.get(headOf.get(focusRow.hash) ?? '')}
                managed={managed}
                busy={busy}
                editable={needsMessage(headOf.get(focusRow.hash) ?? '')}
                message={messageOf(headOf.get(focusRow.hash) ?? focusRow.hash)}
                edited={(headOf.get(focusRow.hash) ?? '') in messages}
                onMessage={m => { const h = headOf.get(focusRow.hash); if (h) setMessages(ms => ({ ...ms, [h]: m })); }}
                onResetMessage={() => {
                  const h = headOf.get(focusRow.hash);
                  if (h) setMessages(ms => { const next = { ...ms }; delete next[h]; return next; });
                }}
              />
            : <div className="ir-details-empty">
                {selected.size > 1
                  ? plural(selected.size, l10n.t('1 commit selected'), l10n.t('{0} commits selected', selected.size))
                  : l10n.t('Select a commit to see its message.')}
              </div>}
        </aside>
      </div>

      <footer className="ir-footer">
        <div className="ir-summary">
          {problems.length > 0
            ? <span className="ir-problem"><Codicon name="warning" /> {problems[0]}</span>
            : <>
                {plural(rows.length, l10n.t('1 commit'), l10n.t('{0} commits', rows.length))}
                {counts.map(c => <span key={c.action} className={`ir-count action-${c.action}`}>· {actionLabel(c.action)} {c.n}</span>)}
              </>}
        </div>
        <button type="button" className="gc-btn-secondary ir-cancel" disabled={busy} onClick={() => send({ type: 'REBASE_CANCEL' })}>
          <Codicon name="close" />
          {managed ? l10n.t('Cancel') : l10n.t('Abort Rebase')}
        </button>
        <button type="button" className="ir-btn primary" disabled={busy || problems.length > 0} onClick={start}
          title={l10n.t('Start Rebasing (Ctrl+Enter)')}>
          {busy ? <><Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t('Rebasing…')}</> : l10n.t('Start Rebasing')}
        </button>
      </footer>
    </div>
  );
}

function Details({ row, commit, headCommit, managed, busy, editable, message, edited, onMessage, onResetMessage }: {
  row: Row;
  commit?: RebaseCommit;
  headCommit?: RebaseCommit;
  managed: boolean;
  busy: boolean;
  editable: boolean;
  message: string;
  edited: boolean;
  onMessage: (message: string) => void;
  onResetMessage: () => void;
}) {
  const isMember = row.action === 'squash' || row.action === 'fixup';
  return (
    <div className="ir-details-inner">
      <div className="ir-details-head">
        <span className="ir-hash">{commit?.shortHash}</span>
        <span className="ir-muted">{commit?.authorName}{commit?.authorDate && ` · ${formatDateTime(commit.authorDate)}`}</span>
        {managed && commit && (
          <button type="button" className="ir-link" onClick={() => send({ type: 'REBASE_OPEN_COMMIT', hash: commit.hash })}>
            <Codicon name="go-to-file" /> {l10n.t('Show Commit')}
          </button>
        )}
      </div>

      {isMember && headCommit && (
        <p className="ir-note">
          <Codicon name="arrow-small-down" />
          {row.action === 'squash'
            ? l10n.t('Folded into {0}, its message joined to that commit\'s.', headCommit.shortHash)
            : l10n.t('Folded into {0}, its message discarded.', headCommit.shortHash)}
        </p>
      )}
      {row.action === 'edit' && <p className="ir-note"><Codicon name="debug-pause" /> {l10n.t('The rebase stops after this commit, for you to amend it. Continue it from the Commit Panel.')}</p>}
      {row.action === 'drop' && <p className="ir-note"><Codicon name="trash" /> {l10n.t('This commit is removed from the branch.')}</p>}
      {!managed && (row.action === 'reword' || row.action === 'squash') && (
        <p className="ir-note"><Codicon name="info" /> {l10n.t('git asks for the new message when it gets to this commit.')}</p>
      )}

      {editable ? (
        <>
          <div className="ir-section-label">
            {isMember || row.action !== 'reword' ? l10n.t('Message of the squashed commit') : l10n.t('New message')}
            {edited && (
              <button type="button" className="ir-link" onClick={onResetMessage}>{l10n.t('Reset message')}</button>
            )}
          </div>
          <textarea
            className="ir-message"
            value={message}
            disabled={busy}
            spellCheck
            aria-label={l10n.t('Commit message')}
            onChange={e => onMessage(e.target.value)}
          />
          {isMember && (
            <div className="ir-section-label">{l10n.t('Original message')}</div>
          )}
          {isMember && <pre className="ir-original">{commit?.message}</pre>}
        </>
      ) : (
        <>
          <div className="ir-section-label">{l10n.t('Message')}</div>
          <pre className="ir-original">{commit?.message}</pre>
        </>
      )}
    </div>
  );
}

const CSS = `
html, body, #root { height: 100%; margin: 0; }
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
.ir-loading { display: flex; align-items: center; gap: 8px; padding: 16px 20px; color: var(--vscode-descriptionForeground); }
.ir-page { height: 100vh; display: flex; flex-direction: column; box-sizing: border-box; padding: 12px 16px; gap: 8px; }
.ir-header { display: flex; align-items: center; gap: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.ir-header > .codicon { font-size: 20px; color: var(--vscode-descriptionForeground); }
.ir-title { font-size: 14px; font-weight: 600; }
.ir-subtitle { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.ir-banner { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; border-radius: 3px; font-size: 12px; line-height: 1.45; border: 1px solid; }
.ir-banner .codicon { margin-top: 1px; flex-shrink: 0; }
.ir-banner-text { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; }
.ir-banner.warning { background: var(--vscode-inputValidation-warningBackground); border-color: var(--vscode-inputValidation-warningBorder); color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); }
.ir-banner.error { background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder); color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground)); }
.ir-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
.ir-tool { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border: none; border-radius: 3px; background: none; color: var(--vscode-foreground); font: inherit; font-size: 12px; cursor: pointer; }
.ir-tool:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
.ir-tool:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.ir-tool:disabled { opacity: 0.45; cursor: default; }
.ir-tool-sep { width: 1px; height: 16px; margin: 0 4px; background: var(--vscode-panel-border); }
.ir-body { flex: 1; min-height: 0; display: flex; gap: 12px; }
.ir-list { flex: 3; min-width: 0; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 3px; outline: none; }
.ir-list:focus-visible { border-color: var(--vscode-focusBorder); }
.ir-row { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px 0 4px; border-top: 2px solid transparent; border-bottom: 2px solid transparent; cursor: default; user-select: none; }
.ir-row:hover { background: var(--vscode-list-hoverBackground); }
.ir-row.selected { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
.ir-list:focus .ir-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground, inherit); }
.ir-list:focus .ir-row.focused { outline: 1px solid var(--vscode-list-focusOutline, var(--vscode-focusBorder)); outline-offset: -1px; }
.ir-row.drop-before { border-top-color: var(--vscode-focusBorder); }
.ir-row.drop-after { border-bottom-color: var(--vscode-focusBorder); }
.ir-grip { opacity: 0.4; cursor: grab; flex-shrink: 0; }
.ir-row:hover .ir-grip { opacity: 0.8; }
.ir-action { width: 84px; flex-shrink: 0; padding: 1px 2px; font: inherit; font-size: 12px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 2px; }
.ir-action:focus { outline: 1px solid var(--vscode-focusBorder); }
.ir-hash { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-textLink-foreground); flex-shrink: 0; }
.ir-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
.ir-tag { flex-shrink: 0; font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.ir-pushed { opacity: 0.7; flex-shrink: 0; }
.ir-author { width: 120px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; }
.ir-date { width: 90px; flex-shrink: 0; text-align: right; color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
.ir-row.action-squash .ir-subject, .ir-row.action-fixup .ir-subject { padding-left: 14px; color: var(--vscode-descriptionForeground); }
.ir-row.action-drop .ir-subject, .ir-row.action-drop .ir-hash { text-decoration: line-through; opacity: 0.6; }
.ir-row.invalid .ir-action { border-color: var(--vscode-inputValidation-errorBorder); }
.action-reword .ir-action, .ir-tool.action-reword .codicon, .ir-count.action-reword { color: var(--vscode-charts-blue); }
.action-edit .ir-action, .ir-tool.action-edit .codicon, .ir-count.action-edit { color: var(--vscode-charts-orange); }
.action-squash .ir-action, .ir-tool.action-squash .codicon, .ir-count.action-squash,
.action-fixup .ir-action, .ir-tool.action-fixup .codicon, .ir-count.action-fixup { color: var(--vscode-charts-purple); }
.action-drop .ir-action, .ir-tool.action-drop .codicon, .ir-count.action-drop { color: var(--vscode-errorForeground); }
.ir-details { flex: 2; min-width: 260px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
.ir-details-inner { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; min-height: calc(100% - 20px); box-sizing: border-box; }
.ir-details-empty { padding: 16px 12px; color: var(--vscode-descriptionForeground); }
.ir-details-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ir-muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
.ir-link { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; padding: 0; border: none; background: none; color: var(--vscode-textLink-foreground); font: inherit; font-size: 12px; cursor: pointer; }
.ir-link:hover { color: var(--vscode-textLink-activeForeground); }
.ir-link:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.ir-note { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.45; }
.ir-note .codicon { margin-top: 1px; }
.ir-section-label { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
.ir-section-label .ir-link { text-transform: none; letter-spacing: normal; font-weight: normal; }
.ir-message { flex: 1; min-height: 140px; resize: vertical; box-sizing: border-box; width: 100%; padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.5; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
.ir-message:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.ir-original { margin: 0; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.5; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12)); border-radius: 2px; }
.ir-footer { display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
.ir-summary { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.ir-problem { display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
.ir-cancel { display: inline-flex; align-items: center; gap: 6px; padding: 6px 16px; font-size: 13px; }
.ir-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 16px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; font: inherit; font-size: 13px; cursor: pointer; }
.ir-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.ir-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.ir-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.ir-btn:disabled { opacity: 0.5; cursor: default; }
@media (max-width: 760px) {
  .ir-body { flex-direction: column; }
  .ir-details { flex: 0 0 auto; max-height: 45%; min-width: 0; }
  .ir-author { display: none; }
}
@media (max-width: 480px) {
  .ir-date { display: none; }
}
`;

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
