import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import type {
  BranchInfo,
  CommitNode,
  FileStatus,
  FileDiff,
  GitFileStatus,
  RepoStatus,
} from '../types/git';
import type { StashEntry, UnpushedCommit } from '../types/messages';
import { parseDiff, buildMonacoContents, detectLanguage } from './DiffParser';
import { getVscodeRepository } from './VscodeGitApi';
import { ForcePushMode, Status, RefType } from './git.d';

const STATUS_MAP: Record<string, GitFileStatus> = {
  M: 'modified', A: 'added', D: 'deleted',
  R: 'renamed', C: 'copied', U: 'conflicted',
  '?': 'untracked',
};

// VS Code Status enum → GitFileStatus
function vsStatusToGitFileStatus(s: Status): GitFileStatus {
  switch (s) {
    case Status.INDEX_MODIFIED:
    case Status.MODIFIED:
    case Status.TYPE_CHANGED:       return 'modified';
    case Status.INDEX_ADDED:
    case Status.INTENT_TO_ADD:
    case Status.INTENT_TO_RENAME:   return 'added';
    case Status.INDEX_DELETED:
    case Status.DELETED:            return 'deleted';
    case Status.INDEX_RENAMED:      return 'renamed';
    case Status.INDEX_COPIED:       return 'copied';
    case Status.UNTRACKED:          return 'untracked';
    case Status.ADDED_BY_US:
    case Status.ADDED_BY_THEM:
    case Status.DELETED_BY_US:
    case Status.DELETED_BY_THEM:
    case Status.BOTH_ADDED:
    case Status.BOTH_DELETED:
    case Status.BOTH_MODIFIED:      return 'conflicted';
    default:                        return 'modified';
  }
}

export class GitService {
  private git: SimpleGit;

  constructor(public readonly repoId: string, public readonly rootPath: string) {
    this.git = simpleGit(rootPath);
  }

  private vsRepo() {
    return getVscodeRepository(this.rootPath);
  }

  async isGitRepo(): Promise<boolean> {
    const vsRepo = this.vsRepo();
    if (vsRepo) return true;
    try { await this.git.status(); return true; } catch { return false; }
  }

