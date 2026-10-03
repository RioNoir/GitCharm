import * as vscode from 'vscode';
import type { CommitPanelConfig, CommitPanelTabId } from '../types/messages';

/** Tab names as the settings spell them (tabOrder, defaultTab), and the panel's own ids. */
const SETTING_TO_TAB: Record<string, CommitPanelTabId> = {
  changes: 'changes',
  shelf: 'shelf',
  stash: 'stash',
  worktrees: 'worktree',
  pullRequests: 'pullrequests',
  issues: 'issues',
  sync: 'push',
};

const DEFAULT_ORDER: CommitPanelTabId[] = ['changes', 'shelf', 'stash', 'worktree', 'issues', 'pullrequests', 'push'];

/** The `show*Tab` setting of each tab that can be hidden. */
const SHOW_SETTING: Partial<Record<CommitPanelTabId, string>> = {
  shelf: 'showShelfTab',
  stash: 'showStashTab',
  worktree: 'showWorktreesTab',
  pullrequests: 'showPullRequestsTab',
  issues: 'showIssuesTab',
  push: 'showSyncTab',
};

export function isCommitPanelTabShown(tab: CommitPanelTabId): boolean {
  const setting = SHOW_SETTING[tab];
  return !setting || vscode.workspace.getConfiguration('gitcharm.commitPanel').get<boolean>(setting, true);
}

/** The tabs in the configured order: unknown names are dropped, and tabs left out of the list keep their default place at the end. */
function orderedTabs(): CommitPanelTabId[] {
  const configured = vscode.workspace.getConfiguration('gitcharm.commitPanel').get<string[]>('tabOrder', []);
  const order: CommitPanelTabId[] = [];
  for (const name of Array.isArray(configured) ? configured : []) {
    const tab = SETTING_TO_TAB[name];
    if (tab && !order.includes(tab)) order.push(tab);
  }
  for (const tab of DEFAULT_ORDER) if (!order.includes(tab)) order.push(tab);
  return order;
}

/** `lastTab`: the tab the panel was last left on in this workspace, for the "last used" default. */
export function getCommitPanelConfig(lastTab: CommitPanelTabId | undefined): CommitPanelConfig {
  const cfg = vscode.workspace.getConfiguration('gitcharm.commitPanel');
  const tabs = orderedTabs().filter(isCommitPanelTabShown);
  const defaultTab = cfg.get<string>('defaultTab', 'changes');
  const wanted = defaultTab === 'lastUsed' ? lastTab : SETTING_TO_TAB[defaultTab];
  const labels = cfg.get<string>('tabLabels', 'active');
  return {
    tabs,
    initialTab: wanted && tabs.includes(wanted) ? wanted : 'changes',
    labels: labels === 'always' || labels === 'never' ? labels : 'active',
    badges: {
      changes: cfg.get<boolean>('showChangesBadge', true),
      shelf: cfg.get<boolean>('showShelfBadge', false),
      stash: cfg.get<boolean>('showStashBadge', false),
      worktree: cfg.get<boolean>('showWorktreesBadge', false),
      pullrequests: cfg.get<boolean>('showPullRequestsBadge', true),
      issues: cfg.get<boolean>('showIssuesBadge', true),
      push: cfg.get<boolean>('showSyncBadge', true),
    },
    subjectMaxLength: Math.max(0, cfg.get<number>('subjectMaxLength', 0)),
  };
}
