# Changelog

All notable changes to GitCharm are documented in this file.

## v0.4.8

### ✨ New Features
- Branch/tag tree view for the Log panel's sidebar, grouping slash-namespaced names into a collapsible folder tree, with repo dots, aggregated ahead/behind counts, and a "Pull" action for non-current local branches
- Keyboard navigation (arrows, Home/End, PageUp/PageDown) for the branch sidebar, commit list, and file trees, with hover-to-focus and auto-scroll
- Detect local branches whose remote was deleted (e.g. after a PR merge) and offer to delete them, via a post-fetch notification or the new "Check for Orphaned Branches" command
- Renaming a branch now offers to rename (or delete) its remote counterpart to match, from both the status bar and the new "Rename…" action in the Log panel's branch context menu
- Checking out a branch with uncommitted changes in the Log panel now offers the same stash/force recovery menu as the status bar, instead of failing silently
- Renamed the "GitCharm Commit" panel to "GitCharm"

### 🐛 Bug Fixes
- Fixed PR provider detection for SSH remotes using a custom `Host` alias (e.g. `git@github-personal:owner/repo.git`)
- Fixed hovering a branch/file/commit row stealing focus from an open VS Code quick pick or input box and closing it
- Fixed the missing branch/tag icon in the commit detail's Descendant Branches badges
- Fixed a stale-render flash in the commit list after a programmatic scroll
- Fixed stash author names not being abbreviated like regular commits
- Fixed the webview bundle being served from Chromium's disk cache after a rebuild

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