  /** Read status directly from git (bypasses VSCode's cached state). */
  async getStatusFresh(): Promise<RepoStatus> {
    const [status, branchInfo] = await Promise.all([
      this.git.status(),
      this.getCurrentBranch(),
    ]);

    const stagedFiles: FileStatus[] = [];
    const unstagedFiles: FileStatus[] = [];
    let conflictCount = 0;

    for (const file of status.files) {
      const absPath = path.join(this.rootPath, file.path);
      const index = file.index.trim();
      const workingDir = file.working_dir.trim();

      if (index === 'U' || workingDir === 'U' || (index === 'A' && workingDir === 'A') || (index === 'D' && workingDir === 'D')) {
        conflictCount++;
        unstagedFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: 'conflicted', staged: false, unstaged: true });
        continue;
      }
      if (index && index !== ' ' && index !== '?') {
        stagedFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: STATUS_MAP[index] ?? 'modified', staged: true, unstaged: false });
      }
      if (workingDir && workingDir !== ' ') {
        unstagedFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: workingDir === '?' ? 'untracked' : (STATUS_MAP[workingDir] ?? 'modified'), staged: false, unstaged: true });
      }
    }

    return { repoId: this.repoId, branch: branchInfo, stagedFiles, unstagedFiles, isDetachedHead: status.detached, conflictCount };
  }

  async getStatus(): Promise<RepoStatus> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const head = vsRepo.state.HEAD;
      const branchInfo: BranchInfo = {
        repoId: this.repoId,
        name: head?.name ?? 'HEAD',
        fullName: head?.name ? `refs/heads/${head.name}` : 'HEAD',
        isHead: true,
        isRemote: false,
        upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined,
        aheadBehind: (head?.ahead !== undefined && head?.behind !== undefined)
          ? { ahead: head.ahead, behind: head.behind }
          : undefined,
      };

      const stagedFiles: FileStatus[] = [];
      const unstagedFiles: FileStatus[] = [];
      let conflictCount = 0;

      const makeFile = (change: import('./git.d').Change, staged: boolean): FileStatus => {
        const relPath = path.relative(this.rootPath, change.uri.fsPath).split(path.sep).join('/');
        const status = vsStatusToGitFileStatus(change.status);
        return {
          repoId: this.repoId,
          path: relPath,
          absolutePath: change.uri.fsPath,
          status,
          staged,
          unstaged: !staged,
        };
      };

      for (const c of vsRepo.state.indexChanges) {
        const f = makeFile(c, true);
        if (f.status === 'conflicted') conflictCount++;
        else stagedFiles.push(f);
      }
      for (const c of vsRepo.state.workingTreeChanges) {
        const f = makeFile(c, false);
        if (f.status === 'conflicted') conflictCount++;
        else unstagedFiles.push(f);
      }
      for (const c of vsRepo.state.untrackedChanges) {
        unstagedFiles.push(makeFile(c, false));
      }
      for (const c of vsRepo.state.mergeChanges) {
        conflictCount++;
        const relPath = path.relative(this.rootPath, c.uri.fsPath).split(path.sep).join('/');
        unstagedFiles.push({
          repoId: this.repoId,
          path: relPath,
          absolutePath: c.uri.fsPath,
          status: 'conflicted',
          staged: false,
          unstaged: true,
        });
      }

      return {
        repoId: this.repoId,
        branch: branchInfo,
        stagedFiles,
        unstagedFiles,
        isDetachedHead: !head?.name,
        conflictCount,
      };
    }

    // Fallback: simple-git
    const [status, branchInfo] = await Promise.all([
      this.git.status(),
      this.getCurrentBranch(),
    ]);

    const stagedFiles: FileStatus[] = [];
    const unstagedFiles: FileStatus[] = [];
    let conflictCount = 0;

    for (const file of status.files) {
      const absPath = path.join(this.rootPath, file.path);
      const index = file.index.trim();
      const workingDir = file.working_dir.trim();

      if (index === 'U' || workingDir === 'U' || (index === 'A' && workingDir === 'A') || (index === 'D' && workingDir === 'D')) {
        conflictCount++;
        unstagedFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: 'conflicted', staged: false, unstaged: true });
        continue;
      }
      if (index && index !== ' ' && index !== '?') {
        stagedFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: STATUS_MAP[index] ?? 'modified', staged: true, unstaged: false });
      }
      if (workingDir && workingDir !== ' ') {
        unstagedFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: workingDir === '?' ? 'untracked' : (STATUS_MAP[workingDir] ?? 'modified'), staged: false, unstaged: true });
      }
    }

    return { repoId: this.repoId, branch: branchInfo, stagedFiles, unstagedFiles, isDetachedHead: status.detached, conflictCount };
  }

  async getCurrentBranch(): Promise<BranchInfo> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const head = vsRepo.state.HEAD;
      return {
        repoId: this.repoId,
        name: head?.name ?? 'HEAD',
        fullName: head?.name ? `refs/heads/${head.name}` : 'HEAD',
        isHead: true,
        isRemote: false,
        upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined,
        aheadBehind: (head?.ahead !== undefined && head?.behind !== undefined)
          ? { ahead: head.ahead, behind: head.behind }
          : undefined,
      };
    }
    const status = await this.git.status();
    return {
      repoId: this.repoId,
      name: status.current ?? 'HEAD',
      fullName: `refs/heads/${status.current ?? 'HEAD'}`,
      isHead: true,
      isRemote: false,
      upstream: status.tracking ?? undefined,
      aheadBehind: status.tracking ? { ahead: status.ahead, behind: status.behind } : undefined,
    };
  }

  async getBranches(): Promise<BranchInfo[]> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      // getBranches({ remote: false }) returns local branches (RefType.Head),
      // getBranches({ remote: true }) returns remote-tracking branches (RefType.RemoteHead).
      // We filter by RefType to avoid duplicates if the API returns both in either call.
      const [localRefs, remoteRefs] = await Promise.all([
        vsRepo.getBranches({ remote: false, sort: 'committerdate' }),
        vsRepo.getBranches({ remote: true,  sort: 'committerdate' }),
      ]);
      const head = vsRepo.state.HEAD;
      const branches: BranchInfo[] = [];

      for (const ref of localRefs.filter(r => r.type === RefType.Head)) {
        const name = ref.name ?? '';
        branches.push({
          repoId: this.repoId,
          name,
          fullName: `refs/heads/${name}`,
          isHead: name === head?.name,
          isRemote: false,
          lastCommitHash: ref.commit,
          aheadBehind: (name === head?.name && head.ahead !== undefined && head.behind !== undefined)
            ? { ahead: head.ahead, behind: head.behind }
            : undefined,
        });
      }

      for (const ref of remoteRefs.filter(r => r.type === RefType.RemoteHead)) {
        const name = ref.name ?? '';
        const remoteName = name.split('/')[0];
        branches.push({
          repoId: this.repoId,
          name,
          fullName: `refs/remotes/${name}`,
          isHead: false,
          isRemote: true,
          remoteName,
          lastCommitHash: ref.commit,
        });
      }

      return branches;
    }

    // Fallback: simple-git
    const result = await this.git.branch(['-avv', '--sort=-committerdate']);
    const branches: BranchInfo[] = [];
    for (const [name, branch] of Object.entries(result.branches)) {
      const isRemote = name.startsWith('remotes/');
      const cleanName = isRemote ? name.replace(/^remotes\//, '') : name;
      const remoteName = isRemote ? cleanName.split('/')[0] : undefined;
      let aheadBehind: { ahead: number; behind: number } | undefined;
      const full = branch.label?.match(/\[.+?: ahead (\d+), behind (\d+)\]/);
      const aheadOnly = branch.label?.match(/\[.+?: ahead (\d+)\]/);
      const behindOnly = branch.label?.match(/\[.+?: behind (\d+)\]/);
      if (full) aheadBehind = { ahead: parseInt(full[1], 10), behind: parseInt(full[2], 10) };
      else if (aheadOnly) aheadBehind = { ahead: parseInt(aheadOnly[1], 10), behind: 0 };
      else if (behindOnly) aheadBehind = { ahead: 0, behind: parseInt(behindOnly[1], 10) };
      branches.push({
        repoId: this.repoId,
        name: cleanName,
        fullName: isRemote ? `refs/remotes/${cleanName}` : `refs/heads/${cleanName}`,
        isHead: branch.current,
        isRemote,
        remoteName,
        lastCommitHash: branch.commit,
        aheadBehind,
      });
    }
    return branches;
  }

  // Log uses raw git format for graph rendering — VS Code API's log() lacks graph parents/refs.
  async getLog(limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string }): Promise<CommitNode[]> {
    const args: string[] = [
      'log',
      `--max-count=${limit}`, `--skip=${skip}`,
      '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%ai%x00%ci%x00%D%x00%s',
      '--date=iso-strict',
    ];
    if (opts?.filterText) args.push(`--grep=${opts.filterText}`, '--regexp-ignore-case');
    if (opts?.filterAuthor) args.push(`--author=${opts.filterAuthor}`, '--regexp-ignore-case');
    if (opts?.filterDateFrom) args.push(`--after=${opts.filterDateFrom}`);
    if (opts?.filterDateTo) args.push(`--before=${opts.filterDateTo}`);
    if (opts?.filterBranch) {
      args.push(opts.filterBranch);
    } else {
      args.push('--exclude=refs/stash', '--all');
    }
    const raw = await this.git.raw(args);
    const commits: CommitNode[] = [];
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\x00');
      if (parts.length < 9) continue;
      const [hash, shortHash, parentsRaw, authorName, authorEmail, authorDate, committerDate, refsRaw, message] = parts;
      commits.push({ hash, shortHash, repoId: this.repoId, message, authorName, authorEmail, authorDate, committerDate, parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [], refs: refsRaw ? refsRaw.split(',').map(r => r.trim()).filter(Boolean) : [] });
    }
    return commits;
  }

  async getCommitFiles(hash: string): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> {
    const [nameStatus, numStat] = await Promise.all([
      this.git.raw(['diff-tree', '--no-commit-id', '-r', '--name-status', hash]),
      this.git.raw(['diff-tree', '--no-commit-id', '-r', '--numstat', hash]),
    ]);
    const stats = new Map<string, { added: number; removed: number }>();
    for (const line of numStat.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const added = parseInt(parts[0], 10);
      const removed = parseInt(parts[1], 10);
      const path = parts[parts.length - 1];
      if (!isNaN(added) && !isNaN(removed)) stats.set(path, { added, removed });
    }
    const files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
    for (const line of nameStatus.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const path = parts[parts.length - 1];
      const s = stats.get(path);
      files.push({ status: parts[0], path, added: s?.added, removed: s?.removed });
    }
    return files;
  }

  async getFileDiff(repoId: string, hash: string, filePath: string): Promise<FileDiff | null> {
    try {
      const vsRepo = this.vsRepo();
      const rawDiff = await this.git.raw(['show', hash, '--', filePath, '--format=']);
      const diffs = parseDiff(`diff --git a/${filePath} b/${filePath}\n${rawDiff}`, repoId);
      if (diffs.length === 0) return null;
      const diff = diffs[0];
      if (vsRepo) {
        diff.originalContent = await vsRepo.show(`${hash}~1`, filePath).catch(() => '');
        diff.modifiedContent = await vsRepo.show(hash, filePath).catch(() => '');
      } else {
        diff.originalContent = await this.git.raw(['show', `${hash}~1:${filePath}`]).catch(() => '');
        diff.modifiedContent = await this.git.raw(['show', `${hash}:${filePath}`]).catch(() => '');
      }
      return diff;
    } catch { return null; }
  }

  async getStagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    try {
      const vsRepo = this.vsRepo();
      const rawDiff = vsRepo
        ? await vsRepo.diff(true)  // cached diff
        : await this.git.diff(['--staged', '--', filePath]);
      // When using vsRepo.diff we get all staged — filter to this file
      const filtered = vsRepo
        ? rawDiff.split('\ndiff --git ').filter(chunk => chunk.includes(`b/${filePath}`)).map((c, i) => i === 0 ? c : 'diff --git ' + c).join('')
        : rawDiff;
      const diffs = parseDiff(filtered || rawDiff, repoId);
      if (diffs.length === 0) return null;
      const diff = diffs[0];
      if (vsRepo) {
        diff.originalContent = await vsRepo.show('HEAD', filePath).catch(() => '');
        diff.modifiedContent = await vsRepo.show('', filePath).catch(() => {
          try { return fs.readFileSync(path.join(this.rootPath, filePath), 'utf8'); } catch { return ''; }
        });
      } else {
        diff.originalContent = await this.git.show([`HEAD:${filePath}`]).catch(() => '');
        diff.modifiedContent = await this.git.raw(['show', `:${filePath}`]).catch(() => {
          try { return fs.readFileSync(path.join(this.rootPath, filePath), 'utf8'); } catch { return ''; }
        });
      }
      return diff;
    } catch { return null; }
  }

  async getUnstagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    try {
      const vsRepo = this.vsRepo();
      const rawDiff = vsRepo
        ? await vsRepo.diffWithHEAD(filePath)
        : await this.git.diff(['--', filePath]);
      if (!rawDiff) {
        const content = fs.readFileSync(path.join(this.rootPath, filePath), 'utf8');
        return { repoId, oldPath: filePath, newPath: filePath, isBinary: false, isNew: true, isDeleted: false, hunks: [], originalContent: '', modifiedContent: content, language: detectLanguage(filePath) };
      }
      const diffs = parseDiff(rawDiff, repoId);
      if (diffs.length === 0) return null;
      const diff = diffs[0];
      diff.originalContent = vsRepo
        ? await vsRepo.show('HEAD', filePath).catch(() => '')
        : await this.git.show([`HEAD:${filePath}`]).catch(() => '');
      diff.modifiedContent = fs.readFileSync(path.join(this.rootPath, filePath), 'utf8');
      return diff;
    } catch { return null; }
  }

  async stageFiles(paths: string[]): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.add(paths); return; }
    await this.git.add(paths);
  }

  async stageAll(): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const all = [
        ...vsRepo.state.workingTreeChanges,
        ...vsRepo.state.untrackedChanges,
        ...vsRepo.state.mergeChanges,
      ].map(c => c.uri.fsPath);
      if (all.length) await vsRepo.add(all);
      return;
    }
    await this.git.add('.');
  }

  async unstageFiles(paths: string[]): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.revert(paths); return; }
    await this.git.reset(['HEAD', '--', ...paths]);
  }

  async unstageAll(): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const staged = vsRepo.state.indexChanges.map(c => c.uri.fsPath);
      if (staged.length) await vsRepo.revert(staged);
      return;
    }
    await this.git.reset(['HEAD']);
  }

  async discardFile(filePath: string): Promise<void> {
    const absPath = path.join(this.rootPath, filePath);

    // Use git status --porcelain to reliably detect untracked (??) vs tracked files,
    // regardless of vsRepo API availability.
    const status = await this.git.raw(['status', '--porcelain', '--', filePath]);
    const isUntracked = status.trimStart().startsWith('??');

    if (isUntracked) {
      const fs = require('fs') as typeof import('fs');
      try { fs.unlinkSync(absPath); } catch { /* already gone */ }
      return;
    }

    // For tracked changes (modified, staged, deleted): restore both index and working tree.
    await this.git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', filePath])
      .catch(() => this.git.raw(['restore', '--staged', '--worktree', '--', filePath]))
      .catch(() => this.git.checkout(['--', filePath]));
  }

  async commit(message: string, amend: boolean): Promise<string> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      await vsRepo.commit(message, { amend });
      return '';
    }
    const result = await this.git.commit(message, undefined, amend ? { '--amend': null } : {});
    return result.summary.changes.toString();
  }

  async getMergeRebaseState(): Promise<'merge' | 'rebase' | null> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      if (vsRepo.state.rebaseCommit !== undefined) return 'rebase';
      if (vsRepo.state.mergeChanges.length > 0) return 'merge';
      return null;
    }
    const mergeHead = await this.git.raw(['rev-parse', '--verify', 'MERGE_HEAD']).catch(() => '');
    if (mergeHead.trim()) return 'merge';
    const rebaseDir = await this.git.raw(['rev-parse', '--git-path', 'rebase-merge']).catch(() => '');
    try {
      if (rebaseDir.trim() && fs.existsSync(rebaseDir.trim())) return 'rebase';
    } catch { /* */ }
    return null;
  }

  async abortMerge(): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.mergeAbort(); return; }
    await this.git.raw(['merge', '--abort']);
  }

  async abortRebase(): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.rebase('--abort' as string); return; }
    await this.git.raw(['rebase', '--abort']);
  }

  async getRemotes(): Promise<string[]> {
    const vsRepo = this.vsRepo();
    if (vsRepo) return vsRepo.state.remotes.map(r => r.name);
    const result = await this.git.getRemotes(false);
    return result.map(r => r.name);
  }

  async push(force = false, remote?: string): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const branchName = vsRepo.state.HEAD?.name;
      const hasUpstream = !!vsRepo.state.HEAD?.upstream;
      const targetRemote = remote ?? 'origin';
      const forceMode = force ? ForcePushMode.ForceWithLease : undefined;
      await vsRepo.push(targetRemote, branchName, !hasUpstream, forceMode);
      return;
    }
    const tracking = await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
    const hasUpstream = !!tracking.trim();
    const branchName = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const targetRemote = remote ?? 'origin';
    const args = ['push'];
    if (!hasUpstream) args.push('--set-upstream', targetRemote, branchName);
    else if (remote) args.push(remote, branchName);
    if (force) args.push('--force-with-lease');
    await this.git.raw(args);
  }

  async pull(): Promise<string> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      if (!vsRepo.state.HEAD?.upstream) return 'No remote tracking branch — skipped';
      await vsRepo.pull();
      return 'pulled';
    }
    const tracking = await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
    if (!tracking.trim()) return 'No remote tracking branch — skipped';
    const result = await this.git.pull();
    return `${result.summary.changes} changes, ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`;
  }

  async pullRebase(): Promise<string> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      if (!vsRepo.state.HEAD?.upstream) return 'No remote tracking branch — skipped';
      const upstream = vsRepo.state.HEAD.upstream;
      await vsRepo.fetch();
      await vsRepo.rebase(`${upstream.remote}/${upstream.name}`);
      return 'pulled (rebase)';
    }
    const tracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
    if (!tracking) return 'No remote tracking branch — skipped';
    await this.git.raw(['pull', '--rebase']);
    return 'pulled (rebase)';
  }

  async fetchAll(): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.fetch({ prune: true }); return; }
    await this.git.fetch(['--all', '--prune']);
  }

  async checkout(branchName: string, createNew?: boolean, from?: string): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      if (createNew) {
        await vsRepo.createBranch(branchName, true, from);
        return;
      }
      // Remote branch → create local tracking branch then checkout
      const remoteMatch = branchName.match(/^([^/]+)\/(.+)$/);
      if (remoteMatch) {
        const [, , localName] = remoteMatch;
        const locals = await vsRepo.getBranches({ remote: false });
        const exists = locals.some(b => b.name === localName);
        if (!exists) await vsRepo.createBranch(localName, false, branchName);
        await vsRepo.checkout(localName);
        return;
      }
      await vsRepo.checkout(branchName);
      return;
    }
    // Fallback: simple-git
    if (createNew) {
      if (from) await this.git.checkout(['-b', branchName, from]);
      else await this.git.checkoutLocalBranch(branchName);
      return;
    }
    const remoteMatch = branchName.match(/^([^/]+)\/(.+)$/);
    if (remoteMatch) {
      const [, , localName] = remoteMatch;
      const branches = await this.getBranches();
      const localExists = branches.some(b => !b.isRemote && b.name === localName);
      if (localExists) await this.git.checkout(localName);
      else await this.git.checkout(['-b', localName, '--track', branchName]);
      return;
    }
    await this.git.checkout(branchName);
  }

  async createBranch(branchName: string, from?: string): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.createBranch(branchName, false, from); return; }
    await this.git.branch(from ? [branchName, from] : [branchName]);
  }

  async merge(from: string): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.merge(from); return; }
    await this.git.merge([from]);
  }

  async rebase(onto: string): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.rebase(onto); return; }
    await this.git.rebase([onto]);
  }

  async deleteBranch(branchName: string, force: boolean): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.deleteBranch(branchName, force); return; }
    await this.git.deleteLocalBranch(branchName, force);
  }

  async checkoutForce(branchName: string): Promise<void> {
    // VS Code API has no force checkout — use simple-git
    await this.git.checkout(['-f', branchName]);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    // VS Code API has no renameBranch — use simple-git
    await this.git.branch(['-m', oldName, newName]);
  }

  async pullFromRemote(remote: string, branch: string, rebase: boolean): Promise<void> {
    // VS Code API pull() doesn't accept remote/branch args — use simple-git
    const args = rebase ? ['pull', '--rebase', remote, branch] : ['pull', remote, branch];
    await this.git.raw(args);
  }

  async cherryPick(hash: string): Promise<void> {
    await this.git.raw(['cherry-pick', hash]);
  }

  async cherryPickContinue(): Promise<void> {
    await this.git.raw(['cherry-pick', '--continue', '--no-edit']);
  }

  async cherryPickSkip(): Promise<void> {
    await this.git.raw(['cherry-pick', '--skip']);
  }

  async cherryPickAbort(): Promise<void> {
    await this.git.raw(['cherry-pick', '--abort']);
  }

  async revertCommit(hash: string): Promise<void> {
    await this.git.raw(['revert', '--no-edit', hash]);
  }

  async revertContinue(): Promise<void> {
    await this.git.raw(['revert', '--continue', '--no-edit']);
  }

  async revertAbort(): Promise<void> {
    await this.git.raw(['revert', '--abort']);
  }

  async resetTo(hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.git.raw(['reset', `--${mode}`, hash]);
  }

  async createPatch(hash: string): Promise<string> {
    return this.git.raw(['format-patch', '-1', '--stdout', hash]);
  }

  async getLastCommitMessage(): Promise<string> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      try {
        const commit = await vsRepo.getCommit('HEAD');
        return commit.message;
      } catch { /* */ }
    }
    return (await this.git.log(['-1', '--format=%s'])).latest?.message ?? '';
  }

  // ── Stash operations ──────────────────────────────────────────────────────

  async stashList(): Promise<StashEntry[]> {
    const raw = await this.git.raw(['stash', 'list', '--format=%gd|%ci|%gs']).catch(() => '');
    if (!raw.trim()) return [];

    const entries: StashEntry[] = [];
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const ref = parts[0].trim();         // stash@{N}
      const date = parts[1].trim();        // ISO date
      const subject = parts.slice(2).join('|').trim(); // "On branch: message" or "WIP on branch: message"

      const indexMatch = ref.match(/stash@\{(\d+)\}/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;

      // Parse branch from subject like "On main: ..." or "WIP on main: ..."
      const branchMatch = subject.match(/^(?:WIP on|On) ([^:]+):/);
      const branch = branchMatch ? branchMatch[1].trim() : '';
      const message = branchMatch ? subject.slice(branchMatch[0].length).trim() : subject;

      // Get files for this stash entry
      let files: Array<{ path: string; status: string }> = [];
      try {
        const fileRaw = await this.git.raw(['stash', 'show', '--name-status', ref]);
        for (const fileLine of fileRaw.trim().split('\n')) {
          if (!fileLine.trim()) continue;
          const fileParts = fileLine.split('\t');
          if (fileParts.length < 2) continue;
          const statusLetter = fileParts[0].trim();
          const filePath = fileParts[fileParts.length - 1].trim();
          const status = STATUS_MAP[statusLetter] ?? 'modified';
          files.push({ path: filePath, status });
        }
      } catch { /* stash might have no files */ }

      entries.push({ ref, index, message, date, branch, files });
    }
    return entries;
  }

  async stashShow(stashRef: string, filePath: string): Promise<string> {
    return this.git.raw(['stash', 'show', '-p', stashRef, '--', filePath]).catch(() => '');
  }

  async stashPush(message: string): Promise<void> {
    await this.git.raw(['stash', 'push', '-u', '-m', message]);
  }

  async stashApply(stashRef: string): Promise<void> {
    await this.git.raw(['stash', 'apply', stashRef]);
  }

  async stashPop(stashRef = 'stash@{0}'): Promise<void> {
    // git stash pop always pops stash@{0}, so we apply then drop
    await this.git.raw(['stash', 'apply', stashRef]);
    await this.git.raw(['stash', 'drop', stashRef]);
  }

  async stashDrop(stashRef: string): Promise<void> {
    await this.git.raw(['stash', 'drop', stashRef]);
  }

  async getStashFileContent(stashRef: string, filePath: string): Promise<string> {
    try {
      return await this.git.show([`${stashRef}:${filePath}`]);
    } catch {
      try {
        return await this.git.show([`${stashRef}^3:${filePath}`]);
      } catch {
        return '';
      }
    }
  }

  // ── Unpushed commits ──────────────────────────────────────────────────────

  async getUnpushedCommits(): Promise<UnpushedCommit[]> {
    try {
      const raw = await this.git.raw(['log', '@{u}..HEAD', '--format=%H|%h|%s|%an|%ci']);
      if (!raw.trim()) return [];
      const commits: UnpushedCommit[] = [];
      for (const line of raw.trim().split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('|');
        if (parts.length < 5) continue;
        commits.push({
          hash: parts[0].trim(),
          shortHash: parts[1].trim(),
          message: parts[2].trim(),
          author: parts[3].trim(),
          date: parts.slice(4).join('|').trim(),
        });
      }
      return commits;
    } catch {
      // No upstream set or other error — return empty
      return [];
    }
  }
}
