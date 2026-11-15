// Acceptance tests for GitCharm's MCP infrastructure: the protocol, the HTTP server with the stdio bridge in front
// of it (as an agent drives them), and installing the server in the agents' configuration files.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { handleMessage, ToolError, type Tool } from '../src/host/mcp/protocol.ts';
import { instancesDir, startMcpHttpServer } from '../src/host/mcp/server.ts';
import { pickInstance, readInstances, runBridge } from '../src/host/mcp/bridge.ts';
import { agentStatus, installAgent, uninstallAgent, type Environment, type ServerSpec } from '../src/host/mcp/installers.ts';
import type { InstanceRecord } from '../src/host/mcp/server.ts';

type T = { after: (fn: () => void | Promise<void>) => void };

function tempDir(t: T, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const echo: Tool = {
  name: 'echo', title: 'Echo', description: 'Echoes its text', kind: 'read',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async (args, context) => ({ text: `${context.clientName}@${context.cwd ?? '-'}: ${String(args.text)}` }),
};
const failing: Tool = {
  name: 'fail', title: 'Fail', description: 'Fails', kind: 'risky',
  inputSchema: { type: 'object', properties: {} },
  run: async () => { throw new ToolError('no such repository'); },
};
const info = { version: '9.9.9', instructions: 'Use the tools.' };
const handle = (m: unknown, c = { clientName: 'test' }) => handleMessage(m, () => [echo, failing], info, c);

// ── Protocol ───────────────────────────────────────────────────────────────────────────────────────────────

test('initialize answers with the client\'s protocol version when supported, else the newest', async () => {
  const old = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.deepEqual((old?.result as { protocolVersion: string }).protocolVersion, '2024-11-05');
  const future = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  const result = future?.result as { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: unknown; instructions: string };
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.serverInfo, { name: 'gitcharm', title: 'GitCharm', version: '9.9.9' });
  assert.equal(result.instructions, 'Use the tools.');
});

test('tools/list describes each tool, with read-only and destructive hints', async () => {
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = (res?.result as { tools: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[] }).tools;
  assert.deepEqual(tools.map(t => [t.name, t.annotations.readOnlyHint, t.annotations.destructiveHint]), [['echo', true, false], ['fail', false, true]]);
});

test('tools/call runs the tool; a failing tool or a missing argument is a tool error, not a protocol error', async () => {
  const ok = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
  assert.deepEqual(ok?.result, { content: [{ type: 'text', text: 'test@-: hi' }], isError: false });
  const failed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fail', arguments: {} } });
  assert.deepEqual(failed?.result, { content: [{ type: 'text', text: 'no such repository' }], isError: true });
  const missing = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {} } });
  assert.deepEqual(missing?.result, { content: [{ type: 'text', text: 'Missing argument: text' }], isError: true });
});

test('unknown tools and methods are JSON-RPC errors; notifications get no answer', async () => {
  const tool = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(tool?.error?.code, -32602);
  const method = await handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  assert.equal(method?.error?.code, -32601);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await handle({ not: 'json-rpc' }))?.error?.code, -32600);
});

// ── Server and bridge ──────────────────────────────────────────────────────────────────────────────────────

/** Drives the bridge as an agent would: one JSON-RPC line in, the answers out, matched by id. */
function agent(t: T, home: string, cwd: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runBridge(input, output, { instancesDir: instancesDir(home), cwd, version: '1.0.0' });
  t.after(async () => { input.end(); await done; });
  const answers = new Map<unknown, (v: Record<string, unknown>) => void>();
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      answers.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  return {
    request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
      const id = next++;
      const p = new Promise<Record<string, unknown>>(resolve => answers.set(id, resolve));
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return p;
    },
    notify(method: string) { input.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); },
  };
}

