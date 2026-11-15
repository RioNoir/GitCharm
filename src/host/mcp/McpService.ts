import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { logError, logInfo, logWarn } from '../utils/Logger';
import { handleMessage, type Tool } from './protocol';
import { mcpHome, startMcpHttpServer, type McpHttpServer } from './server';
import { agentStatuses, installAgent, uninstallAgent, type AgentId, type AgentStatus, type Environment, type ServerSpec } from './installers';
import { createTools, type ToolDeps } from './tools';
import type { McpState } from '../types/messages';

const INSTRUCTIONS = [
  'GitCharm: Git, pull request and issue tools for the repositories open in a VS Code window, through the GitCharm extension.',
  'Call list_repositories first when the window may hold several repositories, and pass `repository` to the other tools;',
  'without it they use the repository containing your working folder.',
  'Commits use the identity of the active GitCharm Git profile. Pull requests and issues go through the forge account connected in GitCharm.',
  'Risky actions (push, merge, deleting branches, rewriting history, posting on the forge) ask the user to confirm in VS Code: if declined, don\'t retry.',
].join(' ');

/**
 * GitCharm's MCP server: runs while gitcharm.mcp.enabled is on (off by default), and installs the stdio bridge in
 * the agents' configuration. See server.ts and bridge.ts for how agents reach this window.
 */
