import * as vscode from 'vscode';
import { CommitPanelProvider } from '../panels/CommitPanelProvider';
import { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { BranchStatusBar } from '../ui/BranchStatusBar';
import { FileAnnotationController } from '../ui/FileAnnotationController';
import { ProfileStatusBar } from '../ui/ProfileStatusBar';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { openFileHistoryPanel } from '../panels/FileHistoryPanel';
import { compareWithCommand } from '../panels/CompareWithCommand';
import { hasConflictMarkers } from '../git/ConflictParser';
import { logInfo, logWarn, notifyWithLogAction, showLogChannel } from '../utils/Logger';
import { plural } from '../utils/plural';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import { forgeProviderLabel } from '../pullRequests/remoteUrlParser';
import { resolveAvatarIconPath } from '../utils/avatarCache';
import { presentOrphanBranches } from '../utils/orphanBranches';
import type { BranchInfo } from '../types/git';

export function registerCommands(
  context: vscode.ExtensionContext,
  commitPanel: CommitPanelProvider,
  logPanel: GitLogPanelProvider,
  branchStatusBar: BranchStatusBar,
  annotationController: FileAnnotationController,
  profileStatusBar: ProfileStatusBar,
  manager?: WorkspaceGitManager,
  extensionUri?: vscode.Uri,
  pullRequestManager?: PullRequestManager,
): void {
  context.subscriptions.push(
    // Open the Git Log where the persisted default location says
    vscode.commands.registerCommand('gitcharm.openLog', () => {
      logPanel.openPreferred();
    }),

    // Pick and persist where the Git Log opens by default
    vscode.commands.registerCommand('gitcharm.setGitLogDefaultLocation', () => {
      void logPanel.triggerDefaultLocationPick();
    }),

    // Show the GitCharm output channel (full error/event log)
    vscode.commands.registerCommand('gitcharm.showOutputLog', () => {
      showLogChannel();
    }),

    vscode.commands.registerCommand('gitcharm.refreshCommitPanel', async () => {
      if (!manager) return;
      await manager.reinitializeAndRefresh();
      logPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.setFileViewFlat', () => {
      commitPanel.setFileViewMode('flat');
    }),
    vscode.commands.registerCommand('gitcharm.setFileViewFlatChecked', () => {
      commitPanel.setFileViewMode('flat');
    }),

    vscode.commands.registerCommand('gitcharm.setFileViewTree', () => {
      commitPanel.setFileViewMode('tree');
    }),
    vscode.commands.registerCommand('gitcharm.setFileViewTreeChecked', () => {
      commitPanel.setFileViewMode('tree');
    }),

    vscode.commands.registerCommand('gitcharm.sortReposByDiscovery', () => {
      commitPanel.setRepoSortMode('discovery');
    }),
    vscode.commands.registerCommand('gitcharm.sortReposByDiscoveryChecked', () => {
      commitPanel.setRepoSortMode('discovery');
    }),

    vscode.commands.registerCommand('gitcharm.sortReposByName', () => {
      commitPanel.setRepoSortMode('name');
    }),
    vscode.commands.registerCommand('gitcharm.sortReposByNameChecked', () => {
      commitPanel.setRepoSortMode('name');
    }),

    vscode.commands.registerCommand('gitcharm.sortReposByPath', () => {
      commitPanel.setRepoSortMode('path');
    }),
    vscode.commands.registerCommand('gitcharm.sortReposByPathChecked', () => {
      commitPanel.setRepoSortMode('path');
    }),

    vscode.commands.registerCommand('gitcharm.showReposWithoutChanges', () => {
      commitPanel.setHideReposWithoutChanges(false);
    }),
    vscode.commands.registerCommand('gitcharm.showReposWithoutChangesChecked', () => {
      commitPanel.setHideReposWithoutChanges(false);
    }),

    vscode.commands.registerCommand('gitcharm.hideReposWithoutChanges', () => {
      commitPanel.setHideReposWithoutChanges(true);
    }),
    vscode.commands.registerCommand('gitcharm.hideReposWithoutChangesChecked', () => {
      commitPanel.setHideReposWithoutChanges(true);
    }),

    vscode.commands.registerCommand('gitcharm.openMergeEditor', async (uri?: vscode.Uri) => {
      // Invoked from the editor context menu VS Code passes the file's URI; from the
      // Command Palette it passes nothing, so fall back to the active editor.
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        logWarn('mergeEditor:open', 'No active file');
        vscode.window.showWarningMessage(vscode.l10n.t('No active file'));
        return;
      }
      const doc = await vscode.workspace.openTextDocument(target);
      if (!hasConflictMarkers(doc.getText())) {
        logWarn('mergeEditor:open', 'No conflict markers found in the current file');
        vscode.window.showWarningMessage(vscode.l10n.t('No conflict markers found in the current file'));
        return;
      }
      await vscode.commands.executeCommand('git.openMergeEditor', target)
        .then(undefined, () => vscode.window.showTextDocument(target));
    }),

    vscode.commands.registerCommand('gitcharm.commit', () => {
      vscode.commands.executeCommand('gitcharm.commitPanel.focus');
    }),

    vscode.commands.registerCommand('gitcharm.pull', () => {
      return branchStatusBar.updateProject();
    }),

    vscode.commands.registerCommand('gitcharm.push', async () => {
      if (!manager) return;
      const metas = manager.getRepoMetas();
      const metaById = new Map(metas.map(m => [m.id, m]));
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing all repositories…'), cancellable: false },
        async () => {
          const results = await manager.pushAll();
          const failed = results.filter(r => !r.ok);
          const ok = results.filter(r => r.ok);
          const pushed = ok.filter(r => r.message !== 'Nothing to push — skipped');
          if (failed.length === 0) {
            const msg = pushed.length === 0
              ? 'Nothing to push — all repositories up to date.'
              : `${pushed.length} ${pushed.length === 1 ? 'repository' : 'repositories'} pushed.`;
            vscode.window.showInformationMessage(pushed.length === 0
              ? vscode.l10n.t('Nothing to push — all repositories up to date.')
              : plural(pushed.length, vscode.l10n.t('1 repository pushed.'), vscode.l10n.t('{0} repositories pushed.', pushed.length)));
            logInfo('push', msg);
          } else {
            const failedDesc = failed.map(r => {
              const name = metaById.get(r.repoId)?.name ?? r.repoId;
              return `${name}: ${r.message}`;
            }).join('; ');
            logWarn('push', `${pushed.length} pushed, ${failed.length} failed: ${failedDesc}`);
            notifyWithLogAction('warning', vscode.l10n.t('{0} pushed, {1} failed: {2}', pushed.length, failed.length, failedDesc));
          }
        }
      );
      commitPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.fetchAll', async () => {
      if (!manager) return;
      await branchStatusBar.fetchAll();
      commitPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.checkOrphanBranches', async () => {
      if (!manager) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking for orphaned branches…'), cancellable: false },
        async () => {
          await manager.fetchAll();
          const metas = manager.getRepoMetas().filter(m => !m.isWorktree);
          const results = await Promise.allSettled(
            metas.map(async m => ({ repoId: m.id, branches: await manager.getRepo(m.id)?.getBranches() ?? [] }))
          );
          const orphaned = results
            .filter((r): r is PromiseFulfilledResult<{ repoId: string; branches: BranchInfo[] }> => r.status === 'fulfilled')
            .flatMap(r => r.value.branches.filter(b => !b.isRemote && b.upstreamGone).map(b => ({ repoId: r.value.repoId, branchName: b.name })));
          presentOrphanBranches(manager, logPanel, orphaned, 'noValidRemote');
        }
      );
    }),

    vscode.commands.registerCommand('gitcharm.syncAll', async () => {
      if (!manager) return;
      const metas = manager.getRepoMetas();
      const metaById = new Map(metas.map(m => [m.id, m]));

      const pick = await vscode.window.showQuickPick(
        [
          { label: `$(git-merge) ${vscode.l10n.t('Merge incoming changes into the current branch')}`, rebase: false },
          { label: `$(repo-forked) ${vscode.l10n.t('Rebase the current branch on top of incoming changes')}`, rebase: true },
        ],
        { title: vscode.l10n.t('Sync — Pull Strategy') }
      ) as { label: string; rebase: boolean } | undefined;
      if (!pick) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Syncing all repositories…'), cancellable: false },
        async () => {
          // Pull first
          const pullResults = await manager.pullAll(pick.rebase);
          const pullFailed = pullResults.filter(r => !r.ok);

          if (pullFailed.length > 0) {
            const failedDesc = pullFailed.map(r => {
              const name = metaById.get(r.repoId)?.name ?? r.repoId;
              return `${name}: ${r.message}`;
            }).join('; ');
            logWarn('sync', `Sync: Pull failed — stopping before push. ${failedDesc}`);
            notifyWithLogAction('warning', vscode.l10n.t('Sync: Pull failed — stopping before push. {0}', failedDesc));
            commitPanel.refresh();
            return;
          }

          // Push only if all pulls succeeded
          const pushResults = await manager.pushAll();
          const pushFailed = pushResults.filter(r => !r.ok);
          const pushOk = pushResults.filter(r => r.ok);

          if (pushFailed.length === 0) {
            vscode.window.showInformationMessage(plural(pushOk.length, vscode.l10n.t('Sync: 1 repository synced.'), vscode.l10n.t('Sync: {0} repositories synced.', pushOk.length)));
            logInfo('sync', `Sync: ${pushOk.length} ${pushOk.length === 1 ? 'repository' : 'repositories'} synced.`);
          } else {
            const failedDesc = pushFailed.map(r => {
              const name = metaById.get(r.repoId)?.name ?? r.repoId;
              return `${name}: ${r.message}`;
            }).join('; ');
            logWarn('sync', `Sync: ${pushOk.length} synced, ${pushFailed.length} push failed: ${failedDesc}`);
            notifyWithLogAction('warning', vscode.l10n.t('Sync: {0} synced, {1} push failed: {2}', pushOk.length, pushFailed.length, failedDesc));
          }
          commitPanel.refresh();
        }
      );
    }),

    vscode.commands.registerCommand('gitcharm.showBranchMenu', (repoId?: string) => {
      branchStatusBar.showMenu(repoId);
    }),

    vscode.commands.registerCommand('gitcharm.showBranchOptions', (repoId: string, branchName: string) => {
      branchStatusBar.showBranchOptions(repoId, branchName);
    }),

    vscode.commands.registerCommand('gitcharm.updateProject', () => {
      branchStatusBar.updateProject();
    }),

    vscode.commands.registerCommand('gitcharm.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rionoir.gitcharm');
    }),

    vscode.commands.registerCommand('gitcharm.resetViewLocations', async () => {
      await vscode.commands.executeCommand('workbench.action.resetViewLocations');
      commitPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.openGitAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.openAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.closeGitAnnotations', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) annotationController.closeAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.toggleGitAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.toggleAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.navigateToAnnotationCommit', (hash: string, repoId: string) => {
      annotationController.navigateToCommit(hash, repoId);
    }),

    vscode.commands.registerCommand('gitcharm.manageHiddenRepos', () => {
      commitPanel.manageHiddenRepos();
    }),

    vscode.commands.registerCommand('gitcharm.manageProfiles', () => {
      profileStatusBar.showMenu();
    }),

    vscode.commands.registerCommand('gitcharm.switchProfile', () => {
      profileStatusBar.switchProfile();
    }),

    // ── Submodule commands ────────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.submodule.init', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, false);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_INIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.update', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_UPDATE', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, recursive: false });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.updateRecursive', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_UPDATE', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, recursive: true });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.deinit', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_DEINIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, force: false });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.deinitForce', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_DEINIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, force: true });
    }),

    vscode.commands.registerCommand('gitcharm.submodule.openInNewWindow', async (repoId?: string) => {
      const metas = manager?.getRepoMetas().filter(m => m.isSubmodule) ?? [];
      let target = repoId ? metas.find(m => m.id === repoId) : undefined;
      if (!target && metas.length === 1) target = metas[0];
      if (!target) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: m.name, description: m.submodulePath, id: m.id })),
          { title: vscode.l10n.t('Open Submodule in New Window'), placeHolder: vscode.l10n.t('Select a submodule…') }
        );
        if (!picked) return;
        target = metas.find(m => m.id === picked.id);
      }
      if (target) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.rootPath), { forceNewWindow: true });
      }
    }),

    // ── AI provider / model selection ─────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.selectAiModel', async () => {
      const config = vscode.workspace.getConfiguration('gitcharm');
      const currentProvider: string = config.get('ai.provider', 'vscode-lm');

      type ProviderItem = vscode.QuickPickItem & { providerId: string };
      const OPEN_SETTINGS_ID = '__open_settings__';
      const providerItems: ProviderItem[] = [
        { label: '$(copilot) VS Code LM', description: vscode.l10n.t('GitHub Copilot or any registered LM extension'), providerId: 'vscode-lm' },
        { label: '$(cloud) Claude API', description: vscode.l10n.t('{0}  (requires API key)', 'Anthropic API'), providerId: 'claude-api' },
        { label: '$(cloud) OpenAI API', description: vscode.l10n.t('{0}  (requires API key)', 'OpenAI API'), providerId: 'openai-api' },
        { label: '$(cloud) Gemini API', description: vscode.l10n.t('{0}  (requires API key)', 'Google Gemini API'), providerId: 'gemini-api' },
        { label: '$(terminal) Claude CLI', description: 'claude --print  (Claude Code / Anthropic)', providerId: 'claude-cli' },
        { label: '$(terminal) Codex CLI', description: 'codex exec  (OpenAI Codex)', providerId: 'codex-cli' },
        { label: '$(terminal) Gemini CLI', description: 'gemini -p  (Google Gemini CLI)', providerId: 'gemini-cli' },
        { label: '$(server) Ollama', description: vscode.l10n.t('Local model via {0} HTTP API', 'Ollama'), providerId: 'ollama' },
        { label: '$(server) LM Studio', description: vscode.l10n.t('Local model via {0} HTTP API', 'LM Studio'), providerId: 'lmstudio' },
      ].map(item => ({
        ...item,
        description: `${item.description}${item.providerId === currentProvider ? '  $(check)' : ''}`,
      }));
      providerItems.push({ label: `$(settings-gear) ${vscode.l10n.t('Open AI Settings')}`, description: vscode.l10n.t('Configure paths, model, diff limits…'), providerId: OPEN_SETTINGS_ID, kind: vscode.QuickPickItemKind.Default });

      const pickedProvider = await vscode.window.showQuickPick(providerItems, {
        title: vscode.l10n.t('Select AI Provider'),
        placeHolder: vscode.l10n.t('Choose a provider…'),
      });
      if (!pickedProvider) return;

      if (pickedProvider.providerId === OPEN_SETTINGS_ID) {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rionoir.gitcharm gitcharm.ai');
        return;
      }

      await config.update('ai.provider', pickedProvider.providerId, vscode.ConfigurationTarget.Global);

      // Provider-specific follow-up
      if (pickedProvider.providerId === 'vscode-lm') {
        let models: vscode.LanguageModelChat[] = [];
        try { models = await vscode.lm.selectChatModels(); } catch { /* none */ }

        if (models.length === 0) {
          vscode.window.showInformationMessage(vscode.l10n.t('Provider set to VS Code LM. No models found — install GitHub Copilot or another LM extension.'));
          return;
        }

        const currentModelId: string = config.get('ai.modelId', '');
        type ModelItem = vscode.QuickPickItem & { modelId: string };
        const modelItems: ModelItem[] = [
          { label: vscode.l10n.t('Auto (first available)'), description: !currentModelId ? `$(check) ${vscode.l10n.t({ message: 'current', comment: ['Marks the currently selected AI model in a quick pick'] })}` : '', modelId: '' },
          ...models.map(m => ({
            label: `${m.vendor} — ${m.family}`,
            description: `${m.vendor}:${m.family}` === currentModelId ? `$(check) ${vscode.l10n.t({ message: 'current', comment: ['Marks the currently selected AI model in a quick pick'] })}` : '',
            modelId: `${m.vendor}:${m.family}`,
          })),
        ];

        const pickedModel = await vscode.window.showQuickPick(modelItems, {
          title: vscode.l10n.t('Select VS Code LM Model'),
          placeHolder: vscode.l10n.t('Pick a model…'),
        });
        if (!pickedModel) return;
        await config.update('ai.modelId', pickedModel.modelId, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(vscode.l10n.t('AI: {0} — {1}', 'VS Code LM', pickedModel.modelId || vscode.l10n.t('Auto')));

      } else if (pickedProvider.providerId === 'ollama') {
        const ollamaUrl: string = config.get('ai.ollamaUrl', 'http://localhost:11434');
        const currentModel: string = config.get('ai.ollamaModel', 'llama3');

        type OllamaModel = { name: string; details?: { parameter_size?: string; family?: string } };
        let ollamaModels: OllamaModel[] = [];
        try {
          const res = await fetch(`${ollamaUrl}/api/tags`);
          if (res.ok) {
            const data = await res.json() as { models?: OllamaModel[] };
            ollamaModels = data.models ?? [];
          }
        } catch { /* Ollama not running or unreachable */ }

        let chosenModel: string | undefined;
        if (ollamaModels.length > 0) {
          type OllamaItem = vscode.QuickPickItem & { modelName: string };
          const modelItems: OllamaItem[] = ollamaModels.map(m => ({
            label: m.name,
            description: [m.details?.family, m.details?.parameter_size].filter(Boolean).join(' · ')
              + (m.name === currentModel ? '  $(check)' : ''),
            modelName: m.name,
          }));
          const picked = await vscode.window.showQuickPick(modelItems, {
            title: vscode.l10n.t('Select Ollama Model'),
            placeHolder: vscode.l10n.t('Pick a local model…'),
          });
          if (!picked) return;
          chosenModel = picked.modelName;
        } else {
          // Ollama unreachable — fall back to manual input
          const msg = ollamaModels.length === 0
            ? 'Could not reach Ollama. Enter the model name manually.'
            : undefined;
          if (msg) {
            vscode.window.showWarningMessage(vscode.l10n.t('Could not reach Ollama. Enter the model name manually.'));
            logWarn('selectAiModel:ollama', msg);
          }
          const input = await vscode.window.showInputBox({
            title: vscode.l10n.t('Ollama Model'),
            prompt: vscode.l10n.t('Enter the Ollama model name'),
            value: currentModel,
            placeHolder: vscode.l10n.t('e.g. {0}', 'llama3, mistral, qwen3.5:9b'),
          });
          if (input === undefined) return;
          chosenModel = input.trim() || 'llama3';
        }

        await config.update('ai.ollamaModel', chosenModel, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(vscode.l10n.t('AI: {0} — {1}', 'Ollama', chosenModel));

      } else if (pickedProvider.providerId === 'lmstudio') {
        const lmstudioUrl: string = config.get('ai.lmstudioUrl', 'http://localhost:1234');
        const currentModel: string = config.get('ai.lmstudioModel', '');

        type LMStudioModel = { id: string };
        let lmstudioModels: LMStudioModel[] = [];
        try {
          const res = await fetch(`${lmstudioUrl}/v1/models`);
          if (res.ok) {
            const data = await res.json() as { data?: LMStudioModel[] };
            lmstudioModels = data.data ?? [];
          }
        } catch { /* LM Studio not running or unreachable */ }

        let chosenModel: string | undefined;
        if (lmstudioModels.length > 0) {
          type LMStudioItem = vscode.QuickPickItem & { modelId: string };
          const modelItems: LMStudioItem[] = lmstudioModels.map(m => ({
            label: m.id,
            description: m.id === currentModel ? '$(check)' : '',
            modelId: m.id,
          }));
          const picked = await vscode.window.showQuickPick(modelItems, {
            title: vscode.l10n.t('Select LM Studio Model'),
            placeHolder: vscode.l10n.t('Pick a loaded model…'),
          });
          if (!picked) return;
          chosenModel = picked.modelId;
        } else {
          vscode.window.showWarningMessage(vscode.l10n.t('Could not reach LM Studio. Make sure it is running and the server is started.'));
          logWarn('selectAiModel:lmstudio', 'Could not reach LM Studio. Make sure it is running and the server is started.');
          const input = await vscode.window.showInputBox({
            title: vscode.l10n.t('LM Studio Model'),
            prompt: vscode.l10n.t('Enter the model identifier (as shown in LM Studio)'),
            value: currentModel,
            placeHolder: vscode.l10n.t('e.g. {0}', 'lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF'),
          });
          if (input === undefined) return;
          chosenModel = input.trim();
        }

        await config.update('ai.lmstudioModel', chosenModel, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(vscode.l10n.t('AI: {0} — {1}', 'LM Studio', chosenModel || vscode.l10n.t({ message: 'default', comment: ['Shown when no specific AI model is configured'] })));

      } else if (pickedProvider.providerId === 'claude-api') {
        const currentModel: string = config.get('ai.claudeModel', '');
        const CUSTOM_ID = '__custom__';
        type ClaudeApiItem = vscode.QuickPickItem & { modelId: string };
        const claudeApiModels: ClaudeApiItem[] = [
          { label: 'claude-sonnet-4-6',        description: vscode.l10n.t('Balanced')      + (currentModel === 'claude-sonnet-4-6'        ? '  $(check)' : ''), modelId: 'claude-sonnet-4-6' },
          { label: 'claude-opus-4-8',           description: vscode.l10n.t('Most capable')  + (currentModel === 'claude-opus-4-8'           ? '  $(check)' : ''), modelId: 'claude-opus-4-8' },
          { label: 'claude-haiku-4-5-20251001', description: vscode.l10n.t('Fastest')       + (currentModel === 'claude-haiku-4-5-20251001' ? '  $(check)' : ''), modelId: 'claude-haiku-4-5-20251001' },
          { label: `$(edit) ${vscode.l10n.t('Enter model ID…')}`, description: vscode.l10n.t('Specify a custom model ID'), modelId: CUSTOM_ID },
        ];
        const pickedClaudeApi = await vscode.window.showQuickPick(claudeApiModels, {
          title: vscode.l10n.t('Select Claude Model'),
          placeHolder: vscode.l10n.t('Pick a model…'),
        });
        if (!pickedClaudeApi) return;
        let chosenClaudeApi = pickedClaudeApi.modelId;
        if (chosenClaudeApi === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: vscode.l10n.t('Claude Model ID'),
            prompt: vscode.l10n.t('Enter the full model ID'),
            value: currentModel,
            placeHolder: vscode.l10n.t('e.g. {0}', 'claude-opus-4-8'),
          });
          if (input === undefined) return;
          chosenClaudeApi = input.trim();
        }
        await config.update('ai.claudeModel', chosenClaudeApi, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(vscode.l10n.t('AI: {0} — {1}', 'Claude API', chosenClaudeApi || vscode.l10n.t({ message: 'default', comment: ['Shown when no specific AI model is configured'] })));

      } else if (pickedProvider.providerId === 'openai-api') {
        const currentModel: string = config.get('ai.openaiModel', 'gpt-4o');
        const CUSTOM_ID = '__custom__';
        type OpenAIItem = vscode.QuickPickItem & { modelId: string };
        const openaiModels: OpenAIItem[] = [
          { label: 'gpt-4o',      description: vscode.l10n.t('Balanced')     + (currentModel === 'gpt-4o'      ? '  $(check)' : ''), modelId: 'gpt-4o' },
          { label: 'gpt-4o-mini', description: vscode.l10n.t('Fast & cheap') + (currentModel === 'gpt-4o-mini' ? '  $(check)' : ''), modelId: 'gpt-4o-mini' },
          { label: 'o3',          description: vscode.l10n.t('Most capable') + (currentModel === 'o3'          ? '  $(check)' : ''), modelId: 'o3' },
          { label: 'o4-mini',     description: vscode.l10n.t('Fast & smart') + (currentModel === 'o4-mini'     ? '  $(check)' : ''), modelId: 'o4-mini' },
          { label: `$(edit) ${vscode.l10n.t('Enter model ID…')}`, description: vscode.l10n.t('Specify a custom model ID'), modelId: CUSTOM_ID },
        ];
        const pickedOpenAI = await vscode.window.showQuickPick(openaiModels, {
          title: vscode.l10n.t('Select OpenAI Model'),
          placeHolder: vscode.l10n.t('Pick a model…'),
        });
        if (!pickedOpenAI) return;
        let chosenOpenAI = pickedOpenAI.modelId;
        if (chosenOpenAI === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: vscode.l10n.t('OpenAI Model ID'),
            prompt: vscode.l10n.t('Enter the full model ID'),
            value: currentModel,
            placeHolder: vscode.l10n.t('e.g. {0}', 'gpt-4o, o3'),
          });
          if (input === undefined) return;
          chosenOpenAI = input.trim();
        }
        await config.update('ai.openaiModel', chosenOpenAI, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(vscode.l10n.t('AI: {0} — {1}', 'OpenAI API', chosenOpenAI || vscode.l10n.t({ message: 'default', comment: ['Shown when no specific AI model is configured'] })));

      } else if (pickedProvider.providerId === 'claude-cli') {
        const currentModel: string = config.get('ai.claudeModel', '');
        const CUSTOM_ID = '__custom__';
        type ClaudeItem = vscode.QuickPickItem & { modelId: string };
        const claudeModels: ClaudeItem[] = [
          { label: vscode.l10n.t('Default ({0})', 'claude-sonnet-4-6'), description: !currentModel ? `$(check) ${vscode.l10n.t({ message: 'current', comment: ['Marks the currently selected AI model in a quick pick'] })}` : '', modelId: '' },
          { label: 'claude-opus-4-7',     description: vscode.l10n.t('Most capable') + (currentModel === 'claude-opus-4-7'     ? '  $(check)' : ''), modelId: 'claude-opus-4-7' },
          { label: 'claude-sonnet-4-6',   description: vscode.l10n.t('Balanced')     + (currentModel === 'claude-sonnet-4-6'   ? '  $(check)' : ''), modelId: 'claude-sonnet-4-6' },
          { label: 'claude-haiku-4-5-20251001', description: vscode.l10n.t('Fastest')+ (currentModel === 'claude-haiku-4-5-20251001' ? '  $(check)' : ''), modelId: 'claude-haiku-4-5-20251001' },
          { label: `$(edit) ${vscode.l10n.t('Enter model ID…')}`, description: vscode.l10n.t('Specify a custom model ID'), modelId: CUSTOM_ID },
        ];
        const pickedClaude = await vscode.window.showQuickPick(claudeModels, {
          title: vscode.l10n.t('Select Claude Model'),
          placeHolder: vscode.l10n.t('Pick a model…'),
        });
        if (!pickedClaude) return;
        let chosenClaude = pickedClaude.modelId;
        if (chosenClaude === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: vscode.l10n.t('Claude Model ID'),
            prompt: vscode.l10n.t('Enter the full model ID'),
            value: currentModel,
            placeHolder: vscode.l10n.t('e.g. {0}', 'claude-opus-4-7'),
          });
          if (input === undefined) return;
          chosenClaude = input.trim();
        }
        await config.update('ai.claudeModel', chosenClaude, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(vscode.l10n.t('AI: {0} — {1}', 'Claude CLI', chosenClaude || vscode.l10n.t({ message: 'default', comment: ['Shown when no specific AI model is configured'] })));

      } else if (pickedProvider.providerId === 'codex-cli') {
        const currentModel: string = config.get('ai.codexModel', '');
        const CUSTOM_ID = '__custom__';
        type CodexItem = vscode.QuickPickItem & { modelId: string };
        const codexModels: CodexItem[] = [
          { label: vscode.l10n.t('Default ({0} account default)', 'codex'), description: !currentModel ? `$(check) ${vscode.l10n.t({ message: 'current', comment: ['Marks the currently selected AI model in a quick pick'] })}` : '', modelId: '' },
          { label: 'o4-mini',  description: vscode.l10n.t('Fast & efficient') + (currentModel === 'o4-mini'  ? '  $(check)' : ''), modelId: 'o4-mini' },
          { label: 'o3',       description: vscode.l10n.t('Most capable')     + (currentModel === 'o3'       ? '  $(check)' : ''), modelId: 'o3' },
          { label: 'o3-mini',  description: vscode.l10n.t('Balanced')         + (currentModel === 'o3-mini'  ? '  $(check)' : ''), modelId: 'o3-mini' },
          { label: `$(edit) ${vscode.l10n.t('Enter model ID…')}`, description: vscode.l10n.t('Specify a custom model ID'), modelId: CUSTOM_ID },
        ];
        const pickedCodex = await vscode.window.showQuickPick(codexModels, {
          title: vscode.l10n.t('Select Codex Model'),
          placeHolder: vscode.l10n.t('Pick a model…'),
        });
        if (!pickedCodex) return;
        let chosenCodex = pickedCodex.modelId;
        if (chosenCodex === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: vscode.l10n.t('Codex Model ID'),
            prompt: vscode.l10n.t('Enter the full model ID'),
            value: currentModel,
            placeHolder: vscode.l10n.t('e.g. {0}', 'o3, o4-mini'),
          });
          if (input === undefined) return;
          chosenCodex = input.trim();
        }
        await config.update('ai.codexModel', chosenCodex, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(vscode.l10n.t('AI: {0} — {1}', 'Codex CLI', chosenCodex || vscode.l10n.t({ message: 'default', comment: ['Shown when no specific AI model is configured'] })));

      } else if (pickedProvider.providerId === 'gemini-api' || pickedProvider.providerId === 'gemini-cli') {
        const isApi = pickedProvider.providerId === 'gemini-api';
        const currentModel: string = config.get('ai.geminiModel', '');
        const CUSTOM_ID = '__custom__';
        type GeminiItem = vscode.QuickPickItem & { modelId: string };
        const geminiModels: GeminiItem[] = [
          { label: isApi ? vscode.l10n.t('Default ({0})', 'gemini-2.0-flash') : vscode.l10n.t('Default ({0} account default)', 'gemini'), description: !currentModel ? `$(check) ${vscode.l10n.t({ message: 'current', comment: ['Marks the currently selected AI model in a quick pick'] })}` : '', modelId: '' },
          { label: 'gemini-2.0-flash',  description: vscode.l10n.t('Fast & efficient') + (currentModel === 'gemini-2.0-flash'  ? '  $(check)' : ''), modelId: 'gemini-2.0-flash' },
          { label: 'gemini-2.5-flash',  description: vscode.l10n.t('Balanced')         + (currentModel === 'gemini-2.5-flash'  ? '  $(check)' : ''), modelId: 'gemini-2.5-flash' },
          { label: 'gemini-2.5-pro',    description: vscode.l10n.t('Most capable')     + (currentModel === 'gemini-2.5-pro'    ? '  $(check)' : ''), modelId: 'gemini-2.5-pro' },
          { label: `$(edit) ${vscode.l10n.t('Enter model ID…')}`, description: vscode.l10n.t('Specify a custom model ID'), modelId: CUSTOM_ID },
        ];
        const pickedGemini = await vscode.window.showQuickPick(geminiModels, {
          title: vscode.l10n.t('Select Gemini Model'),
          placeHolder: vscode.l10n.t('Pick a model…'),
        });
        if (!pickedGemini) return;
        let chosenGemini = pickedGemini.modelId;
        if (chosenGemini === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: vscode.l10n.t('Gemini Model ID'),
            prompt: vscode.l10n.t('Enter the full model ID'),
            value: currentModel,
            placeHolder: vscode.l10n.t('e.g. {0}', 'gemini-2.5-pro'),
          });
          if (input === undefined) return;
          chosenGemini = input.trim();
        }
        await config.update('ai.geminiModel', chosenGemini, vscode.ConfigurationTarget.Global);
        const label = isApi ? 'Gemini API' : 'Gemini CLI';
        vscode.window.showInformationMessage(vscode.l10n.t('AI: {0} — {1}', label, chosenGemini || vscode.l10n.t({ message: 'default', comment: ['Shown when no specific AI model is configured'] })));
      }
    }),

    // ── Worktree commands ─────────────────────────────────────────────────────
    vscode.commands.registerCommand('gitcharm.worktree.add', async () => {
      if (!commitPanel) return;
      // Determine which repo to use
      const metas = manager?.getRepoMetas().filter(m => (m.depth ?? 0) === 0) ?? [];
      let repoId: string | undefined;
      if (metas.length === 1) {
        repoId = metas[0].id;
      } else if (metas.length > 1) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: m.name, description: m.rootPath, id: m.id })),
          { title: vscode.l10n.t('New Worktree — Select Repository'), placeHolder: vscode.l10n.t('Select a repository…') }
        );
        if (!picked) return;
        repoId = picked.id;
      }
      if (!repoId) return;
      commitPanel.handleSubmoduleCommand({ type: 'WORKTREE_CREATE_PROMPT', repoId });
    }),

    vscode.commands.registerCommand('gitcharm.worktree.prune', async () => {
      if (!commitPanel) return;
      const metas = manager?.getRepoMetas().filter(m => (m.depth ?? 0) === 0) ?? [];
      let repoId: string | undefined;
      if (metas.length === 1) {
        repoId = metas[0].id;
      } else if (metas.length > 1) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: m.name, description: m.rootPath, id: m.id })),
          { title: vscode.l10n.t('Prune Worktrees — Select Repository'), placeHolder: vscode.l10n.t('Select a repository…') }
        );
        if (!picked) return;
        repoId = picked.id;
      }
      if (!repoId) return;
      commitPanel.handleSubmoduleCommand({ type: 'WORKTREE_PRUNE', requestId: Math.random().toString(36).slice(2), repoId });
    }),

    // ── Pull Request commands ─────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.pullRequests.refresh', async () => {
      await commitPanel.requestPullRequestRefresh();
    }),

    vscode.commands.registerCommand('gitcharm.pullRequests.manageCredentials', async () => {
      if (!pullRequestManager || !manager) return;

      const ADD_NEW = Symbol('add-new');
      const accounts = pullRequestManager.listAccounts();
      const grouped = [...accounts].sort((a, b) =>
        forgeProviderLabel(a.provider).localeCompare(forgeProviderLabel(b.provider)) || a.label.localeCompare(b.label)
      );

      const avatars = await Promise.all(grouped.map(async account => {
        const email = await pullRequestManager.getAccountEmail(account);
        return email ? resolveAvatarIconPath(email, context.globalStorageUri.fsPath) : undefined;
      }));

      const items: (vscode.QuickPickItem & { accountId?: string | typeof ADD_NEW })[] = [];
      let lastProvider: string | undefined;
      grouped.forEach((account, i) => {
        if (account.provider !== lastProvider) {
          items.push({ label: forgeProviderLabel(account.provider), kind: vscode.QuickPickItemKind.Separator });
          lastProvider = account.provider;
        }
        items.push({ label: account.label, description: account.host, iconPath: avatars[i], accountId: account.id });
      });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: `$(add) ${vscode.l10n.t('Add account…')}`, accountId: ADD_NEW });

      const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Pull Request Accounts'), placeHolder: vscode.l10n.t('Select an account, or add a new one') });
      if (!picked || !picked.accountId) return;

      if (picked.accountId === ADD_NEW) {
        const provider = await vscode.window.showQuickPick(
          [
            { label: 'GitLab', provider: 'gitlab' as const },
            { label: 'Bitbucket Cloud', provider: 'bitbucket' as const },
            { label: 'Gitea / Forgejo', provider: 'gitea' as const },
          ],
          { title: vscode.l10n.t('Add Account'), placeHolder: vscode.l10n.t('Select a forge (GitHub uses your VS Code account, no token needed)') }
        );
        if (!provider) return;
        const host = await vscode.window.showInputBox({
          title: vscode.l10n.t('Add Account — Host'),
          prompt: vscode.l10n.t('Enter the host for this account'),
          placeHolder: provider.provider === 'gitlab' ? 'gitlab.com' : provider.provider === 'bitbucket' ? 'bitbucket.org' : 'gitea.example.com',
          value: provider.provider === 'gitlab' ? 'gitlab.com' : provider.provider === 'bitbucket' ? 'bitbucket.org' : undefined,
        });
        if (!host?.trim()) return;

        let email: string | undefined;
        if (provider.provider === 'bitbucket') {
          email = await vscode.window.showInputBox({ title: vscode.l10n.t('Add Account — Account Email'), prompt: vscode.l10n.t('Enter your Atlassian account email'), placeHolder: 'you@example.com' });
          if (!email?.trim()) return;
        }
        const apiToken = await vscode.window.showInputBox({
          title: provider.provider === 'bitbucket' ? vscode.l10n.t('Add Account — API Token') : vscode.l10n.t('Add Account — Personal Access Token'),
          prompt: provider.provider === 'bitbucket'
            ? vscode.l10n.t('Enter a Bitbucket API Token for {0}', host.trim())
            : vscode.l10n.t('Enter a Personal Access Token for {0}', host.trim()),
          placeHolder: vscode.l10n.t('Token is stored securely and never leaves this machine'),
          password: true,
        });
        if (!apiToken?.trim()) return;
        const label = await vscode.window.showInputBox({
          title: vscode.l10n.t('Add Account — Label'),
          prompt: vscode.l10n.t('Give this account a label (e.g. "Work" or "Personal") — helps tell accounts apart if you add more later'),
          placeHolder: email?.trim() || host.trim(),
        });

        const result = await pullRequestManager.addAccountStandalone(
          provider.provider, host.trim(), label?.trim() || email?.trim() || host.trim(),
          { apiToken: apiToken.trim(), email: email?.trim() }
        );
        if (!result.ok) {
          vscode.window.showErrorMessage(result.error ?? vscode.l10n.t('Failed to validate token'));
          return;
        }
        vscode.window.showInformationMessage(vscode.l10n.t('Added account for {0}. Assign it to a repo from the Pull Requests panel.', host.trim()));
        return;
      }

      // An existing account was picked — offer rename/remove.
      const account = accounts.find(a => a.id === picked.accountId);
      if (!account) return;

      const accountAction = await vscode.window.showQuickPick(
        [
          { label: `$(edit) ${vscode.l10n.t('Rename')}`, action: 'rename' as const },
          { label: `$(trash) ${vscode.l10n.t('Remove')}`, action: 'remove' as const },
        ],
        { title: account.label, placeHolder: `${forgeProviderLabel(account.provider)} — ${account.host}` }
      );
      if (!accountAction) return;

      if (accountAction.action === 'rename') {
        const newLabel = await vscode.window.showInputBox({
          title: vscode.l10n.t('Rename Account'),
          prompt: vscode.l10n.t('Enter a new label for this account'),
          value: account.label,
        });
        if (!newLabel?.trim() || newLabel.trim() === account.label) return;
        await pullRequestManager.renameAccount(account.id, newLabel.trim());
        await commitPanel.requestPullRequestRefresh();
        vscode.window.showInformationMessage(vscode.l10n.t('Renamed to "{0}".', newLabel.trim()));
        return;
      }

      // accountAction.action === 'remove'
      const remove = vscode.l10n.t('Remove');
      const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('Remove the "{0}" account? Any repo assigned to it will be disconnected.', account.label), { modal: true }, remove);
      if (confirm !== remove) return;
      await pullRequestManager.removeAccount(account.id);
      await commitPanel.requestPullRequestRefresh();
      vscode.window.showInformationMessage(vscode.l10n.t('Removed "{0}".', account.label));
    }),

    // ── File History ──────────────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.showFileHistory', async (uri?: vscode.Uri) => {
      if (!manager || !extensionUri) return;
      // uri comes from explorer/context or editor/context; fall back to active editor
      const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!fileUri || fileUri.scheme !== 'file') {
        vscode.window.showInformationMessage(vscode.l10n.t('Open a file to view its history.'));
        return;
      }
      await openFileHistoryPanel(extensionUri, manager, fileUri, logPanel);
    }),

    // ── Compare With ────────────────────────────────────────────────────────────

    vscode.commands.registerCommand('gitcharm.compareWith', async (uri?: vscode.Uri) => {
      if (!manager) return;
      // uri comes from explorer/context or editor/context; fall back to active editor
      const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!fileUri || fileUri.scheme !== 'file') {
        vscode.window.showInformationMessage(vscode.l10n.t('Select a file or folder to compare.'));
        return;
      }
      await compareWithCommand(manager, fileUri);
    }),
  );

  // ─────────────────────────────────────────────────────────────────────────

  // Track files with conflict markers so we know when they've been resolved
  const conflictedFiles = new Set<string>();

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.uri.scheme !== 'file') return;
      if (doc.getText().includes('<<<<<<<')) {
        conflictedFiles.add(doc.uri.fsPath);
      }
    }),

    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'file') return;
      if (e.document.getText().includes('<<<<<<<')) {
        conflictedFiles.add(e.document.uri.fsPath);
      }
    }),

    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme !== 'file') return;
      if (!conflictedFiles.has(doc.uri.fsPath)) return;
      if (!doc.getText().includes('<<<<<<<')) {
        conflictedFiles.delete(doc.uri.fsPath);
        if (!vscode.workspace.getConfiguration('gitcharm').get<boolean>('openCommitPanelOnConflictResolved', true)) return;
        // Delay to run after VS Code's built-in SCM view focus
        setTimeout(() => {
          vscode.commands.executeCommand('gitcharm.commitPanel.focus');
        }, 300);
      }
    }),
  );
}

async function pickSubmodule(
  manager: WorkspaceGitManager | undefined,
  repoId: string | undefined,
  _requireInitialized: boolean,
): Promise<{ parentRepoId: string; submodulePath: string } | undefined> {
  const metas = manager?.getRepoMetas().filter(m => m.isSubmodule) ?? [];
  if (metas.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('No submodules found in this workspace.'));
    return undefined;
  }

  let meta = repoId ? metas.find(m => m.id === repoId) : undefined;
  if (!meta && metas.length === 1) meta = metas[0];
  if (!meta) {
    const picked = await vscode.window.showQuickPick(
      metas.map(m => ({ label: m.name, description: m.submodulePath ?? '', id: m.id })),
      { title: vscode.l10n.t('Select Submodule'), placeHolder: vscode.l10n.t('Select a submodule…') }
    );
    if (!picked) return undefined;
    meta = metas.find(m => m.id === picked.id);
  }
  if (!meta?.parentRepoId || !meta.submodulePath) return undefined;
  return { parentRepoId: meta.parentRepoId, submodulePath: meta.submodulePath };
}
