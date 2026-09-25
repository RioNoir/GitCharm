import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface GenerateOptions {
  /** Called with the whole text generated so far (not just the latest chunk), at most every
   * PROGRESS_INTERVAL_MS — for providers that can stream (all but the Codex and Gemini CLIs). The final text is
   * still the return value, cleaned up (see cleanModelOutput), which the partial text isn't. */
  onProgress?: (textSoFar: string) => void;
}

const PROGRESS_INTERVAL_MS = 80;
const CLI_TIMEOUT_MS = 60_000;

/** Tells Claude Code it isn't running an agent session: GitCharm only ever needs the text of one answer. Its
 * default system prompt (and tools, MCP servers, skills…) is what makes a plain `claude --print` take several
 * seconds before it even starts answering. */
const CLAUDE_CLI_SYSTEM_PROMPT =
  'You generate text for GitCharm, a Git extension for VS Code. Follow the instructions in the user message exactly. '
  + 'Reply with the requested text only, as plain text: never wrap the whole answer in backticks, quotes or a code fence, '
  + 'and add no preamble or closing remarks.';

export async function generateWithAI(
  provider: string,
  prompt: string,
  cfg: vscode.WorkspaceConfiguration,
  options: GenerateOptions = {},
): Promise<string> {
  const progress = throttledProgress(options.onProgress);
  const text = await generateRaw(provider, prompt, cfg, progress);
  const cleaned = cleanModelOutput(text);
  if (!cleaned) throw new Error(vscode.l10n.t('{0} returned an empty response', providerLabel(provider)));
  return cleaned;
}

/** Strips what models wrap a whole answer in despite being told not to — a code fence, or (for a one-line
 * answer such as a title) backticks or quotes. */
export function cleanModelOutput(text: string): string {
  let t = text.trim();
  const fenced = /^(```|~~~)[\w-]*\n([\s\S]*?)\n\1$/.exec(t);
  if (fenced) t = fenced[2].trim();
  if (!t.includes('\n')) t = t.replace(/^(["'`])(.*)\1$/, '$2').trim();
  return t;
}

