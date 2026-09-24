// East Asian Wide / Fullwidth ranges (Unicode UAX #11): CJK ideographs, kana, Hangul,
// fullwidth forms and CJK punctuation render two monospace cells wide.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
];

/**
 * Width of `text` in monospace cells (CSS `ch` units), counting wide CJK characters as 2.
 * Use instead of `.length` when sizing editor decorations by character count.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    width += WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return width;
}
