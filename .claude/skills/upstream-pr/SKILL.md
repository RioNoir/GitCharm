---
name: upstream-pr
description: >-
  Branch, commit, and open a pull request against upstream/main on the GitCharm
  fork. Use when the user asks to create a PR, ship a change, push to upstream,
  or open a pull request on RioNoir/GitCharm.
---

# Upstream PR

This repo is a fork. **PRs target `upstream/main`**, not `origin/main`.

| Remote | Repo |
|--------|------|
| `origin` | the fork (`gaganyadav80/GitCharm`) |
| `upstream` | `RioNoir/GitCharm` |

## Steps

1. `git fetch upstream main`
2. Branch from that tip (`fix/…` or `feat/…`). Never commit on `main`.
3. Commit only the requested work. Message: 1–2 sentences on **why**. HEREDOC, no `--no-verify`.
4. `git push -u origin HEAD`
5. Create the PR against **upstream**:

```bash
gh pr create --repo RioNoir/GitCharm --base main --head "<fork-owner>:<branch>" --title "…" --body "$(cat <<'EOF'
## Summary
- …

## Test plan
- [ ] …

EOF
)"
```

`fork-owner` is the GitHub user on `origin` (`git remote get-url origin`).

## Title and body

- Title: user-facing, what they notice. Match existing PRs (sentence case, no conventional-commit prefix).
- Body: `## Summary` bullets, then `## Test plan` checkboxes.
- Return the PR URL when done.
