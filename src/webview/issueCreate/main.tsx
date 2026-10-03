import '../shared/l10n';
import * as l10n from '@vscode/l10n';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getVsCodeApi, notifyHostReady } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import { MarkdownEditor } from '../shared/MarkdownEditor';
import { focusableFieldStyle } from '../shared/inputStyles';
import { MentionCandidatesContext, toMentionCandidates, type MentionCandidate } from '../shared/mentions';
import { PeopleField, EditFieldButton } from '../pullRequestDetail/components/PeoplePanel';
import { LabelsPanel } from '../pullRequestDetail/components/LabelsPanel';
import type { HostToIssueCreateMsg, IssueCreateToHostMsg, PullRequestLabel, PullRequestUser } from '../../host/types/messages';

function App() {
  const [repoName, setRepoName] = useState('');
  const [ready, setReady] = useState(false);
  const [canManageLabels, setCanManageLabels] = useState(false);
  const [canManageAssignees, setCanManageAssignees] = useState(false);
  const [singleAssignee, setSingleAssignee] = useState(false);
  const [title, setTitle] = useState('');
  const [titleFocused, setTitleFocused] = useState(false);
  const [description, setDescription] = useState('');
  const [assignees, setAssignees] = useState<PullRequestUser[]>([]);
  const [labels, setLabels] = useState<PullRequestLabel[]>([]);
  const [picking, setPicking] = useState<'assignees' | 'labels' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);

  const send = useCallback((msg: IssueCreateToHostMsg) => getVsCodeApi().postMessage(msg), []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToIssueCreateMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'ISSUECREATE_INIT':
          setRepoName(msg.repoName);
          setCanManageLabels(msg.canManageLabels);
          setCanManageAssignees(msg.canManageAssignees);
          setSingleAssignee(msg.singleAssignee);
          if (msg.template) setDescription(prev => prev || msg.template!);
          setReady(true);
          send({ type: 'ISSUECREATE_REQUEST_MENTION_CANDIDATES' });
          break;
        case 'ISSUECREATE_MENTION_CANDIDATES':
          setMentionCandidates(toMentionCandidates(msg.users));
          break;
        case 'ISSUECREATE_ASSIGNEES_PICKED':
          setAssignees(msg.users);
          break;
        case 'ISSUECREATE_LABELS_PICKED':
          setLabels(msg.labels);
          break;
        case 'ISSUECREATE_SUBMIT_RESULT':
          setSubmitting(false);
          if (!msg.ok) setSubmitError(msg.error ?? l10n.t('Failed to create issue'));
          break;
      }
      // Any reply means the QuickPick that was open has closed.
      if (msg.type === 'ISSUECREATE_ASSIGNEES_PICKED' || msg.type === 'ISSUECREATE_LABELS_PICKED') setPicking(null);
    };
    window.addEventListener('message', handler);
    // A cancelled QuickPick sends nothing back — the window regaining focus means it closed.
    const onFocus = () => setPicking(null);
    window.addEventListener('focus', onFocus);
    notifyHostReady();
    return () => { window.removeEventListener('message', handler); window.removeEventListener('focus', onFocus); };
  }, [send]);

  const canSubmit = !!title.trim() && !submitting;
  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(undefined);
    send({ type: 'ISSUECREATE_SUBMIT', title: title.trim(), description, assigneeIds: assignees.map(a => a.id), labelIds: labels.map(l => l.id) });
  };

  return (
    <MentionCandidatesContext.Provider value={mentionCandidates}>
      <div style={css.page}>
        <div style={css.header}>
          <Codicon name="issues" style={css.headerIcon} />
          <div>
            <div style={css.headerTitle}>{l10n.t('New Issue')}</div>
            <div style={css.headerSub}>{repoName}</div>
          </div>
        </div>

        <div style={css.body}>
          <div style={css.formColumn}>
            <div style={css.fieldLabel}>
              <label htmlFor="issue-create-title">{l10n.t('Title')}</label>
              <input
                id="issue-create-title"
                style={{ ...focusableFieldStyle(titleFocused), ...css.input }}
                value={title}
                onChange={e => setTitle(e.target.value)}
                onFocus={() => setTitleFocused(true)}
                onBlur={() => setTitleFocused(false)}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
                placeholder={l10n.t('Issue title')}
                autoFocus
              />
            </div>
            {/* A plain <div>, not a <label>: a label would forward clicks in the editor to its toolbar's first button. */}
            <div style={css.fieldLabel}>
              {l10n.t('Description')}
              <MarkdownEditor value={description} onChange={setDescription} placeholder={l10n.t('Describe the issue…')} />
            </div>
            {submitError && (
              <div style={css.alertError}>
                <Codicon name="error" style={{ fontSize: '14px', flexShrink: 0 }} />
                <span>{submitError}</span>
              </div>
            )}
          </div>

          {ready && (canManageAssignees || canManageLabels) && (
            <div style={css.sideColumn}>
              {canManageAssignees && (
                <section>
                  <div style={css.sideHeader}>
                    <Codicon name="account" style={{ fontSize: '13px', opacity: 0.6 }} />
                    <h3 style={css.sectionTitle}>{singleAssignee ? l10n.t('Assignee') : l10n.t('Assignees')}</h3>
                    <div style={{ marginLeft: 'auto' }}>
                      <EditFieldButton
                        title={l10n.t('Edit assignees')} updating={picking !== null}
                        onPick={() => { setPicking('assignees'); send({ type: 'ISSUECREATE_PICK_ASSIGNEES', current: assignees }); }}
                      />
                    </div>
                  </div>
                  <PeopleField people={assignees} />
                </section>
              )}
              {canManageLabels && (
                <section>
                  <div style={css.sideHeader}>
                    <Codicon name="tag" style={{ fontSize: '13px', opacity: 0.6 }} />
                    <h3 style={css.sectionTitle}>{l10n.t('Labels')}</h3>
                    <div style={{ marginLeft: 'auto' }}>
                      <EditFieldButton
                        title={l10n.t('Edit labels')} updating={picking !== null}
                        onPick={() => { setPicking('labels'); send({ type: 'ISSUECREATE_PICK_LABELS', current: labels }); }}
                      />
                    </div>
                  </div>
                  <LabelsPanel labels={labels} hasLabels />
                </section>
              )}
            </div>
          )}
        </div>

        <div style={css.footer}>
          <button className="gc-btn-secondary" style={css.cancelBtn} onClick={() => send({ type: 'ISSUECREATE_CANCEL' })} disabled={submitting}>
            <Codicon name="close" style={{ fontSize: '13px' }} />
            {l10n.t('Cancel')}
          </button>
          <button
            style={{ ...css.submitBtn, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'default' }}
            disabled={!canSubmit}
            onClick={submit}
          >
            <Codicon name={submitting ? 'loading~spin' : 'check'} style={{ fontSize: '13px' }} />
            {submitting ? l10n.t('Creating…') : l10n.t('Create Issue')}
          </button>
        </div>
      </div>
    </MentionCandidatesContext.Provider>
  );
}

