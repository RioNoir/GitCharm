import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CreatePullRequestForm } from './components/CreatePullRequestForm';
import { getVsCodeApi } from '../shared/vscodeApi';
import type { HostToPrCreateMsg, PrCreateToHostMsg, CreatePullRequestInput, ForgeProvider } from '../../host/types/messages';
import type { BranchInfo } from '../shared/types';

function App() {
  const [repoName, setRepoName] = useState('');
  const [provider, setProvider] = useState<ForgeProvider>('unknown');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();

  const send = useCallback((msg: PrCreateToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

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
        case 'PRCREATE_SUBMIT_RESULT':
          setSubmitting(false);
          if (!msg.ok) setSubmitError(msg.error ?? 'Failed to create pull request');
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [send]);

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
      branches={branches}
      branchesLoading={branchesLoading}
      branchesError={branchesError}
      submitting={submitting}
      submitError={submitError}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  );
}

createRoot(document.getElementById('root')!).render(<App />);
