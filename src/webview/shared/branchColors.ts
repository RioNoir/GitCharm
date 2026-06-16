import { isPrimaryBranch } from './branchUtils';

export const HEAD_COLOR_DARK  = '#c9a84c';
export const HEAD_COLOR_LIGHT = '#8a6914';

// Tag color — muted grey-brown, neutral so it doesn't compete with branch colors.
const TAG_COLOR_DARK  = '#909090';
const TAG_COLOR_LIGHT = '#707070';

// Muted palette — 16 hues, each at least 22° apart on the wheel, desaturated for a calm graph look.
// Avoids the HEAD gold zone (~35°-55°). The former tag teal (~170°) is now free to use.
const PALETTE_DARK: readonly string[] = [
  '#6aaed0', //   200° steel blue
  '#cc6a9a', //   330° pink
  '#6ab86a', //   120° green
  '#cc7070', //     0° red
  '#8c70cc', //   255° indigo
  '#cc7a50', //    18° orange
  '#4aaa9a', //   170° teal (ex-tag color)
  '#cc8060', //    16° orange-red
  '#a0cc6a', //    82° yellow-green
  '#6a8ecc', //   218° cornflower
  '#cc6ab0', //   308° magenta
  '#7acc80', //   128° mint-green
  '#cc6060', //   355° coral-red
  '#6accc0', //   183° aqua
  '#b870cc', //   290° purple
  '#6ab0d0', //   203° sky (replaces duplicate red)
];

const PALETTE_LIGHT: readonly string[] = [
  '#2e6898', //   200°
  '#962860', //   330°
  '#2a7828', //   120°
  '#963232', //     0°
  '#4a2e96', //   255°
  '#963818', //    18°
  '#1a7a6a', //   170° teal (ex-tag color)
  '#964018', //    16°
  '#587818', //    82°
  '#2a4e98', //   218°
  '#962878', //   308°
  '#2a7840', //   128°
  '#982020', //   355°
  '#287878', //   183°
  '#6a2496', //   290°
  '#2a6890', //   203°
];

function parseColor(raw: string): [number, number, number] | null {
  const s = raw.trim();
  const hex = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (rgb) return [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];
  return null;
}

function luminance(r: number, g: number, b: number): number {
  const s = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * s(r) + 0.7152 * s(g) + 0.0722 * s(b);
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function darkenToThreshold(raw: string, threshold: number): string {
  const rgb = parseColor(raw);
  if (!rgb) return raw;
  let [r, g, b] = rgb;
  let lum = luminance(r, g, b);
  while (lum > threshold) {
    r = Math.round(r * 0.82);
    g = Math.round(g * 0.82);
    b = Math.round(b * 0.82);
    lum = luminance(r, g, b);
  }
  return toHex(r, g, b);
}

export function lightenToThreshold(raw: string, threshold: number): string {
  const rgb = parseColor(raw);
  if (!rgb) return raw;
  let [r, g, b] = rgb;
  let lum = luminance(r, g, b);
  while (lum < threshold) {
    r = Math.min(255, Math.round(r * 1.15 + 8));
    g = Math.min(255, Math.round(g * 1.15 + 8));
    b = Math.min(255, Math.round(b * 1.15 + 8));
    const next = luminance(r, g, b);
    if (next === lum) break; // no progress (already at 255)
    lum = next;
  }
  return toHex(r, g, b);
}

export function isDarkTheme(): boolean {
  return typeof document !== 'undefined' &&
    (document.body.classList.contains('vscode-dark') ||
     document.body.classList.contains('vscode-high-contrast'));
}

function readCssVar(...vars: string[]): string {
  if (typeof document === 'undefined') return '';
  for (const v of vars) {
    const val = getComputedStyle(document.body).getPropertyValue(v).trim() ||
                getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    if (val) return val;
  }
  return '';
}

export function primaryBranchColor(): string {
  const raw = readCssVar('--vscode-button-background') || '#0078d4';
  return isDarkTheme() ? lightenToThreshold(raw, 0.28) : darkenToThreshold(raw, 0.22);
}

export function headColor(): string {
  return isDarkTheme() ? HEAD_COLOR_DARK : HEAD_COLOR_LIGHT;
}

export function tagColor(): string {
  return isDarkTheme() ? TAG_COLOR_DARK : TAG_COLOR_LIGHT;
}

export function currentPalette(): readonly string[] {
  return isDarkTheme() ? PALETTE_DARK : PALETTE_LIGHT;
}

// Normalize a branch name: strip remote prefix so origin/foo → foo.
export function normalizeBranchName(name: string): string {
  const slash = name.indexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
}

export function branchPaletteIndex(name: string): number {
  const normalized = normalizeBranchName(name);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash % PALETTE_DARK.length;
}

// Returns the color for a branch name. isHead=true gives the reserved HEAD color
// for non-primary branches. Primary branches always get the VSCode primary color.
export function branchColor(name: string, isHead = false): string {
  const normalized = normalizeBranchName(name);
  if (isPrimaryBranch(normalized)) return primaryBranchColor();
  if (isHead) return headColor();
  return currentPalette()[branchPaletteIndex(normalized)];
}
