# Contributing to GitCharm

Thanks for your interest in contributing to GitCharm! This document explains
how to set up your environment, the workflow we use, and what to expect when
you open an issue or pull request.

## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Getting started

### Prerequisites

* [Node.js](https://nodejs.org/) (LTS recommended)
* [VS Code](https://code.visualstudio.com/) `^1.93.0`

### Setup

```bash
git clone https://github.com/RioNoir/GitCharm.git
cd GitCharm
npm install
```

### Running the extension

Open the project in VS Code and press `F5` to launch an Extension
Development Host with GitCharm loaded, or run the watch build manually:

```bash
npm run watch
```

This runs the host and webview builds concurrently and rebuilds on change.

### Building

```bash
npm run build
```

### Type checking and linting

```bash
npm run typecheck
npm run typecheck:webview
npm run lint
```

Please make sure these pass before opening a pull request.

## Making changes

1. Fork the repository and create a branch off `main`:
   `git checkout -b my-feature`
2. Make your changes, keeping commits focused and descriptive.
3. Update [CHANGELOG.md](CHANGELOG.md) under an "Unreleased" section if your
   change is user-facing.
4. Run typecheck and lint locally (see above).
5. Push your branch and open a pull request against `main`.

### Pull request guidelines

* Describe **what** changed and **why**, not just what files were touched.
* Link any related issues (e.g. `Fixes #123`).
* Keep PRs focused — unrelated changes make review harder and slower.
* Include screenshots or a short clip for UI changes.
* Be responsive to review feedback; a PR that goes stale may be closed.

## Localization

GitCharm uses VS Code's built-in localization:

| File | Contains |
|:--|:--|
| `package.nls.json` / `package.nls.<lang>.json` | Command titles, menus and settings from `package.json` |
| `l10n/bundle.l10n.json` | English UI strings, **generated** by `npm run l10n:export` — don't edit by hand |
| `l10n/bundle.l10n.<lang>.json` | Translations of the bundle, keyed by the English text |

`<lang>` is a VS Code language id (`it`, `zh-cn`, `zh-tw`, `de`, `ja`, …).

### Writing code with UI text

* Host: `vscode.l10n.t('Delete branch "{0}"?', name)`.
* Webviews: `import * as l10n from '@vscode/l10n'` — always import from `@vscode/l10n`
  directly. The extractor follows the import, so calls through an alias or a re-export are
  silently skipped (`npm run l10n:check` catches this).
* One sentence per message, with `{0}` placeholders — never concatenate translated
  fragments. Singular/plural: `plural(n, l10n.t('1 file'), l10n.t('{0} files', n))`.
* Don't translate IDs, message types, values compared in code, git data (stash messages,
  refs) or log output.
* Dates and relative times: use `Intl` with the VS Code language (`vscode.env.language`,
  or `locale` from `src/webview/shared/l10n.ts`), not hand-built English strings.
* Text inputs that react to Enter/Escape must ignore IME composition
  (`isImeComposing()` in `src/webview/shared/ime.ts`).
* After changing UI strings run `npm run l10n:export` and commit `l10n/bundle.l10n.json`;
  CI fails if it's stale.

### Translating

1. Copy `package.nls.json` to `package.nls.<lang>.json` and `l10n/bundle.l10n.json` to
   `l10n/bundle.l10n.<lang>.json`, then translate the values (keep the keys).
2. Keep every `{0}`/`{name}` placeholder; `npm run l10n:check -- --strict` must pass.
3. Try it with `code --extensionDevelopmentPath=. --locale=<lang>` (the matching VS Code
   language pack must be installed).

## Reporting bugs

Open a [GitHub issue](https://github.com/RioNoir/GitCharm/issues) and
include:

* GitCharm version, VS Code version, and OS
* Steps to reproduce
* Expected vs. actual behavior
* Relevant logs from the "GitCharm" output channel, if applicable

## Suggesting features

Feature requests are welcome as GitHub issues. Please describe the problem
you're trying to solve, not just the solution — it helps us find the best
approach, and check existing issues first to avoid duplicates.

## Security issues

Please do **not** report security vulnerabilities through public GitHub
issues. See [SECURITY.md](SECURITY.md) for how to report them responsibly.

## License

By contributing to GitCharm, you agree that your contributions will be
licensed under the project's [GPL-3.0-only license](LICENSE).
