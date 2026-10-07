import * as l10n from '@vscode/l10n';

/** Previews drawn beside a category's settings, reacting to their current values (see previews.tsx). */
export type PreviewId = 'changesView' | 'gitLog' | 'appearance' | 'discovery' | 'branches' | 'sync' | 'notifications' | 'editor';

export interface CategoryDef {
  id: string;
  label: string;
  icon: string;
  description: string;
  /** Sidebar heading this category is listed under. */
  group: string;
  keys: string[];
  preview?: PreviewId;
  /** Categories whose body isn't the plain list of settings. */
  custom?: 'ai' | 'aiPrompts' | 'integrations';
}

export const AI_PROMPT_KEYS = [
  'ai.prompts.commitMessage',
  'ai.prompts.pullRequestTitle',
  'ai.prompts.pullRequestDescription',
  'ai.prompts.explainCommit',
  'ai.prompts.explainPullRequest',
  'ai.prompts.resolveConflicts',
  'ai.prompts.issueBranchName',
  'ai.prompts.explainIssue',
  'ai.prompts.resolveIssue',
];

/** Every `gitcharm.*` setting must be listed in exactly one category (except the API keys, kept in SecretStorage). */
export function getCategories(): CategoryDef[] {
  const workflow = l10n.t({ message: 'Workflow', comment: ['Settings page: sidebar heading'] });
  const views = l10n.t({ message: 'Views', comment: ['Settings page: sidebar heading'] });
  const ai = l10n.t({ message: 'AI', comment: ['Settings page: sidebar heading'] });
  const integrations = l10n.t({ message: 'Integrations', comment: ['Settings page: sidebar heading'] });
  const advanced = l10n.t({ message: 'Advanced', comment: ['Settings page: sidebar heading'] });
  return [
    {
      id: 'branches', group: workflow, icon: 'git-branch', preview: 'branches',
      label: l10n.t('Branches'),
      description: l10n.t('Name suggestions for new branches and what the branch menu shows.'),
      keys: ['branchNameModels', 'showLastCommitInBranchMenu', 'suppressDivergedBranchWarning'],
    },
    {
      id: 'pullRequests', group: workflow, icon: 'git-pull-request',
      label: l10n.t('Pull Requests'),
      description: l10n.t('Defaults for creating, merging and checking out pull requests, and how the list is filtered and refreshed.'),
      keys: [
        'pullRequests.defaultTargetBranch', 'pullRequests.defaultMergeStrategy', 'pullRequests.defaultCheckoutAction',
        'pullRequests.defaultFilter', 'pullRequests.autoRefreshInterval',
      ],
    },
    {
      id: 'issues', group: workflow, icon: 'issues',
      label: l10n.t('Issues'),
      description: l10n.t('How the issue list is filtered and refreshed, and how branches and commit messages refer to an issue.'),
      keys: ['issues.defaultFilter', 'issues.autoRefreshInterval', 'issues.branchNameTemplate', 'issues.commitReferenceTemplate'],
    },
    {
      id: 'sync', group: workflow, icon: 'sync', preview: 'sync',
      label: l10n.t('Sync'),
      description: l10n.t('When GitCharm fetches from the remotes, how it pulls, and when it refreshes its views.'),
      keys: ['fetchOnStartup', 'autoFetchInterval', 'fetchPrune', 'pullMode', 'autoRefreshInterval'],
    },
    {
      id: 'safety', group: workflow, icon: 'shield',
      label: l10n.t('Safety'),
      description: l10n.t('Branches to guard, and which destructive actions ask for confirmation first.'),
      keys: ['protectedBranches', 'confirm.discardChanges', 'confirm.dropStashesAndShelves', 'confirm.commitOperations', 'confirm.deleteBranches'],
    },
    {
      id: 'notifications', group: workflow, icon: 'bell', preview: 'notifications',
      label: l10n.t('Notifications'),
      description: l10n.t('What GitCharm tells you about with a notification.'),
      keys: ['notifyOnIncomingCommits', 'notifyOnUnpushedCommits', 'notifyOnOrphanBranches', 'promptAddUntrackedToGit'],
    },
    {
      id: 'commitPanel', group: views, icon: 'gitcharm-commit', preview: 'changesView',
      label: l10n.t('Commit Panel'),
      description: l10n.t('How the Commit Panel lists your changes, what its main buttons do, and which tabs it shows.'),
      keys: [
        'changesViewMode', 'defaultCommitAction', 'defaultSaveAction', 'openCommitPanelOnConflictResolved',
        'commitSignoff', 'commitPanel.subjectMaxLength',
        'commitPanel.showShelfTab', 'commitPanel.showStashTab', 'commitPanel.showWorktreesTab', 'commitPanel.showPullRequestsTab', 'commitPanel.showIssuesTab',
        'commitPanel.showSyncTab', 'commitPanel.tabOrder', 'commitPanel.defaultTab', 'commitPanel.tabLabels',
        'commitPanel.showChangesBadge', 'commitPanel.showShelfBadge', 'commitPanel.showStashBadge', 'commitPanel.showWorktreesBadge',
        'commitPanel.showPullRequestsBadge', 'commitPanel.showIssuesBadge', 'commitPanel.showSyncBadge', 'commitPanel.showActivityBarBadge',
      ],
    },
    {
      id: 'gitLog', group: views, icon: 'gitcharm-log', preview: 'gitLog',
      label: l10n.t('Log Panel'),
      description: l10n.t('Where the Log Panel opens, its layout, and how much history it loads.'),
      keys: [
        'gitLogDefaultLocation', 'gitLogDefaultLayout', 'graphMaxCommits', 'showUncommittedChangesInLog',
        'gitLog.showAuthor', 'gitLog.showAuthorAvatar', 'gitLog.showDate', 'gitLog.showHash', 'gitLog.showInlineBranches',
      ],
    },
    {
      id: 'editor', group: views, icon: 'code', preview: 'editor',
      label: l10n.t('Editor'),
      description: l10n.t('Blame information shown right inside your files.'),
      keys: ['gitAnnotations.enabled', 'gitGhostText.enabled'],
    },
    {
      id: 'appearance', group: views, icon: 'symbol-color', preview: 'appearance',
      label: l10n.t('Appearance'),
      description: l10n.t('How GitCharm shows dates and commit authors, tells repositories apart, and what it puts in the status bar.'),
      keys: ['dateFormat', 'avatars.enabled', 'avatars.gravatar.enabled', 'projectColors', 'statusBar.showBranch', 'statusBar.showProfile'],
    },
    {
      id: 'ai', group: ai, icon: 'sparkle', custom: 'ai',
      label: l10n.t('AI'),
      description: l10n.t('Pick the model that writes commit messages and pull requests, explains changes, and works on issues.'),
      keys: [
        'ai.enabled', 'ai.provider', 'ai.modelId', 'ai.claudeModel', 'ai.claudePath', 'ai.openaiModel', 'ai.geminiModel',
        'ai.geminiPath', 'ai.codexModel', 'ai.codexPath', 'ai.ollamaModel', 'ai.ollamaUrl', 'ai.lmStudioModel', 'ai.lmStudioUrl',
        'ai.language', 'ai.maxDiffChars', 'ai.operationModels', 'ai.offerConflictResolution',
      ],
    },
    {
      id: 'aiPrompts', group: ai, icon: 'note', custom: 'aiPrompts',
      label: l10n.t('AI Prompts'),
      description: l10n.t('The instructions sent to the model. The changes themselves are always added after them.'),
      keys: AI_PROMPT_KEYS,
    },
    {
      id: 'integrations', group: integrations, icon: 'plug', custom: 'integrations',
      label: l10n.t('Cloud Integrations'),
      description: l10n.t('Connect GitHub, GitLab, Bitbucket, Gitea and Azure DevOps accounts, and choose the account each repository uses.'),
      keys: ['pullRequests.hostProviderOverrides'],
    },
    {
      id: 'discovery', group: advanced, icon: 'search', preview: 'discovery',
      label: l10n.t('Repository Discovery'),
      description: l10n.t('Which repositories and submodules GitCharm finds in the workspace.'),
      keys: ['repositoryScanMaxDepth', 'repositoryScanIgnoredFolders', 'repositoryScanRespectGitignore', 'submoduleMaxDepth'],
    },
    {
      id: 'experimental', group: advanced, icon: 'beaker',
      label: l10n.t('Experimental'),
      description: l10n.t('Settings that may change or go away.'),
      keys: ['resetViewLocationsOnStartup'],
    },
  ];
}

