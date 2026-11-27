# GitCharm Reference

The complete list of GitCharm's commands and settings. For an overview of the features, see the [README](README.md).

- [Commands](#commands)
- [Keybindings](#keybindings)
- [Settings](#settings)

## Commands

All commands are in the Command Palette under **GitCharm**. Some only appear when they apply — for example, file commands need a file open in the editor.

### General

| Command | Description |
|:--|:--|
| `GitCharm: Commit` | Commits the selected changes. |
| `GitCharm: Branch Menu` | Opens the Git Menu (the branch item in the status bar). |
| `GitCharm: Fetch All Remotes` | Fetches all remotes across all repositories. |
| `GitCharm: Pull All (Update Project)` | Pulls all repositories (prompts for merge or rebase strategy). |
| `GitCharm: Push All` | Pushes all repositories. |
| `GitCharm: Sync All (Pull + Push)` | Pulls then pushes all repositories; stops if any pull fails. |
| `GitCharm: Check for Orphaned Branches` | Fetches, then lists local branches whose remote branch was deleted. |
| `GitCharm: Refresh` | Re-discovers repositories and refreshes both the Commit Panel and the Log Panel. |
| `GitCharm: Settings` | Opens the GitCharm settings page, including Cloud Integrations. |
| `GitCharm: Show Output Log` | Opens the GitCharm output log, useful when reporting a bug. |
| `GitCharm: Reset View Locations` | Runs VS Code's Reset View Locations, to clear stale GitCharm badge placement. |

### Log Panel

| Command | Description |
|:--|:--|
| `GitCharm: Focus Log Panel` | Focuses the Log Panel wherever it is set to open. |
| `GitCharm: Fetch and Refresh` | Fetches all remotes and reloads the Log. |
| `GitCharm: Refresh Log` | Reloads the Log without fetching. |
| `GitCharm: Compare Branches` / `Exit Compare Mode` | Shows only the commits one branch has and another doesn't, or goes back to the full Log. |
| `GitCharm: Clear Filters` | Clears every active Log filter. |
| `GitCharm: Show Filters` / `Hide Filters` | Shows or hides the Log filters bar. |
| `GitCharm: Show Branch Sidebar` / `Hide Branch Sidebar` | Shows or hides the branch and tag sidebar. |
| `GitCharm: Undock` | Undocks the Log Panel (with or without the Commit Panel) into an editor tab or a new window, for this session. |
| `GitCharm: Set Default Log Location` | Chooses — and remembers — where the Log Panel opens: bottom panel, editor tab, or a new window. |

### Files & Editor

| Command | Description |
|:--|:--|
| `GitCharm: Show File History` | Shows the Git history of the active file. |
| `GitCharm: Compare with...` | Diffs a file or folder against a chosen branch, tag, or commit. |
| `GitCharm: Open Git Annotations` / `Close Git Annotations` / `Toggle Git Annotations` | Shows or hides inline blame annotations in the active editor. |
| `GitCharm: Open Merge Editor` | Opens VS Code's merge editor for the active conflicted file. |

### Branches & Rebase

| Command | Description |
|:--|:--|
| `GitCharm: Interactive Rebase...` | Rebases the current branch interactively from a chosen commit or onto a branch. |

### Repositories, Submodules & Worktrees

| Command | Description |
|:--|:--|
| `GitCharm: Manage Hidden Repositories` | Reopens repositories previously hidden from the Commit Panel and Log Panel. |
| `GitCharm: Show Submodules` / `Hide Submodules` | Shows or hides Git submodules as repositories, per workspace. |
| `GitCharm: Initialize Submodule` | Initializes a submodule (`git submodule init`). |
| `GitCharm: Update Submodule` / `Update Submodule (Recursive)` | Updates a submodule, optionally with its nested submodules. |
| `GitCharm: Deinit Submodule` / `Force Deinit Submodule` | Deinitializes a submodule, optionally discarding its local changes. |
| `GitCharm: Open Submodule in New Window` | Opens a submodule in a new VS Code window. |
| `GitCharm: Add Worktree` | Creates a new worktree. |
| `GitCharm: Prune Worktrees` | Removes stale worktree entries. |

### Git Profiles

| Command | Description |
|:--|:--|
| `GitCharm: Manage Git Profiles` | Creates, edits, and deletes Git identity profiles, and sets the default. |
| `GitCharm: Switch Git Profile` | Switches the active Git profile for the current workspace. |

### Pull Requests & Issues

| Command | Description |
|:--|:--|
| `GitCharm: Manage Pull Request Credentials` | Opens the Cloud Integrations page of the settings, to add, rename and remove accounts. |
| `GitCharm: Refresh Pull Requests` | Refreshes the Pull Requests tab, bypassing the cache. |
| `GitCharm: Refresh Issues` | Refreshes the Issues tab, bypassing the cache. |
| `GitCharm: Reference an Issue in the Commit Message` | Searches the open issues of the connected repositories and inserts a reference to the chosen one into the commit message. |

## Keybindings

| Keybinding | macOS | Command |
|:--|:--|:--|
| `Ctrl+Alt+L` | `Cmd+Alt+L` | `GitCharm: Focus Log Panel` |
| `Ctrl+Alt+K` | `Cmd+Alt+K` | `GitCharm: Commit` |

## Settings

Every setting can also be changed from **GitCharm: Settings**, which groups them by category and previews their effect. Git profiles are not settings: they are stored by GitCharm and managed with **GitCharm: Manage Git Profiles**.

### Workflow

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.changesViewMode` | `simplified` | How changed files are shown: `simplified`, `changelists`, or `vscode`. Chosen on first install. |
| `gitcharm.defaultCommitAction` | `commit` | Main action of the commit button: `commit`, `commitAndPush` or `commitPushAndOpenPullRequest` (commit, push, then open the New Pull Request form on the pushed branch). |
| `gitcharm.defaultSaveAction` | `stash` | Main action of the Save button: `stash` or `shelve`. |
| `gitcharm.commitSignoff` | `false` | Add a Signed-off-by line to every commit (`git commit --signoff`). |
| `gitcharm.commitPanel.subjectMaxLength` | `0` | Warn when the commit message's first line is longer than this many characters (`0`: off). |
| `gitcharm.commitPanel.keepCommitMessage` | `false` | Keep the commit message in the Commit Panel after committing, to reuse it for the next commit. |
| `gitcharm.promptAddUntrackedToGit` | `true` | Offer to add new untracked files to Git. |
| `gitcharm.pullMode` | `ask` | How GitCharm pulls: `ask` (merge/rebase picker where offered, merge elsewhere), `merge`, `rebase` or `ffOnly`. |
| `gitcharm.fetchOnStartup` | `true` | Fetch all remotes when GitCharm activates. |
| `gitcharm.autoFetchInterval` | `0` | Fetch from every remote every this many minutes while VS Code is focused (`0`: off). New incoming commits are notified as at startup. |
| `gitcharm.fetchPrune` | `true` | Remove remote-tracking branches that no longer exist on the remote when fetching. |
| `gitcharm.autoRefreshInterval` | `0` | Auto-refresh interval in seconds. `0` disables interval refresh and uses file watchers only. |
| `gitcharm.branchNameModels` | `[]` | Branch name prefixes suggested when creating a branch (e.g. `feature/`, `bugfix/`). |
| `gitcharm.notifyOnIncomingCommits` | `true` | Notify on startup when there are incoming commits to pull. |
| `gitcharm.notifyOnUnpushedCommits` | `true` | Notify on startup when there are unpushed commits. |
| `gitcharm.notifyOnOrphanBranches` | `true` | Notify after a fetch when local branches have lost their remote branch. |
| `gitcharm.openCommitPanelOnConflictResolved` | `true` | Open the GitCharm sidebar when a merge conflict is resolved. |
| `gitcharm.suppressDivergedBranchWarning` | `false` | Suppress the "Branches have diverged" warning in the Git Menu and status bar. |

### Safety

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.protectedBranches` | `[]` | Branches GitCharm guards, e.g. `main` or `release/*` (`*` matches anything). Committing or pushing to one asks first; force-pushing to one is refused. |
| `gitcharm.confirm.discardChanges` | `true` | Ask before discarding changes or deleting files and folders from the Commit Panel. |
| `gitcharm.confirm.dropStashesAndShelves` | `true` | Ask before dropping a stash or deleting a shelf. |
| `gitcharm.confirm.commitOperations` | `true` | Ask before reverting, dropping or undoing commits. |
| `gitcharm.confirm.deleteBranches` | `true` | Ask before deleting a branch. |

### Commit Panel

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.commitPanel.showShelfTab` | `true` | Show the Shelf tab. |
| `gitcharm.commitPanel.showStashTab` | `true` | Show the Stash tab. |
| `gitcharm.commitPanel.showWorktreesTab` | `true` | Show the Worktrees tab. |
| `gitcharm.commitPanel.showPullRequestsTab` | `true` | Show the Pull Requests tab. |
| `gitcharm.commitPanel.showIssuesTab` | `true` | Show the Issues tab. |
| `gitcharm.commitPanel.showSyncTab` | `true` | Show the Sync tab (commits to push and to pull). |
| `gitcharm.commitPanel.tabOrder` | all tabs | The order of the tabs. Tabs left out of the list keep their place at the end; hidden tabs stay hidden. |
| `gitcharm.commitPanel.defaultTab` | `changes` | The tab the Commit Panel opens on: `changes`, `shelf`, `stash`, `worktrees`, `issues`, `pullRequests`, `sync`, or `lastUsed`. A hidden tab falls back to the first one. |
| `gitcharm.commitPanel.tabLabels` | `active` | Which tabs show their name next to the icon: `active`, `always` or `never`. When the tabs don't fit, only the active tab keeps its name, and the tabs that still don't fit move to a **More Tabs** (`⋯`) menu; in a very narrow panel the tabs become a dropdown. |
| `gitcharm.commitPanel.showChangesBadge` | `true` | Show the number of changed files on the Changes tab. |
| `gitcharm.commitPanel.showShelfBadge` | `false` | Show the number of shelved changes on the Shelf tab. |
| `gitcharm.commitPanel.showStashBadge` | `false` | Show the number of stashes on the Stash tab. |
| `gitcharm.commitPanel.showWorktreesBadge` | `false` | Show the number of linked worktrees on the Worktrees tab. |
| `gitcharm.commitPanel.showSyncBadge` | `true` | Show the number of commits to push and to pull on the Sync tab. |
| `gitcharm.commitPanel.showPullRequestsBadge` | `true` | Show the number of pull requests on the Pull Requests tab. |
| `gitcharm.commitPanel.showIssuesBadge` | `true` | Show the number of issues on the Issues tab. |
| `gitcharm.commitPanel.showActivityBarBadge` | `true` | Show the number of changed files on GitCharm's icon in the activity bar. |

### Log Panel

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.graphMaxCommits` | `1000` | Maximum number of commits loaded into the Log graph (100–10000). Filters still search the whole history. |
| `gitcharm.showUncommittedChangesInLog` | `true` | Show a row for uncommitted changes on top of the Log graph. |
| `gitcharm.gitLog.showAuthor` | `true` | Show the author's name in each commit row (when the list is wide enough). |
| `gitcharm.gitLog.showAuthorAvatar` | `true` | Show the author's avatar in each commit row. |
| `gitcharm.gitLog.showDate` | `true` | Show the commit date in each commit row. |
| `gitcharm.gitLog.showHash` | `true` | Show the short commit hash in each commit row. |
| `gitcharm.gitLog.showInlineBranches` | `true` | Show branch, tag and stash badges next to the commits they point to. |
| `gitcharm.gitLogDefaultLocation` | `panel` | Where `GitCharm: Focus Log Panel` opens the Log: `panel`, `editorTab`, or `newWindow`. Anything but `panel` also hides the Log view from the bottom panel. |
| `gitcharm.gitLogDefaultLayout` | `logAndCommit` | What the Log shows outside the bottom panel: `logAndCommit` or `logOnly`. Ignored when the location is `panel`. |

### Appearance

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.dateFormat` | `auto` | How dates are shown: `auto` (absolute in the Log Panel, relative elsewhere for recent dates), `absolute` or `relative`. Takes effect after reloading the window. |
| `gitcharm.projectColors` | `{}` | Maps workspace folder/repository names to hex colors for multi-repo views, e.g. `{ "my-repo": "#ff6b6b" }`. |
| `gitcharm.statusBar.showBranch` | `true` | Show the current branch (the Git Menu) in the status bar. |
| `gitcharm.statusBar.showProfile` | `true` | Show the Git profile in use in the status bar. |
| `gitcharm.showLastCommitInBranchMenu` | `false` | Show each branch's and tag's last commit in the branch and tag menus. |
| `gitcharm.gitAnnotations.enabled` | `true` | Enable inline Git blame annotations in the editor. |
| `gitcharm.gitGhostText.enabled` | `true` | Enable inline Git ghost text in the editor. |
| `gitcharm.avatars.enabled` | `true` | Show author avatars, taken from the forges: the repository's own GitHub, GitLab, Bitbucket or Gitea when it is connected, and GitHub, GitLab and Codeberg noreply addresses. No email address is sent to third parties. |
| `gitcharm.avatars.gravatar.enabled` | `false` | When no forge has an avatar for an author, look it up on Gravatar. **Privacy:** this sends a hash of the author's email to gravatar.com, which can reveal the address. Leave disabled for private or company repositories. |

### Repositories

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.repositoryScanMaxDepth` | `1` | Maximum depth of workspace subfolders to scan for Git repositories. `0` only checks workspace folders. |
| `gitcharm.repositoryScanIgnoredFolders` | `["node_modules"]` | Folder names or workspace-relative paths skipped while scanning for nested Git repositories. |
| `gitcharm.repositoryScanIncludedFolders` | `[]` | Workspace-relative folders whose repositories are always listed: the folder itself or its direct subfolders, even when the parent repository ignores them (`.gitignore`) or they sit deeper than `repositoryScanMaxDepth`. Since v0.8.1 the scan skips repositories in gitignored folders (build outputs, fetched dependencies); list here the ones kept there on purpose, e.g. `packages` for independent repositories under a gitignored `packages/*`. `repositoryScanIgnoredFolders` still wins. |
| `gitcharm.submoduleMaxDepth` | `5` | Maximum nesting depth of Git submodules shown as repositories. `1` only shows direct submodules, `0` none. In a workspace with more than 5 submodules they start hidden: a notification offers to show them, and **GitCharm: Show Submodules** / **Hide Submodules** switch it later, per workspace. |

### Pull Requests

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.pullRequests.defaultFilter` | `open` | The filter each repository's pull request list starts with: `open`, `mine`, `assignedToMe`, `reviewRequested` or `mentioningMe`. |
| `gitcharm.pullRequests.autoRefreshInterval` | `0` | Refresh the pull request list every this many minutes while its tab is open and VS Code is focused (`0`: off). |
| `gitcharm.pullRequests.hostProviderOverrides` | `{}` | Forge type per Git host, for self-hosted instances that can't be auto-detected, e.g. `{ "git.mycompany.com": "gitea" }`. Valid values: `github`, `gitlab`, `bitbucket`, `gitea`, `azure`. |
| `gitcharm.pullRequests.defaultTargetBranch` | `""` | Target branch for new pull requests when the repository's default branch can't be determined from the forge (empty: auto-detect `main`/`master`). |
| `gitcharm.pullRequests.defaultMergeStrategy` | `merge` | Strategy pre-selected on the Merge button: `merge`, `squash`, `rebase`, or `fastForward`. Falls back to the first strategy the forge supports. |
| `gitcharm.pullRequests.deleteBranchAfterMerge` | `ask` | What to do with a pull request's source branch after merging it from its detail panel: `ask` (local and remote preselected), `localAndRemote`, `remote`, `local` or `never`. The remote branch is deleted through the forge, never for a fork; the local one only when no commit would be lost. Protected and default branches are kept. |
| `gitcharm.pullRequests.defaultCheckoutAction` | `pr` | Main action of the Checkout button: `pr` (Checkout Pull Request) or `branch` (Checkout Branch). The other stays in its dropdown. |

### Issues

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.issues.defaultFilter` | `open` | The filter each repository's issue list starts with: `open`, `mine`, `assignedToMe` or `mentioningMe`. |
| `gitcharm.issues.autoRefreshInterval` | `0` | Refresh the issue list every this many minutes while its tab is open and VS Code is focused (`0`: off). |
| `gitcharm.issues.branchNameTemplate` | `{number}-{title}` | The name suggested for a branch created from an issue: `{number}`, `{title}` (lowercase, hyphenated) and `{user}` (your forge username), e.g. `feature/{number}-{title}`. |
| `gitcharm.issues.commitReferenceTemplate` | `#{number}` | The text inserted into the commit message when referencing an issue, e.g. `Fixes #{number}`. `{title}` is also available. |

### Experimental

| Setting | Default | Description |
|:--|:--|:--|
| `gitcharm.resetViewLocationsOnStartup` | `false` | Run VS Code's **Reset View Locations** on startup, to clear stale GitCharm badge placement. It resets view positions globally. |
