import * as l10n from '@vscode/l10n';
import React, { useEffect, useState } from 'react';
import { Codicon } from '../shared/Codicon';
import type { PreviewId } from './layout';
import { modelPrefix, normalizeBranchModels } from '../../host/types/branchModels';

// Mock-ups of GitCharm's UI, redrawn from the values being edited, so a setting's effect is visible before going
// looking for it. Each plays a short scene in a loop (selecting files, moving through commits…). They're
// illustrations: sample names and data, theme colors, no real repo data except repository names and colors.

interface PreviewProps {
  get<T>(key: string): T;
  repos: { name: string; color: string }[];
}

const SAMPLE_REPOS = [
  { name: 'web-app', color: '#4fc3f7' },
  { name: 'api', color: '#ffb74d' },
  { name: 'shared-ui', color: '#ba68c8' },
];

/**
 * The workspace's repositories (with their configured colors) for a mock-up that needs at least `min` of them:
 * sample repositories fill in for the missing ones, so a single-repository workspace still gets a full scene.
 */
function effectiveRepos(repos: PreviewProps['repos'], colors: Record<string, string>, min = 1) {
  const list = repos.slice(0, 4);
  for (const sample of SAMPLE_REPOS) {
    if (list.length >= min) break;
    if (!list.some(r => r.name === sample.name)) list.push(sample);
  }
  return list.map(r => ({ name: r.name, color: colors[r.name] ?? r.color }));
}

const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The current step of a scene of `length` steps, advancing every `intervalMs` and starting over. With reduced
 * motion the scene doesn't play: it stays on `restStep`, a frame that still shows what the setting does.
 */
function useLoop(length: number, intervalMs: number, restStep: number): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    setStep(0);
    const timer = setInterval(() => setStep(s => (s + 1) % length), intervalMs);
    return () => clearInterval(timer);
  }, [length, intervalMs]);
  return reducedMotion ? restStep : step % length;
}