const css = {
  page: {
    display: 'flex', flexDirection: 'column' as const, height: '100vh',
    background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)',
    fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size, 13px)',
  } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '16px 24px 12px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0,
  } as React.CSSProperties,
  headerIcon: { fontSize: '18px', opacity: 0.7 } as React.CSSProperties,
  headerTitle: { fontSize: '15px', fontWeight: 600 },
  headerSub: { fontSize: '12px', opacity: 0.55, marginTop: '1px', fontFamily: 'var(--vscode-editor-font-family, monospace)' },
  body: { flex: 1, display: 'flex', flexWrap: 'wrap' as const, overflow: 'auto' } as React.CSSProperties,
  formColumn: {
    flex: 3, minWidth: '360px', display: 'flex', flexDirection: 'column' as const, gap: '14px', padding: '20px 24px', boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  sideColumn: {
    flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column' as const, gap: '20px', padding: '20px 24px', boxSizing: 'border-box' as const,
    borderLeft: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  sideHeader: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' } as React.CSSProperties,
  sectionTitle: {
    fontSize: '11px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', opacity: 0.6, fontWeight: 600, margin: 0,
  } as React.CSSProperties,
  fieldLabel: { display: 'flex', flexDirection: 'column' as const, gap: '4px', fontSize: '11px', opacity: 0.7 } as React.CSSProperties,
  input: { fontSize: '13px', padding: '6px 8px', boxSizing: 'border-box' as const, width: '100%' } as React.CSSProperties,
  alertError: {
    display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '8px 12px', borderRadius: '4px',
    color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
    border: '1px solid var(--vscode-inputValidation-errorBorder)',
  } as React.CSSProperties,
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
    padding: '12px 24px 20px', borderTop: '1px solid var(--vscode-panel-border)', flexShrink: 0,
  } as React.CSSProperties,
  cancelBtn: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 16px' } as React.CSSProperties,
  submitBtn: {
    display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 16px', borderRadius: '3px',
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none',
  } as React.CSSProperties,
};

createRoot(document.getElementById('root')!).render(<App />);
