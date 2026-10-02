import type { RepoMeta } from './git';

export interface WorkspaceRepo {
  meta: RepoMeta;
  rootPath: string;
}

export const PROJECT_COLORS = [
  '#4ec9b0',
  '#569cd6',
  '#dcdcaa',
  '#c586c0',
  '#f44747',
  '#4fc1ff',
  '#ce9178',
  '#b5cea8',
];

/** Hue steps and lightness levels generated colors are picked from — mid-range lightness, so a dot or a tinted background reads on both dark and light themes. */
const CANDIDATE_HUE_STEP = 6;
const CANDIDATE_LIGHTNESS = [50, 60, 70];
const CANDIDATE_SATURATION = 65;

let generated: string[] | null = null;
let candidates: Array<{ hex: string; lab: Lab }> | null = null;

/**
 * The color of the `index`-th repository. The first ones are PROJECT_COLORS; past those
 * — workspaces with many submodules — each next color is, among a grid of hues and
 * lightnesses, the one farthest (in CIELAB, so as the eye sees it) from every color
 * already handed out, instead of cycling the palette again. A repo's color depends only
 * on its index, not on how many repos there are. Always `#rrggbb`, as callers append an
 * alpha channel to it.
 */
export function projectColor(index: number): string {
  if (index < PROJECT_COLORS.length) return PROJECT_COLORS[index];
  generated ??= [];
  candidates ??= CANDIDATE_LIGHTNESS.flatMap(l =>
    Array.from({ length: 360 / CANDIDATE_HUE_STEP }, (_, i) => {
      const hex = hslToHex(i * CANDIDATE_HUE_STEP, CANDIDATE_SATURATION, l);
      return { hex, lab: hexToLab(hex) };
    }));
  const taken = [...PROJECT_COLORS, ...generated].map(hexToLab);
  while (PROJECT_COLORS.length + generated.length <= index) {
    let best = candidates[0];
    let bestDistance = -1;
    for (const c of candidates) {
      const nearest = Math.min(...taken.map(t => labDistance(t, c.lab)));
      if (nearest > bestDistance) { best = c; bestDistance = nearest; }
    }
    generated.push(best.hex);
    taken.push(best.lab);
  }
  return generated[index - PROJECT_COLORS.length];
}

type Lab = [number, number, number];

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const value = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** sRGB hex → CIELAB (D65). */
function hexToLab(hex: string): Lab {
  const [r, g, b] = [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  });
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function labDistance(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
