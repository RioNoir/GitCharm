import * as vscode from 'vscode';
import { CommitPanelProvider } from '../panels/CommitPanelProvider';
import { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { MergeEditorProvider } from '../panels/MergeEditorProvider';
import { BranchStatusBar } from '../ui/BranchStatusBar';
import { FileAnnotationController } from '../ui/FileAnnotationController';
import { ProfileStatusBar } from '../ui/ProfileStatusBar';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';

export function registerCommands(
  context: vscode.ExtensionContext,
  commitPanel: CommitPanelProvider,
  logPanel: GitLogPanelProvider,
  mergeEditor: MergeEditorProvider,
  branchStatusBar: BranchStatusBar,
  annotationController: FileAnnotationController,
  profileStatusBar: ProfileStatusBar,
  manager?: WorkspaceGitManager,
): void {
  context.subscriptions.push(
    // Focus the Git Log panel in the bottom bar
    vscode.commands.registerCommand('gitcharm.openLog', () => {
      logPanel.focus();
    }),

    vscode.commands.registerCommand('gitcharm.refreshCommitPanel', () => {
      commitPanel.refresh();
    }),

    vscode.commands.registerCommand('gitcharm.openMergeEditor', () => {
      mergeEditor.openCurrentEditorFile();
    }),

    vscode.commands.registerCommand('gitcharm.commit', () => {
      vscode.commands.executeCommand('gitcharm.commitPanel.focus');
    }),

    vscode.commands.registerCommand('gitcharm.pull', () => {
      return branchStatusBar.updateProject();
    }),

    vscode.commands.registerCommand('gitcharm.push', () => {
      return branchStatusBar.push();
    }),

    vscode.commands.registerCommand('gitcharm.fetchAll', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitCharm: Fetching all remotes', cancellable: false },
        async () => { /* delegated to panel message handler */ }
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

    vscode.commands.registerCommand('gitcharm.openGitAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.openAnnotations(editor);
    }),

    vscode.commands.registerCommand('gitcharm.closeGitAnnotations', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) annotationController.closeAnnotations(editor);
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

    vscode.commands.registerCommand('gitcharm.reloadRepositories', () => {
      if (manager) {
        manager.reinitializeAndRefresh();
      }
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
          { title: 'Open Submodule in New Window', placeHolder: 'Select a submodule…' }
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
        { label: '$(copilot) VS Code LM', description: 'GitHub Copilot or any registered LM extension', providerId: 'vscode-lm' },
        { label: '$(cloud) Claude API', description: 'Anthropic API  (requires API key)', providerId: 'claude-api' },
        { label: '$(cloud) OpenAI API', description: 'OpenAI API  (requires API key)', providerId: 'openai-api' },
        { label: '$(terminal) Claude CLI', description: 'claude --print  (Claude Code / Anthropic)', providerId: 'claude-cli' },
        { label: '$(terminal) Codex CLI', description: 'codex exec  (OpenAI Codex)', providerId: 'codex-cli' },
        { label: '$(server) Ollama', description: 'Local model via Ollama HTTP API', providerId: 'ollama' },
        { label: '$(server) LM Studio', description: 'Local model via LM Studio HTTP API', providerId: 'lmstudio' },
      ].map(item => ({
        ...item,
        description: `${item.description}${item.providerId === currentProvider ? '  $(check)' : ''}`,
      }));
      providerItems.push({ label: '$(settings-gear) Open AI Settings', description: 'Configure paths, model, diff limits…', providerId: OPEN_SETTINGS_ID, kind: vscode.QuickPickItemKind.Default });

      const pickedProvider = await vscode.window.showQuickPick(providerItems, {
        title: 'GitCharm: Select AI Provider',
        placeHolder: 'Choose a provider…',
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
          vscode.window.showInformationMessage('Provider set to VS Code LM. No models found — install GitHub Copilot or another LM extension.');
          return;
        }

        const currentModelId: string = config.get('ai.modelId', '');
        type ModelItem = vscode.QuickPickItem & { modelId: string };
        const modelItems: ModelItem[] = [
          { label: 'Auto (first available)', description: !currentModelId ? '$(check) current' : '', modelId: '' },
          ...models.map(m => ({
            label: `${m.vendor} — ${m.family}`,
            description: `${m.vendor}:${m.family}` === currentModelId ? '$(check) current' : '',
            modelId: `${m.vendor}:${m.family}`,
          })),
        ];

        const pickedModel = await vscode.window.showQuickPick(modelItems, {
          title: 'GitCharm: Select VS Code LM Model',
          placeHolder: 'Pick a model…',
        });
        if (!pickedModel) return;
        await config.update('ai.modelId', pickedModel.modelId, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`GitCharm AI: VS Code LM — ${pickedModel.modelId || 'Auto'}`);

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
            title: 'GitCharm: Select Ollama Model',
            placeHolder: 'Pick a local model…',
          });
          if (!picked) return;
          chosenModel = picked.modelName;
        } else {
          // Ollama unreachable — fall back to manual input
          const msg = ollamaModels.length === 0
            ? 'Could not reach Ollama. Enter the model name manually.'
            : undefined;
          if (msg) vscode.window.showWarningMessage(msg);
          const input = await vscode.window.showInputBox({
            title: 'GitCharm: Ollama Model',
            prompt: 'Enter the Ollama model name',
            value: currentModel,
            placeHolder: 'e.g. llama3, mistral, qwen3.5:9b',
          });
          if (input === undefined) return;
          chosenModel = input.trim() || 'llama3';
        }

        await config.update('ai.ollamaModel', chosenModel, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`GitCharm AI: Ollama — ${chosenModel}`);

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
            title: 'GitCharm: Select LM Studio Model',
            placeHolder: 'Pick a loaded model…',
          });
          if (!picked) return;
          chosenModel = picked.modelId;
        } else {
          vscode.window.showWarningMessage('Could not reach LM Studio. Make sure it is running and the server is started.');
          const input = await vscode.window.showInputBox({
            title: 'GitCharm: LM Studio Model',
            prompt: 'Enter the model identifier (as shown in LM Studio)',
            value: currentModel,
            placeHolder: 'e.g. lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF',
          });
          if (input === undefined) return;
          chosenModel = input.trim();
        }

        await config.update('ai.lmstudioModel', chosenModel, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`GitCharm AI: LM Studio — ${chosenModel || 'default'}`);

      } else if (pickedProvider.providerId === 'claude-api') {
        const currentModel: string = config.get('ai.claudeModel', '');
        const CUSTOM_ID = '__custom__';
        type ClaudeApiItem = vscode.QuickPickItem & { modelId: string };
        const claudeApiModels: ClaudeApiItem[] = [
          { label: 'claude-sonnet-4-6',        description: 'Balanced'      + (currentModel === 'claude-sonnet-4-6'        ? '  $(check)' : ''), modelId: 'claude-sonnet-4-6' },
          { label: 'claude-opus-4-8',           description: 'Most capable'  + (currentModel === 'claude-opus-4-8'           ? '  $(check)' : ''), modelId: 'claude-opus-4-8' },
          { label: 'claude-haiku-4-5-20251001', description: 'Fastest'       + (currentModel === 'claude-haiku-4-5-20251001' ? '  $(check)' : ''), modelId: 'claude-haiku-4-5-20251001' },
          { label: '$(edit) Enter model ID…', description: 'Specify a custom model ID', modelId: CUSTOM_ID },
        ];
        const pickedClaudeApi = await vscode.window.showQuickPick(claudeApiModels, {
          title: 'GitCharm: Select Claude Model',
          placeHolder: 'Pick a model…',
        });
        if (!pickedClaudeApi) return;
        let chosenClaudeApi = pickedClaudeApi.modelId;
        if (chosenClaudeApi === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: 'GitCharm: Claude Model ID',
            prompt: 'Enter the full model ID',
            value: currentModel,
            placeHolder: 'e.g. claude-opus-4-8',
          });
          if (input === undefined) return;
          chosenClaudeApi = input.trim();
        }
        await config.update('ai.claudeModel', chosenClaudeApi, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`GitCharm AI: Claude API — ${chosenClaudeApi || 'default'}`);

      } else if (pickedProvider.providerId === 'openai-api') {
        const currentModel: string = config.get('ai.openaiModel', 'gpt-4o');
        const CUSTOM_ID = '__custom__';
        type OpenAIItem = vscode.QuickPickItem & { modelId: string };
        const openaiModels: OpenAIItem[] = [
          { label: 'gpt-4o',      description: 'Balanced'     + (currentModel === 'gpt-4o'      ? '  $(check)' : ''), modelId: 'gpt-4o' },
          { label: 'gpt-4o-mini', description: 'Fast & cheap' + (currentModel === 'gpt-4o-mini' ? '  $(check)' : ''), modelId: 'gpt-4o-mini' },
          { label: 'o3',          description: 'Most capable' + (currentModel === 'o3'          ? '  $(check)' : ''), modelId: 'o3' },
          { label: 'o4-mini',     description: 'Fast & smart' + (currentModel === 'o4-mini'     ? '  $(check)' : ''), modelId: 'o4-mini' },
          { label: '$(edit) Enter model ID…', description: 'Specify a custom model ID', modelId: CUSTOM_ID },
        ];
        const pickedOpenAI = await vscode.window.showQuickPick(openaiModels, {
          title: 'GitCharm: Select OpenAI Model',
          placeHolder: 'Pick a model…',
        });
        if (!pickedOpenAI) return;
        let chosenOpenAI = pickedOpenAI.modelId;
        if (chosenOpenAI === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: 'GitCharm: OpenAI Model ID',
            prompt: 'Enter the full model ID',
            value: currentModel,
            placeHolder: 'e.g. gpt-4o, o3',
          });
          if (input === undefined) return;
          chosenOpenAI = input.trim();
        }
        await config.update('ai.openaiModel', chosenOpenAI, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`GitCharm AI: OpenAI API — ${chosenOpenAI || 'default'}`);

      } else if (pickedProvider.providerId === 'claude-cli') {
        const currentModel: string = config.get('ai.claudeModel', '');
        const CUSTOM_ID = '__custom__';
        type ClaudeItem = vscode.QuickPickItem & { modelId: string };
        const claudeModels: ClaudeItem[] = [
          { label: 'Default (claude-sonnet-4-6)', description: !currentModel ? '$(check) current' : '', modelId: '' },
          { label: 'claude-opus-4-7',     description: 'Most capable' + (currentModel === 'claude-opus-4-7'     ? '  $(check)' : ''), modelId: 'claude-opus-4-7' },
          { label: 'claude-sonnet-4-6',   description: 'Balanced'     + (currentModel === 'claude-sonnet-4-6'   ? '  $(check)' : ''), modelId: 'claude-sonnet-4-6' },
          { label: 'claude-haiku-4-5-20251001', description: 'Fastest'+ (currentModel === 'claude-haiku-4-5-20251001' ? '  $(check)' : ''), modelId: 'claude-haiku-4-5-20251001' },
          { label: '$(edit) Enter model ID…', description: 'Specify a custom model ID', modelId: CUSTOM_ID },
        ];
        const pickedClaude = await vscode.window.showQuickPick(claudeModels, {
          title: 'GitCharm: Select Claude Model',
          placeHolder: 'Pick a model…',
        });
        if (!pickedClaude) return;
        let chosenClaude = pickedClaude.modelId;
        if (chosenClaude === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: 'GitCharm: Claude Model ID',
            prompt: 'Enter the full model ID',
            value: currentModel,
            placeHolder: 'e.g. claude-opus-4-7',
          });
          if (input === undefined) return;
          chosenClaude = input.trim();
        }
        await config.update('ai.claudeModel', chosenClaude, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`GitCharm AI: Claude CLI — ${chosenClaude || 'default'}`);

      } else if (pickedProvider.providerId === 'codex-cli') {
        const currentModel: string = config.get('ai.codexModel', '');
        const CUSTOM_ID = '__custom__';
        type CodexItem = vscode.QuickPickItem & { modelId: string };
        const codexModels: CodexItem[] = [
          { label: 'Default (codex account default)', description: !currentModel ? '$(check) current' : '', modelId: '' },
          { label: 'o4-mini',  description: 'Fast & efficient' + (currentModel === 'o4-mini'  ? '  $(check)' : ''), modelId: 'o4-mini' },
          { label: 'o3',       description: 'Most capable'     + (currentModel === 'o3'       ? '  $(check)' : ''), modelId: 'o3' },
          { label: 'o3-mini',  description: 'Balanced'         + (currentModel === 'o3-mini'  ? '  $(check)' : ''), modelId: 'o3-mini' },
          { label: '$(edit) Enter model ID…', description: 'Specify a custom model ID', modelId: CUSTOM_ID },
        ];
        const pickedCodex = await vscode.window.showQuickPick(codexModels, {
          title: 'GitCharm: Select Codex Model',
          placeHolder: 'Pick a model…',
        });
        if (!pickedCodex) return;
        let chosenCodex = pickedCodex.modelId;
        if (chosenCodex === CUSTOM_ID) {
          const input = await vscode.window.showInputBox({
            title: 'GitCharm: Codex Model ID',
            prompt: 'Enter the full model ID',
            value: currentModel,
            placeHolder: 'e.g. o3, o4-mini',
          });
          if (input === undefined) return;
          chosenCodex = input.trim();
        }
        await config.update('ai.codexModel', chosenCodex, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`GitCharm AI: Codex CLI — ${chosenCodex || 'default'}`);
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
          { title: 'New Worktree — Select Repository', placeHolder: 'Select a repository…' }
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
          { title: 'Prune Worktrees — Select Repository', placeHolder: 'Select a repository…' }
        );
        if (!picked) return;
        repoId = picked.id;
      }
      if (!repoId) return;
      commitPanel.handleSubmoduleCommand({ type: 'WORKTREE_PRUNE', requestId: Math.random().toString(36).slice(2), repoId });
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
  requireInitialized: boolean,
): Promise<{ parentRepoId: string; submodulePath: string } | undefined> {
  const metas = manager?.getRepoMetas().filter(m => m.isSubmodule) ?? [];
  if (metas.length === 0) {
    vscode.window.showInformationMessage('No submodules found in this workspace.');
    return undefined;
  }

  let meta = repoId ? metas.find(m => m.id === repoId) : undefined;
  if (!meta && metas.length === 1) meta = metas[0];
  if (!meta) {
    const picked = await vscode.window.showQuickPick(
      metas.map(m => ({ label: m.name, description: m.submodulePath ?? '', id: m.id })),
      { title: 'Select Submodule', placeHolder: 'Select a submodule…' }
    );
    if (!picked) return undefined;
    meta = metas.find(m => m.id === picked.id);
  }
  if (!meta?.parentRepoId || !meta.submodulePath) return undefined;
  return { parentRepoId: meta.parentRepoId, submodulePath: meta.submodulePath };
}
