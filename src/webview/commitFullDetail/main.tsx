import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommitDetail } from '../gitLog/components/CommitDetail';
import { AiExplainSection } from './components/AiExplainSection';
import { Codicon } from '../shared/Codicon';
import { getVsCodeApi } from '../shared/vscodeApi';
import type { CommitNode, HostToCommitFullDetailMsg, HostToLogMsg, IconThemeData } from '../../host/types/messages';
import type { RepoMeta } from '../shared/types';

interface FileEntry { path: string; status: string; added?: number; removed?: number; oldPath?: string }

function App() {
  const [repoId, setRepoId] = useState<string | null>(null);
  const [commit, setCommit] = useState<CommitNode | null>(null);
  const [fullMessage, setFullMessage] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ path: string; status: string } | null>(null);
  const [iconTheme, setIconTheme] = useState<IconThemeData | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiModelLabel, setAiModelLabel] = useState('');
  const [autoExplain, setAutoExplain] = useState(false);
  const [activeProfile, setActiveProfile] = useState<{ name: string; gitName: string; gitEmail: string; builtIn?: 'local' | 'global' } | undefined>();
  const [repoMeta, setRepoMeta] = useState<RepoMeta | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToCommitFullDetailMsg | HostToLogMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      if (msg.type === 'COMMITFULLDETAIL_INIT') {
        // Persisted so VS Code can restore this panel (via registerWebviewPanelSerializer) after a window reload/restart.
        getVsCodeApi().setState({ repoId: msg.repoId, hash: msg.commit.hash });
        setRepoId(msg.repoId);
        setRepoMeta({ id: msg.repoId, name: msg.repoName, rootPath: '', color: '#4ec9b0' });
        setCommit(msg.commit);
        setFullMessage(msg.fullMessage);
        setFiles(msg.files);
        setIconTheme(msg.iconTheme ?? null);
        setAiEnabled(msg.aiEnabled);
        setAiModelLabel(msg.aiModelLabel);
        setAutoExplain(msg.autoExplain);
        setActiveProfile(msg.activeProfile);
      } else if (msg.type === 'COMMITFULLDETAIL_ICON_THEME') {
        setIconTheme(msg.iconTheme);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  if (!commit || !repoMeta) {
    return <div style={{ padding: '16px', fontSize: '12px', opacity: 0.5 }}>Loading…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={styles.toolbar}>
        <Codicon name="git-commit" style={{ opacity: 0.6, fontSize: '14px' }} />
        <span style={styles.toolbarHash}>{commit.shortHash}</span>
        <span style={styles.toolbarMessage}>{commit.message}</span>
      </div>
      {aiEnabled && repoId && (
        <AiExplainSection repoId={repoId} hash={commit.hash} modelLabel={aiModelLabel} autoExplain={autoExplain} />
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <CommitDetail
          commit={commit}
          fullMessage={fullMessage}
          files={files}
          selectedFile={selectedFile}
          loadingFiles={false}
          repos={[repoMeta]}
          iconTheme={iconTheme}
          onSelectFile={setSelectedFile}
          activeProfile={activeProfile}
          hideExtendedDetailButton
          twoColumnLayout
        />
      </div>
    </div>
  );
}

const styles = {
  toolbar: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '8px 16px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    flexShrink: 0,
  } as React.CSSProperties,
  toolbarHash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '12px', opacity: 0.6,
  } as React.CSSProperties,
  toolbarMessage: {
    flex: 1, fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
};

createRoot(document.getElementById('root')!).render(<App />);
