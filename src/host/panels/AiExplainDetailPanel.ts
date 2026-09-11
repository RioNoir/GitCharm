import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { HostToAiExplainMsg } from '../types/messages';

const TAB_TITLE_MAX_LENGTH = 40;

function truncateTitle(title: string): string {
  return title.length > TAB_TITLE_MAX_LENGTH ? `${title.slice(0, TAB_TITLE_MAX_LENGTH)}…` : title;
}

/** One AI Explain Detail panel per originating tab (commit or PR detail) — keyed by an opaque key the
 * caller controls (e.g. `commit:{repoId}:{hash}` or `pr:{repoId}:{number}`), so re-triggering "Explain"
 * from the same source tab reveals/updates the same side panel instead of spawning a new one each time. */
const panels = new Map<string, vscode.WebviewPanel>();

export interface AiExplainSubject {
  key: string;
  kind: 'commit' | 'pull-request';
  title: string;
  subtitle?: string;
}

/** Opens (or reveals+updates, if already open for this `subject.key`) a small read-only panel beside the
 * calling panel, showing an AI-generated explanation. This module never generates the explanation itself —
 * the caller (CommitFullDetailPanel / PullRequestDetailPanel) already owns that prompt-building logic; this
 * just displays whatever it's given, first as a loading state and then as the result once resolved. */
export function openAiExplainDetail(
  extensionUri: vscode.Uri,
  subject: AiExplainSubject,
  modelLabel: string,
  generate: () => Promise<{ explanation?: string; error?: string }>,
): void {
  let panel = panels.get(subject.key);
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
  } else {
    panel = vscode.window.createWebviewPanel(
      'gitcharm.aiExplainDetail',
      `AI Explain — ${truncateTitle(subject.title)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
    panel.iconPath = new vscode.ThemeIcon('sparkle');
    panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'aiExplainDetail', panel.title);
    panel.onDidDispose(() => panels.delete(subject.key));
    panels.set(subject.key, panel);
  }

  const post = (m: HostToAiExplainMsg) => panel!.webview.postMessage(m);
  post({ type: 'AIEXPLAIN_INIT', subjectKind: subject.kind, subjectTitle: subject.title, subjectSubtitle: subject.subtitle, modelLabel });

  generate().then(
    result => post({ type: 'AIEXPLAIN_RESULT', explanation: result.explanation, error: result.error }),
    (e: unknown) => post({ type: 'AIEXPLAIN_RESULT', error: e instanceof Error ? e.message : String(e) }),
  );
}
