// Entry point of out/host/mcp-bridge.js, the command agents run as GitCharm's MCP server. See bridge.ts.
import { defaultInstancesDir, runBridge } from './bridge';

declare const BRIDGE_VERSION: string;

void runBridge(process.stdin, process.stdout, {
  instancesDir: defaultInstancesDir(),
  cwd: process.cwd(),
  env: process.env,
  version: typeof BRIDGE_VERSION === 'string' ? BRIDGE_VERSION : undefined,
}).then(() => process.exit(0));
