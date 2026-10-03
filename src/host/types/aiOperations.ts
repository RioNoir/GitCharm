// The AI operations of GitCharm, each of which can use its own provider and model
// (gitcharm.ai.operationModels) instead of the default ones (gitcharm.ai.provider + that provider's model).
// No vscode import: the settings webview bundles this file too.

export type AiOperation = 'commitMessage' | 'pullRequest' | 'explain' | 'resolveConflicts' | 'issues';

export const AI_OPERATIONS: readonly AiOperation[] = ['commitMessage', 'pullRequest', 'explain', 'resolveConflicts', 'issues'];

/** An operation's own provider and model. An empty model means the provider's default one. */
export interface AiOperationTarget {
  provider: string;
  model?: string;
}

export const AI_PROVIDERS: readonly string[] = [
  'vscode-lm', 'claude-api', 'openai-api', 'gemini-api', 'claude-cli', 'codex-cli', 'gemini-cli', 'ollama', 'lmstudio',
];

/** The setting holding each provider's model. Claude and Gemini share theirs between API and CLI. */
export const AI_MODEL_SETTING: Record<string, string> = {
  'vscode-lm': 'ai.modelId',
  'claude-api': 'ai.claudeModel',
  'claude-cli': 'ai.claudeModel',
  'openai-api': 'ai.openaiModel',
  'gemini-api': 'ai.geminiModel',
  'gemini-cli': 'ai.geminiModel',
  'codex-cli': 'ai.codexModel',
  ollama: 'ai.ollamaModel',
  lmstudio: 'ai.lmStudioModel',
};

/** The override for `operation` in the gitcharm.ai.operationModels value, if it's a valid one. */
export function operationOverride(value: unknown, operation: AiOperation): AiOperationTarget | undefined {
  const entry = (value && typeof value === 'object' ? (value as Record<string, unknown>)[operation] : undefined) as Partial<AiOperationTarget> | undefined;
  if (!entry || typeof entry.provider !== 'string' || !AI_PROVIDERS.includes(entry.provider)) return undefined;
  return { provider: entry.provider, model: typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : undefined };
}
