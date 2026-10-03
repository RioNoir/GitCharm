import * as l10n from '@vscode/l10n';

/** Previews drawn beside a category's settings, reacting to their current values (see previews.tsx). */
export type PreviewId = 'changesView' | 'gitLog' | 'repositories' | 'branches' | 'notifications' | 'editor';

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
];

/** Every `gitcharm.*` setting must be listed in exactly one category (except the API keys, kept in SecretStorage). */
export function getCategories(): CategoryDef[] {
  const workflow = l10n.t({ message: 'Workflow', comment: ['Settings page: sidebar heading'] });
  const views = l10n.t({ message: 'Views', comment: ['Settings page: sidebar heading'] });
  const integrations = l10n.t({ message: 'Integrations', comment: ['Settings page: sidebar heading'] });
  const advanced = l10n.t({ message: 'Advanced', comment: ['Settings page: sidebar heading'] });
  return [
    {
      id: 'commit', group: workflow, icon: 'git-commit', preview: 'changesView',
      label: l10n.t('Commit & Changes'),
      description: l10n.t('How the Commit Panel lists your changes and what its main buttons do.'),
      keys: ['changesViewMode', 'defaultCommitAction', 'defaultSaveAction', 'promptAddUntrackedToGit', 'openCommitPanelOnConflictResolved'],
    },
    {
      id: 'branches', group: workflow, icon: 'git-branch', preview: 'branches',
      label: l10n.t('Branches'),
      description: l10n.t('Name suggestions for new branches and what the branch menu shows.'),
      keys: ['branchNameModels', 'showLastCommitInBranchMenu', 'suppressDivergedBranchWarning'],
    },
    {
      id: 'sync', group: workflow, icon: 'sync', preview: 'notifications',
      label: l10n.t('Sync & Notifications'),
      description: l10n.t('When GitCharm fetches and refreshes, and what it tells you about.'),
      keys: ['fetchOnStartup', 'autoRefreshInterval', 'notifyOnIncomingCommits', 'notifyOnUnpushedCommits', 'notifyOnOrphanBranches'],
    },
    {
      id: 'gitLog', group: views, icon: 'history', preview: 'gitLog',
      label: l10n.t('Git Log'),
      description: l10n.t('Where the Git Log opens, its layout, and how much history it loads.'),
      keys: ['gitLogDefaultLocation', 'gitLogDefaultLayout', 'graphMaxCommits', 'showUncommittedChangesInLog'],
    },
    {
      id: 'repositories', group: views, icon: 'repo', preview: 'repositories',
      label: l10n.t('Repositories'),
      description: l10n.t('Which repositories and submodules GitCharm finds, and the color of each.'),
      keys: ['repositoryScanMaxDepth', 'repositoryScanIgnoredFolders', 'submoduleMaxDepth', 'projectColors'],
    },
    {
      id: 'editor', group: views, icon: 'code', preview: 'editor',
      label: l10n.t('Editor'),
      description: l10n.t('Blame information shown right inside your files.'),
      keys: ['gitAnnotations.enabled', 'gitGhostText.enabled', 'avatars.enabled'],
    },
    {
      id: 'ai', group: integrations, icon: 'sparkle', custom: 'ai',
      label: l10n.t('AI'),
      description: l10n.t('Pick the model that writes commit messages and pull requests, and explains changes.'),
      keys: [
        'ai.enabled', 'ai.provider', 'ai.modelId', 'ai.claudeModel', 'ai.claudePath', 'ai.openaiModel', 'ai.geminiModel',
        'ai.geminiPath', 'ai.codexModel', 'ai.codexPath', 'ai.ollamaModel', 'ai.ollamaUrl', 'ai.lmStudioModel', 'ai.lmStudioUrl',
        'ai.language', 'ai.maxDiffChars', 'ai.operationModels', 'ai.offerConflictResolution',
      ],
    },
    {
      id: 'aiPrompts', group: integrations, icon: 'note', custom: 'aiPrompts',
      label: l10n.t('AI Prompts'),
      description: l10n.t('The instructions sent to the model. The changes themselves are always added after them.'),
      keys: AI_PROMPT_KEYS,
    },
    {
      id: 'integrations', group: integrations, icon: 'plug', custom: 'integrations',
      label: l10n.t('Cloud Integrations'),
      description: l10n.t('Connect GitHub, GitLab, Bitbucket and Gitea accounts, and choose the account each repository uses.'),
      keys: ['pullRequests.hostProviderOverrides'],
    },
    {
      id: 'pullRequests', group: integrations, icon: 'git-pull-request',
      label: l10n.t('Pull Requests'),
      description: l10n.t('Defaults for creating, merging and checking out pull requests.'),
      keys: ['pullRequests.defaultTargetBranch', 'pullRequests.defaultMergeStrategy', 'pullRequests.defaultCheckoutAction'],
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
    case 'repositoryScanMaxDepth': return l10n.t('Repository scan depth');
    case 'repositoryScanIgnoredFolders': return l10n.t('Folders ignored by the scan');
    case 'submoduleMaxDepth': return l10n.t('Submodule depth');
    case 'projectColors': return l10n.t('Repository colors');
    case 'gitAnnotations.enabled': return l10n.t('Git annotations');
    case 'gitGhostText.enabled': return l10n.t('Inline blame (ghost text)');
    case 'avatars.enabled': return l10n.t('Author avatars');
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
