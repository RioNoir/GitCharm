# Changelog

All notable changes to GitCharm are documented in this file.

## v0.4.9

### ✨ New Features
- Branch and tag menus (status bar and Log panel) can now show each branch's or tag's last commit — hash, author, message, and relative time — for both single- and multi-repo views, via the new **Show Last Commit In Branch Menu** setting (off by default)
- Git Log rows now show each commit's short hash, hidden together with the author name on narrower rows to avoid crowding ([#57](https://github.com/RioNoir/GitCharm/pull/57) by [@gaganyadav80](https://github.com/gaganyadav80))
- New setting to control whether GitCharm automatically focuses the sidebar after a merge conflict is resolved (on by default, matching VS Code Source Control) ([#56](https://github.com/RioNoir/GitCharm/pull/56) by [@gaganyadav80](https://github.com/gaganyadav80))
- Clicking an already-selected commit row now toggles the detail pane closed instead of doing nothing; clicking it again reopens it ([#59](https://github.com/RioNoir/GitCharm/pull/59) by [@gaganyadav80](https://github.com/gaganyadav80))

### 🐛 Bug Fixes
- Merging a pull request now fetches the remote afterward, so the Log panel reflects the merge instead of still showing the source branch as unmerged
- Fixed the commit message box keeping a stale merge/rebase message after the merge or rebase was finished from the terminal instead of GitCharm ([#54](https://github.com/RioNoir/GitCharm/pull/54) by [@gaganyadav80](https://github.com/gaganyadav80))
- Fixed the Staged/Unstaged sections auto-expanding when staging or unstaging a file, even if the user had collapsed them ([#55](https://github.com/RioNoir/GitCharm/pull/55) by [@gaganyadav80](https://github.com/gaganyadav80))
- Fixed a double-click on a commit row briefly flashing the detail pane open/closed right before opening the full detail view
- Fixed the author name being squeezed into an unreadable single-letter ellipsis by a long commit message, and the ref-badge overflow stack showing one more layer than the actual number of hidden badges

### 🔧 Other
- Added community health files (CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, issue/PR templates), a CI workflow for typecheck/lint, and Dependabot config for npm and GitHub Actions
- Added a Ko-fi funding link and VS Code Marketplace/CI badges to the README

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

## v0.4.6

### ✨ New Features
- New **"Compare changes between two commits"** action in the Git Log, letting you diff any two selected commits against each other ([#35](https://github.com/RioNoir/GitCharm/pull/35) by [@strayge](https://github.com/strayge))
- Clicking a branch in the sidebar now focuses and scrolls the commit list to that branch's tip commit, keyed by branch and repository so same-named local/remote branches resolve correctly
- The branch sidebar's pull and push actions are now branch-aware, operating on the selected branch rather than always the current one
- Persisted the default GitCharm Log location (bottom panel, editor tab, or new window) via new **Default Location** settings, so `Ctrl/Cmd+Alt+L` and the "Undock…" action reopen the Log where it was last left; the bottom-panel Log view is now hidden entirely when its default home is elsewhere ([#37](https://github.com/RioNoir/GitCharm/pull/37) by [@gaganyadav80](https://github.com/gaganyadav80))
- The commit button now adapts to the branch's actual state when there is nothing to commit: **Publish Branch** when there's no upstream, or **Sync Changes** (with ahead/behind counts) when the branch has diverged, prompting for merge/rebase/force-push-with-lease when needed ([#38](https://github.com/RioNoir/GitCharm/pull/38) by [@gaganyadav80](https://github.com/gaganyadav80))
- The active Git profile (avatar, name) is now shown for stashes in the Log Panel, matching the Commit Panel

### 🐛 Bug Fixes
- Cut Git Log refresh latency after external changes (e.g. a terminal commit) from several seconds to about 120ms, by watching Git refs directly instead of relying solely on VS Code's debounced Git API events ([#42](https://github.com/RioNoir/GitCharm/pull/42) by [@gaganyadav80](https://github.com/gaganyadav80))
- Fixed the commit graph reshuffling while paging or refreshing, and fixed the Log view losing its selection and jumping to the top on every refresh instead of only on a cold start
- Fixed "Push All" inflating its reported repository count by including repositories that had nothing to push
- Fixed the commit-row author avatar clipping/stretching and the date hard-clipping mid-character on narrow panels; both now adapt cleanly across width breakpoints
- Fixed content clipping in narrow panels caused by a sizing bug in the custom overlay scrollbar

### 🔧 Other
- Simplified the Git Log default-location UI, dropping the redundant "Default Location…" menu item (covered by Settings) and trimming setting descriptions ([#37](https://github.com/RioNoir/GitCharm/pull/37) by [@gaganyadav80](https://github.com/gaganyadav80))

## v0.4.5

### ✨ New Features
- New filter for showing only repositories with pending changes in the Commit Panel, with the selected filter state now persisted across sessions
- Moved the Commit Panel toolbar (File View, Sort Repository, Repository View, Refresh, Settings) into VS Code's native "..." view/title menu, and added a per-repository inline expand/collapse button in Tree view (shown only when the repository has subfolders and its header is expanded)

### 🐛 Bug Fixes
- Fixed dependency vulnerabilities (`@vscode/vsce`, `esbuild`) flagged by `npm audit` in dev tooling

### 🔧 Other
- Refreshed the extension icon and outdated README screenshots, and documented repository sorting, hide/show via the title menu, the Refresh command, and Manage Hidden Repositories

## v0.4.4

### 🔧 Other
- Aligned the commit message box, Push section, and commit detail backgrounds with the sidebar background for a more consistent look

## v0.4.3

### 🐛 Bug Fixes
- Fixed the **Amend last commit** checkbox staying silently armed after it should no longer apply (e.g. after a push dropped the repository's ahead count to 0, or when switching to a multi-repo selection), which could cause an unrelated, already-pushed commit to be amended instead of a new commit being created
- Fixed remote branch names losing their first path segment on checkout when passed without their remote prefix (e.g. `noissue/team/FOO` instead of `origin/noissue/team/FOO`), which could cause a subsequent push to land on a new remote branch
- Fixed push and pull error reporting: hook failures (e.g. a failing pre-push lint check) previously showed a generic "failed to push some refs" message instead of the actual hook output, and push errors from the Push tab had no way to reveal more detail
- Fixed content clipping in narrow panels caused by a sizing bug in the custom overlay scrollbar

### 🔧 Other
- Added a centralized **GitCharm** output channel (replacing the separate "GitCharm Profiles" channel) with theme-aware, timestamped logging, and a "Show Log" action on git-error notifications
- The branch/tag filter dropdown now includes remote branches (previously local-only), split into "Local Branches" and "Remote Branches" sections
- Removed the redundant vertical repository list from the Log Panel's branch sidebar, since the repo tab bar above it serves the same purpose; selecting a repo tab now also filters the branch/tag sidebar to that repository

## v0.4.2

### 🐛 Bug Fixes
- Fixed GitCharm not detecting a parent-folder Git repository when the VS Code workspace root is a subfolder of the repository (with `git.openRepositoryInParentFolders` enabled)
- Fixed remote branch names with multiple path segments (e.g. `origin/team/FOO`) being mangled on checkout, which could strip part of the branch name and cause a subsequent push to create an unintended new remote branch
- Removed the redundant "GitCharm:" prefix from notifications, since VS Code already shows the extension as the notification's source
- Fixed folder rows in the Commit Panel's file tree not truncating long names, which could push the changed-file-count badge out of view

### 🔧 Other
- Applied non-breaking `npm audit fix` updates resolving dependency vulnerabilities in dev tooling

## v0.4.1

### ✨ New Features
- Added persistent repository tabs, so the selected repository filter is remembered across sessions (contributed by Nathan)
- Added file-level cherry-pick from the commit detail view, letting individual file changes from a commit be applied to the working tree instead of the whole commit (contributed by Kristijan Ribaric)
- New **"Compare with…"** action for individual files and folders across GitCharm: in the Commit Panel's working-tree file list, the native VS Code Explorer/editor context menu, and the Git Log commit detail
- New **"Toggle Git Annotations"** command, available from the Command Palette

### 🐛 Bug Fixes
- Fixed the colored repo label strips in the Git Log commit list still showing when filtered down to a single repository via the repo tabs
- Fixed alignment and styling issues in the Git Log Branches sidebar, including inconsistent repo-color dot positioning and filter input styling mismatches with the repo tabs bar
- Fixed regressions introduced by the file-level cherry-pick change, including the whole-commit "Cherry-Pick" context menu action being silently broken
- Cleaned up raw, unreadable Git error output (ANSI codes, JSON-like objects) shown to users, replacing it with human-readable messages for common failures (push rejected, authentication failed, dirty working tree, etc.)

### 🔧 Other
- Refined the repository tabs bar to match the Commit Panel's tab styling and only render above the commit list
- The branch/tag filter dropdown now shows per-repository color dots, grouped like the Branches sidebar, to indicate which repositories contain a given ref

## v0.4.0

### ✨ New Features
- **Icon theme support** in the Extended Commit Detail panel: file/folder icons now follow the active VS Code icon theme and update live on theme switches
- **Tag management improvements**: a new **"New Tag…"** action in the Git Menu (global and per-repo, created on HEAD), a push prompt after creating a tag, and a **"Push tag"** option in the "Tags on commit" context menu
- Added a custom overlay scrollbar (VS Code style, fades in on scroll) to the commit panel's file list and the Log Panel's branch/tag sidebar
- The commit panel now shows the active Git profile (avatar, name, and email) above the commit message box; clicking the avatar opens the profile manager
- Enabling **"Amend last commit"** now auto-fills the message field with the previous commit's message (if empty) and disables the Stash/Shelve button while amend mode is active
- Improved the annotation hover tooltip layout with icons and separators for better readability

### 🐛 Bug Fixes
- Fixed bare `remotes/` remote pointers showing up as spurious "remotes/" badges in the commit detail view and in checkout labels
- Fixed the Log Panel not refreshing after creating or deleting a tag from the Git Menu

## v0.3.9

### ✨ New Features
- Added a **File History** panel: view a file's full commit history (via `git log --follow`) from the Explorer, editor context menu, Commit Panel, and commit detail views, with native diff support
- Replaced the custom compare-commits UI with VS Code's native `vscode.changes` API, and added a "View Combined Diff" action to compare all commits in a repository at once from the Push tab
- Added inline "Open Changes" and "Open Commit Detail" hover actions on Log panel commit rows, plus a custom Cut/Copy/Paste context menu on the commit message textarea
- Context menus across all panels now reposition intelligently (opening upward or scrolling) when there isn't enough room below

### 🐛 Bug Fixes
- Fixed hash search in the Log panel being limited to the current page instead of scanning the full history
- Fixed file deselection not happening when its diff tab was closed
- Fixed the stash popover showing the wrong author name/avatar
- Fixed branch badge truncation in the commit detail view

## v0.3.8

### ✨ New Features
- Added a configurable **default save action** for the Commit Panel (stash by default), reflected in the save split-button's label, icon, and click behavior
- Added a **Reset View Locations** command and an optional setting to automatically clear stale GitCharm view placement on startup

### 🐛 Bug Fixes
- Improved commit message input with focus border feedback

## v0.3.7

### ✨ New Features
- Added an **undocked panel**: the Commit Panel and Git Log can now be opened side by side in a resizable editor tab or a separate VS Code window, via "Undock…" in the Log panel menu or the `gitcharm.undock` command
- Pushing or publishing a branch with no remote configured now opens the Manage Remotes picker instead of showing an error
- The Push tab badge now counts unpublished local branches in addition to branches with unpushed commits

### 🐛 Bug Fixes
- Fixed the Commit Panel's badge not following the panel when moved to a different sidebar container
- Fixed the fetch-on-startup incoming-commits notification not firing reliably due to a startup race with the VS Code Git extension

## v0.3.6

### ✨ New Features
- Added **Fetch All**, **Push All**, **Force Push All**, and **Sync All** to the Commit Panel toolbar and Git Menu (global and per-repo), plus a Force Push option in the Push tab split-button
- Git stashes are now integrated into the Git Log as native commit nodes, with full diff stats and stash metadata
- Added "Reveal in Explorer", "Open in New Window", and "Open in File Manager" to repository header context menus, and a "Rename" option for Shelf and Stash entries
- Added a monthly "Do you like GitCharm?" support notification (Leave a Star / Donate / Do Not Show Again)
- Expanded the branch color palette from 12 to 16 hues, added a collapsible Log panel branch sidebar, and made branch colors update live on theme change

### 🐛 Bug Fixes
- Fixed `fetchOnStartup` running more than once
- Fixed stash renaming, which now uses drop + store since Git has no native stash rename
- Fixed double borders between repository sections in the Worktrees tab

## v0.3.5

### ✨ New Features
- Smarter diff resolution in the Log panel: correctly opens diffs for added, deleted, renamed, copied, merge, and root commits, plus a new "Show Combined Diff" context menu entry
- Added a close button to the commit detail panel, and bolded the commit message for the current HEAD commit
- Author name in the commit list is now hidden on narrow panels to save space

### 🐛 Bug Fixes
- Fixed clicking the branch badge in the Push tab not opening the branch menu
- Fixed the HEAD badge always rendering outside the overflow group instead of participating in overflow logic
- Fixed the root commit (no parents) showing no files in its diff
- Fixed author-initials generation for names with parenthesized suffixes (e.g. "Riccardo Morandi (HP)")

## v0.3.4

### ✨ New Features
- **AI-powered commit explanations**: added multi-provider AI support (Anthropic API, OpenAI API, Claude CLI, Codex CLI, Ollama, LM Studio, and Gemini CLI/API) with an "Explain with AI" action in the Log panel and Push tab commit context menus, shown in a new extended commit detail panel
- Added an "Open Full Detail" action to commit context menus in the Log panel and Push tab
- Repository context menu actions ("Manage Repository", "View Git Log", "Hide Repository") are now available from every Commit Panel view mode, with a toolbar indicator for hidden repositories
- Push tab overhaul: branch/tag/detached badges on repository headers, per-commit stats (files changed, +/-), and distinct sync states ("Up to date", "N commits to pull", "Local branch — not published") with a smarter, context-aware push button label
- Added **nested Git repository scanning**, discovering repositories inside workspace subfolders via new `repositoryScanMaxDepth` and `repositoryScanIgnoredFolders` settings, plus a `gitcharm.reloadRepositories` command to force a re-scan
- File selection in Simplified and Changelists view modes now persists across VS Code restarts
- Added a startup notification for unpushed commits with a "Go to Push" action (new `gitcharm.notifyOnUnpushedCommits` setting), and a new `gitcharm.suppressDivergedBranchWarning` setting to hide the diverged-branch warning
- Added an explicit HEAD badge in the commit list, reordered ref badges (local → remote → tags → HEAD → origin/HEAD), and added dynamic per-remote sections in the branch sidebar (no longer hardcoded to "origin")

### 🐛 Bug Fixes
- Fixed branches/tags containing slashes (e.g. `feature/foo`) being mis-parsed or stripped of their prefix in the branch sidebar and Git Log
- Fixed the Commit Panel showing files that belong to nested Git repositories
- Fixed push/pull hardcoding the `origin` remote instead of deriving it from the branch's tracking remote
- Fixed the current branch badge not rendering bold in the commit list
- Fixed the repository header collapse state resetting on every status update
- Fixed the "new changes" auto-expand detection in the VS Code view mode silently never firing due to a status-update payload mismatch
- Fixed the wrong icon showing on the Undo Commit action in the Push tab

### 🔧 Other
- Switched the project license from MIT to GPL-3.0
- Added VS Code Marketplace and Open VSX Registry publish steps to the release workflow

## v0.3.3

### ✨ New Features
- The status bar now shows ahead/behind commit counts (↓N ↑N) next to the branch name
- The Git Log now marks incoming commits (reachable from upstream but not yet in HEAD) with a distinct arrow icon, and merges the branch/tag filters into a single grouped picker
- Improved empty states: **Open Folder**/**Clone Repository** buttons when no workspace is open, and an **Initialize Repository** button when a folder has no Git repository yet
- Added a startup notification for incoming commits to pull, with Pull/Dismiss/Don't-show-again actions (new `gitcharm.notifyOnIncomingCommits` setting)
- Added a Rollback All button to the VS Code view's Changes section header
- Changelist and Git Profile storage moved out of project files (`.vscode`/`.code-workspace`) into the extension's global storage, so these settings no longer pollute versioned workspace files; GitCharm no longer writes credentials into `.git/config`

### 🐛 Bug Fixes
- Fixed ahead/behind counts always reading as zero
- Fixed undoing the very first commit in a repository
- Fixed a crash in the Git Log caused by a React remount when switching between empty and populated states
- Fixed branches without a remote tracking branch incorrectly showing the "unpushed" push indicator

## v0.3.2

### ✨ New Features
- **Git submodule support**: submodules are auto-discovered from `.gitmodules` and shown as separate repositories with a SUB badge across all Commit Panel view modes and the Git Menu; submodule pointer files can be staged/unstaged, and submodules can be updated, initialized, deinitialized, or opened in a new window from the Git Menu
- Added worktree-aware repository headers across all Commit Panel view modes, appending linked worktree branch names after the main repository name
- Added "Reveal in Explorer" and "Reveal in File Manager" to file context menus in the Commit Panel and Log panel
- In-panel error/info banners were replaced with native VS Code notifications

### 🐛 Bug Fixes
- Fixed the `GitCharm: Fetch All Remotes` command not actually fetching anything
- Fixed several GitCharm command palette actions that were missing from registration
- Fixed push/pull/fetch failing with `fatal: 'origin' does not appear to be a git repository` by falling back to direct Git calls when the VS Code Git API has no remotes registered for a repository
- Fixed context menus not closing when clicking outside the WebView
- Fixed the Push tab not refreshing after an undone commit
- Fixed repositories with worktrees being incorrectly flagged by the "branches have diverged" check

## v0.3.1

### ✨ New Features
- Git Log rows now show responsive ref badges (up to 2 visible, with a stacked overflow indicator using real branch colors), sorted by HEAD → synced local+remote → local-only → remote-only → tags
- Author names in the Git Log are now abbreviated (e.g. "Mario Rossi" → "Mario R.") to keep the commit title readable on narrow rows
- **Changelists**: added a first-install QuickPick to choose the preferred Commit Panel view mode (Simplified / Changelists / VS Code); custom changelists now support renaming, right-click highlighting without toggling checkboxes, and an "Add to Git" action for untracked files
- Commit Panel: unified Commit/Commit & Push and Save buttons into single dropdown split-buttons, added per-repo checkboxes and deselect (×) pills in the VS Code view mode, and added a single-repo header shared across all view modes

### 🐛 Bug Fixes
- Fixed merges being rejected outright when the working tree had uncommitted changes — GitCharm now auto-stashes, retries the merge, and restores the stash afterward, with the same stash-and-retry recovery offered from the status bar and Log panel branch menus
- Fixed the current branch name intermittently showing as "HEAD" or a raw commit hash in the status bar and Commit Panel during checkout race conditions
- Fixed the branch badge click in changelist mode triggering a group collapse instead of opening the branch picker
- New and modified files are no longer auto-selected on every status update, only on initial load
- Fixed the pill count badge turning oval with two-digit numbers

## v0.2.9

### 🔧 Other
- Internal CI workflow fix and README update (no user-facing changes)

## v0.2.8

### ✨ New Features
- **Full tag management**: create, checkout, merge, push, and delete tags from the Git Menu (status bar) and the Log panel sidebar, including a three-way delete dialog (local, remote, or both) and a dedicated Tags/Common Tags section
- Added **Checkout...** and **Branch options...** to the Log panel's commit context menu, letting you check out a branch or the underlying revision (detached HEAD), including for remote-only branches
- The status bar, Git Menu, and Commit Panel now show the short commit hash instead of "HEAD" when in detached HEAD state without a tag
- The Log panel now refreshes automatically after a commit or push, with a loading skeleton shown during background fetches

### 🐛 Bug Fixes
- Fixed the detached HEAD pseudo-entry appearing as a local branch in the Log panel's branch sidebar

## v0.2.7

### 🔧 Other
- README badge styling refresh, GitHub stats, and a "Buy Me a Coffee" link (no user-facing extension changes)

## v0.2.6

### 🐛 Bug Fixes
- Git credentials from the active Git Profile are now written to `.git/config` on activation and before every commit, keeping the repository's local identity in sync

### 🔧 Other
- Renamed the project from GitStorm to GitCharm (package, commands, settings, and documentation updated accordingly)

## v0.2.5

### 🐛 Bug Fixes
- Fixed commit ignoring selected files that had unstaged changes on top of staged changes, so the full diff (staged + unstaged) is now committed for partially-staged files

## v0.2.4

### ✨ New Features
- Git Profiles now fall back through **Local** (`.git/config`) and **Global** (`git config --global`) as implicit identity sources when no GitCharm profile is active, with a per-workspace default source selectable from the profiles menu
- Author avatars in the Git Log: resolves GitHub noreply emails to GitHub avatars, other emails to Gravatar, with a colored-initials fallback and blank-avatar detection
- Added Git remote management (add, rename, change URL, remove) to the per-repository branch menu in the status bar

### 🐛 Bug Fixes
- The Git Log panel now refreshes automatically after push and pull operations
- The commit message is now prefilled with `Merge branch 'X' into 'Y'` when a merge conflict is detected
- Fixed an extension startup activation issue
- Simplified global rollback to discard changes directly, consistent with single-file rollback behavior

## v0.2.0

### 🔧 Other
- Internal package identifier and versioning updates (no user-facing changes)

## v0.1.9

### 🔧 Other
- Internal publisher identifier update (no user-facing changes)

## v0.1.8

### 🐛 Bug Fixes
- Fixed the status bar, activity badge, and Git Log not refreshing while the Commit panel was closed

## v0.1.7

### ✨ New Features
- **Git Annotations**: blame-based inline columns in the editor gutter, plus ghost text showing the commit author, relative date, and summary for the current line
- Added **Open/Close Git Annotations** commands to the editor context menu, and settings to enable or disable annotations and ghost text independently
- Annotation hovers now link directly to the corresponding commit in the Git Log panel

### 🐛 Bug Fixes
- Removed the "Unpushed Commits" section from the commit form now that unpushed commits are accessible via the Push tab
- Fixed the activity badge not updating in new windows by reacting to the VS Code Git API's initialization state
- Long branch names in the Changes panel header are now truncated with an ellipsis, with the full name shown on hover

### 🔧 Other
- Added a status bar spinner while the initial Git status is loading on extension startup

## v0.1.5

### ✨ New Features
- Clicking a commit title in the Log Panel now opens the full commit message in a VS Code tab when it has a multi-line body (e.g. a changelog), instead of only expanding inline
- Push tab now shows unpushed commits for branches without upstream tracking, with a commit-count badge on the tab label that updates automatically on commit/undo/push
- The Push button now switches its label to "Publish" only when the branch has no upstream and no local commits yet; a per-row Undo button (HEAD commit only) and a go-to-file button (jumps to the commit in the Log Panel) were added to each Push tab row
- Push tab now refreshes silently (no flicker) and automatically after any successful commit, undo, or push
- Clicking a commit row in the Push tab now focuses the Log Panel and scrolls to that commit
- The "Update" button in the Log Panel was renamed to "Refresh"

### 🐛 Bug Fixes
- Fixed selecting the same commit twice in the Log Panel losing its file list
- Fixed the repository branch sometimes showing as "HEAD" after a commit or push by falling back to `git rev-parse` when the VS Code API returns no branch name
- Fixed stale branch info from the file watcher by forcing an explicit status refresh after commit, push, and pull
- Fixed Copilot commit-message generation failing when the `gpt-4o` model wasn't available, by falling back to any available Copilot model
- Fixed the "Apri file" tooltip showing instead of "Open file", and added missing titles to the Push, Push All, and shelve prompt buttons
- The "Open Changes" button now shows a native VS Code QuickPick with only the applicable options, or runs directly when only one applies

### 🔧 Other
- Hid the repository list in the branch sidebar when the workspace has a single repository, and hid `origin/HEAD` from the remote branches list
- Added a loading (pulsing, read-only) state to the commit message textarea while AI generates a message

## v0.1.4

### 🐛 Bug Fixes
- Fixed the very first commit in a repository (and files outside the workspace root) being mishandled by the file-status and staging logic

### 🔧 Other
- Added README screenshots and updated the extension icon

## v0.1.3

### ✨ New Features
- Commit detail view can now drill into a merge commit's individual parent commits and inspect the files each one changed
- Renamed the Git Log's "Fetch All" button to "Update" and switched its icon, to make clear it also refreshes the log

### 🔧 Other
- Reduced the Git Log auto-refresh debounce delay after repository changes for a snappier update

## v0.1.2

### 🐛 Bug Fixes
- Fixed the amend checkbox in the commit form being permanently disabled and non-functional
- Fixed pulling and rebasing surfacing the underlying Git error message instead of a generic failure
- Fixed unpushed commits not being flagged in the Git Log, and added an indicator icon for them
- Fixed pull/push operations across multiple repositories not logging failures for diagnosis

## v0.1.1

### 🔧 Other
- Internal build/workflow fixes with no user-facing changes

## v0.1.0

### ✨ New Features
- Initial release of GitStorm (later renamed GitCharm): PhpStorm/IntelliJ-style Git management for VS Code
- **Commit Panel**: unified staged/unstaged file tree, commit and commit & push, stash/shelve support, per-repo rollback, and AI-assisted commit message generation
- **Git Log panel**: commit graph with branch sidebar, commit detail view, and file diff viewer
- **3-way Merge Editor** for resolving conflicts directly inside VS Code
- Status bar branch indicator with quick access to Pull, Push, Fetch All Remotes, and the branch menu
- Commands: `GitStorm: Commit`, `GitStorm: Commit & Push`, `GitStorm: Pull`, `GitStorm: Push`, `GitStorm: Fetch All Remotes`, `GitStorm: Open Merge Editor`, `GitStorm: Focus Git Log`, `GitStorm: Update Project`, and `GitStorm: Settings`
