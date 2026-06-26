import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface IconThemeData {
  type: 'svg' | 'font' | 'none';
  // The extension root path — used by callers to add to localResourceRoots
  extensionUri?: vscode.Uri;
  // SVG mode: maps icon definition name → webview URI string for the SVG file
  svgMap?: Record<string, string>;
  fileExtensions?: Record<string, string>;   // ext (lower) → icon name
  fileNames?: Record<string, string>;         // filename (lower) → icon name
  languageIds?: Record<string, string>;       // language id → icon name
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  // Font mode
  fontFaceUri?: string;
  fontId?: string;
  fontFormat?: string;
  charMap?: Record<string, string>;   // icon name → unicode char (already converted)
  colorMap?: Record<string, string>;  // icon name → color
}

interface IconDefinitionSvg { iconPath: string }
interface IconDefinitionFont { fontCharacter: string; fontColor?: string; fontSize?: string }
type IconDef = IconDefinitionSvg | IconDefinitionFont;

interface FontSource { path: string; format: string }
interface FontDefinition { id: string; src: FontSource[] }

interface IconThemeJson {
  iconDefinitions?: Record<string, IconDef>;
  fonts?: FontDefinition[];
  light?: IconThemeJson;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
}

function isSvg(d: IconDef): d is IconDefinitionSvg {
  return 'iconPath' in d;
}

