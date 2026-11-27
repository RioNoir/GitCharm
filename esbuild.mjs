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

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching host for changes...');
} else {
  await esbuild.build(options);
  console.log('Host build complete.');
}