export class McpService implements vscode.Disposable {
  private server: McpHttpServer | undefined;
  private starting: Promise<void> | undefined;
  private error: string | undefined;
  private tools: Tool[];
  private lastRepoKey = '';
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the server starts or stops, or an agent's installation changes. */
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly vscodeAgent: boolean;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: ToolDeps) {
    this.tools = createTools(deps);
    this.vscodeAgent = this.registerWithVscode();
    this.disposables.push(
      this.onDidChangeEmitter,
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('gitcharm.mcp.enabled')) void this.sync(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.updateRecord()),
      deps.manager.onStatusChange(() => this.updateRecord()),
    );
    void this.sync();
  }

  isEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitcharm.mcp').get<boolean>('enabled', false);
  }

  getState(): McpState {
    return {
      enabled: this.isEnabled(),
      running: !!this.server,
      error: this.error,
      agents: agentStatuses(this.spec(), this.environment()),
      vscodeAgent: this.vscodeAgent,
    };
  }

  async install(id: AgentId): Promise<void> {
    this.copyBridge();
    installAgent(id, this.spec(), this.environment());
    logInfo('mcp', `Installed in ${id}`);
    this.onDidChangeEmitter.fire();
  }

  async uninstall(id: AgentId): Promise<void> {
    uninstallAgent(id, this.environment());
    logInfo('mcp', `Removed from ${id}`);
    this.onDidChangeEmitter.fire();
  }

  /** Command palette: turns the server on if needed, then lets the user pick the agents to install it in. */
  async pickAgents(): Promise<void> {
    if (!this.isEnabled()) {
      const enable = vscode.l10n.t('Enable');
      const picked = await vscode.window.showInformationMessage(
        vscode.l10n.t('GitCharm\'s MCP server is off. Enable it, so agents can use GitCharm\'s tools while VS Code is open?'), enable);
      if (picked !== enable) return;
      await vscode.workspace.getConfiguration('gitcharm.mcp').update('enabled', true, vscode.ConfigurationTarget.Global);
    }
    const statuses = agentStatuses(this.spec(), this.environment());
    type Item = vscode.QuickPickItem & { id: AgentId };
    const items: Item[] = statuses.map(s => ({
      id: s.id,
      label: s.label,
      description: statusLabel(s),
      detail: s.configPath,
      picked: s.status === 'installed' || s.status === 'outdated',
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: vscode.l10n.t('Install GitCharm\'s MCP server in agents'),
      placeHolder: vscode.l10n.t('Checked agents get the server; unchecking one removes it'),
      ignoreFocusOut: true,
    });
    if (!chosen) return;
    const wanted = new Set(chosen.map(c => c.id));
    const errors: string[] = [];
    for (const s of statuses) {
      try {
        if (wanted.has(s.id) && s.status !== 'installed') await this.install(s.id);
        else if (!wanted.has(s.id) && (s.status === 'installed' || s.status === 'outdated')) await this.uninstall(s.id);
      } catch (e: unknown) {
        errors.push(`${s.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (errors.length > 0) void vscode.window.showErrorMessage(errors.join('\n'));
    else void vscode.window.showInformationMessage(vscode.l10n.t('Restart the agents for the change to take effect.'));
  }

  // ── Server lifecycle ─────────────────────────────────────────────────────────────────────────────────────

  private async sync(): Promise<void> {
    await this.starting;
    if (this.isEnabled() && !this.server) {
      this.starting = this.start();
      await this.starting;
    } else if (!this.isEnabled() && this.server) {
      const server = this.server;
      this.server = undefined;
      await server.close();
      logInfo('mcp', 'MCP server stopped');
    }
    this.onDidChangeEmitter.fire();
    this.vscodeDefinitionsChanged?.fire();
  }

  private async start(): Promise<void> {
    try {
      this.copyBridge();
      const { folders, repos } = this.workspace();
      this.lastRepoKey = repos.join('|');
      this.server = await startMcpHttpServer({
        handle: (message, ctx) => handleMessage(message, () => this.tools, { version: this.version(), instructions: INSTRUCTIONS }, ctx,
          (tool, e) => logError('mcp', `${tool}: ${e instanceof Error ? e.message : String(e)}`)),
        version: this.version(),
        workspaceFolders: folders,
        repositories: repos,
      });
      this.error = undefined;
      logInfo('mcp', `MCP server listening on 127.0.0.1:${this.server.port}`);
      this.refreshInstalledAgents();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      logError('mcp', `MCP server failed to start: ${this.error}`);
    } finally {
      this.starting = undefined;
    }
  }

  private workspace(): { folders: string[]; repos: string[] } {
    return {
      folders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      repos: this.deps.manager.getRepoMetas().map(m => m.rootPath),
    };
  }

  private updateRecord(): void {
    if (!this.server) return;
    const { folders, repos } = this.workspace();
    const key = [...folders, '', ...repos].join('|');
    if (key === this.lastRepoKey) return;
    this.lastRepoKey = key;
    try {
      this.server.update({ workspaceFolders: folders, repositories: repos });
    } catch (e: unknown) {
      logWarn('mcp', `Could not update the instance record: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * A VS Code update moves its runtime (the command agents start the bridge with): entries installed before are
   * brought up to date, so agents keep finding the server.
   */
  private refreshInstalledAgents(): void {
    for (const s of agentStatuses(this.spec(), this.environment())) {
      if (s.status !== 'outdated') continue;
      try {
        installAgent(s.id, this.spec(), this.environment());
        logInfo('mcp', `Updated the server's command in ${s.label}`);
      } catch (e: unknown) {
        logWarn('mcp', `Could not update ${s.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ── The bridge and how agents start it ──────────────────────────────────────────────────────────────────

  /** Where agents find the bridge: a copy outside the extension's folder, whose path changes with every version. */
  private bridgePath(): string {
    return path.join(mcpHome(), 'mcp-bridge.js');
  }

  private copyBridge(): void {
    const source = path.join(this.context.extensionPath, 'out', 'host', 'mcp-bridge.js');
    const target = this.bridgePath();
    const content = fs.readFileSync(source);
    try {
      if (fs.readFileSync(target).equals(content)) return;
    } catch { /* not there yet */ }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  /** The bridge runs on VS Code's own Node runtime: agents need no Node installed. */
  private spec(env: Record<string, string> = {}): ServerSpec {
    return { command: stableExecPath(process.execPath), args: [this.bridgePath()], env: { ELECTRON_RUN_AS_NODE: '1', ...env } };
  }

  private environment(): Environment {
    return { home: os.homedir(), platform: process.platform, env: process.env };
  }

  private version(): string {
    return (this.context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  }

  // ── VS Code's own agent ──────────────────────────────────────────────────────────────────────────────────

  private vscodeDefinitionsChanged: vscode.EventEmitter<void> | undefined;

  /**
   * Registers the server with VS Code's MCP API (1.101+), for Copilot's agent mode: nothing to install there. The
   * bridge is pointed at this window by its process id. Older VS Code versions don't have the API: nothing happens.
   */
  private registerWithVscode(): boolean {
    type McpApi = {
      registerMcpServerDefinitionProvider?: (id: string, provider: {
        onDidChangeMcpServerDefinitions: vscode.Event<void>;
        provideMcpServerDefinitions: () => unknown[];
      }) => vscode.Disposable;
    };
    const lm = (vscode as unknown as { lm?: McpApi }).lm;
    const Definition = (vscode as unknown as {
      McpStdioServerDefinition?: new (label: string, command: string, args?: string[], env?: Record<string, string>, version?: string) => unknown;
    }).McpStdioServerDefinition;
    if (!lm?.registerMcpServerDefinitionProvider || !Definition) return false;
    this.vscodeDefinitionsChanged = new vscode.EventEmitter<void>();
    try {
      this.disposables.push(this.vscodeDefinitionsChanged, lm.registerMcpServerDefinitionProvider('gitcharm.mcp', {
        onDidChangeMcpServerDefinitions: this.vscodeDefinitionsChanged.event,
        provideMcpServerDefinitions: () => {
          if (!this.isEnabled()) return [];
          const spec = this.spec({ GITCHARM_MCP_PID: String(process.pid) });
          return [new Definition('GitCharm', spec.command, spec.args, spec.env, this.version())];
        },
      }));
      return true;
    } catch (e: unknown) {
      logWarn('mcp', `Could not register with VS Code's MCP support: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  dispose(): void {
    void this.server?.close();
    this.server = undefined;
    this.disposables.forEach(d => d.dispose());
  }
}

function statusLabel(s: AgentStatus): string {
  switch (s.status) {
    case 'installed': return vscode.l10n.t('Installed');
    case 'outdated': return vscode.l10n.t('Installed (will be updated)');
    case 'unreadable': return vscode.l10n.t('Configuration unreadable');
    default: return s.detected ? vscode.l10n.t('Not installed') : vscode.l10n.t('Not found on this machine');
  }
}

/** A snap's runtime path names its revision, which the next update removes: its "current" link stays. */
function stableExecPath(execPath: string): string {
  const snap = /^\/snap\/([^/]+)\/\d+\//.exec(execPath);
  if (!snap) return execPath;
  const current = execPath.replace(/^\/snap\/[^/]+\/\d+\//, `/snap/${snap[1]}/current/`);
  return fs.existsSync(current) ? current : execPath;
}

