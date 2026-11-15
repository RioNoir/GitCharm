// The Model Context Protocol, as much of it as GitCharm's server needs: JSON-RPC 2.0 with initialize, ping,
// tools/list and tools/call. No SDK: the transport (HTTP between the bridge and the extension, stdio between the
// agent and the bridge) carries one JSON-RPC message at a time, and this handles each.
//
// Kept free of vscode and of runtime imports, so the tests run it as it is.

export const SERVER_NAME = 'gitcharm';
/** Protocol versions this server speaks, newest first: an older client gets its own version back when listed. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A JSON Schema for a tool's arguments: an object with named properties. */
export interface InputSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

/** What a tool does to the repository or the forge, for the confirmation policy and the client's own hints. */
export type ToolKind = 'read' | 'write' | 'risky';

/** Who is calling: the client the agent's bridge announced, and the folder the agent works in. */
export interface CallContext {
  clientName: string;
  cwd?: string;
}

export interface ToolResult {
  /** Text shown to the agent: plain text, or JSON for structured data. */
  text: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  inputSchema: InputSchema;
  run(args: Record<string, unknown>, context: CallContext): Promise<ToolResult>;
}

/** A failure the agent caused (bad arguments, unknown repository): reported to it as a tool error, not logged. */
export class ToolError extends Error {}

export const ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

export interface ServerInfo {
  version: string;
  instructions: string;
}

/**
 * Handles one JSON-RPC message. Resolves to the response, or to undefined for a notification (no id), which gets
 * none. `tools()` is read on every call: tools can depend on settings.
 */
export async function handleMessage(
  message: unknown,
  tools: () => readonly Tool[],
  info: ServerInfo,
  context: CallContext,
  onError?: (tool: string, error: unknown) => void,
): Promise<JsonRpcResponse | undefined> {
  if (!isRequest(message)) return reply(null, undefined, { code: ERROR.invalidRequest, message: 'Invalid JSON-RPC request' });
  const id = message.id ?? null;
  const notification = message.id === undefined || message.id === null;
  if (notification) return undefined;
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'GitCharm', version: info.version },
        instructions: info.instructions,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: tools().map(t => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            title: t.title,
            readOnlyHint: t.kind === 'read',
            destructiveHint: t.kind === 'risky',
            openWorldHint: false,
          },
        })),
      });
    case 'tools/call': {
      const name = params.name;
      const tool = tools().find(t => t.name === name);
      if (typeof name !== 'string' || !tool) return reply(id, undefined, { code: ERROR.invalidParams, message: `Unknown tool: ${String(name)}` });
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
      const missing = (tool.inputSchema.required ?? []).filter(k => args[k] === undefined || args[k] === null || args[k] === '');
      if (missing.length > 0) return reply(id, toolResult({ text: `Missing argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`, isError: true }));
      try {
        return reply(id, toolResult(await tool.run(args, context)));
      } catch (e: unknown) {
        // A tool that fails is an answer the agent can act on, not a protocol error.
        if (!(e instanceof ToolError)) onError?.(tool.name, e);
        return reply(id, toolResult({ text: e instanceof Error ? e.message : String(e), isError: true }));
      }
    }
    default:
      return reply(id, undefined, { code: ERROR.methodNotFound, message: `Method not found: ${message.method}` });
  }
}

function toolResult(result: ToolResult): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: result.text }], isError: !!result.isError };
}

function reply(id: JsonRpcId | null, result: unknown, error?: JsonRpcResponse['error']): JsonRpcResponse {
  return error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
}

function isRequest(message: unknown): message is JsonRpcRequest {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  return m.jsonrpc === '2.0' && typeof m.method === 'string' && (m.params === undefined || (typeof m.params === 'object' && m.params !== null));
}

// ── Argument helpers for the tools ───────────────────────────────────────────────────────────────────────────

export function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`);
  return v;
}

export function reqStr(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (!v) throw new ToolError(`"${key}" is required`);
  return v;
}

export function num(args: Record<string, unknown>, key: string, fallback: number, max?: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ToolError(`"${key}" must be a non-negative number`);
  return Math.floor(max !== undefined ? Math.min(n, max) : n);
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new ToolError(`"${key}" must be true or false`);
  return v;
}

export function strList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new ToolError(`"${key}" must be a list of strings`);
  return v as string[];
}

/** Cuts text to `max` characters, saying so: the agent knows the output is partial. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated: ${text.length - max} more characters)`;
}
