# Changelog

All notable changes to GitCharm are documented in this file.

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