test('an agent reaches the window\'s tools through the bridge, which passes on its name and folder', async t => {
  const home = tempDir(t, 'gitcharm-mcp-home-');
  const server = await startMcpHttpServer({ handle: (m, c) => handle(m, c), version: '9.9.9', workspaceFolders: ['/work/app'], repositories: [], home });
  t.after(() => server.close());
  const a = agent(t, home, '/work/app/src');
  const init = await a.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', title: 'Claude Code' } });
  assert.equal((init.result as { serverInfo: { version: string } }).serverInfo.version, '9.9.9');
  a.notify('notifications/initialized');
  const call = await a.request('tools/call', { name: 'echo', arguments: { text: 'hi' } });
  assert.deepEqual(call.result, { content: [{ type: 'text', text: 'Claude Code@/work/app/src: hi' }], isError: false });
});

test('the instance record is readable by its user only, and goes away with the server', async t => {
  const home = tempDir(t, 'gitcharm-mcp-home-');
  const server = await startMcpHttpServer({ handle: (m, c) => handle(m, c), version: '1', workspaceFolders: [], repositories: [], home });
  if (process.platform !== 'win32') assert.equal(fs.statSync(server.recordPath).mode & 0o777, 0o600);
  assert.equal(readInstances(instancesDir(home)).length, 1);
  await server.close();
  assert.equal(readInstances(instancesDir(home)).length, 0);
});

test('the server refuses requests without its token, and requests from a browser page', async t => {
  const home = tempDir(t, 'gitcharm-mcp-home-');
  const server = await startMcpHttpServer({ handle: (m, c) => handle(m, c), version: '1', workspaceFolders: [], repositories: [], home });
  t.after(() => server.close());
  const [record] = readInstances(instancesDir(home));
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const url = `http://127.0.0.1:${server.port}/rpc`;
  assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { Authorization: `Bearer ${record.token}`, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { Authorization: `Bearer ${record.token}` } })).status, 200);
});

test('with no GitCharm window the bridge still answers, and says how to turn the server on', async t => {
  const home = tempDir(t, 'gitcharm-mcp-home-');
  const a = agent(t, home, '/work');
  const init = await a.request('initialize', { protocolVersion: '2025-06-18' });
  assert.match((init.result as { instructions: string }).instructions, /gitcharm\.mcp\.enabled/);
  assert.deepEqual((await a.request('tools/list')).result, { tools: [] });
  const call = await a.request('tools/call', { name: 'echo', arguments: {} });
  assert.equal((call.result as { isError: boolean }).isError, true);
});

test('a window opened after the agent started is found on the next message', async t => {
  const home = tempDir(t, 'gitcharm-mcp-home-');
  const a = agent(t, home, '/work');
  assert.deepEqual((await a.request('tools/list')).result, { tools: [] });
  const server = await startMcpHttpServer({ handle: (m, c) => handle(m, c), version: '1', workspaceFolders: [], repositories: [], home });
  t.after(() => server.close());
  const list = (await a.request('tools/list')).result as { tools: unknown[] };
  assert.equal(list.tools.length, 2);
});

test('the bridge picks the window containing the agent\'s folder, the deepest one, else the newest', () => {
  const r = (pid: number, startedAt: number, workspaceFolders: string[], repositories: string[] = []): InstanceRecord =>
    ({ pid, port: 1, token: 't', startedAt, version: '1', workspaceFolders, repositories });
  const records = [r(1, 10, ['/work']), r(2, 5, ['/work/app']), r(3, 1, ['/other'], ['/work/app/lib'])];
  assert.equal(pickInstance(records, '/work/app/src')?.pid, 2);
  assert.equal(pickInstance(records, '/work/app/lib/x')?.pid, 3);
  assert.equal(pickInstance(records, '/work/docs')?.pid, 1);
  assert.equal(pickInstance(records, '/elsewhere')?.pid, 1);
  assert.equal(pickInstance(records, '/work/app', { GITCHARM_MCP_PID: '3' })?.pid, 3);
});

// ── Installers ─────────────────────────────────────────────────────────────────────────────────────────────

