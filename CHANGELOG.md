# Changelog

All notable changes to GitCharm are documented in this file.

## v0.4.9

### ✨ New Features
- Branch and tag menus (status bar and Log panel) can now show each branch's or tag's last commit — hash, author, message, and relative time — for both single- and multi-repo views, via the new **Show Last Commit In Branch Menu** setting (off by default)

### 🐛 Bug Fixes
- Merging a pull request now fetches the remote afterward, so the Log panel reflects the merge instead of still showing the source branch as unmerged

## v0.4.8

### ✨ New Features
- Branch/tag tree view for the Log panel's sidebar, grouping slash-namespaced names into a collapsible folder tree, with repo dots, aggregated ahead/behind counts, and a "Pull" action for non-current local branches
- Keyboard navigation (arrows, Home/End, PageUp/PageDown) for the branch sidebar, commit list, and file trees, with hover-to-focus and auto-scroll
- Detect local branches whose remote was deleted (e.g. after a PR merge) and offer to delete them, via a post-fetch notification or the new "Check for Orphaned Branches" command
- Renaming a branch now offers to rename (or delete) its remote counterpart to match, from both the status bar and the new "Rename…" action in the Log panel's branch context menu
- Checking out a branch with uncommitted changes in the Log panel now offers the same stash/force recovery menu as the status bar, instead of failing silently
- Renamed the "GitCharm Commit" panel to "GitCharm"
- New **Branch Name Models** setting: configure prefixes (e.g. `feature/`, `bugfix/`, `revert-`) that show up as selectable, completable suggestions when creating a new branch
- Branch menus (status bar and Log panel) now show each branch's last commit — hash, author, message, and relative time — for both single- and multi-repo views
- New **"Checkout detached…"** action in the repo branch menu, to check out any branch without moving HEAD onto it
- New **"Checkout '<branch>' and merge '<current>' into it"** action, combining a checkout with merging the previously active branch in one step
- New generic **"Compare '<branch>' with…"** action to diff any branch or tag against another, not just against the current branch
- The repository's actual primary branch (e.g. `main` vs. a stale `master`) is now detected from the remote's real default branch (`origin/HEAD`) instead of a name-based guess, and deleting it from the remote is now blocked in both the status bar and the Log panel
- The main Git Menu is now grouped into Fetch/Pull/Push/Sync, New Branch/Tag, and Commit/Log sections, and drops "all repositories" wording when the workspace has only one repository
- Creating a branch that already exists now offers to check it out instead of failing, and creating/checking out a branch with uncommitted changes now offers the same stash/force recovery menu everywhere

### 🐛 Bug Fixes
- Fixed PR provider detection for SSH remotes using a custom `Host` alias (e.g. `git@github-personal:owner/repo.git`)
- Fixed hovering a branch/file/commit row stealing focus from an open VS Code quick pick or input box and closing it
- Fixed the missing branch/tag icon in the commit detail's Descendant Branches badges
- Fixed a stale-render flash in the commit list after a programmatic scroll
- Fixed stash author names not being abbreviated like regular commits
- Fixed the webview bundle being served from Chromium's disk cache after a rebuild
- Fixed `origin/HEAD` showing up as a phantom remote branch in branch lists
- Fixed remote branch names losing their `<remote>/` prefix in some menu labels
- Fixed a false "success" notification after a multi-repo checkout when one of the repositories actually failed

## v0.4.7

### ✨ New Features
- **Pull Requests**: new dedicated tab in the Commit Panel, with multi-provider support (GitHub, GitLab, Bitbucket Cloud, Gitea)
  - PR creation with branch selection, comments, and comment moderation
  - Enriched activity timeline, reviewers/assignees/labels, and CI checks
  - PR account management with avatars and automatic refresh on repo add/remove
  - **AI Explanation** for pull requests, moved to a floating action button
  - Settings for default merge strategy and checkout action
  - Extended PR filters and polished Commit Panel row/header styling
- Copy branch name from the context menu
- Detail panels are now restored across restarts, with the tab bar collapsible into a dropdown
- Redesigned the Branches/Merged Commits sections in the commit detail view
- Unified file trees under a shared `GenericFileTree` component and migrated Full Detail to React
- Collapsed the Stash button into the Commit dropdown

### 🐛 Bug Fixes
- Fixed misaligned repo/section header borders across the Commit and Log panels
- Fixed Bitbucket PR actions being hidden despite having write access
- Git Log no longer wipes other repos' stashes when filtered to a single repo
- Fixed the commit message being lost when finishing a rebase from the panel
- Commit box now correctly picks up the message git prepared
- Only refs pointing at the selected commit are now shown
- Fixed the branch menu merging the wrong ref into a same-named local branch
- Various Commit Panel bug fixes surfaced from VS Code parity work
- Fixed stash display in Full Detail
- Fixed all ESLint errors and warnings across the codebase

### 🔧 Other
- Changed the support link to Ko-fi and updated the support notification in `extension.ts`
- Documented the Pull Requests feature in the README
- Added a dedicated GitHub-only CI workflow for beta releases
