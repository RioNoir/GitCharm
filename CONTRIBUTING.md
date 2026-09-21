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