/** Short titles: package.json only has descriptions, and VS Code's own titles are derived from the key. */
export function settingLabel(key: string): string {
  switch (key) {
    case 'changesViewMode': return l10n.t('Changes view');
    case 'defaultCommitAction': return l10n.t('Default commit action');
    case 'defaultSaveAction': return l10n.t('Default save action');
    case 'promptAddUntrackedToGit': return l10n.t('Ask to add new files to Git');
    case 'openCommitPanelOnConflictResolved': return l10n.t('Open the Commit Panel when conflicts are resolved');
    case 'branchNameModels': return l10n.t('Branch name prefixes');
    case 'showLastCommitInBranchMenu': return l10n.t('Show the last commit in the branch menu');
    case 'suppressDivergedBranchWarning': return l10n.t('Hide the diverged branch warning');
    case 'fetchOnStartup': return l10n.t('Fetch on startup');
    case 'autoRefreshInterval': return l10n.t('Auto-refresh interval');
    case 'notifyOnIncomingCommits': return l10n.t('Incoming commits');
    case 'notifyOnUnpushedCommits': return l10n.t('Unpushed commits');
    case 'notifyOnOrphanBranches': return l10n.t('Orphan branches');
    case 'gitLogDefaultLocation': return l10n.t('Default location');
    case 'gitLogDefaultLayout': return l10n.t('Default layout');
    case 'graphMaxCommits': return l10n.t('Maximum commits');
    case 'showUncommittedChangesInLog': return l10n.t('Show uncommitted changes');
    case 'commitPanel.showShelfTab': return l10n.t('Show Shelf tab');
    case 'commitPanel.showStashTab': return l10n.t('Show Stash tab');
    case 'commitPanel.showWorktreesTab': return l10n.t('Show Worktrees tab');
    case 'commitPanel.showPullRequestsTab': return l10n.t('Show Pull Requests tab');
    case 'commitPanel.showIssuesTab': return l10n.t('Show Issues tab');
    case 'commitPanel.showSyncTab': return l10n.t('Show Sync tab');
    case 'commitPanel.tabOrder': return l10n.t('Tab order');
    case 'commitSignoff': return l10n.t('Sign off commits');
    case 'commitPanel.subjectMaxLength': return l10n.t('Commit title length');
    case 'protectedBranches': return l10n.t('Protected branches');
    case 'confirm.discardChanges': return l10n.t('Confirm discarding changes');
    case 'confirm.dropStashesAndShelves': return l10n.t('Confirm dropping stashes and shelves');
    case 'confirm.commitOperations': return l10n.t('Confirm reverting, dropping and undoing commits');
    case 'confirm.deleteBranches': return l10n.t('Confirm deleting branches');
    case 'autoFetchInterval': return l10n.t('Periodic fetch (minutes)');
    case 'fetchPrune': return l10n.t('Prune on fetch');
    case 'pullMode': return l10n.t('Pull mode');
    case 'dateFormat': return l10n.t('Date format');
    case 'statusBar.showBranch': return l10n.t('Branch in the status bar');
    case 'statusBar.showProfile': return l10n.t('Git profile in the status bar');
    case 'pullRequests.defaultFilter': return l10n.t('Default filter');
    case 'pullRequests.autoRefreshInterval': return l10n.t('Auto-refresh (minutes)');
    case 'commitPanel.defaultTab': return l10n.t('Default tab');
    case 'commitPanel.tabLabels': return l10n.t('Tab names');
    case 'commitPanel.showChangesBadge': return l10n.t('Changes badge');
    case 'commitPanel.showSyncBadge': return l10n.t('Sync badge');
    case 'commitPanel.showShelfBadge': return l10n.t('Shelf badge');
    case 'commitPanel.showStashBadge': return l10n.t('Stash badge');
    case 'commitPanel.showWorktreesBadge': return l10n.t('Worktrees badge');
    case 'commitPanel.showPullRequestsBadge': return l10n.t('Pull Requests badge');
    case 'commitPanel.showIssuesBadge': return l10n.t('Issues badge');
    case 'issues.defaultFilter': return l10n.t('Default filter');
    case 'issues.autoRefreshInterval': return l10n.t('Auto-refresh (minutes)');
    case 'issues.branchNameTemplate': return l10n.t('Branch name for an issue');
    case 'issues.commitReferenceTemplate': return l10n.t('Issue reference in commit messages');
    case 'commitPanel.showActivityBarBadge': return l10n.t('Activity bar badge');
    case 'gitLog.showAuthor': return l10n.t('Show author');
    case 'gitLog.showAuthorAvatar': return l10n.t('Show author avatar');
    case 'gitLog.showDate': return l10n.t('Show date');
    case 'gitLog.showHash': return l10n.t('Show hash');
    case 'gitLog.showInlineBranches': return l10n.t('Show inline branches');
    case 'repositoryScanMaxDepth': return l10n.t('Repository scan depth');
    case 'repositoryScanIgnoredFolders': return l10n.t('Folders ignored by the scan');
    case 'repositoryScanRespectGitignore': return l10n.t('Skip gitignored repositories');
    case 'submoduleMaxDepth': return l10n.t('Submodule depth');
    case 'projectColors': return l10n.t('Repository colors');
    case 'gitAnnotations.enabled': return l10n.t('Git annotations');
    case 'gitGhostText.enabled': return l10n.t('Inline blame (ghost text)');
    case 'avatars.enabled': return l10n.t('Author avatars');
    case 'avatars.gravatar.enabled': return l10n.t('Gravatar as fallback');
    case 'ai.enabled': return l10n.t('AI features');
    case 'ai.language': return l10n.t('Language');
    case 'ai.provider': return l10n.t('Provider');
    case 'ai.modelId':
    case 'ai.claudeModel':
    case 'ai.openaiModel':
    case 'ai.geminiModel':
    case 'ai.codexModel':
    case 'ai.ollamaModel':
    case 'ai.lmStudioModel': return l10n.t('Model');
    case 'ai.claudePath':
    case 'ai.geminiPath':
    case 'ai.codexPath': return l10n.t('Executable path');
    case 'ai.ollamaUrl':
    case 'ai.lmStudioUrl': return l10n.t('Server URL');
    case 'ai.maxDiffChars': return l10n.t('Maximum diff size');
    case 'ai.operationModels': return l10n.t('Models per operation');
    case 'ai.offerConflictResolution': return l10n.t('Offer to resolve conflicts');
    case 'ai.prompts.resolveConflicts': return l10n.t('Resolve conflicts');
    case 'ai.prompts.issueBranchName': return l10n.t('Issue branch name');
    case 'ai.prompts.explainIssue': return l10n.t('Explain issue');
    case 'ai.prompts.resolveIssue': return l10n.t('Resolve issue');
    case 'ai.prompts.commitMessage': return l10n.t('Commit message');
    case 'ai.prompts.pullRequestTitle': return l10n.t('Pull request title');
    case 'ai.prompts.pullRequestDescription': return l10n.t('Pull request description');
    case 'ai.prompts.explainCommit': return l10n.t('Explain commit');
    case 'ai.prompts.explainPullRequest': return l10n.t('Explain pull request');
    case 'pullRequests.defaultTargetBranch': return l10n.t('Default target branch');
    case 'pullRequests.defaultMergeStrategy': return l10n.t('Default merge strategy');
    case 'pullRequests.defaultCheckoutAction': return l10n.t('Default checkout action');
    case 'pullRequests.hostProviderOverrides': return l10n.t('Self-hosted forges');
    case 'resetViewLocationsOnStartup': return l10n.t('Reset view locations on startup');
    default: return key;
  }
}

