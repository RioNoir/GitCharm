// fantasticon config for `npm run icons:build`: packs the SVGs in media/icon-font/src into
// media/icon-font/gitcharm-icons.woff, the same way @vscode/codicons builds its font.
//
// VS Code only themes custom title-bar icons like codicons (same colour, high contrast
// included) when they come from an icon font registered under `contributes.icons`. Sources
// follow the codicon conventions: 16x16 viewBox, filled outlines (no strokes).
//
// Keep `codepoints` in sync with `contributes.icons` in package.json: a glyph's codepoint is
// its `fontCharacter` there, so never renumber an existing glyph.
const path = require('path');

const root = path.resolve(__dirname, '..');

module.exports = {
  name: 'gitcharm-icons',
  inputDir: path.join(root, 'media', 'icon-font', 'src'),
  outputDir: path.join(root, 'media', 'icon-font'),
  fontTypes: ['woff'],
  assetTypes: [],
  normalize: true,
  codepoints: {
    'compare-mode': 0xe000,
    'compare-mode-active': 0xe001,
    log: 0xe002,
    commit: 0xe003,
  },
};
