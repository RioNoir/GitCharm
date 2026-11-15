// The HTTP end of GitCharm's MCP server, in the extension host: it listens on 127.0.0.1 only, on a random port,
// and answers only requests carrying its random token. Each VS Code window running it writes an instance record —
// port, token, workspace folders — to ~/.gitcharm/mcp/instances/<pid>.json, readable by the user alone; the stdio
// bridge an agent launches picks the window it works in from those records.
//
// Kept free of vscode and of runtime imports, so the tests run it as it is.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { CallContext, JsonRpcResponse } from './protocol';

export interface InstanceRecord {
  pid: number;
  port: number;
  token: string;
  /** Milliseconds since the epoch: with no better match, the bridge picks the newest window. */
  startedAt: number;
  version: string;
  /** The window's workspace folders and repositories: the bridge picks the window containing the agent's folder. */
  workspaceFolders: string[];
  repositories: string[];
}

export type Handler = (message: unknown, context: CallContext) => Promise<JsonRpcResponse | undefined>;

export interface McpHttpServer {
  readonly port: number;
  readonly recordPath: string;
  /** Rewrites the instance record, e.g. when the workspace's repositories change. */
  update(fields: Pick<InstanceRecord, 'workspaceFolders' | 'repositories'>): void;
  close(): Promise<void>;
}

/** Where GitCharm keeps its MCP files: the bridge, and the instance records. */
export function mcpHome(home = os.homedir()): string {
  return path.join(home, '.gitcharm', 'mcp');
}

export function instancesDir(home = os.homedir()): string {
  return path.join(mcpHome(home), 'instances');
}

const MAX_BODY = 4 * 1024 * 1024;

export async function startMcpHttpServer(options: {
  handle: Handler;
  version: string;
  workspaceFolders: string[];
  repositories: string[];
  home?: string;
}): Promise<McpHttpServer> {
  const token = crypto.randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);

  const server = http.createServer((req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    // A browser page could reach 127.0.0.1 too: it always sends Origin, the bridge never does.
    if (req.headers.origin) return send(403, { error: 'Forbidden' });
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) return send(401, { error: 'Unauthorized' });
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { error: 'Not found' });

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { send(413, { error: 'Too large' }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === 'string' && v ? decodeURIComponent(v) : undefined;
      };
      const context: CallContext = { clientName: header('x-gitcharm-client') ?? 'An MCP client', cwd: header('x-gitcharm-cwd') };
      options.handle(message, context).then(
        response => (response ? send(200, response) : send(204)),
        (e: unknown) => send(200, { jsonrpc: '2.0', id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }),
      );
    });
  });
  // Tool calls can wait on a confirmation dialog: no timeout on the request.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;

  const dir = instancesDir(options.home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const recordPath = path.join(dir, `${process.pid}.json`);
  let record: InstanceRecord = {
    pid: process.pid, port, token, startedAt: Date.now(), version: options.version,
    workspaceFolders: options.workspaceFolders, repositories: options.repositories,
  };
  const write = () => {
    // Written whole, then renamed: the bridge never reads half a record.
    const tmp = `${recordPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, recordPath);
  };
  write();

  return {
    port,
    recordPath,
    update(fields) {
      record = { ...record, ...fields };
      write();
    },
    close() {
      try { fs.unlinkSync(recordPath); } catch { /* already gone */ }
      return new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
