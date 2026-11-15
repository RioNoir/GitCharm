import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import type { GitProfileService } from '../git/GitProfileService';
import type { BranchInfo, RepoMeta } from '../types/git';
import type { PullRequestManager } from '../pullRequests/PullRequestManager';
import type { IssueManager } from '../issues/IssueManager';
import type { MergeStrategy, PullRequestStateFilter } from '../pullRequests/types';
import type { IssueStateFilter } from '../issues/types';
import { resolveCommitCredentials } from '../git/commitCredentials';
import { cleanUpAfterMerge, type BranchCleanupChoice } from '../pullRequests/deleteBranchAfterMerge';
import { formatGitError } from '../utils/gitErrorUtils';
import { logInfo } from '../utils/Logger';
import { bool, num, reqStr, str, strList, ToolError, truncate, type CallContext, type InputSchema, type Tool, type ToolKind, type ToolResult } from './protocol';

export interface ToolDeps {
  manager: WorkspaceGitManager;
  profileService: GitProfileService;
  pullRequestManager: PullRequestManager;
  issueManager: IssueManager;
}

type Confirmation = 'risky' | 'allWrites' | 'never';

const REPOSITORY = {
  repository: {
    type: 'string',
    description: 'Repository name, path or id, as list_repositories returns them. Optional: defaults to the repository containing the agent\'s working folder, or to the only one.',
  },
};
const MAX_CHARS = { max_chars: { type: 'number', description: 'Cut the diff after this many characters (default 20000).' } };

const json = (value: unknown): ToolResult => ({ text: JSON.stringify(value) });

