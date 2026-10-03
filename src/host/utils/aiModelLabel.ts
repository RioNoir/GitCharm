import * as vscode from 'vscode';
import { aiConfigFor } from '../ai/aiOperations';
import type { AiOperation } from '../types/aiOperations';

/** Short human label for the currently configured AI provider/model, e.g. "claude api · claude-sonnet-4-6". */
export function getAiModelLabel(config: vscode.WorkspaceConfiguration, operation?: AiOperation): string {
  // An operation may have a provider and model of its own (gitcharm.ai.operationModels).
  const { provider, cfg } = operation ? aiConfigFor(operation, config) : { provider: config.get<string>('ai.provider', 'vscode-lm'), cfg: config };
  switch (provider) {
    case 'claude-api': {
      const model: string = cfg.get('ai.claudeModel', 'claude-sonnet-4-6');
      return `claude api · ${model || 'claude-sonnet-4-6'}`;
    }
    case 'openai-api': {
      const model: string = cfg.get('ai.openaiModel', 'gpt-4o');
      return `openai api · ${model || 'gpt-4o'}`;
    }
    case 'claude-cli': {
      const model: string = cfg.get('ai.claudeModel', '');
      return model ? `claude · ${model}` : 'claude';
    }
    case 'codex-cli': {
      const model: string = cfg.get('ai.codexModel', '');
      return model ? `codex · ${model}` : 'codex';
    }
    case 'gemini-api': {
      const model: string = cfg.get('ai.geminiModel', 'gemini-2.0-flash');
      return `gemini api · ${model || 'gemini-2.0-flash'}`;
    }
    case 'gemini-cli': {
      const model: string = cfg.get('ai.geminiModel', '');
      return model ? `gemini · ${model}` : 'gemini';
    }
    case 'ollama': {
      const model: string = cfg.get('ai.ollamaModel', 'llama3');
      return `ollama · ${model}`;
    }
    case 'lmstudio': {
      const model: string = cfg.get('ai.lmStudioModel', '');
      return model ? `lmstudio · ${model}` : 'lmstudio';
    }
    default: {
      const modelId: string = cfg.get('ai.modelId', '');
      return modelId ? modelId.replace('copilot:', '') : 'copilot';
    }
  }
}
