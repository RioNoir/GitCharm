import * as vscode from 'vscode';
import { execFile } from 'child_process';

export async function generateWithAI(
  provider: string,
  prompt: string,
  cfg: vscode.WorkspaceConfiguration,
): Promise<string> {
  switch (provider) {
    case 'claude-cli': {
      const claudeModel: string = cfg.get('ai.claudeModel', '');
      const claudeArgs = claudeModel
        ? ['--print', '--model', claudeModel, prompt]
        : ['--print', prompt];
      return runCli(cfg.get('ai.claudePath', 'claude'), claudeArgs, '');
    }

    case 'claude-api': {
      const apiKey: string = cfg.get('ai.claudeApiKey', '');
      if (!apiKey) throw new Error('Anthropic API key not set. Configure gitcharm.ai.claudeApiKey in settings.');
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
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
      const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
      const text = data.content?.find(b => b.type === 'text')?.text?.trim();
      if (!text) throw new Error('Anthropic API returned an empty response');
      return text;
    }

    case 'openai-api': {
      const apiKey: string = cfg.get('ai.openaiApiKey', '');
      if (!apiKey) throw new Error('OpenAI API key not set. Configure gitcharm.ai.openaiApiKey in settings.');
      const model: string = cfg.get('ai.openaiModel', 'gpt-4o');
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('OpenAI API returned an empty response');
      return text;
    }

    case 'codex-cli': {
      const codexModel: string = cfg.get('ai.codexModel', '');
      const codexArgs = ['exec', '--dangerously-bypass-approvals-and-sandbox', ...(codexModel ? ['-m', codexModel] : [])];
      return runCli(
        cfg.get('ai.codexPath', 'codex'),
        codexArgs,
        prompt,
        output => output.split('\n').filter(l => l.trim()).pop() ?? output.trim(),
      );
    }

    case 'ollama': {
      const model: string = cfg.get('ai.ollamaModel', 'llama3');
      const base: string = cfg.get('ai.ollamaUrl', 'http://localhost:11434');
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
      const data = await res.json() as { message?: { content?: string } };
      const text = data.message?.content?.trim();
      if (!text) throw new Error('Ollama returned an empty response');
      return text;
    }

    case 'lmstudio': {
      const model: string = cfg.get('ai.lmstudioModel', '');
      const base: string = cfg.get('ai.lmstudioUrl', 'http://localhost:1234');
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || undefined, stream: false, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`LM Studio error ${res.status}: ${await res.text()}`);
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('LM Studio returned an empty response');
      return text;
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
      if (!model) throw new Error('No VS Code LM model available. Install GitHub Copilot or use the "GitCharm: Select AI Provider" command to switch provider.');
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        new vscode.CancellationTokenSource().token,
      );
      let result = '';
      for await (const chunk of response.text) result += chunk;
      return result.trim();
    }
  }
}

function runCli(
  bin: string,
  args: string[],
  input: string,
  extractOutput: (raw: string) => string = s => s.trim(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 60_000, maxBuffer: 1024 * 1024, input }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); return; }
      const message = extractOutput(stdout);
      if (!message) reject(new Error('CLI returned an empty response'));
      else resolve(message);
    });
  }).then(undefined, (firstErr: Error) => {
    const shell = process.env.SHELL ?? '/bin/zsh';
    // Resolve the login shell PATH first, then re-exec the binary directly with that env.
    // We never interpolate `input` into a shell command — it always goes via stdin.
    return new Promise<string>((resolve, reject) => {
      execFile(shell, ['-lc', 'echo $PATH'], { timeout: 10_000 }, (pathErr: Error | null, pathOut: string) => {
        const shellPath = pathErr ? process.env.PATH : pathOut.trim();
        const env = { ...process.env, PATH: shellPath };
        execFile(bin, args, { timeout: 60_000, maxBuffer: 1024 * 1024, input, env },
          (err2: Error | null, stdout2: string, stderr2: string) => {
            if (err2) { reject(new Error(stderr2.trim() || err2.message || firstErr.message)); return; }
            const message = extractOutput(stdout2);
            if (!message) reject(new Error('CLI returned an empty response'));
            else resolve(message);
          });
      });
    });
  });
}
