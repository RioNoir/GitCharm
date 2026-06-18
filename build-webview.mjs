import * as esbuild from 'esbuild';
import { argv } from 'process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = argv.includes('--watch');
const isProd = !isWatch;

const apps = [
  { name: 'commitPanel',   entry: 'src/webview/commitPanel/main.tsx' },
  { name: 'gitLog',        entry: 'src/webview/gitLog/main.tsx' },
  { name: 'mergeEditor',   entry: 'src/webview/mergeEditor/main.tsx' },
  { name: 'undockedPanel', entry: 'src/webview/undockedPanel/main.tsx' },
];

/** @returns {import('esbuild').BuildOptions} */
function makeOptions(app) {
  return {
    entryPoints: [resolve(__dirname, app.entry)],
    bundle: true,
    outfile: resolve(__dirname, `out/webview/${app.name}/index.js`),
    format: 'esm',
    platform: 'browser',
    target: ['es2020', 'chrome105'],
    jsx: 'automatic',
    jsxImportSource: 'react',
    sourcemap: !isProd,
    minify: isProd,
    logLevel: 'info',
    define: {
      'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
      'process.platform': '"browser"',
    },
    loader: {
      '.tsx': 'tsx',
      '.ts': 'ts',
      '.css': 'css',
      '.svg': 'text',
      '.ttf': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.png': 'dataurl',
    },
    // Monaco editor is large — use CDN loading via @monaco-editor/react default behaviour
    // External monaco-editor so it loads from CDN (configured in main.tsx files)
    // NOTE: In Phase 4, replace with bundled Monaco for offline support
  };
}

if (isWatch) {
  const contexts = await Promise.all(apps.map(app => esbuild.context(makeOptions(app))));
  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('Watching webview apps for changes...');
} else {
  for (const app of apps) {
    console.log(`Building webview: ${app.name}`);
    await esbuild.build(makeOptions(app));
    console.log(`  ✓ ${app.name} → out/webview/${app.name}/index.js`);
  }
  console.log('All webview builds complete.');
}
