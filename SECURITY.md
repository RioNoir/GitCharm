# Security Policy

## Supported Versions

GitCharm is under active development. Only the latest published release on
the VS Code Marketplace is supported with security fixes.

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| Older   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in GitCharm, please **do not**
report it through a public GitHub issue, discussion, or pull request.

Instead, report it privately by emailing **85.grocers-esteem@icloud.com** with:

* A description of the vulnerability and its potential impact
* Steps to reproduce, or a proof of concept if available
* The GitCharm version, VS Code version, and OS you tested on

### What to expect

* We aim to acknowledge reports within 5 business days.
* We'll keep you updated as we investigate and work on a fix.
* Once a fix is released, we'll credit you in the release notes if you'd
  like (or keep you anonymous, your choice).

Please give us reasonable time to address the issue before any public
disclosure.

## Scope

GitCharm is a VS Code extension that operates on local Git repositories and,
optionally, integrates with remote providers (e.g. GitHub, GitLab, Bitbucket)
for features like pull requests. Vulnerabilities of particular interest
include:

* Arbitrary code or command execution via crafted repository content
  (branch names, commit messages, file paths, hooks, etc.)
* Credential or token handling issues (storage, leakage to logs, unintended
  transmission)
* Path traversal or unsafe file system access within the extension's host
  process

Issues in third-party dependencies should generally be reported upstream,
but feel free to let us know as well so we can track and update.