/** The same cleanup for text still being streamed: only the opening of a fence can be recognized yet. */
export function cleanPartialModelOutput(text: string): string {
  return text.replace(/^\s*(```|~~~)[\w-]*\n/, '').trimStart();
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'claude-api': return 'Anthropic API';
    case 'openai-api': return 'OpenAI API';
    case 'gemini-api': return 'Gemini API';
    case 'ollama': return 'Ollama';
    case 'lmstudio': return 'LM Studio';
    case 'vscode-lm': return 'VS Code LM';
    default: return 'CLI';
  }
}

type Progress = (textSoFar: string) => void;

function throttledProgress(onProgress: GenerateOptions['onProgress']): Progress {
  if (!onProgress) return () => {};
  let last = 0;
  return text => {
    const now = Date.now();
    if (now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    onProgress(text);
  };
}

async function generateRaw(provider: string, prompt: string, cfg: vscode.WorkspaceConfiguration, progress: Progress): Promise<string> {
  switch (provider) {
    case 'claude-cli': {
      const claudeModel: string = cfg.get('ai.claudeModel', '');
      const args = [
        '--print',
        '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        // A single-answer text generation: no tools, no MCP servers, no skills, no saved session. Not `--bare`,
        // which would also skip the OAuth login most Claude subscriptions authenticate with.
        '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
        '--system-prompt', CLAUDE_CLI_SYSTEM_PROMPT,
        ...(claudeModel ? ['--model', claudeModel] : []),
        prompt,
      ];
      let text = '';
      let result: string | undefined;
      let resultError: string | undefined;
      try {
        await runCli(cfg.get('ai.claudePath', 'claude'), args, '', line => {
          const event = parseJson<ClaudeCliEvent>(line);
          if (!event) return;
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
            text += event.event.delta.text ?? '';
            progress(text);
          } else if (event.type === 'result') {
            if (event.is_error) resultError = event.result || event.subtype || 'error';
            else result = event.result;
          }
        });
      } catch (err) {
        // A failed run still reports its reason as a `result` event on stdout — clearer than the raw JSON stream.
        throw resultError ? new Error(resultError) : err;
      }
      if (resultError) throw new Error(resultError);
      return result ?? text;
    }

    case 'claude-api': {
      const apiKey: string = cfg.get('ai.claudeApiKey', '');
      if (!apiKey) throw new Error(vscode.l10n.t('{0} API key not set. Configure {1} in settings.', 'Anthropic', 'gitcharm.ai.claudeApiKey'));
      const model: string = cfg.get('ai.claudeModel', 'claude-sonnet-4-6');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-6',
          max_tokens: 1024,
          stream: true,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(vscode.l10n.t('{0} error {1}: {2}', 'Anthropic API', res.status, await res.text()));
      let text = '';
      for await (const data of readSse(res)) {
        const event = parseJson<{ type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } }>(data);
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          text += event.delta.text ?? '';
          progress(text);
        } else if (event?.type === 'error') {
          throw new Error(vscode.l10n.t('{0} error {1}: {2}', 'Anthropic API', res.status, event.error?.message ?? data));
        }
      }
      return text;
    }

    case 'openai-api': {
      const apiKey: string = cfg.get('ai.openaiApiKey', '');
      if (!apiKey) throw new Error(vscode.l10n.t('{0} API key not set. Configure {1} in settings.', 'OpenAI', 'gitcharm.ai.openaiApiKey'));
      const model: string = cfg.get('ai.openaiModel', 'gpt-4o');
      return streamChatCompletions('https://api.openai.com/v1/chat/completions', 'OpenAI API', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      }, { model: model || 'gpt-4o', messages: [{ role: 'user', content: prompt }] }, progress);
    }

    case 'gemini-cli': {
      const geminiModel: string = cfg.get('ai.geminiModel', '');
      const geminiArgs = geminiModel ? ['-m', geminiModel, '-p', prompt] : ['-p', prompt];
      return runCli(cfg.get('ai.geminiPath', 'gemini'), geminiArgs, '');
    }

    case 'gemini-api': {
      const apiKey: string = cfg.get('ai.geminiApiKey', '');
      if (!apiKey) throw new Error(vscode.l10n.t('{0} API key not set. Configure {1} in settings.', 'Gemini', 'gitcharm.ai.geminiApiKey'));
      const model: string = cfg.get('ai.geminiModel', 'gemini-2.0-flash');
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:streamGenerateContent?alt=sse&key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (!res.ok) throw new Error(vscode.l10n.t('{0} error {1}: {2}', 'Gemini API', res.status, await res.text()));
      let text = '';
      for await (const data of readSse(res)) {
        const chunk = parseJson<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(data);
        const piece = chunk?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
        if (piece) { text += piece; progress(text); }
      }
      return text;
    }

    case 'codex-cli': {
      const codexModel: string = cfg.get('ai.codexModel', '');
      const codexArgs = ['exec', '--dangerously-bypass-approvals-and-sandbox', ...(codexModel ? ['-m', codexModel] : [])];
      const output = await runCli(cfg.get('ai.codexPath', 'codex'), codexArgs, prompt);
      return output.split('\n').filter(l => l.trim()).pop() ?? output.trim();
    }

    case 'ollama': {
      const model: string = cfg.get('ai.ollamaModel', 'llama3');
      const base: string = cfg.get('ai.ollamaUrl', 'http://localhost:11434');
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(vscode.l10n.t('{0} error {1}: {2}', 'Ollama', res.status, await res.text()));
      let text = '';
      for await (const line of readLines(res)) {
        const chunk = parseJson<{ message?: { content?: string }; error?: string }>(line);
        if (chunk?.error) throw new Error(vscode.l10n.t('{0} error {1}: {2}', 'Ollama', res.status, chunk.error));
        if (chunk?.message?.content) { text += chunk.message.content; progress(text); }
      }
      return text;
    }

    case 'lmstudio': {
      const model: string = cfg.get('ai.lmstudioModel', '');
      const base: string = cfg.get('ai.lmstudioUrl', 'http://localhost:1234');
      return streamChatCompletions(`${base}/v1/chat/completions`, 'LM Studio', { 'Content-Type': 'application/json' },
        { model: model || undefined, messages: [{ role: 'user', content: prompt }] }, progress);
    }

    case 'vscode-lm':
    default: {
      let model: vscode.LanguageModelChat | undefined;
      const modelId: string = cfg.get('ai.modelId', '');
      if (modelId) {
        const [vendor, ...rest] = modelId.split(':');
        const family = rest.join(':');
        const found = await vscode.lm.selectChatModels(family ? { vendor, family } : { vendor });
        model = found[0];
      }
      if (!model) {
        const all = await vscode.lm.selectChatModels();
        model = all[0];
      }
      if (!model) throw new Error(vscode.l10n.t('No VS Code LM model available. Install GitHub Copilot or use the "GitCharm: Select AI Model" command to switch provider.'));
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        new vscode.CancellationTokenSource().token,
      );
      let result = '';
      for await (const chunk of response.text) {
        result += chunk;
        progress(result);
      }
      return result;
    }
  }
}

interface ClaudeCliEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
}

/** OpenAI-compatible `/chat/completions` with `stream: true` (OpenAI, LM Studio). */
async function streamChatCompletions(url: string, label: string, headers: Record<string, string>, body: Record<string, unknown>, progress: Progress): Promise<string> {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
  if (!res.ok) throw new Error(vscode.l10n.t('{0} error {1}: {2}', label, res.status, await res.text()));
  let text = '';
  for await (const data of readSse(res)) {
    if (data === '[DONE]') break;
    const chunk = parseJson<{ choices?: Array<{ delta?: { content?: string } }>; error?: { message?: string } }>(data);
    if (chunk?.error) throw new Error(vscode.l10n.t('{0} error {1}: {2}', label, res.status, chunk.error.message ?? data));
    const piece = chunk?.choices?.[0]?.delta?.content;
    if (piece) { text += piece; progress(text); }
  }
  return text;
}

function parseJson<T>(text: string): T | undefined {
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

/** Yields each line of a streamed response body (NDJSON). */
async function* readLines(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield line;
    }
    if (done) break;
  }
  if (buffer.trim()) yield buffer;
}

/** Yields the `data:` payload of each Server-Sent Event of a streamed response body. */
async function* readSse(res: Response): AsyncGenerator<string> {
  for await (const line of readLines(res)) {
    if (line.startsWith('data:')) yield line.slice(5).trim();
  }
}

/** The user's shell PATH, resolved once per session: a VS Code that didn't inherit it doesn't see the PATH the
 * shell sets up (Homebrew, ~/.local/bin…), where these CLIs usually live. Interactive as well as login (`-ilc`)
 * because that's where most setups add to PATH (~/.zshrc, ~/.bashrc — a login-only shell never reads them);
 * the marker picks the PATH line out of anything those rc files print themselves. */
let loginShellPath: Promise<string | undefined> | undefined;
const PATH_MARKER = '__GITCHARM_PATH__';

function getLoginShellPath(): Promise<string | undefined> {
  loginShellPath ??= new Promise(resolve => {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const child = spawn(shell, ['-ilc', `echo "${PATH_MARKER}$PATH"`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 10_000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').reverse().find(l => l.includes(PATH_MARKER));
      resolve(line ? line.slice(line.indexOf(PATH_MARKER) + PATH_MARKER.length).trim() || undefined : undefined);
    });
  });
  return loginShellPath;
}

/**
 * Runs a CLI and resolves with its whole stdout. `input` is written to stdin (then closed) — Codex reads its
 * prompt from there; the others take it as an argument. `onLine` receives each stdout line as it arrives, for
 * CLIs that stream JSON events. If the binary isn't on VS Code's PATH, retries once with the login shell's PATH
 * (never on Windows, which has no login shell to ask).
 */
async function runCli(bin: string, args: string[], input: string, onLine?: (line: string) => void): Promise<string> {
  try {
    return await spawnCli(bin, args, input, process.env, onLine);
  } catch (firstErr) {
    if (process.platform === 'win32' || (firstErr as NodeJS.ErrnoException).code !== 'ENOENT') throw firstErr;
    const shellPath = await getLoginShellPath();
    if (!shellPath) throw firstErr;
    return spawnCli(bin, args, input, { ...process.env, PATH: shellPath }, onLine);
  }
}

function spawnCli(bin: string, args: string[], input: string, env: NodeJS.ProcessEnv, onLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(vscode.l10n.t('{0} did not answer within {1} seconds', bin, CLI_TIMEOUT_MS / 1000))));
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!onLine) return;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', err => finish(() => reject(err)));
    child.on('close', code => finish(() => {
      if (onLine && pending.trim()) onLine(pending.trim());
      if (code !== 0) { reject(new Error(stderr.trim() || stdout.trim() || vscode.l10n.t('{0} exited with code {1}', bin, code ?? '?'))); return; }
      if (!stdout.trim()) { reject(new Error(vscode.l10n.t('{0} returned an empty response', 'CLI'))); return; }
      resolve(stdout);
    }));

    child.stdin.on('error', () => { /* the CLI may exit before reading stdin — its exit code tells the story */ });
    child.stdin.end(input);
  });
}
