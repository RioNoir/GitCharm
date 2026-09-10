import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CreatePullRequestForm } from './components/CreatePullRequestForm';
import { getVsCodeApi } from '../shared/vscodeApi';
import type {
  ChangedFile, CommitNode, HostToPrCreateMsg, PrCreateToHostMsg, CreatePullRequestInput, ForgeProvider, IconThemeData,
} from '../../host/types/messages';
import type { BranchInfo } from '../shared/types';

function pickDefaultTarget(branches: BranchInfo[]): string {
  const local = branches.filter(b => !b.isRemote);
  const main = local.find(b => b.name === 'main') ?? local.find(b => b.name === 'master');
  if (main) return main.name;
  const remoteMain = branches.find(b => b.isRemote && (b.name.endsWith('/main') || b.name.endsWith('/master')));
  if (remoteMain) return remoteMain.name.split('/').pop()!;
  return local[0]?.name ?? '';
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function App() {
  const [repoName, setRepoName] = useState('');
  const [provider, setProvider] = useState<ForgeProvider>('unknown');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string | undefined>();
  const [iconTheme, setIconTheme] = useState<IconThemeData | null>(null);

  const [sourceBranch, setSourceBranch] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState(false);
  const [pickingBranch, setPickingBranch] = useState<'source' | 'target' | null>(null);

  const [compareLoading, setCompareLoading] = useState(false);
  const [compareFiles, setCompareFiles] = useState<ChangedFile[]>([]);
  const [compareCommits, setCompareCommits] = useState<CommitNode[]>([]);
  const [compareError, setCompareError] = useState<string | undefined>();

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();

  const pendingPickRequestId = useRef<string | null>(null);
  const pendingCompareRequestId = useRef<string | null>(null);

  const send = useCallback((msg: PrCreateToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  const localBranches = useMemo(() => branches.filter(b => !b.isRemote), [branches]);
  const currentBranch = useMemo(() => localBranches.find(b => b.isHead)?.name ?? '', [localBranches]);

  useEffect(() => {
    if (!sourceBranch && currentBranch) setSourceBranch(currentBranch);
  }, [currentBranch, sourceBranch]);

  useEffect(() => {
    if (!targetBranch && localBranches.length > 0) setTargetBranch(pickDefaultTarget(branches));
  }, [branches, localBranches, targetBranch]);

  // Branch selection happens via a native QuickPick (a discrete pick-one-and-close interaction, not a stream
  // of keystrokes), so there's no burst of events to debounce — the requestId guard below (mirrored on the
  // host) is all that's needed to keep a stale response from clobbering a newer one.
  useEffect(() => {
    if (!sourceBranch || !targetBranch || sourceBranch === targetBranch) {
      pendingCompareRequestId.current = null;
      setCompareLoading(false);
      setCompareFiles([]);
      setCompareCommits([]);
      setCompareError(undefined);
      return;
    }
    const requestId = makeRequestId('cmp');
    pendingCompareRequestId.current = requestId;
    setCompareLoading(true);
    setCompareError(undefined);
    send({ type: 'PRCREATE_REQUEST_COMPARE', requestId, sourceBranch, targetBranch });
  }, [sourceBranch, targetBranch, send]);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToPrCreateMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'PRCREATE_INIT':
          setRepoName(msg.repoName);
          setProvider(msg.provider);
          send({ type: 'PRCREATE_REQUEST_BRANCHES' });
          break;
        case 'PRCREATE_BRANCHES_RESULT':
          setBranchesLoading(false);
          setBranches(msg.branches);
          setBranchesError(msg.error);
          break;
        case 'PRCREATE_ICON_THEME':
          setIconTheme(msg.iconTheme);
          break;
        case 'PRCREATE_BRANCH_PICKED':
          if (pendingPickRequestId.current !== msg.requestId) break;
          pendingPickRequestId.current = null;
          setPickingBranch(null);
          if (msg.branch) {
            if (msg.role === 'source') setSourceBranch(msg.branch);
            else setTargetBranch(msg.branch);
          }
          break;
        case 'PRCREATE_COMPARE_RESULT':
          if (pendingCompareRequestId.current !== msg.requestId) break;
          setCompareLoading(false);
          setCompareFiles(msg.files);
          setCompareCommits(msg.commits);
          setCompareError(msg.error);
          break;
        case 'PRCREATE_SUBMIT_RESULT':
          setSubmitting(false);
          if (!msg.ok) setSubmitError(msg.error ?? 'Failed to create pull request');
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [send]);

  const handlePickBranch = useCallback((role: 'source' | 'target') => {
    const requestId = makeRequestId('pick');
    pendingPickRequestId.current = requestId;
    setPickingBranch(role);
    send({ type: 'PRCREATE_PICK_BRANCH', requestId, role, current: role === 'source' ? sourceBranch : targetBranch });
  }, [send, sourceBranch, targetBranch]);

  const handleOpenFile = useCallback((file: ChangedFile) => {
    send({ type: 'PRCREATE_OPEN_FILE_DIFF', sourceBranch, targetBranch, file });
  }, [send, sourceBranch, targetBranch]);

  const handleOpenNativeCompare = useCallback(() => {
    send({ type: 'PRCREATE_OPEN_NATIVE_COMPARE', sourceBranch, targetBranch });
  }, [send, sourceBranch, targetBranch]);

  const handleSubmit = useCallback((input: CreatePullRequestInput) => {
    setSubmitting(true);
    setSubmitError(undefined);
    send({ type: 'PRCREATE_SUBMIT', input });
  }, [send]);

  const handleCancel = useCallback(() => {
    send({ type: 'PRCREATE_CANCEL' });
  }, [send]);

  return (
    <CreatePullRequestForm
      repoName={repoName}
      provider={provider}
      branchesLoading={branchesLoading}
      branchesError={branchesError}
      iconTheme={iconTheme}
      sourceBranch={sourceBranch}
      targetBranch={targetBranch}
      onPickBranch={handlePickBranch}
      pickingBranch={pickingBranch}
      title={title}
      onTitleChange={setTitle}
      description={description}
      onDescriptionChange={setDescription}
      draft={draft}
      onDraftChange={setDraft}
      compareLoading={compareLoading}
      compareFiles={compareFiles}
      compareCommits={compareCommits}
      compareError={compareError}
      onOpenFile={handleOpenFile}
      onOpenNativeCompare={handleOpenNativeCompare}
      submitting={submitting}
      submitError={submitError}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  );
}

createRoot(document.getElementById('root')!).render(<App />);