/** Titles for enum options; the longer explanation comes from package.json's enumDescriptions. */
export function enumLabel(key: string, value: string): string {
  switch (`${key}=${value}`) {
    case 'changesViewMode=simplified': return l10n.t('Simplified');
    case 'changesViewMode=changelists': return l10n.t('Changelists');
    case 'changesViewMode=vscode': return 'VS Code';
    case 'defaultCommitAction=commit': return 'Commit';
    case 'defaultCommitAction=commitAndPush': return 'Commit and Push';
    case 'defaultSaveAction=stash': return 'Stash';
    case 'defaultSaveAction=shelve': return 'Shelve';
    case 'commitPanel.defaultTab=changes': return l10n.t({ message: 'Changes', comment: ['Tab title: list of changed files'] });
    case 'commitPanel.defaultTab=shelf': return l10n.t('Shelf');
    case 'commitPanel.defaultTab=stash': return l10n.t({ message: 'Stash', comment: ['Tab title: list of git stashes'] });
    case 'commitPanel.defaultTab=worktrees': return l10n.t('Worktrees');
    case 'commitPanel.defaultTab=pullRequests': return l10n.t('Pull Requests');
    case 'commitPanel.defaultTab=issues': return l10n.t('Issues');
    case 'commitPanel.defaultTab=sync': return l10n.t({ message: 'Sync', comment: ['Tab title: remote operations — commits to push and to pull'] });
    case 'commitPanel.defaultTab=lastUsed': return l10n.t('Last used');
    case 'commitPanel.tabLabels=active': return l10n.t('Active tab');
    case 'pullMode=ask': return l10n.t('Ask');
    case 'pullMode=merge': return 'Merge';
    case 'pullMode=rebase': return 'Rebase';
    case 'pullMode=ffOnly': return l10n.t('Fast-forward only');
    case 'dateFormat=auto': return l10n.t('Automatic');
    case 'dateFormat=absolute': return l10n.t('Absolute');
    case 'dateFormat=relative': return l10n.t('Relative');
    case 'pullRequests.defaultFilter=open': return l10n.t('All open');
    case 'pullRequests.defaultFilter=mine': return l10n.t('Created by me');
    case 'pullRequests.defaultFilter=assignedToMe': return l10n.t('Assigned to me');
    case 'pullRequests.defaultFilter=reviewRequested': return l10n.t('Awaiting my review');
    case 'pullRequests.defaultFilter=mentioningMe': return l10n.t('Mentioning me');
    case 'issues.defaultFilter=open': return l10n.t('All open');
    case 'issues.defaultFilter=mine': return l10n.t('Created by me');
    case 'issues.defaultFilter=assignedToMe': return l10n.t('Assigned to me');
    case 'issues.defaultFilter=mentioningMe': return l10n.t('Mentioning me');
    case 'commitPanel.tabLabels=always': return l10n.t('All tabs');
    case 'commitPanel.tabLabels=never': return l10n.t('Icons only');
    case 'gitLogDefaultLocation=panel': return l10n.t('Bottom panel');
    case 'gitLogDefaultLocation=editorTab': return l10n.t('Editor tab');
    case 'gitLogDefaultLocation=newWindow': return l10n.t('New window');
    case 'gitLogDefaultLayout=logAndCommit': return l10n.t('Log and commit details');
    case 'gitLogDefaultLayout=logOnly': return l10n.t('Log only');
    case 'pullRequests.defaultMergeStrategy=merge': return 'Merge';
    case 'pullRequests.defaultMergeStrategy=squash': return 'Squash';
    case 'pullRequests.defaultMergeStrategy=rebase': return 'Rebase';
    case 'pullRequests.defaultMergeStrategy=fastForward': return 'Fast-forward';
    case 'pullRequests.defaultCheckoutAction=pr': return 'Checkout Pull Request';
    case 'pullRequests.defaultCheckoutAction=branch': return 'Checkout Branch';
    case 'ai.provider=vscode-lm': return 'VS Code LM';
    case 'ai.provider=claude-api': return 'Claude API';
    case 'ai.provider=openai-api': return 'OpenAI API';
    case 'ai.provider=gemini-api': return 'Gemini API';
    case 'ai.provider=claude-cli': return 'Claude CLI';
    case 'ai.provider=codex-cli': return 'Codex CLI';
    case 'ai.provider=gemini-cli': return 'Gemini CLI';
    case 'ai.provider=ollama': return 'Ollama';
    case 'ai.provider=lmstudio': return 'LM Studio';
    default: return value;
  }
}
