import * as vscode from 'vscode';
import { getAiApiKey } from './aiSecrets';

export interface AiModelOption {
  /** The value stored in the provider's model setting. */
  id: string;
  label: string;
  detail?: string;
}

const LIST_TIMEOUT_MS = 10_000;

/**
 * The models a provider offers right now, for a dropdown. Throws (with a message worth showing) when the
 * provider can't be asked: no API key, server not running… CLI providers have no listing API, so callers
 * offer a free-text field for them instead.
 */
export async function listAiModels(provider: string, cfg: vscode.WorkspaceConfiguration): Promise<AiModelOption[]> {
  switch (provider) {
    case 'vscode-lm': {
      const models = await vscode.lm.selectChatModels();
      // Several models can share a family (e.g. per-region endpoints); the setting stores vendor:family.
      const seen = new Set<string>();
      return models
        .map(m => ({ id: `${m.vendor}:${m.family}`, label: m.name || m.family, detail: m.vendor }))
        .filter(m => !seen.has(m.id) && seen.add(m.id));
    }

    case 'claude-api': {
      const apiKey = await requireKey('claude', 'Anthropic');
      const data = await getJson<{ data?: Array<{ id: string; display_name?: string }> }>(
        'https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, 'Anthropic API');
      return (data.data ?? []).map(m => ({ id: m.id, label: m.display_name || m.id, detail: m.display_name ? m.id : undefined }));
    }

    case 'openai-api': {
      const apiKey = await requireKey('openai', 'OpenAI');
      const data = await getJson<{ data?: Array<{ id: string }> }>(
        'https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` }, 'OpenAI API');
      // The listing also has embeddings, audio, image and moderation models, which can't write text.
      return (data.data ?? [])
        .filter(m => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !/(audio|realtime|transcribe|tts|image|search)/.test(m.id))
        .map(m => ({ id: m.id, label: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    case 'gemini-api': {
      const apiKey = await requireKey('gemini', 'Gemini');
      const data = await getJson<{ models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> }>(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`, {}, 'Gemini API');
      return (data.models ?? [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => {
          const id = m.name.replace(/^models\//, '');
          return { id, label: m.displayName || id, detail: m.displayName ? id : undefined };
        });
    }

    case 'ollama': {
      const base = cfg.get<string>('ai.ollamaUrl', 'http://localhost:11434');
      const data = await getJson<{ models?: Array<{ name: string; details?: { parameter_size?: string; family?: string } }> }>(
        `${base}/api/tags`, {}, 'Ollama');
      return (data.models ?? []).map(m => ({
        id: m.name,
        label: m.name,
        detail: [m.details?.family, m.details?.parameter_size].filter(Boolean).join(' · ') || undefined,
      }));
    }

    case 'lmstudio': {
      const base = cfg.get<string>('ai.lmStudioUrl', 'http://localhost:1234');
      const data = await getJson<{ data?: Array<{ id: string }> }>(`${base}/v1/models`, {}, 'LM Studio');
      return (data.data ?? []).map(m => ({ id: m.id, label: m.id }));
    }

    default:
      return [];
  }
}

async function requireKey(provider: 'claude' | 'openai' | 'gemini', label: string): Promise<string> {
  const key = await getAiApiKey(provider);
  if (!key) throw new Error(vscode.l10n.t('Add your {0} API key to list its models.', label));
  return key;
}

async function getJson<T>(url: string, headers: Record<string, string>, label: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch {
    throw new Error(vscode.l10n.t('Could not reach {0}.', label));
  }
  if (!res.ok) throw new Error(vscode.l10n.t('{0} error {1}: {2}', label, res.status, (await res.text()).slice(0, 300)));
  return await res.json() as T;
}