// Convert "\E099" escape notation → actual Unicode character U+E099
function parseCharacter(raw: string): string {
  return raw.replace(/\\([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
  mjs: 'javascript', cjs: 'javascript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
  php: 'php', lua: 'lua', dart: 'dart', html: 'html', htm: 'html', css: 'css',
  scss: 'scss', less: 'less', sass: 'sass', json: 'json', jsonc: 'jsonc', xml: 'xml',
  yaml: 'yaml', yml: 'yaml', md: 'markdown', markdown: 'markdown',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'fish',
  sql: 'sql', graphql: 'graphql', vue: 'vue', svelte: 'svelte',
  toml: 'toml', ini: 'ini', dockerfile: 'dockerfile', tf: 'terraform', hcl: 'terraform',
  ex: 'elixir', exs: 'elixir', clj: 'clojure', cljs: 'clojure', hs: 'haskell',
  erl: 'erlang', pl: 'perl', scala: 'scala', groovy: 'groovy', proto: 'proto3',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
};

function resolveIconName(theme: IconThemeData, name: string, isFolder: boolean, isOpen: boolean): string | null {
  const lower = name.toLowerCase();
  if (isFolder) {
    if (isOpen) return theme.folderNamesExpanded?.[lower] ?? theme.folderExpanded ?? null;
    return theme.folderNames?.[lower] ?? theme.folder ?? null;
  }
  if (theme.fileNames?.[lower]) return theme.fileNames[lower];
  const parts = lower.split('.');
  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('.');
      if (theme.fileExtensions?.[suffix]) return theme.fileExtensions[suffix];
    }
    const ext = parts[parts.length - 1];
    const langId = EXT_TO_LANG[ext];
    if (langId && theme.languageIds?.[langId]) return theme.languageIds[langId];
  }
  return theme.file ?? null;
}

export interface ResolvedIconMap {
  type: 'svg' | 'font' | 'none';
  // SVG: filename/folderKey → webview URI
  uriMap?: Record<string, string>;
  // Font: filename/folderKey → { char, color }
  charMap?: Record<string, { char: string; color?: string }>;
  fontFaceUri?: string;
  fontId?: string;
  fontFormat?: string;
}

export function resolveIconsForFiles(
  theme: IconThemeData,
  filePaths: string[],
): ResolvedIconMap {
  if (theme.type === 'none') return { type: 'none' };

  // Collect all unique file basenames + folder names from paths
  const names = new Set<string>();
  const folderNames = new Set<string>();
  for (const p of filePaths) {
    const parts = p.split('/');
    names.add(parts[parts.length - 1]);
    for (let i = 0; i < parts.length - 1; i++) folderNames.add(parts[i]);
  }

  if (theme.type === 'svg') {
    const uriMap: Record<string, string> = {};
    // Default file/folder icons
    const fileIcon = resolveIconName(theme, '', false, false);
    if (fileIcon && theme.svgMap?.[fileIcon]) uriMap['__file__'] = theme.svgMap[fileIcon];
    const folderIcon = resolveIconName(theme, '', true, false);
    if (folderIcon && theme.svgMap?.[folderIcon]) uriMap['__folder__'] = theme.svgMap[folderIcon];
    const folderOpenIcon = resolveIconName(theme, '', true, true);
    if (folderOpenIcon && theme.svgMap?.[folderOpenIcon]) uriMap['__folder_open__'] = theme.svgMap[folderOpenIcon];

    for (const name of names) {
      const iconName = resolveIconName(theme, name, false, false);
      if (iconName && theme.svgMap?.[iconName]) uriMap[name] = theme.svgMap[iconName];
    }
    for (const name of folderNames) {
      const iconName = resolveIconName(theme, name, true, false);
      if (iconName && theme.svgMap?.[iconName]) uriMap[`dir:${name}`] = theme.svgMap[iconName];
      const openName = resolveIconName(theme, name, true, true);
      if (openName && theme.svgMap?.[openName]) uriMap[`dir_open:${name}`] = theme.svgMap[openName];
    }
    return { type: 'svg', uriMap };
  }

  if (theme.type === 'font') {
    const charMap: Record<string, { char: string; color?: string }> = {};
    const addFont = (key: string, iconName: string | null) => {
      if (!iconName || !theme.charMap?.[iconName]) return;
      charMap[key] = { char: theme.charMap[iconName], color: theme.colorMap?.[iconName] };
    };
    addFont('__file__', resolveIconName(theme, '', false, false));
    addFont('__folder__', resolveIconName(theme, '', true, false));
    addFont('__folder_open__', resolveIconName(theme, '', true, true));
    for (const name of names) addFont(name, resolveIconName(theme, name, false, false));
    for (const name of folderNames) {
      addFont(`dir:${name}`, resolveIconName(theme, name, true, false));
      addFont(`dir_open:${name}`, resolveIconName(theme, name, true, true));
    }
    return { type: 'font', charMap, fontFaceUri: theme.fontFaceUri, fontId: theme.fontId, fontFormat: theme.fontFormat };
  }

  return { type: 'none' };
}

export function getIconThemeExtensionUri(): vscode.Uri | undefined {
  try {
    const themeId = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
    if (!themeId) return undefined;
    const themeExt = vscode.extensions.all.find(ext => {
      const themes: Array<{ id: string }> = ext.packageJSON?.contributes?.iconThemes ?? [];
      return themes.some((t: { id: string }) => t.id === themeId);
    });
    return themeExt ? vscode.Uri.file(themeExt.extensionPath) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadIconTheme(webview: vscode.Webview): Promise<IconThemeData> {
  try {
    const themeId = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
    if (!themeId) return { type: 'none' };

    const themeExt = vscode.extensions.all.find(ext => {
      const themes: Array<{ id: string; path: string }> = ext.packageJSON?.contributes?.iconThemes ?? [];
      return themes.some(t => t.id === themeId);
    });
    if (!themeExt) return { type: 'none' };

    const extensionUri = vscode.Uri.file(themeExt.extensionPath);

    const themes: Array<{ id: string; path: string }> = themeExt.packageJSON?.contributes?.iconThemes ?? [];
    const themeDef = themes.find(t => t.id === themeId);
    if (!themeDef) return { type: 'none' };

    const themeJsonPath = path.join(themeExt.extensionPath, themeDef.path);
    const themeDir = path.dirname(themeJsonPath);
    const raw = fs.readFileSync(themeJsonPath, 'utf8');
    const json = stripJsonComments(raw);

    const iconDefinitions: Record<string, IconDef> = json.iconDefinitions ?? {};
    const firstDef = Object.values(iconDefinitions)[0];
    if (!firstDef) return { type: 'none' };

    const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
    const variant = isDark ? json : mergeVariant(json, json.light ?? {});

    if (isSvg(firstDef)) {
      // SVG-based theme (Material Icon Theme, etc.)
      const svgMap: Record<string, string> = {};

      // Build map for both base and light-override definitions
      const allDefs = isDark
        ? iconDefinitions
        : { ...iconDefinitions, ...(json.light?.iconDefinitions ?? {}) };

      for (const [name, def] of Object.entries(allDefs)) {
        if (!isSvg(def)) continue;
        const absPath = path.resolve(themeDir, def.iconPath);
        if (fs.existsSync(absPath)) {
          svgMap[name] = webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
        }
      }

      return {
        type: 'svg',
        extensionUri,
        svgMap,
        fileExtensions: variant.fileExtensions ?? {},
        fileNames: variant.fileNames ?? {},
        languageIds: variant.languageIds ?? {},
        folderNames: variant.folderNames ?? {},
        folderNamesExpanded: variant.folderNamesExpanded ?? {},
        file: variant.file ?? json.file,
        folder: variant.folder ?? json.folder,
        folderExpanded: variant.folderExpanded ?? json.folderExpanded,
      };
    } else {
      // Font-based theme (Seti, etc.)
      const fonts: Array<{ id: string; src: Array<{ path: string; format: string }> }> = json.fonts ?? [];
      const primaryFont = fonts[0];
      if (!primaryFont) return { type: 'none' };

      const fontSrc = primaryFont.src[0];
      const fontAbsPath = path.resolve(themeDir, fontSrc.path);
      if (!fs.existsSync(fontAbsPath)) return { type: 'none' };

      const fontUri = webview.asWebviewUri(vscode.Uri.file(fontAbsPath)).toString();
      const charMap: Record<string, string> = {};
      const colorMap: Record<string, string> = {};

      for (const [name, def] of Object.entries(iconDefinitions)) {
        if (isSvg(def)) continue;
        const fc = def as IconDefinitionFont;
        charMap[name] = parseCharacter(fc.fontCharacter);
        if (fc.fontColor) colorMap[name] = fc.fontColor;
      }

      return {
        type: 'font',
        extensionUri,
        fontFaceUri: fontUri,
        fontId: primaryFont.id,
        fontFormat: fontSrc.format,
        charMap,
        colorMap,
        fileExtensions: variant.fileExtensions ?? {},
        fileNames: variant.fileNames ?? {},
        languageIds: variant.languageIds ?? {},
        folderNames: variant.folderNames ?? {},
        folderNamesExpanded: variant.folderNamesExpanded ?? {},
        file: variant.file ?? json.file,
        folder: variant.folder ?? json.folder,
        folderExpanded: variant.folderExpanded ?? json.folderExpanded,
      };
    }
  } catch {
    return { type: 'none' };
  }
}

// Parse JSONC (JSON with // and /* */ comments and trailing commas)
function stripJsonComments(text: string): IconThemeJson {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Single-line comment
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // Multi-line comment
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // String — copy verbatim, don't interpret anything inside
    if (text[i] === '"') {
      result += text[i++];
      while (i < text.length) {
        if (text[i] === '\\') { result += text[i++]; result += text[i++]; continue; }
        result += text[i];
        if (text[i++] === '"') break;
      }
      continue;
    }
    result += text[i++];
  }
  // Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, '$1');
  return normalizeIconThemeJson(JSON.parse(result));
}

function mergeVariant(base: IconThemeJson, light: IconThemeJson): IconThemeJson {
  return {
    ...base,
    fileExtensions: mergeStringMap(base.fileExtensions, light.fileExtensions),
    fileNames: mergeStringMap(base.fileNames, light.fileNames),
    languageIds: mergeStringMap(base.languageIds, light.languageIds),
    folderNames: mergeStringMap(base.folderNames, light.folderNames),
    folderNamesExpanded: mergeStringMap(base.folderNamesExpanded, light.folderNamesExpanded),
    file: light.file ?? base.file,
    folder: light.folder ?? base.folder,
    folderExpanded: light.folderExpanded ?? base.folderExpanded,
  };
}

function mergeStringMap(base?: Record<string, string>, override?: Record<string, string>): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function normalizeIconThemeJson(value: unknown): IconThemeJson {
  if (!isRecord(value)) return {};

  return {
    iconDefinitions: readIconDefinitions(value.iconDefinitions),
    fonts: readFonts(value.fonts),
    light: isRecord(value.light) ? normalizeIconThemeJson(value.light) : undefined,
    fileExtensions: readStringMap(value.fileExtensions),
    fileNames: readStringMap(value.fileNames),
    languageIds: readStringMap(value.languageIds),
    folderNames: readStringMap(value.folderNames),
    folderNamesExpanded: readStringMap(value.folderNamesExpanded),
    file: readString(value.file),
    folder: readString(value.folder),
    folderExpanded: readString(value.folderExpanded),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;

  const entries = Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string'
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readIconDefinitions(value: unknown): Record<string, IconDef> | undefined {
  if (!isRecord(value)) return undefined;

  const result: Record<string, IconDef> = {};
  for (const [name, def] of Object.entries(value)) {
    if (!isRecord(def)) continue;
    if (typeof def.iconPath === 'string') {
      result[name] = { iconPath: def.iconPath };
    } else if (typeof def.fontCharacter === 'string') {
      result[name] = {
        fontCharacter: def.fontCharacter,
        fontColor: readString(def.fontColor),
        fontSize: readString(def.fontSize),
      };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function readFonts(value: unknown): FontDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const fonts: FontDefinition[] = [];
  for (const font of value) {
    if (!isRecord(font) || typeof font.id !== 'string' || !Array.isArray(font.src)) continue;

    const src = font.src
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map(item => ({
        path: readString(item.path),
        format: readString(item.format),
      }))
      .filter((item): item is FontSource => !!item.path && !!item.format);

    if (src.length > 0) fonts.push({ id: font.id, src });
  }

  return fonts.length > 0 ? fonts : undefined;
}
