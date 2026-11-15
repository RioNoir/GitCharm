// Installing GitCharm's MCP server in the agents' own configuration files: the stdio bridge as a server named
// "gitcharm", at user level, so the agent has it in every project. Only that entry is ever written or removed;
// a file that can't be parsed is left alone and the error says so.
//
// Kept free of vscode and of runtime imports, so the tests run it against a temporary home folder.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const SERVER_KEY = 'gitcharm';

/** How an agent starts the bridge. */
export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type AgentId = 'claudeCode' | 'codex' | 'geminiCli' | 'cursor' | 'claudeDesktop';
export const AGENT_IDS: readonly AgentId[] = ['claudeCode', 'codex', 'geminiCli', 'cursor', 'claudeDesktop'];

export type InstallStatus = 'installed' | 'outdated' | 'notInstalled' | 'unreadable';

export interface AgentStatus {
  id: AgentId;
  label: string;
  configPath: string;
  /** The agent seems to be on this machine: its configuration folder exists. */
  detected: boolean;
  status: InstallStatus;
  error?: string;
}

export interface Environment {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

interface Agent {
  label: string;
  configPath(e: Environment): string;
  /** The folder whose existence says the agent is installed. */
  detectPath(e: Environment): string;
  format: 'json' | 'toml';
  /** The JSON entry, for JSON configuration files. */
  entry?(spec: ServerSpec): Record<string, unknown>;
}

const jsonEntry = (spec: ServerSpec) => ({ command: spec.command, args: spec.args, env: spec.env });

const AGENTS: Record<AgentId, Agent> = {
  claudeCode: {
    label: 'Claude Code',
    configPath: e => path.join(e.home, '.claude.json'),
    detectPath: e => path.join(e.home, '.claude'),
    format: 'json',
    entry: spec => ({ type: 'stdio', ...jsonEntry(spec) }),
  },
  codex: {
    label: 'Codex',
    configPath: e => path.join(codexHome(e), 'config.toml'),
    detectPath: e => codexHome(e),
    format: 'toml',
  },
  geminiCli: {
    label: 'Gemini CLI',
    configPath: e => path.join(e.home, '.gemini', 'settings.json'),
    detectPath: e => path.join(e.home, '.gemini'),
    format: 'json',
    entry: jsonEntry,
  },
  cursor: {
    label: 'Cursor',
    configPath: e => path.join(e.home, '.cursor', 'mcp.json'),
    detectPath: e => path.join(e.home, '.cursor'),
    format: 'json',
    entry: jsonEntry,
  },
  claudeDesktop: {
    label: 'Claude Desktop',
    configPath: e => path.join(claudeDesktopDir(e), 'claude_desktop_config.json'),
    detectPath: e => claudeDesktopDir(e),
    format: 'json',
    entry: jsonEntry,
  },
};

function codexHome(e: Environment): string {
  return e.env.CODEX_HOME || path.join(e.home, '.codex');
}

function claudeDesktopDir(e: Environment): string {
  if (e.platform === 'darwin') return path.join(e.home, 'Library', 'Application Support', 'Claude');
  if (e.platform === 'win32') return path.join(e.env.APPDATA || path.join(e.home, 'AppData', 'Roaming'), 'Claude');
  return path.join(e.env.XDG_CONFIG_HOME || path.join(e.home, '.config'), 'Claude');
}

export function agentLabel(id: AgentId): string {
  return AGENTS[id].label;
}

export function agentStatuses(spec: ServerSpec, e: Environment): AgentStatus[] {
  return AGENT_IDS.map(id => agentStatus(id, spec, e));
}

export function agentStatus(id: AgentId, spec: ServerSpec, e: Environment): AgentStatus {
  const agent = AGENTS[id];
  const configPath = agent.configPath(e);
  const base = { id, label: agent.label, configPath, detected: fs.existsSync(agent.detectPath(e)) || fs.existsSync(configPath) };
  try {
    const text = readText(configPath);
    if (text === undefined) return { ...base, status: 'notInstalled' };
    if (agent.format === 'toml') {
      const block = findTomlBlock(text);
      if (!block) return { ...base, status: 'notInstalled' };
      return { ...base, status: normalizeToml(block.text) === normalizeToml(tomlBlock(spec)) ? 'installed' : 'outdated' };
    }
    const current = parseJsonObject(text, configPath).mcpServers;
    const entry = current && typeof current === 'object' ? (current as Record<string, unknown>)[SERVER_KEY] : undefined;
    if (entry === undefined) return { ...base, status: 'notInstalled' };
    return { ...base, status: JSON.stringify(entry) === JSON.stringify(agent.entry!(spec)) ? 'installed' : 'outdated' };
  } catch (err: unknown) {
    return { ...base, status: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Adds GitCharm's server to the agent's configuration, or brings an existing entry up to date. */
export function installAgent(id: AgentId, spec: ServerSpec, e: Environment): void {
  const agent = AGENTS[id];
  const configPath = agent.configPath(e);
  const text = readText(configPath);
  if (agent.format === 'toml') {
    const current = text ?? '';
    const block = findTomlBlock(current);
    const without = block ? current.slice(0, block.start) + current.slice(block.end) : current;
    const trimmed = without.replace(/\s+$/, '');
    writeAtomically(configPath, `${trimmed ? `${trimmed}\n\n` : ''}${tomlBlock(spec)}`);
    return;
  }
  const config = text === undefined ? {} : parseJsonObject(text, configPath);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers as Record<string, unknown> : {};
  config.mcpServers = { ...servers, [SERVER_KEY]: agent.entry!(spec) };
  writeAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** Removes GitCharm's server from the agent's configuration; nothing else in it changes. */
export function uninstallAgent(id: AgentId, e: Environment): void {
  const agent = AGENTS[id];
  const configPath = agent.configPath(e);
  const text = readText(configPath);
  if (text === undefined) return;
  if (agent.format === 'toml') {
    const block = findTomlBlock(text);
    if (!block) return;
    writeAtomically(configPath, `${(text.slice(0, block.start) + text.slice(block.end)).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`);
    return;
  }
  const config = parseJsonObject(text, configPath);
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object' || !(SERVER_KEY in servers)) return;
  delete servers[SERVER_KEY];
  writeAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

// ── TOML (Codex) ────────────────────────────────────────────────────────────────────────────────────────────

/** The [mcp_servers.gitcharm] table. TOML basic strings take JSON's escapes, so JSON.stringify quotes them. */
export function tomlBlock(spec: ServerSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${JSON.stringify(spec.command)}`,
    `args = [${spec.args.map(a => JSON.stringify(a)).join(', ')}]`,
    `env = { ${env} }`,
    '',
  ].join('\n');
}

const TABLE = `\\[\\s*mcp_servers\\s*\\.\\s*"?${SERVER_KEY}"?\\s*`;
/** [mcp_servers.gitcharm], and its sub-tables such as [mcp_servers.gitcharm.env]. */
const OUR_TABLE = new RegExp(`^\\s*${TABLE}\\]\\s*(#.*)?$`);
const OUR_SUBTABLE = new RegExp(`^\\s*${TABLE}\\.[^\\]]+\\]\\s*(#.*)?$`);
const ANY_TABLE = /^\s*\[/;

/** Our table with its sub-tables, as offsets into the text: from its header up to the next other table. */
function findTomlBlock(text: string): { start: number; end: number; text: string } | undefined {
  let offset = 0;
  let start = -1;
  let end = text.length;
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '');
    if (start < 0) {
      if (OUR_TABLE.test(bare)) start = offset;
    } else if (ANY_TABLE.test(bare) && !OUR_SUBTABLE.test(bare)) {
      end = offset;
      break;
    }
    offset += line.length;
  }
  return start < 0 ? undefined : { start, end, text: text.slice(start, end) };
}

function normalizeToml(text: string): string {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).join('\n');
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────────────────────

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function parseJsonObject(text: string, file: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not plain JSON (comments or a syntax error?): add the server by hand`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} does not hold a JSON object`);
  return value as Record<string, unknown>;
}

/** Writes beside the file and renames over it, keeping its permissions: the agent never reads half a file. */
function writeAtomically(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}
