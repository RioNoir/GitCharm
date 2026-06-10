import { isPrimaryBranch } from './branchUtils';

export const HEAD_COLOR_DARK  = '#c9a84c';
export const HEAD_COLOR_LIGHT = '#8a6914';

// Tag color — fixed cyan/teal, distinct from HEAD gold and the blue primary.
const TAG_COLOR_DARK  = '#4aaa9a';
const TAG_COLOR_LIGHT = '#1a7a6a';

const PALETTE_DARK: readonly string[] = [
  '#6a9fc2', '#a07cb0', '#5aaa96', '#b87c5a',
  '#7a9e5a', '#b09050', '#7085b8', '#a06060',
  '#5a8fa0', '#908060', '#7aaa70', '#9a7060',
];

const PALETTE_LIGHT: readonly string[] = [
  '#2a6090', '#6a3a80', '#2a7a68', '#8a4a28',
  '#3a6a28', '#7a5a18', '#3a4a88', '#7a2828',
  '#1a5a70', '#605030', '#3a6a30', '#603828',
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
  return isDarkTheme() ? lightenToThreshold(raw, 0.18) : darkenToThreshold(raw, 0.3);
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