const spec: ServerSpec = { command: '/opt/VS Code/code', args: ['/home/u/.gitcharm/mcp/mcp-bridge.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };

function env(t: T, platform: NodeJS.Platform = 'linux'): Environment {
  return { home: tempDir(t, 'gitcharm-agents-'), platform, env: {} };
}

test('Claude Code: the server is added to ~/.claude.json, keeping everything else in it', async t => {
  const e = env(t);
  const file = path.join(e.home, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));
  assert.equal(agentStatus('claudeCode', spec, e).status, 'notInstalled');
  installAgent('claudeCode', spec, e);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.numStartups, 3);
  assert.deepEqual(config.mcpServers.other, { command: 'x' });
  assert.deepEqual(config.mcpServers.gitcharm, { type: 'stdio', ...spec });
  assert.equal(agentStatus('claudeCode', spec, e).status, 'installed');
  assert.equal(agentStatus('claudeCode', { ...spec, command: '/new/code' }, e).status, 'outdated');
  uninstallAgent('claudeCode', e);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { numStartups: 3, mcpServers: { other: { command: 'x' } } });
});

test('Codex: the [mcp_servers.gitcharm] table is added, replaced and removed, other tables untouched', async t => {
  const e = env(t);
  const file = path.join(e.home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.gitcharm]\ncommand = "old"\n\n[mcp_servers.gitcharm.env]\nA = "1"\n\n[profiles.fast]\nmodel = "mini"\n';
  fs.writeFileSync(file, original);
  assert.equal(agentStatus('codex', spec, e).status, 'outdated');
  installAgent('codex', spec, e);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.match(text, /\[profiles\.fast\]\nmodel = "mini"/);
  assert.doesNotMatch(text, /command = "old"|\[mcp_servers\.gitcharm\.env\]/);
  assert.match(text, /\[mcp_servers\.gitcharm\]\ncommand = "\/opt\/VS Code\/code"\nargs = \["\/home\/u\/\.gitcharm\/mcp\/mcp-bridge\.js"\]\nenv = \{ ELECTRON_RUN_AS_NODE = "1" \}\n$/);
  assert.equal(agentStatus('codex', spec, e).status, 'installed');
  uninstallAgent('codex', e);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.fast]\nmodel = "mini"\n');
});

test('Codex: CODEX_HOME is honoured, and Windows paths are escaped', async t => {
  const e = env(t, 'win32');
  e.env.CODEX_HOME = path.join(e.home, 'codex-home');
  installAgent('codex', { ...spec, command: 'C:\\Program Files\\VS Code\\Code.exe' }, e);
  const text = fs.readFileSync(path.join(e.home, 'codex-home', 'config.toml'), 'utf8');
  assert.match(text, /command = "C:\\\\Program Files\\\\VS Code\\\\Code\.exe"/);
});

test('Gemini CLI, Cursor and Claude Desktop get the same entry in their own files', async t => {
  const e = env(t, 'darwin');
  for (const id of ['geminiCli', 'cursor', 'claudeDesktop'] as const) installAgent(id, spec, e);
  const read = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(e.home, ...p), 'utf8')).mcpServers.gitcharm;
  assert.deepEqual(read('.gemini', 'settings.json'), spec);
  assert.deepEqual(read('.cursor', 'mcp.json'), spec);
  assert.deepEqual(read('Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), spec);
});

test('a configuration file that is not plain JSON is left alone', async t => {
  const e = env(t);
  const file = path.join(e.home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ // a comment\n "mcpServers": {} }');
  assert.equal(agentStatus('cursor', spec, e).status, 'unreadable');
  assert.throws(() => installAgent('cursor', spec, e), /not plain JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ // a comment\n "mcpServers": {} }');
});

test('an agent counts as detected when its folder exists', async t => {
  const e = env(t);
  assert.equal(agentStatus('codex', spec, e).detected, false);
  fs.mkdirSync(path.join(e.home, '.codex'));
  assert.equal(agentStatus('codex', spec, e).detected, true);
});
