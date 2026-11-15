// The stdio bridge agents launch as GitCharm's MCP server (out/host/mcp-bridge.js, run by VS Code's own Node
// runtime). It reads newline-delimited JSON-RPC from stdin, forwards each message to the GitCharm window the agent
// works in — found from the instance records the extension writes — and writes the answers to stdout.
//
// With no window running GitCharm's MCP server it still answers, so the agent's connection stays up: initialize
// says how to turn the server on, tools/list is empty, and the window is looked for again on every message.
//
// Kept free of vscode and of runtime imports, so the tests run it as it is.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { Readable, Writable } from 'stream';
import type { InstanceRecord } from './server';

const NOT_RUNNING = 'GitCharm\'s MCP server is not running. Open the project in VS Code with the GitCharm extension and turn on '
  + '"gitcharm.mcp.enabled" (GitCharm Settings → MCP Server), then ask again.';

export function readInstances(dir: string): InstanceRecord[] {
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const records: InstanceRecord[] = [];
  for (const name of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as InstanceRecord;
      if (typeof r.port === 'number' && typeof r.token === 'string' && isAlive(r.pid)) records.push(r);
    } catch { /* half-written or foreign: skip */ }
  }
  return records;
}

/**
 * The window to talk to: the one named by GITCHARM_MCP_PID; else the one whose workspace folder or repository
 * contains `cwd` (the deepest match); else the newest.
 */
export function pickInstance(records: readonly InstanceRecord[], cwd: string, env: NodeJS.ProcessEnv = {}): InstanceRecord | undefined {
  if (env.GITCHARM_MCP_PID) return records.find(r => String(r.pid) === env.GITCHARM_MCP_PID);
  let best: InstanceRecord | undefined;
  let bestDepth = -1;
  for (const r of records) {
    for (const folder of [...r.workspaceFolders, ...r.repositories]) {
      if (contains(folder, cwd) && folder.length > bestDepth) { best = r; bestDepth = folder.length; }
    }
  }
  return best ?? [...records].sort((a, b) => b.startedAt - a.startedAt)[0];
}

export interface BridgeOptions {
  instancesDir: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
}

/** Runs the bridge until `input` ends. */
export function runBridge(input: Readable, output: Writable, options: BridgeOptions): Promise<void> {
  let clientName = 'An MCP client';
  let instance: InstanceRecord | undefined;
  const write = (message: unknown) => { output.write(`${JSON.stringify(message)}\n`); };

  const forward = async (message: Record<string, unknown>, retry = true): Promise<unknown> => {
    instance ??= pickInstance(readInstances(options.instancesDir), options.cwd, options.env);
    if (!instance) return fallback(message, options.version);
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${instance.token}`,
          'X-GitCharm-Client': encodeURIComponent(clientName),
          'X-GitCharm-Cwd': encodeURIComponent(options.cwd),
        },
        body: JSON.stringify(message),
      });
      if (res.status === 204) return undefined;
      if (res.status === 401) throw new Error('stale instance');
      return await res.json();
    } catch {
      // The window was closed, or reloaded with a new port and token: look again, once.
      instance = undefined;
      return retry ? forward(message, false) : fallback(message, options.version);
    }
  };

  const pending = new Set<Promise<void>>();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (message.method === 'initialize') {
      const info = (message.params as { clientInfo?: { name?: unknown; title?: unknown } } | undefined)?.clientInfo;
      const name = typeof info?.title === 'string' ? info.title : typeof info?.name === 'string' ? info.name : undefined;
      if (name) clientName = name;
    }
    // Requests run side by side (a confirmation dialog must not hold up a ping); JSON-RPC matches answers by id.
    const p = forward(message).then(response => { if (response !== undefined) write(response); });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  return new Promise(resolve => lines.on('close', () => { void Promise.all(pending).then(() => resolve()); }));
}

/** Answers for when no GitCharm window is reachable. */
function fallback(message: Record<string, unknown>, version = '0.0.0'): unknown {
  const id = message.id;
  if (id === undefined || id === null) return undefined;
  switch (message.method) {
    case 'initialize': {
      const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'gitcharm', title: 'GitCharm', version },
          instructions: NOT_RUNNING,
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: [] } };
    case 'tools/call': return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: NOT_RUNNING }], isError: true } };
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM: the process exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function contains(folder: string, target: string): boolean {
  const norm = (p: string) => {
    const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
  };
  const f = norm(folder);
  const t = norm(target);
  return t === f || t.startsWith(`${f}/`);
}

export function defaultInstancesDir(): string {
  return path.join(os.homedir(), '.gitcharm', 'mcp', 'instances');
}
