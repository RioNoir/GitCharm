import * as vscode from 'vscode';
import { AI_MODEL_SETTING, operationOverride, type AiOperation } from '../types/aiOperations';

/**
 * The provider an operation runs with, and the configuration to read its settings from: the operation's own
 * model (gitcharm.ai.operationModels) stands in for that provider's model setting, so every provider reads
 * its model the usual way.
 */
export function aiConfigFor(operation: AiOperation, cfg = vscode.workspace.getConfiguration('gitcharm')): { provider: string; cfg: vscode.WorkspaceConfiguration } {
  const override = operationOverride(cfg.get('ai.operationModels'), operation);
  const provider = override?.provider ?? cfg.get<string>('ai.provider', 'vscode-lm');
  const model = override?.model;
  if (!model) return { provider, cfg };
  const modelKey = AI_MODEL_SETTING[provider];
  const wrapped = new Proxy(cfg, {
    get(target, prop) {
      if (prop === 'get') {
        return (key: string, defaultValue?: unknown) => (key === modelKey ? model : target.get(key, defaultValue));
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { provider, cfg: wrapped };
}