/** GitCharm's MCP tools, working on the repositories of this VS Code window. */
export function createTools(deps: ToolDeps): Tool[] {
  const { manager, pullRequestManager, issueManager } = deps;

  const tool = (
    name: string, title: string, kind: ToolKind, description: string,
    properties: InputSchema['properties'], required: string[],
    run: (args: Record<string, unknown>, ctx: CallContext) => Promise<ToolResult>,
  ): Tool => ({
    name, title, kind, description,
    inputSchema: { type: 'object', properties: { ...REPOSITORY, ...properties }, required, additionalProperties: false },
    run: async (args, ctx) => {
      if (kind !== 'read') logInfo('mcp', `${ctx.clientName}: ${name} ${JSON.stringify(args)}`);
      try {
        return await run(args, ctx);
      } catch (e: unknown) {
        if (e instanceof ToolError) throw e;
        // A git failure (a conflict, a rejected push) is something the agent can act on.
        throw new ToolError(formatGitError(e));
      }
    },
  });

  /** The repository a call is about: named, else the one containing the agent's folder, else the only one. */
  const resolve = (args: Record<string, unknown>, ctx: CallContext): { meta: RepoMeta; repo: GitService } => {
    const metas = manager.getRepoMetas();
    const wanted = str(args, 'repository');
    let meta: RepoMeta | undefined;
    if (wanted) {
      const asPath = path.resolve(ctx.cwd ?? '', wanted);
      meta = metas.find(m => m.id === wanted || samePath(m.rootPath, asPath))
        ?? metas.find(m => m.name.toLowerCase() === wanted.toLowerCase());
      if (!meta) throw new ToolError(`No repository "${wanted}" in this VS Code window. Repositories: ${metas.map(m => m.name).join(', ') || 'none'}`);
    } else if (ctx.cwd) {
      meta = metas.filter(m => inside(m.rootPath, ctx.cwd!)).sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    }
    if (!meta && !wanted && metas.length === 1) meta = metas[0];
    if (!meta) throw new ToolError(`Name the repository: this VS Code window has ${metas.map(m => m.name).join(', ') || 'none'}`);
    const repo = manager.getRepo(meta.id);
    if (!repo) throw new ToolError(`Repository "${meta.name}" is not available`);
    return { meta, repo };
  };

  /** Asks in VS Code before a write, as gitcharm.mcp.confirmation says: risky ones only (default), every write, or none. */
  const confirm = async (kind: ToolKind, message: string, detail?: string) => {
    const policy = vscode.workspace.getConfiguration('gitcharm.mcp').get<Confirmation>('confirmation', 'risky');
    if (kind === 'read' || policy === 'never' || (policy === 'risky' && kind !== 'risky')) return;
    const allow = vscode.l10n.t('Allow');
    const picked = await vscode.window.showWarningMessage(message, { modal: true, detail }, allow);
    if (picked !== allow) throw new ToolError('The user declined this action in VS Code.');
  };

  const commitCredentials = async (repo: GitService) => {
    const { credentials, noIdentity } = await resolveCommitCredentials(manager, deps.profileService, repo.rootPath);
    if (noIdentity) throw new ToolError('No Git identity is configured: set a Git profile in GitCharm (or user.name and user.email) first.');
    return credentials;
  };

  /** A forge answer, or its error as a tool error — `notFound` names what a 404 means instead of the raw answer. */
  const forge = <T>(result: T | { error: string }, notFound?: string): T => {
    if (result && typeof result === 'object' && 'error' in result && typeof (result as { error: unknown }).error === 'string') {
      const error = (result as { error: string }).error;
      throw new ToolError(notFound && /\b404\b|not found/i.test(error) ? notFound : error);
    }
    return result as T;
  };

  const actionResult = (result: { ok: boolean; error?: string }) => {
    if (!result.ok) throw new ToolError(result.error ?? 'The forge refused the action');
  };

  const refreshed = () => { void manager.getAllStatusesFresh(); };

  return [
    // ── Git: read ────────────────────────────────────────────────────────────────────────────────────────────
    tool('list_repositories', 'List repositories', 'read',
      'The Git repositories open in this VS Code window, with their current branch and how many changes each has.',
      {}, [], async () => {
        const metas = manager.getRepoMetas();
        const statuses = await Promise.all(metas.map(m => manager.getRepo(m.id)?.getStatus().catch(() => undefined)));
        return json(metas.map((m, i) => {
          const s = statuses[i];
          return {
            name: m.name, path: m.rootPath, id: m.id,
            ...(m.isSubmodule ? { submodule: true } : {}), ...(m.isWorktree ? { worktree: true } : {}),
            branch: s?.branch.name, upstream: s?.branch.upstream, ...(s ? tracked(s.branch) : {}),
            staged: s?.stagedFiles.length, unstaged: s?.unstagedFiles.length, conflicts: s?.conflictCount, inProgress: s?.mergeRebaseState,
          };
        }));
      }),

    tool('get_status', 'Get status', 'read',
      'Branch, upstream, and the staged and unstaged files of a repository, as in GitCharm\'s Commit Panel.',
      {}, [], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const s = await repo.getStatusFresh();
        const files = (list: typeof s.stagedFiles) => list.map(f => ({ path: f.path, status: f.status, ...(f.oldPath ? { from: f.oldPath } : {}) }));
        return json({
          repository: meta.name, branch: s.branch.name, detached: s.isDetachedHead || undefined, upstream: s.branch.upstream,
          ...tracked(s.branch), inProgress: s.mergeRebaseState, conflicts: s.conflictCount,
          staged: files(s.stagedFiles), unstaged: files(s.unstagedFiles),
        });
      }),

    tool('get_log', 'Get history', 'read',
      'Commits of a repository, newest first: of the current branch, a given branch, or a file. Filter by author or message text.',
      {
        limit: { type: 'number', description: 'How many commits (default 30, at most 200).' },
        skip: { type: 'number', description: 'Commits to skip, to page.' },
        branch: { type: 'string', description: 'Branch or ref to list instead of the current branch.' },
        author: { type: 'string', description: 'Only commits by this author (name or email).' },
        text: { type: 'string', description: 'Only commits whose message contains this.' },
        path: { type: 'string', description: 'Only commits changing this file (follows renames).' },
      }, [], async (args, ctx) => {
        const { repo } = resolve(args, ctx);
        const limit = num(args, 'limit', 30, 200);
        const skip = num(args, 'skip', 0);
        const file = str(args, 'path');
        if (file) {
          const history = await repo.getFileHistory(file, limit + skip);
          return json(history.slice(skip).map(c => ({ hash: c.hash, date: c.authorDate, author: c.authorName, subject: c.message, change: c.status, ...(c.oldPath ? { from: c.oldPath } : {}) })));
        }
        const log = await repo.getLog(limit, skip, { filterBranch: str(args, 'branch'), filterAuthor: str(args, 'author'), filterText: str(args, 'text') });
        return json(log.filter(c => !c.isStash).map(c => ({
          hash: c.hash, date: c.authorDate, author: c.authorName, subject: c.message.split('\n')[0],
          ...(c.refs.length ? { refs: c.refs } : {}), ...(c.parents.length > 1 ? { merge: true } : {}), ...(c.unpushed ? { unpushed: true } : {}),
        })));
      }),

    tool('get_commit', 'Get commit', 'read',
      'A commit\'s full message, author, changed files and diff.',
      { commit: { type: 'string', description: 'Commit hash or ref.' }, include_diff: { type: 'boolean', description: 'Include the diff (default true).' }, ...MAX_CHARS },
      ['commit'], async (args, ctx) => {
        const { repo } = resolve(args, ctx);
        const hash = await repo.resolveRef(reqStr(args, 'commit')).catch(() => { throw new ToolError(`Unknown commit ${String(args.commit)}`); });
        const [meta, message, files] = await Promise.all([repo.getCommitMeta(hash), repo.getFullCommitMessage(hash), repo.getCommitFiles(hash)]);
        const diff = bool(args, 'include_diff', true) ? await repo.getCommitDiff(hash, num(args, 'max_chars', 20000, 200000), false) : undefined;
        return json({ hash, author: `${meta.authorName} <${meta.authorEmail}>`, date: meta.authorDate, message: message.trim(), files, ...(diff !== undefined ? { diff } : {}) });
      }),

    tool('get_diff', 'Get uncommitted changes', 'read',
      'The diff of the uncommitted changes: all of them, or only the staged ones, optionally for some files.',
      { staged: { type: 'boolean', description: 'Only the staged changes.' }, paths: { type: 'array', items: { type: 'string' }, description: 'Only these files.' }, ...MAX_CHARS },
      [], async (args, ctx) => {
        const { repo } = resolve(args, ctx);
        const staged = bool(args, 'staged');
        let paths = strList(args, 'paths');
        if (!paths) {
          const s = await repo.getStatusFresh();
          paths = [...new Set([...s.stagedFiles, ...(staged ? [] : s.unstagedFiles)].map(f => f.path))];
        }
        if (paths.length === 0) return { text: staged ? 'No staged changes.' : 'No uncommitted changes.' };
        return { text: await repo.getCommitDiffForPaths(paths, staged, num(args, 'max_chars', 20000, 200000)) || 'No changes in these files.' };
      }),

    tool('compare', 'Compare branches', 'read',
      'The commits on `head` that `base` doesn\'t have, and their combined diff — e.g. what a branch would bring into main.',
      {
        base: { type: 'string', description: 'Base branch or ref, e.g. main or origin/main.' },
        head: { type: 'string', description: 'Branch or ref to compare (default HEAD).' },
        include_diff: { type: 'boolean', description: 'Include the combined diff (default true).' }, ...MAX_CHARS,
      }, ['base'], async (args, ctx) => {
        const { repo } = resolve(args, ctx);
        const base = reqStr(args, 'base');
        const head = str(args, 'head') ?? 'HEAD';
        const commits = await repo.getCommitsBetween(base, head, 200);
        const diff = bool(args, 'include_diff', true) ? await repo.getBranchDiff(base, head, num(args, 'max_chars', 20000, 200000)) : undefined;
        return json({
          commits: commits.map(c => ({ hash: c.hash, date: c.authorDate, author: c.authorName, subject: c.message.split('\n')[0] })),
          ...(diff !== undefined ? { diff } : {}),
        });
      }),

    tool('list_branches', 'List branches', 'read',
      'Local branches (and remote ones if asked), with upstream, ahead/behind and last commit.',
      { include_remote: { type: 'boolean', description: 'Also list remote branches.' } }, [], async (args, ctx) => {
        const { repo } = resolve(args, ctx);
        const remote = bool(args, 'include_remote');
        const branches = (await repo.getBranches()).filter(b => remote || !b.isRemote);
        return json(branches.map(b => ({
          name: b.name, ...(b.isHead ? { current: true } : {}), ...(b.isRemote ? { remote: true } : {}),
          upstream: b.upstream, ...(b.upstreamGone ? { upstreamGone: true } : {}),
          ...tracked(b), lastCommit: b.lastCommitHash, lastCommitDate: b.lastCommitDate, lastCommitSubject: b.lastCommitMessage,
        })));
      }),

    tool('list_stashes', 'List stashes', 'read', 'The repository\'s stashes, newest first, with their files.', {}, [], async (args, ctx) => {
      const { repo } = resolve(args, ctx);
      return json((await repo.stashList()).map(s => ({ ref: s.ref, message: s.message, branch: s.branch, date: s.date, files: s.files.map(f => `${f.status} ${f.path}`) })));
    }),

    // ── Git: write ───────────────────────────────────────────────────────────────────────────────────────────
    tool('stage', 'Stage files', 'write', 'Stages files for the next commit: the given paths, or every change.',
      { paths: { type: 'array', items: { type: 'string' }, description: 'Files to stage. Omit to stage every change.' } }, [], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const paths = strList(args, 'paths');
        await confirm('write', vscode.l10n.t('{0} wants to stage changes in {1}.', ctx.clientName, meta.name), paths?.join('\n'));
        if (paths) await repo.stageFiles(paths); else await repo.stageAll();
        refreshed();
        return { text: paths ? `Staged ${paths.length} file(s).` : 'Staged every change.' };
      }),

    tool('unstage', 'Unstage files', 'write', 'Moves staged files back to the unstaged changes: the given paths, or all of them.',
      { paths: { type: 'array', items: { type: 'string' }, description: 'Files to unstage. Omit to unstage everything.' } }, [], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const paths = strList(args, 'paths');
        await confirm('write', vscode.l10n.t('{0} wants to unstage changes in {1}.', ctx.clientName, meta.name), paths?.join('\n'));
        if (paths) await repo.unstageFiles(paths); else await repo.unstageAll();
        refreshed();
        return { text: paths ? `Unstaged ${paths.length} file(s).` : 'Unstaged everything.' };
      }),

    tool('commit', 'Commit', 'write',
      'Commits the staged changes with the active GitCharm Git profile\'s identity. Amending rewrites the last commit and asks for confirmation.',
      {
        message: { type: 'string', description: 'Commit message: subject line, blank line, body.' },
        stage_all: { type: 'boolean', description: 'Stage every change first.' },
        amend: { type: 'boolean', description: 'Amend the last commit instead of creating one.' },
      }, ['message'], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const message = reqStr(args, 'message');
        const amend = bool(args, 'amend');
        await confirm(amend ? 'risky' : 'write',
          amend ? vscode.l10n.t('{0} wants to amend the last commit in {1}.', ctx.clientName, meta.name) : vscode.l10n.t('{0} wants to commit in {1}.', ctx.clientName, meta.name),
          message);
        if (bool(args, 'stage_all')) await repo.stageAll();
        if (!amend && (await repo.getStatusFresh()).stagedFiles.length === 0) throw new ToolError('Nothing is staged: stage files first, or pass stage_all.');
        const hash = await repo.commit(message, amend, await commitCredentials(repo));
        refreshed();
        return { text: `Committed ${hash || ''}`.trim() };
      }),

    tool('create_branch', 'Create branch', 'write', 'Creates a branch, from the current commit or another ref, and checks it out unless told not to.',
      {
        name: { type: 'string', description: 'New branch name.' },
        from: { type: 'string', description: 'Ref to start from (default: the current commit).' },
        checkout: { type: 'boolean', description: 'Check the new branch out (default true).' },
      }, ['name'], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const name = reqStr(args, 'name');
        const from = str(args, 'from');
        await confirm('write', vscode.l10n.t('{0} wants to create the branch "{1}" in {2}.', ctx.clientName, name, meta.name));
        if (bool(args, 'checkout', true)) await repo.checkout(name, true, from); else await repo.createBranch(name, from);
        refreshed();
        return { text: `Created branch ${name}${bool(args, 'checkout', true) ? ' and checked it out' : ''}.` };
      }),

    tool('switch_branch', 'Switch branch', 'write', 'Checks out an existing branch (a remote one gets a local tracking branch).',
      { branch: { type: 'string', description: 'Branch to check out.' } }, ['branch'], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const branch = reqStr(args, 'branch');
        await confirm('write', vscode.l10n.t('{0} wants to check out "{1}" in {2}.', ctx.clientName, branch, meta.name));
        await repo.checkout(branch);
        refreshed();
        return { text: `Checked out ${branch}.` };
      }),

    tool('fetch', 'Fetch', 'write', 'Fetches every remote of the repository.', {}, [], async (args, ctx) => {
      const { meta, repo } = resolve(args, ctx);
      await confirm('write', vscode.l10n.t('{0} wants to fetch in {1}.', ctx.clientName, meta.name));
      await repo.fetchAll();
      refreshed();
      return { text: 'Fetched.' };
    }),

    tool('pull', 'Pull', 'write', 'Pulls the current branch, the way GitCharm\'s pull setting says (merge, rebase or fast-forward only).', {}, [], async (args, ctx) => {
      const { meta, repo } = resolve(args, ctx);
      await confirm('write', vscode.l10n.t('{0} wants to pull in {1}.', ctx.clientName, meta.name));
      const out = await repo.pullWithDefault();
      refreshed();
      return { text: out || 'Pulled.' };
    }),

    tool('push', 'Push', 'risky', 'Pushes the current branch, publishing it when it has no upstream yet. Protected branches stay guarded. Asks for confirmation.',
      { force: { type: 'boolean', description: 'Force push with lease.' } }, [], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const force = bool(args, 'force');
        const branch = (await repo.getCurrentBranch()).name;
        await confirm('risky', force
          ? vscode.l10n.t('{0} wants to force push "{1}" in {2}.', ctx.clientName, branch, meta.name)
          : vscode.l10n.t('{0} wants to push "{1}" in {2}.', ctx.clientName, branch, meta.name));
        const out = await repo.push(force);
        refreshed();
        return { text: out === 'pushed' ? `Pushed ${branch}.` : out };
      }),

    tool('stash', 'Stash changes', 'write', 'Stashes the uncommitted changes, or only some files.',
      { message: { type: 'string', description: 'Stash message.' }, paths: { type: 'array', items: { type: 'string' }, description: 'Only these files.' } }, [], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        await confirm('write', vscode.l10n.t('{0} wants to stash changes in {1}.', ctx.clientName, meta.name));
        await repo.stashPush(str(args, 'message') ?? '', strList(args, 'paths'));
        refreshed();
        return { text: 'Stashed.' };
      }),

    tool('stash_pop', 'Pop stash', 'write', 'Applies a stash (the latest by default) and drops it.',
      { stash: { type: 'string', description: 'Stash ref, e.g. stash@{1} (default stash@{0}).' } }, [], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const ref = str(args, 'stash') ?? 'stash@{0}';
        await confirm('write', vscode.l10n.t('{0} wants to pop {1} in {2}.', ctx.clientName, ref, meta.name));
        await repo.stashPop(ref);
        refreshed();
        return { text: `Popped ${ref}.` };
      }),

    tool('delete_branch', 'Delete branch', 'risky', 'Deletes a local branch. Without force, git refuses one with unmerged commits. Asks for confirmation.',
      { branch: { type: 'string', description: 'Local branch to delete.' }, force: { type: 'boolean', description: 'Delete even with unmerged commits.' } },
      ['branch'], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const branch = reqStr(args, 'branch');
        await confirm('risky', vscode.l10n.t('{0} wants to delete the branch "{1}" in {2}.', ctx.clientName, branch, meta.name));
        await repo.deleteBranch(branch, bool(args, 'force'));
        refreshed();
        return { text: `Deleted ${branch}.` };
      }),

    // ── History rewriting ────────────────────────────────────────────────────────────────────────────────────
    tool('squash_commits', 'Squash commits', 'risky',
      'Squashes adjacent commits of the current branch into one with the given message; the commits after them are replayed as they were. Rewrites history: asks for confirmation.',
      {
        commits: { type: 'array', items: { type: 'string' }, description: 'The commits to squash, adjacent, any order.' },
        message: { type: 'string', description: 'Message of the squashed commit.' },
      }, ['commits', 'message'], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const commits = strList(args, 'commits') ?? [];
        const message = reqStr(args, 'message');
        const groups = await repo.getSquashGroups(commits);
        if (groups.length !== 1 || groups[0].length !== new Set(commits).size) {
          throw new ToolError('The commits must be two or more adjacent commits of the current branch: squash one run of adjacent commits per call.');
        }
        await confirm('risky', vscode.l10n.t('{0} wants to squash {1} commits in {2}.', ctx.clientName, groups[0].length, meta.name), message);
        await repo.squashCommits([{ hashes: groups[0], message }]);
        refreshed();
        return { text: `Squashed ${groups[0].length} commits.` };
      }),

    tool('drop_commits', 'Drop commits', 'risky',
      'Removes commits from the current branch; the commits after them are replayed. A conflict cancels it and leaves the branch as it was. Asks for confirmation.',
      { commits: { type: 'array', items: { type: 'string' }, description: 'The commits to drop.' } }, ['commits'], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const commits = strList(args, 'commits') ?? [];
        if (commits.length === 0) throw new ToolError('"commits" is empty');
        await confirm('risky', vscode.l10n.t('{0} wants to drop {1} commits in {2}.', ctx.clientName, commits.length, meta.name), commits.join('\n'));
        await repo.dropCommits(commits);
        refreshed();
        return { text: `Dropped ${commits.length} commit(s).` };
      }),

    // ── Pull requests ────────────────────────────────────────────────────────────────────────────────────────
    tool('list_pull_requests', 'List pull requests', 'read',
      'Pull requests of the repository on its forge (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea), through the account connected in GitCharm.',
      {
        state: { type: 'string', enum: ['open', 'draft', 'merged', 'closed', 'all'], description: 'Default open (drafts included).' },
        author: { type: 'string', enum: ['all', 'mine'], description: 'Default all.' },
        search: { type: 'string', description: 'Text to search, or a PR number.' },
        page: { type: 'number', description: 'Page, from 1.' },
      }, [], async (args, ctx) => {
        const { meta } = resolve(args, ctx);
        const state = str(args, 'state') ?? 'open';
        const states: PullRequestStateFilter[] = state === 'all' ? ['open', 'draft', 'merged', 'closed'] : state === 'open' ? ['open', 'draft'] : [state as PullRequestStateFilter];
        const result = forge(await pullRequestManager.queryPullRequests(meta.id, {
          states, author: str(args, 'author') === 'mine' ? 'mine' : 'all', page: Math.max(1, num(args, 'page', 1)), search: str(args, 'search'),
        }));
        return json({
          pullRequests: result.items.map(p => ({ number: p.number, title: p.title, state: p.state, source: p.sourceBranch, target: p.targetBranch, author: p.authorName, updated: p.updatedAt, url: p.url, ...(p.sourceRepoFullName ? { fork: p.sourceRepoFullName } : {}) })),
          hasMore: result.hasMore,
        });
      }),

    tool('get_pull_request', 'Get pull request', 'read',
      'A pull request\'s description, state, mergeability, reviewers, CI checks, changed files and comments.',
      {
        number: { type: 'number', description: 'Pull request number.' },
        include_comments: { type: 'boolean', description: 'Include comments (default true).' },
        include_files: { type: 'boolean', description: 'Include changed files (default true).' },
      }, ['number'], async (args, ctx) => {
        const { meta } = resolve(args, ctx);
        const number = num(args, 'number', 0);
        const pr = forge(await pullRequestManager.getPullRequestDetail(meta.id, number), `Pull request #${number} not found in ${meta.name}.`);
        const [checks, files, comments] = await Promise.all([
          pullRequestManager.listChecks(meta.id, pr.headSha),
          bool(args, 'include_files', true) ? pullRequestManager.listChangedFiles(meta.id, number) : undefined,
          bool(args, 'include_comments', true) ? pullRequestManager.listComments(meta.id, number) : undefined,
        ]);
        return json({
          number: pr.number, title: pr.title, state: pr.state, url: pr.url, author: pr.authorName, source: pr.sourceBranch, target: pr.targetBranch,
          ...(pr.sourceRepoFullName ? { fork: pr.sourceRepoFullName } : {}), mergeable: pr.mergeableState, headSha: pr.headSha,
          description: pr.description, reviewers: pr.reviewers.map(r => r.username), labels: pr.labels.map(l => l.name),
          checks: checks.items.map(c => ({ name: c.name, state: c.state })),
          ...(files ? { files: files.items.map(f => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })) } : {}),
          ...(comments ? { comments: comments.items.map(c => ({ author: c.authorName, date: c.createdAt, body: truncate(c.body, 4000) })) } : {}),
        });
      }),

    tool('create_pull_request', 'Create pull request', 'risky',
      'Opens a pull request on the forge from a pushed branch (default: the current one) into the target (default: the repository\'s default branch). Asks for confirmation.',
      {
        title: { type: 'string', description: 'Title.' },
        description: { type: 'string', description: 'Description, in Markdown.' },
        source: { type: 'string', description: 'Source branch, pushed (default: the current branch).' },
        target: { type: 'string', description: 'Target branch (default: the repository\'s default branch).' },
        draft: { type: 'boolean', description: 'Open as a draft.' },
      }, ['title'], async (args, ctx) => {
        const { meta, repo } = resolve(args, ctx);
        const source = str(args, 'source') ?? (await repo.getCurrentBranch()).name;
        const remote = await pullRequestManager.getPullRequestRemote(meta.id) ?? 'origin';
        const target = str(args, 'target') ?? meta.defaultBranch ?? await repo.getRemoteDefaultBranch(remote)
          ?? (vscode.workspace.getConfiguration('gitcharm.pullRequests').get<string>('defaultTargetBranch', '') || 'main');
        if (!(await repo.run(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${source}`]).then(() => true, () => false))) {
          throw new ToolError(`"${source}" is not on ${remote}: push it first.`);
        }
        const title = reqStr(args, 'title');
        await confirm('risky', vscode.l10n.t('{0} wants to open a pull request from "{1}" into "{2}" in {3}.', ctx.clientName, source, target, meta.name), title);
        const result = await pullRequestManager.createPullRequest(meta.id, { sourceBranch: source, targetBranch: target, title, description: str(args, 'description') ?? '', draft: bool(args, 'draft') });
        if (!result.ok || !result.pr) throw new ToolError(result.error ?? 'The forge refused the pull request');
        return json({ number: result.pr.number, url: result.pr.url });
      }),

    tool('comment_on_pull_request', 'Comment on pull request', 'risky', 'Posts a comment on a pull request. Asks for confirmation.',
      { number: { type: 'number', description: 'Pull request number.' }, body: { type: 'string', description: 'Comment, in Markdown.' } },
      ['number', 'body'], async (args, ctx) => {
        const { meta } = resolve(args, ctx);
        const number = num(args, 'number', 0);
        const body = reqStr(args, 'body');
        await confirm('risky', vscode.l10n.t('{0} wants to comment on pull request #{1} in {2}.', ctx.clientName, number, meta.name), body);
        const result = await pullRequestManager.postComment(meta.id, number, body);
        if (!result.ok) throw new ToolError(result.error ?? 'The forge refused the comment');
        return { text: 'Comment posted.' };
      }),

    tool('merge_pull_request', 'Merge pull request', 'risky',
      'Merges a pull request on the forge, then deletes its branch as asked (or as GitCharm\'s "delete branch after merge" setting says). Asks for confirmation.',
      {
        number: { type: 'number', description: 'Pull request number.' },
        strategy: { type: 'string', enum: ['merge', 'squash', 'rebase', 'fastForward'], description: 'Default: GitCharm\'s default merge strategy.' },
        delete_branch: { type: 'string', enum: ['local_and_remote', 'remote', 'local', 'none'], description: 'What to delete after the merge. Omit to follow the setting (which may ask the user).' },
      }, ['number'], async (args, ctx) => {
        const { meta } = resolve(args, ctx);
        const number = num(args, 'number', 0);
        const strategy = (str(args, 'strategy') ?? vscode.workspace.getConfiguration('gitcharm.pullRequests').get<MergeStrategy>('defaultMergeStrategy', 'merge')) as MergeStrategy;
        const pr = forge(await pullRequestManager.getPullRequestDetail(meta.id, number), `Pull request #${number} not found in ${meta.name}.`);
        if (pr.state === 'merged' || pr.state === 'closed') throw new ToolError(`Pull request #${number} is ${pr.state}.`);
        await confirm('risky', vscode.l10n.t('{0} wants to merge pull request #{1} ({2}) in {3}.', ctx.clientName, number, strategy, meta.name), pr.title);
        actionResult(await pullRequestManager.mergePullRequest(meta.id, number, strategy));
        const choice = ({ local_and_remote: 'localAndRemote', remote: 'remote', local: 'local', none: 'never' } as Record<string, BranchCleanupChoice>)[str(args, 'delete_branch') ?? ''];
        const cleanup = await cleanUpAfterMerge(manager, pullRequestManager, meta.id, pr, choice);
        return { text: [`Merged pull request #${number}.`, ...cleanup].join(' ') };
      }),

    // ── Issues ───────────────────────────────────────────────────────────────────────────────────────────────
    tool('list_issues', 'List issues', 'read', 'Issues of the repository on its forge, through the account connected in GitCharm.',
      {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open.' },
        author: { type: 'string', enum: ['all', 'mine'], description: 'Default all.' },
        search: { type: 'string', description: 'Text to search, or an issue number.' },
      }, [], async (args, ctx) => {
        const { meta } = resolve(args, ctx);
        const state = str(args, 'state') ?? 'open';
        const states: IssueStateFilter[] = state === 'all' ? ['open', 'closed'] : [state as IssueStateFilter];
        const result = forge(await issueManager.queryIssues(meta.id, { states, author: str(args, 'author') === 'mine' ? 'mine' : 'all', search: str(args, 'search') }));
        return json({
          issues: result.items.map(i => ({ number: i.number, title: i.title, state: i.state, author: i.authorName, updated: i.updatedAt, url: i.url, labels: i.labels?.map(l => l.name) })),
          hasMore: !!result.nextCursor,
        });
      }),

    tool('get_issue', 'Get issue', 'read', 'An issue\'s description, state, assignees and labels.',
      { number: { type: 'number', description: 'Issue number.' } }, ['number'], async (args, ctx) => {
        const { meta } = resolve(args, ctx);
        const number = num(args, 'number', 0);
        const issue = forge(await issueManager.getIssueDetail(meta.id, number), `Issue #${number} not found in ${meta.name}.`);
        return json({
          number: issue.number, title: issue.title, state: issue.state, url: issue.url, author: issue.authorName,
          description: issue.description, assignees: issue.assignees.map(a => a.username), labels: issue.labels.map(l => l.name),
        });
      }),
  ];
}

/** Ahead/behind, only with an upstream: a branch never pushed is not "even" with anything. */
function tracked(b: BranchInfo): { ahead?: number; behind?: number } {
  return b.upstream && b.aheadBehind ? { ahead: b.aheadBehind.ahead, behind: b.aheadBehind.behind } : {};
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function inside(folder: string, target: string): boolean {
  const norm = (p: string) => {
    const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
  };
  return norm(target) === norm(folder) || norm(target).startsWith(`${norm(folder)}/`);
}
