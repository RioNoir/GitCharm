import * as esbuild from 'esbuild';
import { argv } from 'process';

const isProd = argv.includes('--prod');
const isWatch = argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/host/extension.ts'],
  bundle: true,
  outfile: 'out/host/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !isProd,
  minify: isProd,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
  },
};

/** The stdio bridge agents run as GitCharm's MCP server (src/host/mcp/bridge.ts): plain Node, no vscode. */
const { version } = JSON.parse(await import('fs').then(fs => fs.promises.readFile('package.json', 'utf8')));
/** @type {import('esbuild').BuildOptions} */
const bridgeOptions = {
  ...options,
  entryPoints: ['src/host/mcp/bridgeMain.ts'],
  outfile: 'out/host/mcp-bridge.js',
  external: [],
  define: { ...options.define, BRIDGE_VERSION: JSON.stringify(version) },
};

if (isWatch) {
  const contexts = await Promise.all([esbuild.context(options), esbuild.context(bridgeOptions)]);
  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('Watching host for changes...');
} else {
  await Promise.all([esbuild.build(options), esbuild.build(bridgeOptions)]);
  console.log('Host build complete.');
}
