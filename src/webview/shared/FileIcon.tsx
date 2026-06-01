import React, { useEffect } from 'react';
import type { IconThemeData } from '../../host/types/messages';
import { Codicon } from './Codicon';

// Extension → VSCode language ID (subset of common ones)
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact',
  js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift',
  cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
  php: 'php', lua: 'lua', r: 'r', dart: 'dart',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', sass: 'sass',
  json: 'json', jsonc: 'jsonc', xml: 'xml', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'fish',
  sql: 'sql', graphql: 'graphql',
  vue: 'vue', svelte: 'svelte',
  toml: 'toml', ini: 'ini',
  dockerfile: 'dockerfile',
  tf: 'terraform', hcl: 'terraform',
  ex: 'elixir', exs: 'elixir',
  clj: 'clojure', cljs: 'clojure',
  hs: 'haskell',
  erl: 'erlang',
  pl: 'perl',
  scala: 'scala',
  groovy: 'groovy',
  proto: 'proto3',
  ps1: 'powershell', psm1: 'powershell',
  bat: 'bat', cmd: 'bat',
};

// Fallback codicon map when no icon theme is active
const EXT_CODICONS: Record<string, string> = {
  ts: 'symbol-variable', tsx: 'symbol-variable', js: 'symbol-variable', jsx: 'symbol-variable',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  html: 'symbol-method', htm: 'symbol-method',
  css: 'symbol-color', scss: 'symbol-color', less: 'symbol-color',
  svg: 'symbol-color', png: 'symbol-color', jpg: 'symbol-color', jpeg: 'symbol-color',
  py: 'symbol-namespace', rb: 'symbol-namespace', go: 'symbol-namespace', rs: 'symbol-namespace',
  java: 'symbol-namespace', kt: 'symbol-namespace', swift: 'symbol-namespace', cs: 'symbol-namespace',
  cpp: 'symbol-namespace', c: 'symbol-namespace', h: 'symbol-namespace',
  sh: 'terminal', bash: 'terminal', zsh: 'terminal',
  yml: 'list-ordered', yaml: 'list-ordered', toml: 'list-ordered', ini: 'list-ordered',
  lock: 'lock', sql: 'database', xml: 'symbol-structure', proto: 'symbol-structure',
  txt: 'file-text', log: 'output',
};

let injectedFontId: string | null = null;

function ensureFontInjected(theme: IconThemeData) {
  if (theme.type !== 'font' || !theme.fontFaceUri || !theme.fontId) return;
  if (injectedFontId === theme.fontId) return;
  injectedFontId = theme.fontId;
  const styleId = `gitcharm-icon-font-${theme.fontId}`;
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `@font-face { font-family: "${theme.fontId}"; src: url("${theme.fontFaceUri}") format("${theme.fontFormat ?? 'woff'}"); font-weight: normal; font-style: normal; }`;
  document.head.appendChild(style);
}

function resolveIconName(theme: IconThemeData, fileName: string, isFolder: boolean, isOpen: boolean): string | null {
  const lower = fileName.toLowerCase();

  if (isFolder) {
    if (isOpen) return theme.folderNamesExpanded?.[lower] ?? theme.folderExpanded ?? null;
    return theme.folderNames?.[lower] ?? theme.folder ?? null;
  }

  // 1. Exact filename match (highest priority — e.g. "package.json", ".gitignore")
  const exactFile = theme.fileNames?.[lower];
  if (exactFile) return exactFile;

  // 2. Multi-part extension match, longest suffix first (e.g. "d.ts" before "ts")
  const parts = lower.split('.');
  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('.');
      const bySuffix = theme.fileExtensions?.[suffix];
      if (bySuffix) return bySuffix;
    }

    // 3. Language ID fallback using final extension
    const ext = parts[parts.length - 1];
    const langId = EXT_TO_LANG[ext];
    if (langId) {
      const byLang = theme.languageIds?.[langId];
      if (byLang) return byLang;
    }
  }

  return theme.file ?? null;
}

interface FileIconProps {
  name: string;
  isFolder?: boolean;
  isOpen?: boolean;
  theme?: IconThemeData | null;
  size?: number;
  style?: React.CSSProperties;
}

export function FileIcon({ name, isFolder = false, isOpen = false, theme, size = 14, style }: FileIconProps) {
  useEffect(() => {
    if (theme) ensureFontInjected(theme);
  }, [theme?.fontId]);

  const base: React.CSSProperties = { flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...style };

  if (!theme || theme.type === 'none') {
    return <Codicon name={fallbackCodicon(name, isFolder, isOpen)} style={{ fontSize: `${size}px`, opacity: 0.75, ...base }} />;
  }

  const iconName = resolveIconName(theme, name, isFolder, isOpen);

  if (theme.type === 'svg' && iconName) {
    const uri = theme.svgMap?.[iconName];
    if (uri) {
      return <img src={uri} width={size} height={size} style={{ ...base, objectFit: 'contain' }} aria-hidden />;
    }
  }

  if (theme.type === 'font' && iconName) {
    const char = theme.charMap?.[iconName];
    const color = theme.colorMap?.[iconName];
    if (char) {
      return (
        <span style={{ fontFamily: `"${theme.fontId}"`, fontSize: `${size}px`, color: color ?? 'inherit', lineHeight: 1, userSelect: 'none', ...base }} aria-hidden>
          {char}
        </span>
      );
    }
  }

  // Fallback to codicon
  return <Codicon name={fallbackCodicon(name, isFolder, isOpen)} style={{ fontSize: `${size}px`, opacity: 0.75, ...base }} />;
}

function fallbackCodicon(name: string, isFolder: boolean, isOpen: boolean): string {
  if (isFolder) return isOpen ? 'folder-opened' : 'folder';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return EXT_CODICONS[ext] ?? 'file';
}