/** A broken mock-up must never take the settings page down with it: it's dropped, the settings stay. */
class PreviewBoundary extends React.Component<{ children: React.ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('GitCharm settings preview failed', error);
  }

  componentDidUpdate(prev: { resetKey: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function Preview(props: PreviewProps & { id: PreviewId }) {
  return (
    <PreviewBoundary resetKey={props.id}>
      <PreviewContent {...props} />
    </PreviewBoundary>
  );
}

function PreviewContent({ id, ...props }: PreviewProps & { id: PreviewId }) {
  return (
    <figure className="gc-preview" aria-label={l10n.t('Preview')}>
      <figcaption className="gc-preview-caption">{l10n.t('Preview')}</figcaption>
      <div className="gc-preview-body" aria-hidden="true">
        {id === 'changesView' && <ChangesViewPreview {...props} />}
        {id === 'gitLog' && <GitLogPreview {...props} />}
        {id === 'repositories' && <RepositoriesPreview {...props} />}
        {id === 'branches' && <BranchesPreview {...props} />}
        {id === 'notifications' && <NotificationsPreview {...props} />}
        {id === 'editor' && <EditorPreview {...props} />}
      </div>
    </figure>
  );
}

// ── Commit & Changes ────────────────────────────────────────────────────────

type Check = 'on' | 'off' | 'some';

/** The Commit Panel's checkbox: filled when checked, a dash when partly checked. */
function Cb({ state }: { state: Check }) {
  return (
    <span className={`pv-cb ${state}`}>
      {state === 'on' && <Codicon name="check" />}
      {state === 'some' && <Codicon name="remove" />}
    </span>
  );
}

/** Repository row: checkbox, chevron, color dot, upper-case name, branch pill, selected/total count. */
function RepoRow({ repo, check, count, collapsed, indent = 0, badge, className }: {
  repo: { name: string; color: string }; check?: Check; count?: string; collapsed?: boolean; indent?: number; badge?: boolean; className?: string;
}) {
  return (
    <div className={`pv-repo${className ? ` ${className}` : ''}`} style={{ paddingLeft: 4 + indent * 10 }}>
      {check && <Cb state={check} />}
      <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={{ fontSize: 11 }} />
      <span className="pv-dot" style={{ background: repo.color, width: 6, height: 6 }} />
      <span className="pv-repo-name">{repo.name.toUpperCase()}</span>
      <span className="pv-branch"><Codicon name="git-branch" style={{ fontSize: 9 }} />main</span>
      {count && <span className={badge ? 'pv-count' : 'pv-num'}>{count}</span>}
    </div>
  );
}

/** Section row of the Changelists / VS Code views: CHANGES, a changelist, UNVERSIONED FILES, STAGED CHANGES… */
function GroupRow({ label, icon, check, count, accent }: { label: string; icon: string; check?: Check; count: string; accent?: boolean }) {
  return (
    <div className={`pv-group${accent ? ' accent' : ''}`}>
      {check && <Cb state={check} />}
      <Codicon name="chevron-down" style={{ fontSize: 11 }} />
      <Codicon name={icon} style={{ fontSize: 11 }} />
      <span className="pv-grow">{label}</span>
      <span className="pv-count">{count}</span>
    </div>
  );
}

const FILE_ICON: Record<string, { icon: string; color: string }> = {
  git: { icon: 'source-control', color: '#f1502f' },
  json: { icon: 'json', color: '#cbcb41' },
  py: { icon: 'file-code', color: '#4b8bbe' },
  folder: { icon: 'folder', color: '#dcb67a' },
};

function FileRow({ name, kind, status, check, indent = 1, count, className }: {
  name: string; kind: keyof typeof FILE_ICON; status?: 'M' | 'U'; check?: Check; indent?: number; count?: number; className?: string;
}) {
  const icon = FILE_ICON[kind];
  return (
    <div className={`pv-file${className ? ` ${className}` : ''}`} style={{ paddingLeft: 4 + indent * 10 }}>
      {check && <Cb state={check} />}
      {kind === 'folder' && <Codicon name="chevron-right" style={{ fontSize: 11 }} />}
      <Codicon name={icon.icon} style={{ fontSize: 11, color: icon.color }} />
      <span className={`pv-grow pv-ellipsis${status === 'U' ? ' s-U-text' : status === 'M' ? ' s-M-text' : ''}`}>{name}</span>
      {status ? <span className={`pv-status s-${status}`}>{status}</span> : <span className="pv-num">{count}</span>}
    </div>
  );
}

const COMMIT_MESSAGE = 'Fix date formatting';

/**
 * Scene: a file of the second repository is hovered, then selected (or staged, in the VS Code view); the
 * commit message types itself; the main button is pressed; the panel confirms the commit.
 */
function ChangesViewPreview({ get, repos }: PreviewProps) {
  const step = useLoop(11, 650, 6);
  const mode = get<string>('changesViewMode');
  const commitAndPush = get<string>('defaultCommitAction') === 'commitAndPush';
  const shelve = get<string>('defaultSaveAction') === 'shelve';
  const [front, back, third] = effectiveRepos(repos, get<Record<string, string>>('projectColors'), 3);
  const simplified = mode !== 'changelists' && mode !== 'vscode';

  const hover = step === 1;
  const picked = step >= 2 && step < 9;
  const typed = step < 3 || step >= 8 ? 0 : step >= 6 ? COMMIT_MESSAGE.length : Math.round(COMMIT_MESSAGE.length * (step - 2) / 4);
  const pressed = step === 7;
  const done = step >= 8 && step < 10;
  const hot = hover ? 'pv-hot' : picked && step === 2 ? 'pv-flash' : undefined;
  const backPicked = picked || done;

  return (
    <div className="pv-panel pv-commit">
      <div className="pv-commit-title">GitCharm Commit</div>
      <div className="pv-commit-tabs">
        <span className="pv-commit-tab active"><Codicon name="git-branch" style={{ fontSize: 11 }} />{simplified ? 'Changes' : 'Commit'}<span className="pv-count">{simplified ? 9 : 10}</span></span>
        <Codicon name="archive" style={{ fontSize: 11, opacity: 0.6 }} />
        <Codicon name="cloud-download" style={{ fontSize: 11, opacity: 0.6 }} />
        <Codicon name="git-pull-request" style={{ fontSize: 11, opacity: 0.6 }} />
      </div>
      <div className="pv-content">
        {simplified && (
          <>
            <RepoRow repo={front} check="on" count="3/3" badge />
            <FileRow name=".gitignore" kind="git" status="M" check="on" />
            <FileRow name="components.json" kind="json" status="M" check="on" />
            <FileRow name="lib" kind="folder" check="on" count={1} />
            <RepoRow repo={back} check={backPicked ? 'some' : 'off'} count={backPicked ? '1/2' : '0/2'} badge={backPicked} />
            <FileRow name="main.py" kind="py" status="M" check={backPicked ? 'on' : 'off'} className={hot} />
            <FileRow name="config.py" kind="py" status="M" check="off" />
            <RepoRow repo={third} check="some" count="2/4" badge />
            <FileRow name="app" kind="folder" check="some" count={2} />
            <FileRow name="launcher.py" kind="py" status="M" check="on" />
          </>
        )}
        {mode === 'changelists' && (
          <>
            <GroupRow label="CHANGES" icon="diff-multiple" check="some" count="3/5" />
            <RepoRow repo={front} check="on" count="3/3" indent={1} />
            <FileRow name=".gitignore" kind="git" status="M" check="on" indent={2} />
            <FileRow name="components.json" kind="json" status="M" check="on" indent={2} />
            <RepoRow repo={back} check="off" count="0/2" indent={1} collapsed />
            <GroupRow label="CUSTOM CHANGELIST" icon="list-flat" check="some" count="2/4" />
            <RepoRow repo={third} check="some" count="2/4" indent={1} />
            <FileRow name="launcher.py" kind="py" status="M" check="on" indent={2} />
            <GroupRow label="UNVERSIONED FILES" icon="question" check={backPicked ? 'on' : 'off'} count={backPicked ? '1/1' : '0/1'} />
            <RepoRow repo={back} check={backPicked ? 'on' : 'off'} count={backPicked ? '1/1' : '0/1'} indent={1} />
            <FileRow name="file.json" kind="json" status="U" check={backPicked ? 'on' : 'off'} indent={2} className={hot} />
          </>
        )}
        {mode === 'vscode' && (
          <>
            <GroupRow label="STAGED CHANGES" icon="git-commit" count={backPicked ? '10' : '9'} accent />
            <RepoRow repo={front} check="on" count="3" />
            <FileRow name=".gitignore" kind="git" status="M" />
            <FileRow name="components.json" kind="json" status="M" />
            <RepoRow repo={third} check="on" count="4" />
            <FileRow name="launcher.py" kind="py" status="M" />
            {backPicked && (
              <>
                <RepoRow repo={back} check="on" count="1" className="pv-in" />
                <FileRow name="file.json" kind="json" status="U" className={`pv-in${step === 2 ? ' pv-flash' : ''}`} />
              </>
            )}
            {!backPicked && (
              <>
                <GroupRow label="CHANGES" icon="diff-multiple" count="1" />
                <RepoRow repo={back} count="1" />
                <FileRow name="file.json" kind="json" status="U" className={hot} />
              </>
            )}
          </>
        )}
      </div>
      <div className="pv-commitbox">
        <div className="pv-chips">
          <span className="pv-chip" style={{ color: front.color, borderColor: front.color }}>× {front.name.toLowerCase()} <b>3</b></span>
          <span className="pv-chip" style={{ color: third.color, borderColor: third.color }}>× {third.name.toLowerCase()} <b>2</b></span>
          {picked && <span key="back" className="pv-chip pv-in" style={{ color: back.color, borderColor: back.color }}>× {back.name.toLowerCase()} <b>1</b></span>}
        </div>
        <div className="pv-textarea">
          {done ? (
            <span className="pv-in pv-committed"><Codicon name="pass" style={{ fontSize: 11 }} /> {commitAndPush ? l10n.t('Committed and pushed 6 files') : l10n.t('Committed 6 files')}</span>
          ) : typed > 0 ? (
            <span>{COMMIT_MESSAGE.slice(0, typed)}{typed < COMMIT_MESSAGE.length && <span className="pv-caret" />}</span>
          ) : (
            <span className="pv-muted">Commit message (Cmd+Enter to commit)</span>
          )}
          <Codicon name="sparkle" style={{ fontSize: 11, marginLeft: 'auto', opacity: 0.7 }} />
        </div>
        <div className="pv-buttons">
          <span className="pv-btn"><Codicon name={shelve ? 'archive' : 'git-stash'} style={{ fontSize: 11 }} />{shelve ? 'Shelve' : 'Stash'}<span className="pv-btn-split"><Codicon name="chevron-down" style={{ fontSize: 10 }} /></span></span>
          <span className={`pv-btn primary pv-grow${pressed ? ' pv-pressed' : ''}`}>
            <span className="pv-grow pv-center"><Codicon name="check" style={{ fontSize: 11 }} /> {commitAndPush ? 'Commit and Push' : 'Commit'}</span>
            <span className="pv-btn-split"><Codicon name="chevron-down" style={{ fontSize: 10 }} /></span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Git Log ─────────────────────────────────────────────────────────────────

const GRAPH_ROWS = [
  { msg: 'Add login form validation', author: 'Alex Kim', hash: 'a1b2c3d', when: '2h', lane: 0 },
  { msg: 'Merge branch feature/search', author: 'Sam Rivera', hash: '9f8e7d6', when: '5h', lane: 0 },
  { msg: 'Improve search ranking', author: 'Sam Rivera', hash: 'e4f5a6b', when: '1d', lane: 1 },
  { msg: 'Fix date formatting', author: 'Alex Kim', hash: '3c4d5e6', when: '2d', lane: 0 },
  { msg: 'Bump dependencies', author: 'Jo Chen', hash: '7a8b9c0', when: '3d', lane: 0 },
];

function MiniGraph({ uncommitted, color, compact, selected }: { uncommitted: boolean; color: string; compact?: boolean; selected: number }) {
  return (
    <div className="pv-graph">
      {uncommitted && (
        <div className="pv-graph-row">
          <span className="pv-lane"><span className="pv-node hollow" style={{ borderColor: color }} /></span>
          <span className="pv-grow pv-italic">{l10n.t('Uncommitted changes')}</span>
        </div>
      )}
      {GRAPH_ROWS.slice(0, compact ? 3 : 5).map((r, i) => (
        <div key={i} className={`pv-graph-row${i === selected ? ' selected' : ''}`}>
          <span className="pv-lane">
            <span className="pv-node" style={{ background: r.lane ? '#ffb74d' : color, marginLeft: r.lane * 10 }} />
          </span>
          <span className="pv-grow pv-ellipsis">{r.msg}</span>
          {!compact && <span className="pv-muted">{r.author}</span>}
        </div>
      ))}
    </div>
  );
}

/** Scene: the selection walks down the commits; the Commit panel beside the log shows the selected one. */
function GitLogPreview({ get }: PreviewProps) {
  const location = get<string>('gitLogDefaultLocation');
  const logOnly = get<string>('gitLogDefaultLayout') === 'logOnly';
  const uncommitted = get<boolean>('showUncommittedChangesInLog');
  const max = get<number>('graphMaxCommits');
  const color = 'var(--vscode-charts-blue, #4fc3f7)';
  const compact = location === 'panel';
  const selected = useLoop(compact ? 3 : 5, 1200, 0);
  const commit = GRAPH_ROWS[selected];
  const logPane = (
    <div className="pv-split">
      <div className="pv-split-main"><MiniGraph uncommitted={uncommitted} color={color} compact={compact} selected={selected} /></div>
      {/* The layout only applies outside the bottom panel, where the Commit panel can sit beside the log. */}
      {!compact && !logOnly && (
        <div className="pv-split-side">
          <div className="pv-side-title">Commit</div>
          <div key={selected} className="pv-in pv-side-detail">
            <div className="pv-ellipsis"><b>{commit.msg}</b></div>
            <div className="pv-muted">{commit.author} · {commit.when}</div>
            <div className="pv-muted mono">{commit.hash}</div>
          </div>
        </div>
      )}
    </div>
  );
  return (
    <div className="pv-stack">
      <div className="pv-window">
        <div className="pv-window-bar"><span className="pv-traffic" /><span className="pv-window-title">VS Code</span></div>
        <div className="pv-window-body">
          <div className="pv-activity" />
          <div className="pv-editor-area">
            {location === 'editorTab' ? (
              <>
                <div className="pv-tabs"><span className="pv-etab">App.tsx</span><span className="pv-etab active"><Codicon name="history" style={{ fontSize: 11 }} /> Git Log</span></div>
                {logPane}
              </>
            ) : (
              <>
                <div className="pv-tabs"><span className="pv-etab active">App.tsx</span></div>
                <div className="pv-code-lines">{[70, 45, 85, 30, 60].map((w, i) => <div key={i} className="pv-skel" style={{ width: `${w}%` }} />)}</div>
                {location === 'panel' && (
                  <div className="pv-bottom-panel">
                    <div className="pv-tabs small"><span className="pv-etab">TERMINAL</span><span className="pv-etab active">GITCHARM LOG</span></div>
                    {logPane}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {location === 'newWindow' && (
        <div className="pv-window pv-window-floating">
          <div className="pv-window-bar"><span className="pv-traffic" /><span className="pv-window-title">GitCharm Log</span></div>
          {logPane}
        </div>
      )}
      <div className="pv-footnote"><Codicon name="info" /> {l10n.t('Loads up to {0} commits per repository.', max.toLocaleString())}</div>
    </div>
  );
}

// ── Repositories ────────────────────────────────────────────────────────────

/** Scene: each repository's tab gets selected in turn; its commits and its place in the workspace light up. */
function RepositoriesPreview({ get, repos }: PreviewProps) {
  const list = effectiveRepos(repos, get<Record<string, string>>('projectColors'));
  const depth = get<number>('repositoryScanMaxDepth');
  const subDepth = get<number>('submoduleMaxDepth');
  const ignored = get<string[]>('repositoryScanIgnoredFolders');
  const active = useLoop(Math.min(list.length, 3), 1400, 0);
  const activeName = list[active]?.name;
  const dim = (name: string | undefined) => (name !== undefined && name !== activeName ? ' pv-dim' : ' pv-lit');
  return (
    <div className="pv-stack">
      <div className="pv-panel">
        <div className="pv-titlebar"><span>GITCHARM LOG</span></div>
        <div className="pv-repo-tabs">
          {list.map(r => (
            <span key={r.name} className={`pv-repo-tab${r.name === activeName ? ' active' : ''}`} style={r.name === activeName ? { borderColor: r.color } : undefined}>
              <span className="pv-dot" style={{ background: r.color }} />{r.name}
            </span>
          ))}
        </div>
        <div className="pv-graph">
          {GRAPH_ROWS.slice(0, 4).map((row, i) => {
            const r = list[i % Math.min(list.length, 3)];
            return (
              <div key={i} className={`pv-graph-row${dim(r.name)}`}>
                <span className="pv-lane"><span className="pv-node" style={{ background: r.color }} /></span>
                <span className="pv-grow pv-ellipsis">{row.msg}</span>
                <span className="pv-repo-pill" style={{ color: r.color, borderColor: r.color }}>{r.name}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pv-tree">
        <div className="pv-tree-row"><Codicon name="root-folder" /> workspace</div>
        <div className={`pv-tree-row${dim(list[0].name)}`} style={{ paddingLeft: 16 }}><Codicon name="repo" /> {list[0].name}</div>
        <div className={`pv-tree-row${depth < 1 ? ' off' : dim(list[1]?.name)}`} style={{ paddingLeft: 16 }}><Codicon name="folder" /> packages/<Codicon name="repo" /> {list[1]?.name ?? 'api'} <span className="pv-muted">{l10n.t('depth {0}', 1)}</span></div>
        <div className={`pv-tree-row${subDepth < 1 ? ' off' : dim(list[2]?.name)}`} style={{ paddingLeft: 32 }}><Codicon name="package" /> {list[2]?.name ?? 'vendor/lib'} <span className="pv-muted">{l10n.t('submodule')}</span></div>
        {ignored.slice(0, 2).map(f => (
          <div key={f} className="pv-tree-row off" style={{ paddingLeft: 16 }}><Codicon name="folder" /> {f} <span className="pv-muted">{l10n.t('ignored')}</span></div>
        ))}
      </div>
    </div>
  );
}

// ── Branches ────────────────────────────────────────────────────────────────

const NEW_BRANCH = 'login-form';

/** Scene: creating a branch — the prefixes are offered, one is picked, then the rest of the name is typed. */
function BranchesPreview({ get }: PreviewProps) {
  const models = get<string[]>('branchNameModels');
  const lastCommit = get<boolean>('showLastCommitInBranchMenu');
  const diverged = !get<boolean>('suppressDivergedBranchWarning');
  // What the branch prompt offers: the same normalization ("feature" -> "feature/"), dedupe and order.
  const prefixes = normalizeBranchModels(models).map(modelPrefix);
  const step = useLoop(9, 750, 3);

  const prefix = prefixes[0] ?? '';
  // 0–1: the list of prefixes, highlight moving; 2: the prefix is picked; 3–6: the name is typed; 7–8: hold.
  const typedChars = step < 3 ? 0 : Math.min(NEW_BRANCH.length, Math.round(NEW_BRANCH.length * (step - 2) / 4));
  const input = step < 2 ? '' : (prefixes.length > 0 ? prefix : '') + NEW_BRANCH.slice(0, typedChars);
  const activeItem = step === 1 && prefixes.length > 1 ? 1 : 0;
  const shownPrefixes = step < 2 ? prefixes.slice(0, 4) : [];
  return (
    <div className="pv-stack">
      <div className="pv-quickpick">
        <div className="pv-qp-input">
          {input ? <span className="mono pv-qp-typed">{input}</span> : <span>{l10n.t('New branch name')}</span>}
          <span className="pv-caret" />
        </div>
        {shownPrefixes.length === 0 && step < 2 && <div className="pv-qp-item pv-muted">{l10n.t('No prefixes: type the whole name')}</div>}
        {shownPrefixes.map((p, i) => (
          <div key={p} className={`pv-qp-item${i === activeItem ? ' active' : ''}`}><Codicon name="git-branch" /> <span className="mono">{p}</span><span className="pv-muted">…</span></div>
        ))}
        {step >= 2 && (
          <div className="pv-qp-item active pv-in"><Codicon name="add" /> <span>{l10n.t('Create branch {0}', input || '…')}</span></div>
        )}
      </div>
      <div className="pv-quickpick">
        <div className="pv-qp-input">{l10n.t('Select a branch')}</div>
        <div className="pv-qp-item active">
          <Codicon name="git-branch" /> main
          {diverged && <span className="pv-warn"><Codicon name="warning" /> ↑2 ↓3</span>}
        </div>
        {lastCommit && <div className="pv-qp-detail mono">a1b2c3d · Alex Kim · Add login form validation · 2h</div>}
        <div className="pv-qp-item"><Codicon name="git-branch" /> feature/search</div>
        {lastCommit && <div className="pv-qp-detail mono">e4f5a6b · Sam Rivera · Improve search ranking · 1d</div>}
      </div>
    </div>
  );
}

// ── Sync & Notifications ────────────────────────────────────────────────────

function Toast({ icon, text, actions }: { icon: string; text: string; actions: string[] }) {
  return (
    <div className="pv-toast pv-in">
      <Codicon name={icon} style={{ color: 'var(--vscode-notificationsInfoIcon-foreground)' }} />
      <div className="pv-grow">
        <div>{text}</div>
        <div className="pv-toast-actions">{actions.map(a => <span key={a} className="pv-btn primary small">{a}</span>)}</div>
      </div>
    </div>
  );
}

/** Scene: startup — the fetch runs, then each enabled notification pops up in turn. */
function NotificationsPreview({ get }: PreviewProps) {
  const fetch = get<boolean>('fetchOnStartup');
  const refresh = get<number>('autoRefreshInterval');
  const toasts: React.ReactElement[] = [];
  if (get<boolean>('notifyOnIncomingCommits')) toasts.push(<Toast key="in" icon="cloud-download" text={l10n.t('3 incoming commits on main')} actions={['Pull']} />);
  if (get<boolean>('notifyOnUnpushedCommits')) toasts.push(<Toast key="out" icon="cloud-upload" text={l10n.t('2 commits ready to push on feature/search')} actions={['Push']} />);
  if (get<boolean>('notifyOnOrphanBranches')) toasts.push(<Toast key="orphan" icon="git-branch" text={l10n.t('1 local branch lost its remote')} actions={[l10n.t('Review')]} />);

  // 0–1: fetching; then one notification per step; then a pause before starting over.
  const length = 2 + toasts.length + 3;
  const step = useLoop(length, 900, length - 1);
  const fetching = fetch && step < 2;
  const shown = Math.max(0, Math.min(toasts.length, step - 1));
  return (
    <div className="pv-stack">
      <div className="pv-timeline">
        <div className={`pv-timeline-step${fetch ? '' : ' off'}`}>
          <Codicon name={!fetch ? 'circle-slash' : fetching ? 'loading' : 'check'} className={fetching ? 'codicon-modifier-spin' : undefined} />
          {!fetch ? l10n.t('No fetch at startup') : fetching ? l10n.t('Fetching all remotes…') : l10n.t('Fetch all remotes at startup')}
        </div>
        <div className="pv-timeline-step"><Codicon name="sync" /> {refresh > 0 ? l10n.t('Refresh every {0}s', refresh) : l10n.t('Refresh when files change')}</div>
      </div>
      {toasts.length > 0
        ? <div className="pv-toasts">{toasts.slice(0, shown)}</div>
        : <div className="pv-empty"><Codicon name="bell-slash" /> {l10n.t('No notifications')}</div>}
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

const CODE = [
  { code: 'export function validate(form: LoginForm) {', blame: '12/03/2026  Alex K.', author: 'Alex Kim', initials: 'AK', when: '2 weeks ago', summary: 'Add login form validation' },
  { code: '  if (!form.email.includes("@")) {', blame: '12/03/2026  Alex K.', author: 'Alex Kim', initials: 'AK', when: '2 weeks ago', summary: 'Add login form validation' },
  { code: '    return { ok: false, field: "email" };', blame: '02/01/2026  Sam R.', author: 'Sam Rivera', initials: 'SR', when: '3 months ago', summary: 'Return the failing field' },
  { code: '  }', blame: '12/03/2026  Alex K.', author: 'Alex Kim', initials: 'AK', when: '2 weeks ago', summary: 'Add login form validation' },
  { code: '  return { ok: true };', blame: '28/11/2025  Jo C.', author: 'Jo Chen', initials: 'JC', when: '4 months ago', summary: 'Initial validation helpers' },
  { code: '}', blame: '28/11/2025  Jo C.', author: 'Jo Chen', initials: 'JC', when: '4 months ago', summary: 'Initial validation helpers' },
];

/** Scene: the cursor moves down the file; the inline blame and the hover follow the current line. */
function EditorPreview({ get }: PreviewProps) {
  const annotations = get<boolean>('gitAnnotations.enabled');
  const ghost = get<boolean>('gitGhostText.enabled');
  const avatars = get<boolean>('avatars.enabled');
  const current = useLoop(CODE.length, 1100, 2);
  const line = CODE[current];
  return (
    <div className="pv-stack">
      <div className="pv-editor">
        {CODE.map((l, i) => (
          <div key={i} className={`pv-code-row${i === current ? ' current' : ''}`}>
            {annotations && <span className="pv-blame">{l.blame}</span>}
            <span className="pv-ln">{i + 1}</span>
            <span className="pv-code">{l.code}{i === current && <span className="pv-caret" />}</span>
            {ghost && i === current && <span key={current} className="pv-ghost pv-fade">{l.author}, {l.when} · {l.summary}</span>}
          </div>
        ))}
      </div>
      <div key={line.author} className="pv-hover pv-in">
        {avatars
          ? <span className="pv-avatar img" />
          : <span className="pv-avatar">{line.initials}</span>}
        <div className="pv-grow">
          <div><b>{line.author}</b> <span className="pv-muted">· {line.when}</span></div>
          <div className="pv-muted">{line.summary}</div>
        </div>
      </div>
      {!annotations && <div className="pv-footnote"><Codicon name="info" /> {l10n.t('Annotations are off: blame can no longer be shown beside the line numbers.')}</div>}
    </div>
  );
}
