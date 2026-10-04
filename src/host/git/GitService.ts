import * as vscode from 'vscode';
import { guardProtectedBranch } from '../utils/protectedBranches';
import { SimpleGit } from 'simple-git';
import { createGit } from './gitClient';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  BranchInfo,
  CommitNode,
  FileStatus,
  FileDiff,
  GitFileStatus,
  RepoStatus,
  SubmoduleEntry,
} from '../types/git';
import type { CompareCounts, CompareRange, RangeFileEntry, RebaseCommit, RebasePlanEntry, StashEntry, UnpushedCommit } from '../types/messages';
import { buildRebaseTodo, shQuote } from './rebaseTodo';
import { compareRangeArgs, isSafeCompareRef } from './compareRange';
import { foldCommitChanges, parseRawLogChanges } from './combinedChanges';
import { parseDiff, detectLanguage } from './DiffParser';
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

/** Drops the comment lines git adds to prepared commit messages, the way `git commit` would. */
function stripCommitComments(raw: string): string {
  return raw.replace(/^\s*#.*$\n?/gm, '').trim();
}

export type PullMode = 'merge' | 'rebase' | 'ffOnly';

/** gitcharm.pullMode: 'ask' keeps the merge/rebase picker where GitCharm shows one. */
export function configuredPullMode(): PullMode | 'ask' {
  const mode = vscode.workspace.getConfiguration('gitcharm').get<string>('pullMode', 'ask');
  return mode === 'merge' || mode === 'rebase' || mode === 'ffOnly' ? mode : 'ask';
}

export class GitService {
  private git: SimpleGit;
  // Set immediately after a tag checkout, cleared when VS Code API confirms the update.
  private _pendingDetachedTag: string | undefined;

  constructor(public readonly repoId: string, public readonly rootPath: string) {
    this.git = createGit(rootPath);
  }

  // ── Ref-keyed cache ───────────────────────────────────────────────────────
  //
  // Branches, tags, stashes, unpushed/incoming commits and the log itself depend only on
  // the repo's refs (plus HEAD and the branch config), yet the Log Panel re-read all of them
  // for every repo on every page and refresh: ~15 git processes per repo, hundreds with a
  // few dozen submodules. They are kept here instead, valid while refsFingerprint() — one
  // git process, shared by all the reads of one load — is unchanged. Comparing against
  // the refs themselves, rather than invalidating on file events, can't serve a stale
  // value after an operation whose watcher event hasn't arrived yet.

  private refCache = new Map<string, { fingerprint: string; value: Promise<unknown>; createdAt: number }>();
  private fingerprintInFlight: Promise<string | null> | null = null;
  private fingerprintPaths: Promise<{ head: string; config: string; stashLog: string } | null> | null = null;
  /** Bounds the entries kept for log queries, whose keys vary with every filter. */
  private static readonly REF_CACHE_MAX = 24;
  /**
   * Branch and tag rows carry relative dates ("5 minutes ago") that age without any ref
   * changing; past this an entry is read again. Long enough to cover one burst of loads.
   */
  private static readonly REF_CACHE_TTL_MS = 60_000;

  /**
   * A digest of everything the cached reads depend on: every ref and the object it points
   * at, HEAD (the branch checked out, or the commit when detached), the config's mtime
   * (upstreams) and the stash reflog's mtime (dropping a stash below the top leaves
   * refs/stash as it was). Concurrent callers share one run. Null when it can't be taken,
   * in which case nothing is cached.
   */
  private refsFingerprint(): Promise<string | null> {
    if (this.fingerprintInFlight) return this.fingerprintInFlight;
    const run = (async () => {
      this.fingerprintPaths ??= this.git
        .raw(['rev-parse', '--path-format=absolute', '--git-path', 'HEAD', '--git-path', 'config', '--git-path', 'logs/refs/stash'])
        .then(out => {
          const [head, config, stashLog] = out.trim().split('\n');
          return head && config && stashLog ? { head, config, stashLog } : null;
        })
        .catch(() => null);
      const paths = await this.fingerprintPaths;
      if (!paths) return null;
      const mtime = (file: string) => fs.promises.stat(file).then(st => String(st.mtimeMs), () => '');
      const [refs, head, config, stashLog] = await Promise.all([
        this.git.raw(['for-each-ref', '--format=%(objectname) %(refname)']),
        fs.promises.readFile(paths.head, 'utf8'),
        mtime(paths.config),
        mtime(paths.stashLog),
      ]);
      return crypto.createHash('sha1').update(`${head}\0${config}\0${stashLog}\0${refs}`).digest('hex');
    })().catch(() => null);
    this.fingerprintInFlight = run;
    void run.finally(() => { if (this.fingerprintInFlight === run) this.fingerprintInFlight = null; });
    return run;
  }

  /**
   * `compute()`, or its result from an earlier call made while the refs were the same.
   * Concurrent callers share one computation. Each caller gets its own copy, so mutating
   * a result can't alter the cached one.
   *
   * `fingerprint` lets a method making several reads in a row take one fingerprint for all
   * of them; it must have been taken by that same call, so it can't predate a change the
   * caller expects to see.
   */
  private async cachedByRefs<T>(key: string, compute: () => Promise<T>, fingerprint?: Promise<string | null>): Promise<T> {
    fingerprint ??= this.refsFingerprint();
    return this.cachedWith(key, compute, await fingerprint);
  }

  private async cachedWith<T>(key: string, compute: () => Promise<T>, fingerprint: string | null): Promise<T> {
    if (fingerprint === null) return compute();
    let entry = this.refCache.get(key);
    if (!entry || entry.fingerprint !== fingerprint || Date.now() - entry.createdAt > GitService.REF_CACHE_TTL_MS) {
      const value = compute();
      entry = { fingerprint, value, createdAt: Date.now() };
      this.refCache.delete(key);
      this.refCache.set(key, entry);
      if (this.refCache.size > GitService.REF_CACHE_MAX) {
        this.refCache.delete(this.refCache.keys().next().value!);
      }
      // A failure isn't worth keeping: the next call tries again.
      value.catch(() => { if (this.refCache.get(key)?.value === value) this.refCache.delete(key); });
    }
    return structuredClone(await (entry.value as Promise<T>));
  }

  setPendingDetachedTag(tagName: string | undefined): void {
    this._pendingDetachedTag = tagName;
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

    // Override aheadBehind with a direct git count — always attempt rev-list since
    // the VS Code API's HEAD.upstream can lag and arrive undefined even when a tracking
    // branch is configured, causing ahead/behind to be silently skipped.
    let freshBranchInfo = branchInfo;
    try {
      const [aheadRaw, behindRaw] = await Promise.all([
        this.git.raw(['rev-list', '--count', '@{u}..HEAD']),
        this.git.raw(['rev-list', '--count', 'HEAD..@{u}']),
      ]);
      const ahead = parseInt(aheadRaw.trim(), 10);
      const behind = parseInt(behindRaw.trim(), 10);
      if (!isNaN(ahead) && !isNaN(behind)) {
        freshBranchInfo = { ...branchInfo, aheadBehind: { ahead, behind } };
      }
    } catch { /* no upstream configured — leave aheadBehind as-is */ }

    const stagedFiles: FileStatus[] = [];
    const unstagedFiles: FileStatus[] = [];
    let conflictCount = 0;

    const rootPrefix = this.rootPath + path.sep;
    for (const file of status.files) {
      const absPath = path.join(this.rootPath, file.path);
      if (!absPath.startsWith(rootPrefix)) continue;
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

    return { repoId: this.repoId, branch: freshBranchInfo, stagedFiles, unstagedFiles, isDetachedHead: status.detached, conflictCount, ...(await this.operationState()) };
  }

  private async getShortHash(): Promise<string | undefined> {
    try {
      return (await this.git.raw(['rev-parse', '--short', 'HEAD'])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async getFullHash(fingerprint?: Promise<string | null>): Promise<string | undefined> {
    return this.cachedByRefs('headHash', () => this.readFullHash(), fingerprint);
  }

  private async readFullHash(): Promise<string | undefined> {
    try {
      return (await this.git.raw(['rev-parse', 'HEAD'])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveHeadName(hint?: string): Promise<string> {
    if (hint) return hint;
    try {
      const name = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      return (name && name !== 'HEAD') ? name : (await this.git.raw(['branch', '--show-current'])).trim() || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }

  private async getDetachedTag(vsTagName?: string, fingerprint?: Promise<string | null>): Promise<string | undefined> {
    // Highest priority: explicitly set after a tag checkout, before VS Code API updates.
    if (this._pendingDetachedTag) return this._pendingDetachedTag;
    // VS Code API already knows the exact tag name.
    if (vsTagName) return vsTagName;
    return this.cachedByRefs('detachedTag', () => this.readDetachedTag(), fingerprint);
  }

  private async readDetachedTag(): Promise<string | undefined> {
    try {
      // git describe --tags --exact-match returns the tag whose ref IS HEAD,
      // which is precise when multiple tags point at the same commit.
      const tag = (await this.git.raw(['describe', '--tags', '--exact-match', 'HEAD'])).trim();
      return tag || undefined;
    } catch {
      try {
        const tag = (await this.git.raw(['tag', '--points-at', 'HEAD', '--sort=-creatordate'])).trim().split('\n')[0].trim();
        return tag || undefined;
      } catch {
        return undefined;
      }
    }
  }

  async getStatus(): Promise<RepoStatus> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const head = vsRepo.state.HEAD;
      // VS Code API may transiently report head.name as undefined during a branch
      // checkout before it has finished updating its internal state. When head.name
      // is absent but the type is NOT a Tag, fall back to rev-parse.
      let resolvedBranchName: string | undefined = head?.name;
      if (!resolvedBranchName && head?.type !== RefType.Tag) {
        try {
          const raw = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
          if (raw && raw !== 'HEAD') resolvedBranchName = raw;
        } catch { /* ignore, treat as genuinely detached */ }
      }
      const isDetached = !resolvedBranchName || head?.type === RefType.Tag;
      const branchName = isDetached ? 'HEAD' : resolvedBranchName!;
      // When type === Tag, head.name is the exact tag checked out
      const detachedTag = isDetached ? await this.getDetachedTag(head?.type === RefType.Tag ? head.name : undefined) : undefined;
      const detachedFullHash = (isDetached && !detachedTag) ? (head?.commit ?? await this.getFullHash()) : undefined;
      const detachedHash = detachedFullHash ? detachedFullHash.slice(0, 8) : undefined;
      const branchInfo: BranchInfo = {
        repoId: this.repoId,
        name: branchName,
        fullName: isDetached ? 'HEAD' : `refs/heads/${branchName}`,
        isHead: true,
        isRemote: false,
        upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined,
        aheadBehind: (head?.ahead !== undefined && head?.behind !== undefined)
          ? { ahead: head.ahead, behind: head.behind }
          : undefined,
        detachedTag,
        detachedHash,
        detachedFullHash,
      };

      const stagedFiles: FileStatus[] = [];
      const unstagedFiles: FileStatus[] = [];
      let conflictCount = 0;

      const rootPrefix = this.rootPath + path.sep;
      const makeFile = (change: import('./git.d').Change, staged: boolean): FileStatus | null => {
        if (!change.uri.fsPath.startsWith(rootPrefix)) return null;
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

      // VS Code API does not reliably track gitlink (submodule pointer) entries —
      // it may report them only in workingTreeChanges regardless of index state,
      // or in both simultaneously. Query their real staged/unstaged state via
      // simple-git porcelain and handle them separately.
      const submoduleRelPaths = await this.getSubmoduleRelativePaths();
      const submodulePorcelainFiles: FileStatus[] = [];
      if (submoduleRelPaths.size > 0) {
        const porcelain = await this.git.status();
        for (const file of porcelain.files) {
          if (!submoduleRelPaths.has(file.path)) continue;
          const absPath = path.join(this.rootPath, file.path);
          const index = file.index.trim();
          const workingDir = file.working_dir.trim();
          if (index && index !== ' ' && index !== '?') {
            submodulePorcelainFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: 'submodule', staged: true, unstaged: false });
          } else if (workingDir && workingDir !== ' ') {
            submodulePorcelainFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: 'submodule', staged: false, unstaged: true });
          }
        }
      }

      for (const c of vsRepo.state.indexChanges) {
        const f = makeFile(c, true);
        if (!f) continue;
        // Submodule paths are handled via porcelain above
        if (submoduleRelPaths.has(f.path)) continue;
        if (f.status === 'conflicted') conflictCount++;
        else stagedFiles.push(f);
      }
      for (const c of vsRepo.state.workingTreeChanges) {
        const f = makeFile(c, false);
        if (!f) continue;
        // Submodule paths are handled via porcelain above
        if (submoduleRelPaths.has(f.path)) continue;
        if (f.status === 'conflicted') conflictCount++;
        else unstagedFiles.push(f);
      }

      // Merge porcelain-resolved submodule entries
      for (const f of submodulePorcelainFiles) {
        if (f.staged) stagedFiles.push(f);
        else unstagedFiles.push(f);
      }
      for (const c of vsRepo.state.untrackedChanges) {
        const f = makeFile(c, false);
        if (f) unstagedFiles.push(f);
      }
      for (const c of vsRepo.state.mergeChanges) {
        if (!c.uri.fsPath.startsWith(rootPrefix)) continue;
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
        isDetachedHead: isDetached,
        conflictCount,
        ...(await this.operationState()),
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

    const rootPrefix = this.rootPath + path.sep;
    for (const file of status.files) {
      const absPath = path.join(this.rootPath, file.path);
      if (!absPath.startsWith(rootPrefix)) continue;
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

    return { repoId: this.repoId, branch: branchInfo, stagedFiles, unstagedFiles, isDetachedHead: status.detached, conflictCount, ...(await this.operationState()) };
  }

  async getCurrentBranch(): Promise<BranchInfo> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const head = vsRepo.state.HEAD;
      const vsTagName = head?.type === RefType.Tag ? head.name : undefined;
      // VS Code API may transiently report head.name as undefined during a branch
      // checkout before it has finished updating its internal state. When head.name
      // is absent but the type is NOT a Tag, fall back to rev-parse to check whether
      // we are actually on a named branch.
      let resolvedBranchName: string | undefined = head?.name;
      if (!resolvedBranchName && head?.type !== RefType.Tag) {
        try {
          const raw = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
          if (raw && raw !== 'HEAD') resolvedBranchName = raw;
        } catch { /* ignore, treat as genuinely detached */ }
      }
      const isDetached = !resolvedBranchName || head?.type === RefType.Tag;
      const branchName = isDetached ? 'HEAD' : resolvedBranchName!;
      // If VS Code API now reports the same tag as pending, the update has arrived — clear it.
      if (this._pendingDetachedTag && vsTagName === this._pendingDetachedTag) {
        this._pendingDetachedTag = undefined;
      }
      // If VS Code API reports a branch (no longer detached), clear pending.
      if (!isDetached) this._pendingDetachedTag = undefined;
      // Taken only if a cached read is needed — on a branch, none is — and shared by them.
      let fingerprint: Promise<string | null> | undefined;
      const once = () => (fingerprint ??= this.refsFingerprint());
      const detachedTag = isDetached ? await this.getDetachedTag(vsTagName, once()) : undefined;
      const detachedFullHash = (isDetached && !detachedTag) ? (head?.commit ?? await this.getFullHash(once())) : undefined;
      const detachedHash = detachedFullHash ? detachedFullHash.slice(0, 8) : undefined;
      return {
        repoId: this.repoId,
        name: branchName,
        fullName: isDetached ? `HEAD` : `refs/heads/${branchName}`,
        isHead: true,
        isRemote: false,
        upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined,
        aheadBehind: (head?.ahead !== undefined && head?.behind !== undefined)
          ? { ahead: head.ahead, behind: head.behind }
          : undefined,
        detachedTag,
        detachedHash,
        detachedFullHash,
      };
    }
    // Only the branch line is used: skip the untracked-file scan, the costly part of a status.
    // That line depends on refs alone (branch, upstream, ahead/behind), so it is cached.
    const fingerprint = this.refsFingerprint();
    const status = await this.cachedByRefs('headStatus', async () => {
      const { detached, current, tracking, ahead, behind } = await this.git.status(['--untracked-files=no']);
      return { detached, current, tracking, ahead, behind };
    }, fingerprint);
    const isDetached = status.detached;
    const branchName = await this.resolveHeadName(status.current ?? undefined);
    const detachedTag = isDetached ? await this.getDetachedTag(undefined, fingerprint) : undefined;
    const detachedFullHash = (isDetached && !detachedTag) ? await this.getFullHash(fingerprint) : undefined;
    const detachedHash = detachedFullHash ? detachedFullHash.slice(0, 8) : undefined;
    return {
      repoId: this.repoId,
      name: branchName,
      fullName: isDetached ? 'HEAD' : `refs/heads/${branchName}`,
      isHead: true,
      isRemote: false,
      upstream: status.tracking ?? undefined,
      aheadBehind: status.tracking ? { ahead: status.ahead, behind: status.behind } : undefined,
      detachedTag,
      detachedHash,
      detachedFullHash,
    };
  }

  async getBranches(): Promise<BranchInfo[]> {
    return this.cachedByRefs('branches', () => this.readBranches());
  }

  private async readBranches(): Promise<BranchInfo[]> {
    const tipMetadata = new Map<string, {
      hash: string;
      date?: string;
      dateRelative?: string;
      message?: string;
      author?: string;
    }>();
    try {
      const raw = await this.git.raw([
        'for-each-ref',
        '--format=%(objectname)%00%(committerdate:iso-strict)%00%(committerdate:relative)%00%(authorname)%00%(contents:subject)%00%(refname:short)',
        'refs/heads/',
        'refs/remotes/',
      ]);
      for (const line of raw.trim().split('\n')) {
        const [hash, date, dateRelative, author, message, name] = line.split('\0');
        if (hash && name) {
          tipMetadata.set(name, {
            hash,
            date: date || undefined,
            dateRelative: dateRelative || undefined,
            author: author || undefined,
            message: message || undefined,
          });
        }
      }
    } catch { /* branch refs still come from the primary provider */ }

    const goneBranches = new Set<string>();
    try {
      const raw = await this.git.raw([
        'for-each-ref',
        '--format=%(refname:short)%00%(upstream:track)',
        'refs/heads/',
      ]);
      for (const line of raw.trim().split('\n')) {
        const [name, track] = line.split('\0');
        if (name && track === '[gone]') goneBranches.add(name);
      }
    } catch { /* upstream:track unsupported or no upstream configured — treat as not gone */ }

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

      const headIsOnBranch = head?.type === RefType.Head;
      for (const ref of localRefs.filter(r => r.type === RefType.Head)) {
        const name = ref.name ?? '';
        const isHead = headIsOnBranch && name === head?.name;
        branches.push({
          repoId: this.repoId,
          name,
          fullName: `refs/heads/${name}`,
          isHead,
          isRemote: false,
          upstreamGone: goneBranches.has(name),
          lastCommitHash: ref.commit ?? tipMetadata.get(name)?.hash,
          lastCommitDate: tipMetadata.get(name)?.date,
          lastCommitDateRelative: tipMetadata.get(name)?.dateRelative,
          lastCommitMessage: tipMetadata.get(name)?.message,
          lastCommitAuthor: tipMetadata.get(name)?.author,
          aheadBehind: (isHead && head!.ahead !== undefined && head!.behind !== undefined)
            ? { ahead: head!.ahead, behind: head!.behind }
            : undefined,
        });
      }

      for (const ref of remoteRefs.filter(r => r.type === RefType.RemoteHead)) {
        // ref.name is already the full "remote/branch" string (e.g. "origin/noissue/team/x").
        // Use ref.remote for the remote name — splitting ref.name on '/' breaks for branch
        // names that themselves contain slashes.
        const name = ref.name ?? '';
        // Skip the remote's symbolic default-branch pointer (e.g. "origin/HEAD") — it's not
        // a real branch, just an alias, and would otherwise show up as a phantom branch.
        if (name.endsWith('/HEAD')) continue;
        const remoteName = ref.remote ?? name.split('/')[0];
        branches.push({
          repoId: this.repoId,
          name,
          fullName: `refs/remotes/${name}`,
          isHead: false,
          isRemote: true,
          remoteName,
          lastCommitHash: ref.commit ?? tipMetadata.get(name)?.hash,
          lastCommitDate: tipMetadata.get(name)?.date,
          lastCommitDateRelative: tipMetadata.get(name)?.dateRelative,
          lastCommitMessage: tipMetadata.get(name)?.message,
          lastCommitAuthor: tipMetadata.get(name)?.author,
        });
      }

      return branches;
    }

    // Fallback: simple-git
    const result = await this.git.branch(['-avv', '--sort=-committerdate']);
    const branches: BranchInfo[] = [];
    for (const [name, branch] of Object.entries(result.branches)) {
      // Skip the detached HEAD pseudo-entry (e.g. "(HEAD detached at a9b68a1)")
      if (branch.current && name.startsWith('(HEAD detached')) continue;
      const isRemote = name.startsWith('remotes/');
      const cleanName = isRemote ? name.replace(/^remotes\//, '') : name;
      // Skip the remote's symbolic default-branch pointer (e.g. "origin/HEAD") — it's not
      // a real branch, just an alias, and would otherwise show up as a phantom branch.
      if (isRemote && cleanName.endsWith('/HEAD')) continue;
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
        upstreamGone: !isRemote && goneBranches.has(cleanName),
        lastCommitHash: tipMetadata.get(cleanName)?.hash ?? branch.commit,
        lastCommitDate: tipMetadata.get(cleanName)?.date,
        lastCommitDateRelative: tipMetadata.get(cleanName)?.dateRelative,
        lastCommitMessage: tipMetadata.get(cleanName)?.message,
        lastCommitAuthor: tipMetadata.get(cleanName)?.author,
        aheadBehind,
      });
    }
    return branches;
  }

  /** Parses the null-byte-delimited `%H%x00%h%x00%P%x00%an%x00%ae%x00%ai%x00%ci%x00%D%x00%s` git log format shared by getLog and getCommitsBetween. */
  private _parseLogOutput(raw: string): CommitNode[] {
    const commits: CommitNode[] = [];
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\x00');
      if (parts.length < 9) continue;
      const [hash, shortHash, parentsRaw, authorName, authorEmail, authorDate, committerDate, refsRaw, message, mark] = parts;
      const commit: CommitNode = { hash, shortHash, repoId: this.repoId, message, authorName, authorEmail, authorDate, committerDate, parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [], refs: refsRaw ? refsRaw.split(',').map(r => r.trim()).filter(Boolean) : [] };
      // %m of a --left-right compare log, appended after the subject
      if (mark === '<') commit.compareSide = 'target';
      else if (mark === '>') commit.compareSide = 'base';
      commits.push(commit);
    }
    return commits;
  }

  /** A single commit as a full `CommitNode` (including `refs`, unlike `getCommitMeta`) — works for root commits too, unlike `getCommitsBetween(hash~1, hash)` which has no base to diff against. */
  async getCommitNode(hash: string): Promise<CommitNode | null> {
    const raw = await this.git.raw([
      'log', '--max-count=1',
      '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%ai%x00%ci%x00%D%x00%s',
      '--decorate=full', '--date=iso-strict', '--abbrev=8',
      hash,
    ]);
    return this._parseLogOutput(raw)[0] ?? null;
  }

  /** Commits reachable from `head` but not from `base` (i.e. `git log base..head`) — used to preview what a PR from `head` into `base` would bring in, before the PR exists. No unpushed/incoming marking (that's specific to local-branch-vs-upstream, not a branch-vs-branch comparison). */
  async getCommitsBetween(base: string, head: string, limit = 200): Promise<CommitNode[]> {
    const raw = await this.git.raw([
      'log', '--date-order', `--max-count=${limit}`,
      '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%ai%x00%ci%x00%D%x00%s',
      '--decorate=full', '--date=iso-strict', '--abbrev=8',
      `${base}..${head}`,
    ]);
    return this._parseLogOutput(raw);
  }

  /**
   * Commits whose hash starts with `prefix`, looked up in the object database instead
   * of walking history, so a commit is found however far back it is. As with the log
   * itself, only commits the log could show count: reachable from a ref other than the
   * stash or from HEAD — or, in compare mode, on the side(s) of the compare its mode shows.
   * `logArgs` (format and author/date filters) are applied to the matches.
   */
  private async findCommitsByHashPrefix(prefix: string, logArgs: string[], compare?: CompareRange): Promise<CommitNode[]> {
    // Every object (commit, tree, blob, tag) with the prefix; empty when none does.
    const candidates = (await this.git.raw(['rev-parse', `--disambiguate=${prefix}`]).catch(() => ''))
      .split('\n').map(l => l.trim()).filter(Boolean)
      // Bounds the command line (Windows caps it at 32K chars). Hundreds of matches
      // would take a 4-char prefix in a repo of tens of millions of objects.
      .slice(0, 500);
    if (candidates.length === 0) return [];

    // git log skips the trees and blobs among them and peels annotated tags to their
    // commit, which the prefix check then drops.
    const matches = this._parseLogOutput(
      await this.git.raw(['log', '--no-walk', ...logArgs, ...candidates]),
    ).filter(c => c.hash.toLowerCase().startsWith(prefix));

    const isAncestor = (hash: string, of: string) =>
      this.git.raw(['merge-base', '--is-ancestor', hash, of]).then(() => true, () => false);
    if (compare) {
      const mode = compare.mode ?? 'ahead';
      const sideOf = async (hash: string): Promise<'target' | 'base' | null> => {
        const [onTarget, onBase] = await Promise.all([isAncestor(hash, compare.target), isAncestor(hash, compare.base)]);
        return onTarget === onBase ? null : onTarget ? 'target' : 'base';
      };
      const sides = await Promise.all(matches.map(c => sideOf(c.hash)));
      return matches.flatMap((c, i) => {
        const side = sides[i];
        if (!side) return [];
        if (mode === 'both') return [{ ...c, compareSide: side }];
        return side === (mode === 'ahead' ? 'target' : 'base') ? [c] : [];
      });
    }
    const isReachable = async (hash: string): Promise<boolean> => {
      const refs = await this.git.raw(['for-each-ref', '--format=%(refname)', '--contains', hash]).catch(() => '');
      if (refs.split('\n').some(r => r.trim() && r.trim() !== 'refs/stash')) return true;
      return isAncestor(hash, 'HEAD');
    };
    const reachable = await Promise.all(matches.map(c => isReachable(c.hash)));
    return matches.filter((_, i) => reachable[i]);
  }

  /**
   * Compare refs are checked before anything is passed to git, so a ref can never be read
   * as an option or a second range, and a ref missing from this repo throws here — the
   * caller then drops this repo instead of the whole log.
   */
  private async verifyCompareRefs({ base, target }: CompareRange): Promise<void> {
    if (!isSafeCompareRef(base) || !isSafeCompareRef(target)) {
      throw new Error(`Invalid compare refs: ${JSON.stringify(base)}..${JSON.stringify(target)}`);
    }
    const verified = await Promise.all([base, target].map(ref =>
      this.git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => ''),
    ));
    if (verified.some(out => !out.trim())) {
      throw new Error(`Compare ref not found: ${base}..${target}`);
    }
  }

  /** Number of commits only on `target` and only on `base`, whatever the compare's mode. */
  async countCompareSides(compare: CompareRange): Promise<CompareCounts> {
    await this.verifyCompareRefs(compare);
    const out = await this.git.raw(['rev-list', '--left-right', '--count', `${compare.target}...${compare.base}`]);
    const [target, base] = out.trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
    return { target: target ?? 0, base: base ?? 0 };
  }

  // Log uses raw git format for graph rendering — VS Code API's log() lacks graph parents/refs.
  async getLog(limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; compare?: CompareRange; worktreeServices?: GitService[] }): Promise<CommitNode[]> {
    // A compare ref missing from this repo throws here: the caller's allSettled drops this repo, not the whole log
    if (opts?.compare) await this.verifyCompareRefs(opts.compare);
    const bothSides = opts?.compare?.mode === 'both';
    const isHashSearch = opts?.filterText && /^[0-9a-f]{4,40}$/i.test(opts.filterText.trim());
    // One fingerprint for the log and the unpushed/incoming reads that follow it.
    const fingerprint = this.refsFingerprint();
    const format = ['--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%ai%x00%ci%x00%D%x00%s', '--decorate=full', '--date=iso-strict', '--abbrev=8'];
    // A compare of both sides also reads each commit's side (%m, after the subject)
    const logFormat = bothSides ? [`${format[0]}%x00%m`, ...format.slice(1)] : format;
    const filterArgs: string[] = [];
    if (opts?.filterAuthor) filterArgs.push(`--author=${opts.filterAuthor}`, '--regexp-ignore-case');
    if (opts?.filterDateFrom) filterArgs.push(`--after=${opts.filterDateFrom}`);
    if (opts?.filterDateTo) filterArgs.push(`--before=${opts.filterDateTo}`);

    let commits: CommitNode[];
    if (isHashSearch) {
      // Not paginated: a hash prefix matches a handful of commits at most.
      commits = await this.findCommitsByHashPrefix(opts!.filterText!.trim().toLowerCase(), [...format, ...filterArgs], opts?.compare);
    } else {
      const args: string[] = [
        'log',
        // --date-order, not --topo-order: the log renders in committer-date order (see
        // getInterleavedLog), and asking git for a different order than the one displayed
        // meant a page's contents depended on where its boundaries fell. Date order is
        // still topological — a commit never precedes its own parent.
        '--date-order',
        `--max-count=${limit}`, `--skip=${skip}`,
        ...logFormat,
      ];
      if (opts?.filterText) args.push(`--grep=${opts.filterText}`, '--regexp-ignore-case');
      args.push(...filterArgs);
      if (opts?.compare) {
        // Compare mode replaces the branch filter
        args.push(...compareRangeArgs(opts.compare));
      } else if (opts?.filterBranch) {
        args.push(opts.filterBranch);
      } else {
        args.push('--exclude=refs/stash', '--all');
      }
      // The same query on unchanged refs gives the same commits: a refresh caused by
      // another repo, or a page re-requested, doesn't need to run git log again here.
      commits = this._parseLogOutput(await this.cachedByRefs(`log:${JSON.stringify(args)}`, () => this.git.raw(args), fingerprint));
    }

    // Mark unpushed commits: hashes ahead of the remote tracking branch.
    // 'all' means there is no upstream — every commit on this branch is local.
    const worktreeServices = opts?.worktreeServices ?? [];
    const [unpushedHashes, incomingHashes, ...worktreeUnpushedResults] = await Promise.all([
      this.getUnpushedHashes(fingerprint),
      this.getIncomingHashes(fingerprint),
      ...worktreeServices.map(wt => wt.getUnpushedHashes()),
    ]);
    const allUnpushedHashes = new Set<string>();
    if (unpushedHashes === 'all') {
      for (const c of commits) c.unpushed = true;
    } else {
      unpushedHashes.forEach(h => allUnpushedHashes.add(h));
    }
    for (const wtResult of worktreeUnpushedResults) {
      if (wtResult !== 'all') wtResult.forEach(h => allUnpushedHashes.add(h));
    }
    if (allUnpushedHashes.size > 0) {
      for (const c of commits) {
        if (allUnpushedHashes.has(c.hash)) c.unpushed = true;
      }
    }
    for (const c of commits) {
      if (incomingHashes.has(c.hash)) c.incoming = true;
    }

    return commits;
  }

  private async getUnpushedHashes(fingerprint?: Promise<string | null>): Promise<Set<string> | 'all'> {
    return this.cachedByRefs('unpushed', () => this.readUnpushedHashes(), fingerprint);
  }

  private async readUnpushedHashes(): Promise<Set<string> | 'all'> {
    try {
      const upstreamTracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      if (upstreamTracking) {
        const raw = await this.git.raw(['log', '--format=%H', `${upstreamTracking}..HEAD`]);
        return new Set(raw.trim().split('\n').filter(Boolean));
      }
      // No tracking branch — check if any remote refs exist
      const remoteRefs = (await this.git.raw(['for-each-ref', '--format=%(refname)', 'refs/remotes/']).catch(() => '')).trim();
      if (!remoteRefs) return 'all'; // no remotes at all → every commit is local
      // Remotes exist but no tracking → commits not reachable from any remote ref
      const raw = await this.git.raw(['log', '--format=%H', 'HEAD', '--not', '--remotes']);
      return new Set(raw.trim().split('\n').filter(Boolean));
    } catch {
      return new Set();
    }
  }

  async getUnpushedCount(): Promise<number> {
    try {
      const upstreamTracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      if (upstreamTracking) {
        const raw = await this.git.raw(['rev-list', '--count', `${upstreamTracking}..HEAD`]);
        return parseInt(raw.trim(), 10) || 0;
      }
      const remoteRefs = (await this.git.raw(['for-each-ref', '--format=%(refname)', 'refs/remotes/']).catch(() => '')).trim();
      if (!remoteRefs) {
        const raw = await this.git.raw(['rev-list', '--count', 'HEAD']);
        return parseInt(raw.trim(), 10) || 0;
      }
      const raw = await this.git.raw(['rev-list', '--count', 'HEAD', '--not', '--remotes']);
      return parseInt(raw.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  // Parameter on its own line: vscode-l10n-dev's extractor misreads a signature that has
  // both `<string | null>` and a closing `>>` on one line, and drops every string after it.
  private async getIncomingHashes(
    fingerprint?: Promise<string | null>,
  ): Promise<Set<string>> {
    return this.cachedByRefs('incoming', () => this.readIncomingHashes(), fingerprint);
  }

  private async readIncomingHashes(): Promise<Set<string>> {
    // Straight from git, not the VS Code Git API's HEAD: the log reloads on ref changes
    // before that API has caught up, and its stale upstream/behind (e.g. those of the
    // branch just checked out from) would leave the incoming commits unmarked.
    // Without an upstream (or with a detached HEAD) `@{u}` fails, and nothing is incoming.
    const raw = await this.git.raw(['log', '--format=%H', 'HEAD..@{u}']).catch(() => '');
    return new Set(raw.trim().split('\n').filter(Boolean));
  }

  async getMergeCommits(hash: string, parents: string[]): Promise<import('../types/messages').MergeParentCommit[]> {
    const result: import('../types/messages').MergeParentCommit[] = [];
    // parents[0] is the main branch tip, parents[1..] are the merged-in branches.
    // For each secondary parent, list commits that it introduced (not in parents[0]).
    for (let i = 1; i < parents.length; i++) {
      const range = `${parents[0]}..${parents[i]}`;
      // --shortstat appends one aggregate "N files changed, N insertions(+), N deletions(-)"
      // line after each commit — cheap way to get per-commit totals for the Full Detail
      // view without a second request per row.
      const raw = await this.git.raw([
        'log', range,
        '--format=%x01%H%x00%h%x00%an%x00%ae%x00%ai%x00%s', '--abbrev=8', '--shortstat',
      ]).catch(() => '');
      for (const entry of raw.split('\x01')) {
        if (!entry.trim()) continue;
        const [header, ...statLines] = entry.split('\n');
        const [h, sh, an, ae, ad, ...msgParts] = header.split('\x00');
        if (!h) continue;
        const statLine = statLines.join('\n');
        const filesMatch = statLine.match(/(\d+) files? changed/);
        const addMatch = statLine.match(/(\d+) insertions?\(\+\)/);
        const delMatch = statLine.match(/(\d+) deletions?\(-\)/);
        result.push({
          hash: h, shortHash: sh, message: msgParts.join('\x00'), authorName: an, authorEmail: ae, authorDate: ad, parentIndex: i,
          ...(filesMatch ? { filesChanged: parseInt(filesMatch[1], 10) } : {}),
          ...(addMatch ? { additions: parseInt(addMatch[1], 10) } : {}),
          ...(delMatch ? { deletions: parseInt(delMatch[1], 10) } : {}),
        });
      }
    }
    return result;
  }

  async getCommitFiles(hash: string, knownParents?: string[]): Promise<Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }>> {
    // For merge commits, diff-tree uses combined diff and omits most files.
    // Diff against first parent instead to get the full file list.
    let parents = knownParents;
    if (!parents) {
      const raw = await this.git.raw(['log', '-1', '--format=%P', hash]).catch(() => '');
      parents = raw.trim().split(' ').filter(Boolean);
    }
    const isMerge = parents.length >= 2;
    const isRoot  = parents.length === 0;

    const baseArgs = isMerge
      ? ['diff', '--name-status', parents[0], hash]
      : ['diff-tree', '--no-commit-id', '-r', '--name-status', ...(isRoot ? ['--root'] : []), hash];
    const numArgs = isMerge
      ? ['diff', '--numstat', parents[0], hash]
      : ['diff-tree', '--no-commit-id', '-r', '--numstat', ...(isRoot ? ['--root'] : []), hash];

    const [nameStatus, numStat] = await Promise.all([
      this.git.raw(baseArgs),
      this.git.raw(numArgs),
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
    const files: Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }> = [];
    for (const line of nameStatus.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const statusCode = parts[0][0];
      // Renames and copies: R100\told_path\tnew_path (3 parts)
      const isRenameOrCopy = (statusCode === 'R' || statusCode === 'C') && parts.length >= 3;
      const filePath = parts[parts.length - 1];
      const oldPath = isRenameOrCopy ? parts[1] : undefined;
      const s = stats.get(filePath);
      files.push({ status: statusCode, path: filePath, added: s?.added, removed: s?.removed, ...(oldPath ? { oldPath } : {}) });
    }
    return files;
  }

  async getFileHistory(filePath: string, limit = 2000): Promise<Array<{
    hash: string; shortHash: string; message: string;
    authorName: string; authorEmail: string; authorDate: string;
    status: string; oldPath?: string;
  }>> {
    const args = [
      'log', '--follow', `--max-count=${limit}`,
      '--format=%H%x00%h%x00%an%x00%ae%x00%ai%x00%s',
      '--name-status', '--diff-filter=ACDMRT', '--abbrev=8',
      '--', filePath,
    ];
    const raw = await this.git.raw(args).catch(() => '');
    const results: Array<{
      hash: string; shortHash: string; message: string;
      authorName: string; authorEmail: string; authorDate: string;
      status: string; oldPath?: string;
    }> = [];
    let current: { hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string } | null = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (line.includes('\x00')) {
        const parts = line.split('\x00');
        if (parts.length >= 6) {
          current = { hash: parts[0], shortHash: parts[1], authorName: parts[2], authorEmail: parts[3], authorDate: parts[4], message: parts[5] };
        }
        continue;
      }
      if (current && /^[ACDMRT]/.test(line)) {
        const cols = line.split('\t');
        const statusCode = cols[0][0];
        const isRename = (statusCode === 'R' || statusCode === 'C') && cols.length >= 3;
        results.push({
          ...current,
          status: statusCode,
          ...(isRename ? { oldPath: cols[1] } : {}),
        });
        current = null;
      }
    }
    return results;
  }

  async gitObjectExists(ref: string, filePath: string): Promise<boolean> {
    try {
      await this.git.raw(['cat-file', '-e', `${ref}:${filePath}`]);
      return true;
    } catch { return false; }
  }

  async getParents(hash: string): Promise<string[]> {
    try {
      const raw = await this.git.raw(['log', '-1', '--format=%P', hash]);
      return raw.trim().split(' ').filter(Boolean);
    } catch { return []; }
  }

  async findParentWithFileDiff(hash: string, filePath: string, parents: string[]): Promise<string | null> {
    const list = parents.length > 0 ? parents : await this.getParents(hash);
    for (const p of list) {
      try {
        const out = await this.git.raw(['diff', '--name-only', p, hash, '--', filePath]);
        if (out.trim()) return p;
      } catch { /* try next */ }
    }
    return list[0] ?? null;
  }

  async getCommitDiff(hash: string, maxChars = 8000): Promise<string> {
    try {
      const raw = await this.git.raw(['show', hash, '--stat', '--patch', '--format=']);
      return raw.length > maxChars ? raw.slice(0, maxChars) + '\n...[diff truncated]' : raw;
    } catch { return ''; }
  }

  /** What a PR from `head` into `base` would change — `base...head` (three dots) diffs against their merge base, the same view forges show, so commits that landed on `base` meanwhile don't show up as reverted. */
  async getBranchDiff(base: string, head: string, maxChars = 8000): Promise<string> {
    try {
      const raw = await this.git.raw(['diff', '--stat', '--patch', `${base}...${head}`]);
      return raw.length > maxChars ? raw.slice(0, maxChars) + '\n...[diff truncated]' : raw;
    } catch { return ''; }
  }

  /** Full messages (subject + body) of `git log base..head`, oldest first. */
  async getCommitMessagesBetween(base: string, head: string, limit = 100): Promise<string[]> {
    try {
      const raw = await this.git.raw(['log', '--reverse', `--max-count=${limit}`, '--format=%B%x00', `${base}..${head}`]);
      return raw.split('\0').map(m => m.trim()).filter(Boolean);
    } catch { return []; }
  }

  async getCombinedFiles(hashes: string[]): Promise<Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }>> {
    const ordered = await this._sortHashesOldestFirst(hashes);
    const oldest = ordered[0];
    const newest = ordered[ordered.length - 1];
    return oldest && newest ? this._getFilesBetweenRefs(`${oldest}~1`, newest) : [];
  }

  async getFilesBetween(hashes: string[]): Promise<Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }>> {
    const ordered = await this._sortHashesOldestFirst(hashes);
    const oldest = ordered[0];
    const newest = ordered[ordered.length - 1];
    return oldest && newest ? this._getFilesBetweenRefs(oldest, newest) : [];
  }

  private async _getFilesBetweenRefs(base: string, newest: string): Promise<Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }>> {
    try {
      const [nameStatus, numStat] = await Promise.all([
        this.git.raw(['diff', '--name-status', base, newest]),
        this.git.raw(['diff', '--numstat', base, newest]),
      ]);
      const stats = new Map<string, { added: number; removed: number }>();
      for (const line of numStat.trim().split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const added = parseInt(parts[0], 10);
        const removed = parseInt(parts[1], 10);
        const p = parts[parts.length - 1];
        if (!isNaN(added) && !isNaN(removed)) stats.set(p, { added, removed });
      }
      const files: Array<{ path: string; status: string; added?: number; removed?: number; oldPath?: string }> = [];
      for (const line of nameStatus.trim().split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 2) continue;
        const statusCode = parts[0][0];
        const filePath = parts[parts.length - 1];
        const oldPath = (statusCode === 'R' || statusCode === 'C') && parts.length >= 3 ? parts[1] : undefined;
        const s = stats.get(filePath);
        files.push({ status: statusCode, path: filePath, added: s?.added, removed: s?.removed, ...(oldPath ? { oldPath } : {}) });
      }
      return files;
    } catch { return []; }
  }

  async getCombinedFileDiff(repoId: string, hashes: string[], filePath: string): Promise<FileDiff | null> {
    const ordered = await this._sortHashesOldestFirst(hashes);
    const oldest = ordered[0];
    const newest = ordered[ordered.length - 1];
    if (!oldest || !newest) return null;
    try {
      const vsRepo = this.vsRepo();
      const rawDiff = await this.git.raw(['diff', `${oldest}~1`, newest, '--', filePath, '--no-renames']);
      const diffs = parseDiff(rawDiff || `diff --git a/${filePath} b/${filePath}\n`, repoId);
      const diff = diffs[0] ?? { repoId, oldPath: filePath, newPath: filePath, isBinary: false, isNew: false, isDeleted: false, hunks: [] };
      if (vsRepo) {
        diff.originalContent = await vsRepo.show(`${oldest}~1`, filePath).catch(() => '');
        diff.modifiedContent = await vsRepo.show(newest, filePath).catch(() => '');
      } else {
        diff.originalContent = await this.git.raw(['show', `${oldest}~1:${filePath}`]).catch(() => '');
        diff.modifiedContent = await this.git.raw(['show', `${newest}:${filePath}`]).catch(() => '');
      }
      return diff;
    } catch { return null; }
  }

  async getCombinedFilesOrder(hashes: string[]): Promise<string[]> {
    return this._sortHashesOldestFirst(hashes);
  }

  /**
   * The changes the given commits introduce, folded per file — unlike a diff between two
   * snapshots, commits in between that aren't selected don't count. Each file spans from the
   * parent of the first selected commit touching it (`baseRef`) to the last one (`headRef`),
   * following renames; a file that ends up as it started (added then deleted, a change then its
   * revert) is left out. Merges count with their changes against the first parent. Line stats
   * add up those of each commit. `orderedHashes`: the commits' full hashes, oldest first.
   */
  async getCombinedChanges(hashes: string[]): Promise<{ files: Array<Omit<RangeFileEntry, 'repoId'>>; orderedHashes: string[] }> {
    if (hashes.length === 0) return { files: [], orderedHashes: [] };
    // --no-walk prints each given commit once, newest first; \x01 marks where a commit starts
    const raw = await this.git.raw([
      'log', '--no-walk', '--diff-merges=first-parent', '--root', '-M',
      '--raw', '--numstat', '--no-abbrev', '-z', '--format=%x01%H %P', ...hashes,
    ]);
    const commits = parseRawLogChanges(raw).reverse();
    return { files: foldCommitChanges(commits), orderedHashes: commits.map(c => c.hash) };
  }

  async getRefVsWorkingTreeFiles(ref: string, folderPath: string): Promise<Array<{ path: string; status: string }>> {
    const pathArgs = folderPath ? ['--', folderPath] : [];
    const [nameStatus, untracked] = await Promise.all([
      this.git.raw(['diff', '--name-status', ref, ...pathArgs]).catch(() => ''),
      this.git.raw(['ls-files', '--others', '--exclude-standard', ...pathArgs]).catch(() => ''),
    ]);
    const files: Array<{ path: string; status: string }> = [];
    for (const line of nameStatus.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      files.push({ status: parts[0][0], path: parts[parts.length - 1] });
    }
    for (const line of untracked.trim().split('\n')) {
      const p = line.trim();
      if (p) files.push({ status: 'A', path: p });
    }
    return files;
  }

  private async _sortHashesOldestFirst(hashes: string[]): Promise<string[]> {
    if (hashes.length <= 1) return [...hashes];
    try {
      // --no-walk prints each given commit exactly once, in reverse-chronological order
      const raw = await this.git.raw(['log', '--no-walk', '--format=%H', ...hashes]);
      const ordered = raw.trim().split('\n').map(l => l.trim()).filter(h => hashes.includes(h));
      // ordered is newest-first; reverse for oldest-first
      const result = ordered.reverse();
      // Safety: ensure every hash is present
      for (const h of hashes) {
        if (!result.includes(h)) result.push(h);
      }
      return result;
    } catch {
      return [...hashes];
    }
  }

  /**
   * Diff of the given paths as they would be committed: only the index when `stagedOnly`,
   * otherwise index + working tree against HEAD (untracked files have no diff).
   */
  async getCommitDiffForPaths(paths: string[], stagedOnly: boolean, maxChars = 8000): Promise<string> {
    if (paths.length === 0) return '';
    try {
      let raw: string;
      if (stagedOnly) {
        raw = await this.git.raw(['diff', '--cached', '--', ...paths]);
      } else {
        raw = await this.git.raw(['diff', 'HEAD', '--', ...paths]).catch(async () => {
          // No HEAD yet (initial commit): combine staged and unstaged changes
          const staged = await this.git.raw(['diff', '--cached', '--', ...paths]).catch(() => '');
          const unstaged = await this.git.raw(['diff', '--', ...paths]).catch(() => '');
          return staged + unstaged;
        });
      }
      return raw.length > maxChars ? raw.slice(0, maxChars) + '\n...[diff truncated]' : raw;
    } catch { return ''; }
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
    // Always use simple-git for gitlink (submodule pointer) entries —
    // vsRepo.add() silently ignores mode-160000 entries.
    const submodulePaths = await this.getSubmoduleRelativePaths();
    const [gitlinkPaths, regularPaths] = paths.reduce<[string[], string[]]>(
      ([gl, reg], p) => submodulePaths.has(p) ? [[...gl, p], reg] : [gl, [...reg, p]],
      [[], []]
    );
    if (gitlinkPaths.length > 0) {
      // Distinguish two cases that both show ' M' in the parent's porcelain:
      //   1. Submodule has a new commit (HEAD differs from parent's recorded pointer) → stageable (+prefix in submodule status)
      //   2. Submodule only has uncommitted working-tree changes, no new commit → NOT stageable (no prefix, or - for uninit)
      const submoduleStatusRaw = await this.git.raw(['submodule', 'status', '--', ...gitlinkPaths]).catch(() => '');
      // Each line: <prefix><sha> <path> (<describe>)
      // prefix: ' ' = matches parent index, '+' = different commit, '-' = uninitialised, 'U' = merge conflict
      const submoduleHasNewCommit = new Set<string>();
      for (const line of submoduleStatusRaw.split('\n')) {
        const m = line.match(/^([+\- U])([0-9a-f]+)\s+(\S+)/);
        if (!m) continue;
        const prefix = m[1];
        const relPath = m[3];
        if (prefix === '+') submoduleHasNewCommit.add(relPath);
      }
      const notStageable = gitlinkPaths.filter(p => {
        const porcelain = submoduleHasNewCommit.has(p);
        return !porcelain; // not stageable if no new commit
      });
      if (notStageable.length > 0) {
        const names = notStageable.map(p => path.basename(p)).join(', ');
        throw new Error(
          vscode.l10n.t('Cannot stage {0}: the submodule has uncommitted changes but no new commit. Commit inside the submodule first, then stage the pointer here.', names)
        );
      }
      await this.git.raw(['add', '--', ...gitlinkPaths]);
    }
    if (regularPaths.length > 0) {
      if (vsRepo) {
        await vsRepo.add(regularPaths.map(p => path.resolve(this.rootPath, p)));
      } else {
        const rootPrefix = this.rootPath + path.sep;
        const safePaths = regularPaths.filter(p => path.join(this.rootPath, p).startsWith(rootPrefix));
        if (safePaths.length > 0) await this.git.add(safePaths);
      }
    }
  }

  async stageAll(): Promise<void> {
    const vsRepo = this.vsRepo();
    const submodulePaths = await this.getSubmoduleRelativePaths();

    if (submodulePaths.size > 0) {
      const subPaths = [...submodulePaths];
      const submoduleStatusRaw = await this.git.raw(['submodule', 'status', '--', ...subPaths]).catch(() => '');
      const submoduleHasNewCommit = new Set<string>();
      for (const line of submoduleStatusRaw.split('\n')) {
        const m = line.match(/^([+\- U])([0-9a-f]+)\s+(\S+)/);
        if (m && m[1] === '+') submoduleHasNewCommit.add(m[3]);
      }
      const stageable = subPaths.filter(p => submoduleHasNewCommit.has(p));
      const notStageable = subPaths.filter(p => !submoduleHasNewCommit.has(p) && submoduleStatusRaw.includes(p));
      if (stageable.length > 0) await this.git.raw(['add', '--', ...stageable]);
      if (notStageable.length > 0) {
        const names = notStageable.map(p => path.basename(p)).join(', ');
        throw new Error(
          vscode.l10n.t('Cannot stage {0}: the submodule has uncommitted changes but no new commit. Commit inside the submodule first, then stage the pointer here.', names)
        );
      }
    }

    if (vsRepo) {
      const all = [
        ...vsRepo.state.workingTreeChanges,
        ...vsRepo.state.untrackedChanges,
        ...vsRepo.state.mergeChanges,
      ].map(c => c.uri.fsPath).filter(p => {
        const rel = path.relative(this.rootPath, p).split(path.sep).join('/');
        return !submodulePaths.has(rel);
      });
      if (all.length) await vsRepo.add(all);
      return;
    }
    await this.git.add('.');
  }

  async unstageFiles(paths: string[]): Promise<void> {
    const vsRepo = this.vsRepo();
    // Always use simple-git for gitlink (submodule pointer) entries.
    const submodulePaths = await this.getSubmoduleRelativePaths();
    const [gitlinkPaths, regularPaths] = paths.reduce<[string[], string[]]>(
      ([gl, reg], p) => submodulePaths.has(p) ? [[...gl, p], reg] : [gl, [...reg, p]],
      [[], []]
    );
    if (gitlinkPaths.length > 0) {
      await this.git.reset(['HEAD', '--', ...gitlinkPaths]);
    }
    if (regularPaths.length > 0) {
      if (vsRepo) {
        await vsRepo.revert(regularPaths.map(p => path.resolve(this.rootPath, p)));
      } else {
        await this.git.reset(['HEAD', '--', ...regularPaths]);
      }
    }
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
      try { fs.unlinkSync(absPath); } catch { /* already gone */ }
      return;
    }

    // For tracked changes (modified, staged, deleted): restore both index and working tree.
    await this.git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', filePath])
      .catch(() => this.git.raw(['restore', '--staged', '--worktree', '--', filePath]))
      .catch(() => this.git.checkout(['--', filePath]));
  }

  async commit(message: string, amend: boolean, credentials?: { gitName: string; gitEmail: string }, log?: (s: string) => void): Promise<string> {
    log?.(`GitService.commit — credentials=${JSON.stringify(credentials)} amend=${amend}`);
    await guardProtectedBranch('commit', this.rootPath, await this.headBranchName());
    const signoff = vscode.workspace.getConfiguration('gitcharm').get<boolean>('commitSignoff', false);
    if (credentials?.gitName && credentials?.gitEmail) {
      const flags = [
        '-c', `user.name=${credentials.gitName}`,
        '-c', `user.email=${credentials.gitEmail}`,
        'commit', '-m', message,
        ...(amend ? ['--amend'] : []),
        ...(signoff ? ['--signoff'] : []),
      ];
      log?.(`GitService.commit — running git.raw with flags: ${JSON.stringify(flags)}`);
      await this.git.raw(flags);
      return '';
    }
    log?.(`GitService.commit — no credentials, using vsRepo/simple-git`);
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      await vsRepo.commit(message, { amend, signoff });
      return '';
    }
    const result = await this.git.commit(message, undefined, { ...(amend ? { '--amend': null } : {}), ...(signoff ? { '--signoff': null } : {}) });
    return result.summary.changes.toString();
  }

  /**
   * Absolute path of the repo's git dir. It is a plain file for worktrees and
   * submodules, so resolve it through git once and cache it.
   */
  private gitDirPromise?: Promise<string>;
  private gitDir(): Promise<string> {
    return this.gitDirPromise ??= this.git
      .raw(['rev-parse', '--absolute-git-dir'])
      .then(out => out.trim() || path.join(this.rootPath, '.git'))
      .catch(() => path.join(this.rootPath, '.git'));
  }

  // ponytail: commit.template is resolved once per session; a mid-session config
  // change needs a window reload. Watch .git/config if that ever matters.
  private commitTemplatePromise?: Promise<string>;
  private commitTemplate(): Promise<string> {
    return this.commitTemplatePromise ??= (async () => {
      const configured = (await this.git.raw(['config', '--get', 'commit.template']).catch(() => '')).trim();
      if (!configured) return '';
      // git expands a leading ~ / ~user itself — mirror that before reading.
      let templatePath = configured.replace(/^~([^/]*)\//, (_m, user: string) =>
        `${user ? path.join(path.dirname(os.homedir()), user) : os.homedir()}/`);
      if (!path.isAbsolute(templatePath)) templatePath = path.join(this.rootPath, templatePath);
      try {
        return stripCommitComments(fs.readFileSync(templatePath, 'utf8'));
      } catch {
        return '';
      }
    })();
  }

  /** The message git prepared for an in-progress rebase, merge, or squash, or '' if none. */
  async getMergeSquashMessage(): Promise<string> {
    const dir = await this.gitDir();
    // Rebase message files first: a conflicted pick can leave MERGE_MSG behind from a merge commit.
    for (const name of ['rebase-merge/message', 'rebase-apply/message', 'MERGE_MSG', 'SQUASH_MSG']) {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue; // no merge / squash in progress
      }
      const message = stripCommitComments(raw);
      if (message) return message;
    }
    return '';
  }

  /**
   * The message the commit box should seed itself with when empty — the same sources
   * VS Code's Source Control input uses: the message git prepared for an in-progress
   * merge or squash, otherwise the configured commit.template. Empty when there is
   * nothing to seed.
   */
  async getInputTemplate(): Promise<string> {
    const mergeSquash = await this.getMergeSquashMessage();
    if (mergeSquash) return mergeSquash;
    return this.commitTemplate();
  }

  /**
   * Whether a merge or rebase is still open. Read off the git dir rather than the
   * VS Code API, which only reports a merge while conflicts are unresolved — the
   * operation is still in progress after they are staged, and that is exactly when
   * the panel needs to offer Continue. Cheap enough for every status refresh.
   */
  async getMergeRebaseState(): Promise<'merge' | 'rebase' | null> {
    const dir = await this.gitDir();
    const exists = (name: string) => { try { return fs.existsSync(path.join(dir, name)); } catch { return false; } };
    // Rebase wins: an interactive rebase can leave MERGE_HEAD behind on a conflicted pick.
    if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
    if (exists('MERGE_HEAD')) return 'merge';
    return null;
  }

  /** The RepoStatus fields of a merge or rebase in progress. */
  private async operationState(): Promise<Pick<RepoStatus, 'mergeRebaseState' | 'rebaseProgress'>> {
    const state = await this.getMergeRebaseState();
    if (state !== 'rebase') return { mergeRebaseState: state ?? undefined };
    return { mergeRebaseState: state, rebaseProgress: await this.getRebaseProgress() };
  }

  async rebaseContinue(): Promise<void> {
    // `rebase --continue` opens an editor for the commit being replayed. core.editor=true
    // is the no-op shell builtin, so the stored message is accepted unchanged and the
    // command never blocks — simple-git needs allowUnsafeEditor to let the override past.
    await createGit(this.rootPath, { unsafe: { allowUnsafeEditor: true } })
      .raw(['-c', 'core.editor=true', 'rebase', '--continue']);
  }

  // Raw git rather than vsRepo() — getMergeRebaseState() (which the panel uses to decide
  // whether Abort should even be offered) reads the git dir directly, and VS Code's API
  // state can disagree with it (e.g. once conflicts are staged); using the same source
  // for both the check and the action avoids Abort silently no-op'ing against stale state.
  async abortMerge(): Promise<void> {
    await this.git.raw(['merge', '--abort']);
  }

  async abortRebase(): Promise<void> {
    await this.git.raw(['rebase', '--abort']);
  }

  async rebaseSkip(): Promise<void> {
    await createGit(this.rootPath, { unsafe: { allowUnsafeEditor: true } })
      .raw(['-c', 'core.editor=true', 'rebase', '--skip']);
  }

  /**
   * How far an interactive rebase has got: commits replayed (the one it stopped at included) out of all of
   * them. Counted from the todo files rather than msgnum/end, which also count label and exec lines.
   */
  async getRebaseProgress(): Promise<{ step: number; total: number } | undefined> {
    const dir = path.join(await this.gitDir(), 'rebase-merge');
    const count = (name: string) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8').split('\n')
          .filter(l => /^(p|pick|r|reword|e|edit|s|squash|f|fixup|m|merge)\s/.test(l.trim())).length;
      } catch {
        return -1;
      }
    };
    const done = count('done');
    const todo = count('git-rebase-todo');
    if (done < 0 || todo < 0 || done + todo === 0) return undefined;
    return { step: done, total: done + todo };
  }

  /** Whether tracked files have uncommitted changes, which keep a rebase from starting. */
  async hasTrackedChanges(): Promise<boolean> {
    return (await this.git.raw(['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
  }

  async isAncestorOfHead(hash: string): Promise<boolean> {
    return this.git.raw(['merge-base', '--is-ancestor', hash, 'HEAD']).then(() => true, () => false);
  }

  /**
   * The commits an interactive rebase onto `upstream` replays (null: the whole history, `--root`), oldest
   * first — as git lists them in its todo: no merge commits, and none whose change `upstream` already has.
   */
  async getRebaseCommits(upstream: string | null): Promise<{ commits: RebaseCommit[]; mergeCount: number }> {
    const RS = '\x1E', GS = '\x1D';
    const range = upstream ? ['--right-only', '--cherry-pick', `${upstream}...HEAD`] : ['HEAD'];
    const [raw, merges, unpushed] = await Promise.all([
      this.git.raw(['log', '--no-merges', '--topo-order', '--reverse', '--abbrev=8', `--format=%H${GS}%h${GS}%aN${GS}%aI${GS}%B${RS}`, ...range, '--']),
      this.git.raw(['rev-list', '--count', '--merges', upstream ? `${upstream}..HEAD` : 'HEAD', '--']),
      this.readUnpushedHashes(),
    ]);
    const commits = raw.split(RS).map(r => r.replace(/^\n/, '')).filter(Boolean).map(record => {
      const [hash, shortHash, authorName, authorDate, body = ''] = record.split(GS);
      const message = body.trim();
      return {
        hash, shortHash, authorName, authorDate, message,
        subject: message.split('\n')[0] ?? '',
        pushed: unpushed !== 'all' && !unpushed.has(hash),
      };
    });
    return { commits, mergeCount: parseInt(merges.trim(), 10) || 0 };
  }

  /**
   * Runs an interactive rebase that carries out `plan` (oldest first) without stopping for an editor — it
   * only stops where the plan says edit, or on a conflict. The todo and the new messages are written to
   * the git dir, where the exec lines of a rebase resumed later (even after a reload) still find them.
   */
  async interactiveRebase(upstream: string | null, plan: RebasePlanEntry[], subjects: ReadonlyMap<string, string>, autostash: boolean): Promise<void> {
    const dir = path.join(await this.gitDir(), 'gitcharm-rebase');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const todo = buildRebaseTodo(plan, subjects, (index, message) => {
      const file = path.join(dir, `message-${index}`);
      fs.writeFileSync(file, message.endsWith('\n') ? message : `${message}\n`);
      return file;
    });
    const todoFile = path.join(dir, 'git-rebase-todo');
    fs.writeFileSync(todoFile, todo);
    // git hands sequence.editor the todo it generated; copying ours over it is the whole edit. core.editor=true
    // accepts any message git would still ask for (a squash left to git) unchanged.
    await createGit(this.rootPath, { unsafe: { allowUnsafeEditor: true } }).raw([
      '-c', `sequence.editor=cp ${shQuote(todoFile)}`, '-c', 'core.editor=true',
      'rebase', '--interactive', ...(autostash ? ['--autostash'] : []), ...(upstream ? [upstream] : ['--root']),
    ]);
    // Done without stopping: no exec line is left to read the messages. (A stopped rebase leaves them for the next run to clear.)
    fs.rmSync(dir, { recursive: true, force: true });
  }

  async getRemotes(): Promise<string[]> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const fromApi = vsRepo.state.remotes.map(r => r.name);
      // VS Code API may return empty remotes for repos it considers a submodule kind —
      // fall back to simple-git to get the real list.
      if (fromApi.length > 0) return fromApi;
    }
    const result = await this.git.getRemotes(false);
    return result.map(r => r.name);
  }

  async getRemotesWithUrls(): Promise<{ name: string; fetchUrl: string; pushUrl: string }[]> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const fromApi = vsRepo.state.remotes;
      if (fromApi.length > 0) {
        return fromApi.map(r => ({
          name: r.name,
          fetchUrl: r.fetchUrl ?? '',
          pushUrl: r.pushUrl ?? r.fetchUrl ?? '',
        }));
      }
    }
    const result = await this.git.getRemotes(true);
    return result.map(r => ({
      name: r.name,
      fetchUrl: r.refs.fetch ?? '',
      pushUrl: r.refs.push ?? r.refs.fetch ?? '',
    }));
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.git.addRemote(name, url);
    this.vsRepo()?.fetch?.();
  }

  async removeRemote(name: string): Promise<void> {
    await this.git.removeRemote(name);
  }

  async renameRemote(oldName: string, newName: string): Promise<void> {
    await this.git.remote(['rename', oldName, newName]);
  }

  async setRemoteUrl(name: string, url: string): Promise<void> {
    await this.git.remote(['set-url', name, url]);
  }

  async getBranchUpstream(branchName: string): Promise<{ remote: string; branchName: string } | null> {
    const localRef = `refs/heads/${branchName}`;
    const raw = await this.git.raw([
      'for-each-ref',
      '--format=%(upstream:remotename)%00%(upstream:remoteref)',
      localRef,
    ]).catch(() => '');
    const [remote, remoteRef] = raw.trim().split('\0');
    if (!remote || remote === '.' || !remoteRef?.startsWith('refs/heads/')) return null;
    return { remote, branchName: remoteRef.slice('refs/heads/'.length) };
  }

  async pushBranch(branchName: string, remote: string, remoteBranchName: string, setUpstream: boolean): Promise<void> {
    await guardProtectedBranch('push', this.rootPath, remoteBranchName);
    const refspec = `refs/heads/${branchName}:refs/heads/${remoteBranchName}`;
    const vsRepo = this.vsRepo();
    if (vsRepo?.state.remotes.some(item => item.name === remote)) {
      await vsRepo.push(remote, refspec, setUpstream);
      return;
    }
    const args = ['push'];
    if (setUpstream) args.push('--set-upstream');
    args.push(remote, refspec);
    await this.git.raw(args);
  }

  /**
   * Upstream tracking state read straight from git (VS Code's cached HEAD can lag), plus
   * whether a divergence looks like rewritten history rather than genuine new remote work.
   */
  async getUpstreamState(): Promise<{ upstream?: string; ahead: number; behind: number; rewritten: boolean }> {
    const upstream = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
    if (!upstream) return { ahead: 0, behind: 0, rewritten: false };
    const [aheadRaw, behindRaw] = await Promise.all([
      this.git.raw(['rev-list', '--count', `${upstream}..HEAD`]).catch(() => '0'),
      this.git.raw(['rev-list', '--count', `HEAD..${upstream}`]).catch(() => '0'),
    ]);
    const ahead = parseInt(aheadRaw.trim(), 10) || 0;
    const behind = parseInt(behindRaw.trim(), 10) || 0;
    const rewritten = ahead > 0 && behind > 0 && await this.isDivergenceRewrite(upstream);
    return { upstream, ahead, behind, rewritten };
  }

  /**
   * True when the commits only the upstream has look like older versions of our own —
   * the signature of an amend, rebase or squash rather than someone else's new commits.
   * Checked two ways: patch equivalence (`git cherry` marks those with "-"), which catches
   * message-only rewrites, and matching subjects, which catches rewrites that changed content.
   */
  private async isDivergenceRewrite(upstream: string): Promise<boolean> {
    try {
      const [cherryRaw, oursRaw, theirsRaw] = await Promise.all([
        this.git.raw(['cherry', 'HEAD', upstream]).catch(() => ''),
        this.git.raw(['log', '--format=%s', `${upstream}..HEAD`]).catch(() => ''),
        this.git.raw(['log', '--format=%s', `HEAD..${upstream}`]).catch(() => ''),
      ]);
      const cherry = cherryRaw.trim().split('\n').map(l => l.trim()).filter(Boolean);
      if (cherry.length > 0 && cherry.every(l => l.startsWith('-'))) return true;
      const ours = new Set(oursRaw.split('\n').map(l => l.trim()).filter(Boolean));
      const theirs = theirsRaw.split('\n').map(l => l.trim()).filter(Boolean);
      return theirs.length > 0 && theirs.every(subject => ours.has(subject));
    } catch {
      return false;
    }
  }

  async push(force = false, remote?: string): Promise<string> {
    await guardProtectedBranch(force ? 'forcePush' : 'push', this.rootPath, await this.headBranchName());
    const vsRepo = this.vsRepo();
    // Only use VS Code API when it actually knows the remotes for this repo.
    // If remotes are empty VS Code would push to an unknown remote (exit 128).
    // Repos where VS Code lists no remotes are typically SSH-keyed or use a
    // system credential helper, so falling back to simple-git is safe there.
    if (vsRepo && vsRepo.state.remotes.length > 0) {
      const hasUpstream = !!vsRepo.state.HEAD?.upstream;
      // Nothing ahead of upstream means a push would be a silent no-op — skip it
      // so callers (e.g. the push-all notification) don't count it as pushed.
      if (hasUpstream && !force && !vsRepo.state.HEAD?.ahead) return 'Nothing to push — skipped';
      const branchName = vsRepo.state.HEAD?.name;
      const targetRemote = remote ?? vsRepo.state.HEAD?.upstream?.remote ?? vsRepo.state.remotes[0]?.name ?? 'origin';
      const forceMode = force ? ForcePushMode.ForceWithLease : undefined;
      // Let the original error (with its stderr/gitErrorCode intact) propagate as-is —
      // callers need the raw detail to show an accurate message (e.g. a failing hook's
      // real output), not a string pre-collapsed by formatGitError.
      await vsRepo.push(targetRemote, branchName, !hasUpstream, forceMode);
      return 'pushed';
    }
    const tracking = await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
    const hasUpstream = !!tracking.trim();
    const branchName = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (hasUpstream && !force) {
      const status = await this.git.status().catch(() => undefined);
      if (status && !status.ahead) return 'Nothing to push — skipped';
    }
    // Derive remote from tracking branch (e.g. "upstream/main" → "upstream"), else first available remote.
    const trackingRemote = tracking.trim().split('/')[0] || '';
    const firstRemote = (await this.getRemotes().catch(() => []))[0] ?? 'origin';
    const targetRemote = remote ?? (trackingRemote || firstRemote);
    const args = ['push'];
    if (!hasUpstream) args.push('--set-upstream', targetRemote, branchName);
    else if (remote) args.push(remote, branchName);
    if (force) args.push('--force-with-lease');
    await this.git.raw(args);
    return 'pushed';
  }

  /** The checked-out branch's name, or undefined on a detached HEAD. */
  private async headBranchName(): Promise<string | undefined> {
    const fromApi = this.vsRepo()?.state.HEAD?.name;
    if (fromApi) return fromApi;
    const name = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    return name && name !== 'HEAD' ? name : undefined;
  }

  async pull(): Promise<string> {
    const vsRepo = this.vsRepo();
    if (vsRepo && vsRepo.state.remotes.length > 0) {
      if (!vsRepo.state.HEAD?.upstream) return vscode.l10n.t('No remote tracking branch — skipped');
      await vsRepo.pull();
      return vscode.l10n.t('pulled');
    }
    const tracking = await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
    if (!tracking.trim()) return vscode.l10n.t('No remote tracking branch — skipped');
    const result = await this.git.pull();
    return vscode.l10n.t('{0} files changed, {1} insertions, {2} deletions', result.summary.changes, result.summary.insertions, result.summary.deletions);
  }

  /** Pulls the way gitcharm.pullMode says ("ask" only matters where a pull picker is shown: plain pulls merge). */
  async pullWithDefault(): Promise<string> {
    const mode = configuredPullMode();
    return this.pullWith(mode === 'ask' ? 'merge' : mode);
  }

  async pullWith(mode: PullMode): Promise<string> {
    if (mode === 'rebase') return this.pullRebase();
    if (mode === 'ffOnly') return this.pullFastForwardOnly();
    return this.pull();
  }

  /** Pulls only when the branch can fast-forward: git refuses otherwise, leaving local commits untouched. */
  async pullFastForwardOnly(): Promise<string> {
    const tracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
    if (!tracking) return vscode.l10n.t('No remote tracking branch — skipped');
    await this.git.raw(['pull', '--ff-only']);
    return vscode.l10n.t('pulled (fast-forward)');
  }

  async pullRebase(): Promise<string> {
    const vsRepo = this.vsRepo();
    if (vsRepo && vsRepo.state.remotes.length > 0) {
      if (!vsRepo.state.HEAD?.upstream) return vscode.l10n.t('No remote tracking branch — skipped');
      const upstream = vsRepo.state.HEAD.upstream;
      await vsRepo.fetch();
      await vsRepo.rebase(`${upstream.remote}/${upstream.name}`);
      return vscode.l10n.t('pulled (rebase)');
    }
    const tracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
    if (!tracking) return vscode.l10n.t('No remote tracking branch — skipped');
    await this.git.raw(['pull', '--rebase']);
    return vscode.l10n.t('pulled (rebase)');
  }

  async fetchAll(): Promise<void> {
    const prune = vscode.workspace.getConfiguration('gitcharm').get<boolean>('fetchPrune', true);
    const vsRepo = this.vsRepo();
    if (vsRepo && vsRepo.state.remotes.length > 0) { await vsRepo.fetch({ prune }); return; }
    await this.git.fetch(['--all', ...(prune ? ['--prune'] : [])]);
  }

  async checkout(branchName: string, createNew?: boolean, from?: string): Promise<void> {
    this._pendingDetachedTag = undefined;
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      if (createNew) {
        await vsRepo.createBranch(branchName, true, from);
        return;
      }
      // If branchName already names an existing local branch verbatim, check it out directly —
      // don't run it through remote-name splitting just because it contains a slash (e.g. a
      // local branch legitimately named "noissue/team/FOO" must not be mistaken for a
      // "noissue" remote + "team/FOO" branch).
      const locals = await vsRepo.getBranches({ remote: false });
      if (locals.some(b => b.name === branchName)) {
        await vsRepo.checkout(branchName);
        return;
      }
      // Remote branch → create local tracking branch then checkout
      const remoteMatch = branchName.match(/^([^/]+)\/(.+)$/);
      if (remoteMatch) {
        const [, , localName] = remoteMatch;
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
    const branches = await this.getBranches();
    if (branches.some(b => !b.isRemote && b.name === branchName)) {
      await this.git.checkout(branchName);
      return;
    }
    const remoteMatch = branchName.match(/^([^/]+)\/(.+)$/);
    if (remoteMatch) {
      const [, , localName] = remoteMatch;
      const localExists = branches.some(b => !b.isRemote && b.name === localName);
      if (localExists) await this.git.checkout(localName);
      else await this.git.checkout(['-b', localName, '--track', branchName]);
      return;
    }
    await this.git.checkout(branchName);
  }

  async checkoutDetached(ref: string): Promise<void> {
    // VS Code's Repository.checkout(treeish) has no detached option and would follow
    // a branch name instead of detaching from it, so this always shells out directly.
    this._pendingDetachedTag = undefined;
    await this.git.raw(['checkout', '--detach', ref]);
  }

  async checkoutDetachedForce(ref: string): Promise<void> {
    this._pendingDetachedTag = undefined;
    await this.git.raw(['checkout', '--detach', '-f', ref]);
  }

  async createBranch(branchName: string, from?: string): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.createBranch(branchName, false, from); return; }
    await this.git.branch(from ? [branchName, from] : [branchName]);
  }

  /**
   * Merge `from` into the current branch. Returns whether HEAD actually moved:
   * git exits 0 with "Already up to date" when there is nothing to merge, and
   * callers must not report that as a completed merge.
   */
  async merge(from: string): Promise<{ upToDate: boolean }> {
    const before = await this.getFullHash();
    try {
      await this.git.merge([from]);
    } catch (e: unknown) {
      const isDirty = (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree'
        || String(e).includes('overwritten by merge')
        || String(e).includes('Your local changes');
      if (!isDirty) throw e;
      // Stash uncommitted changes, retry merge, then restore stash.
      // If the merge produces conflicts the stash pop will also conflict —
      // the user resolves both sets in the normal conflict flow.
      const stashRef = `WIP before merge of ${from}`;
      await this.git.stash(['push', '-m', stashRef]);
      try {
        await this.git.merge([from]);
      } catch (mergeErr: unknown) {
        // Merge failed (e.g. conflicts) — pop stash on top so the user
        // ends up with both the merge conflicts and their original changes.
        await this.git.stash(['pop']).catch(() => {});
        throw mergeErr;
      }
      await this.git.stash(['pop']);
    }
    return { upToDate: !!before && before === await this.getFullHash() };
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

  /** Deletes a branch on the remote itself (`git push <remote> --delete <branch>`), not just
   * the local remote-tracking ref — `branchName` is the bare branch name, without the
   * `<remote>/` prefix a remote-tracking BranchInfo carries in its `name`. */
  async deleteRemoteBranch(remote: string, branchName: string): Promise<void> {
    await this.git.raw(['push', remote, '--delete', `refs/heads/${branchName}`]);
  }

  /**
   * Resolves the remote's actual default branch (bare name, e.g. "main") via the
   * `refs/remotes/<remote>/HEAD` symref — the same pointer `git clone` sets up and that
   * GitHub/GitLab/etc. report as the repository's default branch. Falls back to asking the
   * remote directly (`ls-remote --symref`, no local state changed) when the symref hasn't
   * been set up locally (e.g. a shallow clone, or after `git remote add` without a fetch).
   * Returns undefined if neither resolves (offline, remote unreachable, no such remote).
   */
  async getRemoteDefaultBranch(remote: string): Promise<string | undefined> {
    try {
      const raw = await this.git.raw(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
      const ref = raw.trim();
      if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
    } catch { /* symref not set up locally — fall through to asking the remote */ }

    try {
      const raw = await this.git.raw(['ls-remote', '--symref', remote, 'HEAD']);
      // e.g. "ref: refs/heads/main\tHEAD"
      const match = raw.match(/^ref:\s*refs\/heads\/(\S+)\s+HEAD/m);
      if (match) return match[1];
    } catch { /* remote unreachable — caller falls back to the naming heuristic */ }

    return undefined;
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

  /**
   * Updates a local branch from its upstream without checking it out, by fetching straight
   * into the local ref. Git refuses this fetch when it isn't a fast-forward, which is the
   * right outcome here — there's no working tree to merge into for a branch that isn't current.
   */
  async pullBranchFastForward(remote: string, remoteBranchName: string, localBranch: string): Promise<void> {
    await this.git.raw(['fetch', remote, `${remoteBranchName}:${localBranch}`]);
  }

  async localBranchExists(branch: string): Promise<boolean> {
    try {
      await this.git.raw(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetches a forge PR's head ref into a local branch (creating or force-updating it) and checks it out.
   * `remoteRef` is provider-specific — e.g. GitHub's `pull/{number}/head`.
   * Mirrors merge()'s dirty-tree stash/retry pattern, since a force-updating fetch can't move the
   * ref of the currently checked-out branch while the working tree has uncommitted changes.
   */
  async checkoutPullRequest(remote: string, remoteRef: string, localBranch: string): Promise<void> {
    const currentBranch = await this.getCurrentBranch().catch(() => null);
    const isCurrent = currentBranch?.name === localBranch;

    const fetchAndMove = () => this.git.raw(['fetch', remote, `+${remoteRef}:refs/heads/${localBranch}`]);

    if (!isCurrent) {
      // Not checked out anywhere — force-updating the ref directly is always safe.
      await fetchAndMove();
      await this.checkout(localBranch);
      return;
    }

    // Currently checked out: fetch into a temp ref first, then reset the branch onto it,
    // so a dirty tree fails at the reset step (catchable) rather than corrupting refs mid-fetch.
    await this.git.raw(['fetch', remote, `${remoteRef}:refs/pr-checkout-fetch-tmp`]);
    try {
      await this.git.reset(['--hard', 'refs/pr-checkout-fetch-tmp']);
    } catch (e: unknown) {
      const isDirty = (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree'
        || String(e).includes('overwritten by checkout')
        || String(e).includes('Your local changes');
      if (!isDirty) throw e;
      const stashRef = `WIP before checking out PR branch ${localBranch}`;
      await this.git.stash(['push', '-m', stashRef]);
      try {
        await this.git.reset(['--hard', 'refs/pr-checkout-fetch-tmp']);
      } finally {
        await this.git.stash(['pop']).catch(() => {});
      }
    } finally {
      await this.git.raw(['update-ref', '-d', 'refs/pr-checkout-fetch-tmp']).catch(() => {});
    }
  }

  async cherryPick(hash: string): Promise<void> {
    await this.git.raw(['cherry-pick', hash]);
  }

  async cherryPickFile(hash: string, filePath: string, oldPath?: string): Promise<void> {
    const parentsRaw = await this.git.raw(['log', '-1', '--format=%P', hash]).catch(() => '');
    const parents = parentsRaw.trim().split(' ').filter(Boolean);
    const base = parents[0] ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const paths = [...new Set([oldPath, filePath].filter((p): p is string => Boolean(p)))];
    const patch = await this.git.raw(['diff', '--binary', '--find-renames', base, hash, '--', ...paths]);
    if (!patch.trim()) {
      throw new Error(vscode.l10n.t('No changes found for {0} in {1}', filePath, hash.slice(0, 8)));
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-cherry-pick-file-'));
    const patchPath = path.join(tmpDir, 'changes.patch');
    fs.writeFileSync(patchPath, patch, 'utf8');

    try {
      try {
        await this.git.raw(['apply', '--binary', '--3way', '--whitespace=fix', patchPath]);
      } catch (e) {
        const conflicts = await this.git.raw(['diff', '--name-only', '--diff-filter=U', '--', ...paths]).catch(() => '');
        if (conflicts.trim()) {
          throw new Error(`FILE_CHERRY_PICK_CONFLICT:${conflicts.trim()}`);
        }
        try {
          await this.git.raw(['apply', '--binary', '--whitespace=fix', patchPath]);
        } catch (fallbackErr) {
          throw new Error(vscode.l10n.t('Failed to cherry-pick selected changes: {0}', String(fallbackErr)));
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  async revertFileToParent(hash: string, filePath: string): Promise<void> {
    // For added files, 'A' status: the file was created in this commit, so reverting
    // means deleting it from working tree by checking out from the empty tree.
    // For other statuses: restore the file to its state in the parent commit.
    await this.git.raw(['checkout', `${hash}~1`, '--', filePath]);
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

  async dropCommit(hash: string): Promise<void> {
    await this.git.raw(['rebase', '--onto', `${hash}^`, hash]);
  }

  async squashCommits(oldestHash: string, message: string): Promise<void> {
    await this.git.raw(['reset', '--soft', `${oldestHash}^`]);
    await this.git.raw(['commit', '-m', message]);
  }

  async cherryPickMulti(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      await this.git.raw(['cherry-pick', hash]);
    }
  }

  async revertCommits(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      await this.git.raw(['revert', '--no-edit', hash]);
    }
  }

  async dropCommits(oldestHash: string): Promise<void> {
    await this.git.raw(['reset', '--hard', `${oldestHash}^`]);
  }

  async undoCommit(): Promise<void> {
    const parentCount = await this.git.raw(['rev-list', '--count', 'HEAD']).then(s => parseInt(s.trim(), 10)).catch(() => 0);
    if (parentCount <= 1) {
      // First commit: unstage all files and delete HEAD so the branch goes back to unborn state
      await this.git.raw(['rm', '-r', '--cached', '.']);
      await this.git.raw(['update-ref', '-d', 'HEAD']);
    } else {
      await this.git.raw(['reset', '--soft', 'HEAD~1']);
    }
  }

  async editCommitMessage(message: string): Promise<void> {
    await this.git.raw(['commit', '--amend', '-m', message]);
  }

  async rewordCommit(newMessage: string): Promise<void> {
    await this.git.raw(['commit', '--amend', '-m', newMessage]);
  }

  async createBranchFromCommit(name: string, hash: string): Promise<void> {
    await this.git.raw(['checkout', '-b', name, hash]);
  }

  async createTag(name: string, hash: string): Promise<void> {
    await this.git.raw(['tag', name, hash]);
  }

  async resolveRef(ref: string): Promise<string> {
    return (await this.git.revparse(['--verify', ref])).trim();
  }

  async getTags(): Promise<Array<{
    name: string;
    hash: string;
    date: string;
    dateRelative?: string;
    message?: string;
    author?: string;
  }>> {
    return this.cachedByRefs('tags', () => this.readTags());
  }

  private async readTags(): Promise<Array<{
    name: string;
    hash: string;
    date: string;
    dateRelative?: string;
    message?: string;
    author?: string;
  }>> {
    // Use %(refname:strip=2) instead of %(refname:short) to always strip refs/tags/
    // prefix — %(refname:short) may return "tags/<name>" when a branch with the
    // same name exists, which causes display and matching issues.
    // %(objectname:short) and %(creatordate) reflect the tag object itself for annotated
    // tags; %(*authorname)/%(*contents:subject) fall back to the pointed-at commit for both
    // annotated and lightweight tags (empty %(*...) fields when not applicable).
    const out = await this.git.raw([
      'tag', '--sort=-creatordate',
      '--format=%(refname:strip=2)%09%(objectname:short)%09%(creatordate:iso)%09%(creatordate:relative)%09%(*authorname)%(authorname)%09%(*contents:subject)%(contents:subject)',
    ]).catch(() => '');
    return out.trim().split('\n').filter(Boolean).map(line => {
      // Subject (the trailing field) may itself contain a literal tab — reassemble the
      // remainder instead of a straight positional split so it isn't silently truncated.
      const [name, hash, date, dateRelative, author, ...messageParts] = line.split('\t');
      const message = messageParts.join('\t');
      return {
        name: name.trim(),
        hash: hash.trim(),
        date: date.trim(),
        dateRelative: dateRelative?.trim() || undefined,
        author: author?.trim() || undefined,
        message: message?.trim() || undefined,
      };
    });
  }

  async getTagsForCommit(hash: string): Promise<string[]> {
    const out = await this.git.raw(['tag', '--points-at', hash]).catch(() => '');
    return out.trim().split('\n').map(t => t.trim()).filter(Boolean);
  }

  async deleteTag(name: string): Promise<void> {
    await this.git.raw(['tag', '-d', name]);
  }

  async pushTag(name: string, remote: string): Promise<void> {
    await this.git.raw(['push', remote, `refs/tags/${name}`]);
  }

  async deleteTagRemote(name: string, remote: string): Promise<void> {
    await this.git.raw(['push', remote, `--delete`, `refs/tags/${name}`]);
  }

  async checkoutTag(name: string): Promise<void> {
    await this.git.raw(['checkout', name]);
    this._pendingDetachedTag = name;
  }

  async mergeTag(name: string): Promise<void> {
    await this.git.raw(['merge', name]);
  }

  // Refs that point AT this commit — never branches that merely contain it.
  // --points-at peels annotated tags, so one call covers heads, remotes and tags.
  async getRefsAt(hash: string): Promise<{ local: string[]; remote: string[]; tags: string[] }> {
    const out = await this.git.raw(['for-each-ref', '--points-at', hash, '--format=%(refname)']).catch(() => '');
    const local: string[] = [], remote: string[] = [], tags: string[] = [];
    for (const ref of out.split('\n').map(r => r.trim()).filter(Boolean)) {
      if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
      else if (ref.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
      else if (ref.startsWith('refs/remotes/')) {
        const name = ref.slice('refs/remotes/'.length);
        // <remote>/HEAD is a symbolic alias, not a branch.
        if (name.includes('/') && !name.endsWith('/HEAD')) remote.push(name);
      }
    }
    return { local, remote, tags };
  }

  /**
   * Branches/tags that descend from this commit without pointing at it directly —
   * shown in a separate "descendant branches" section so that information isn't
   * lost now that getRefsAt only reports exact matches.
   */
  async getBranchesContaining(hash: string): Promise<{ local: string[]; remote: string[]; tags: string[] }> {
    const [localOut, remoteOut, tagOut] = await Promise.all([
      this.git.raw(['branch', '--contains', hash, '--format=%(refname:short)']).catch(() => ''),
      this.git.raw(['branch', '-r', '--contains', hash, '--format=%(refname:short)']).catch(() => ''),
      // --contains: every tag reachable from the commit, not just ones directly on it.
      this.git.raw(['tag', '--contains', hash]).catch(() => ''),
    ]);
    const parse = (out: string) => out.split('\n').map(b => b.trim()).filter(Boolean);
    // Local branches must not contain a slash — anything with '/' is a remote ref
    // that leaked into the local output on some git configurations.
    // Exclude remote-leaked refs (contain '/') and the detached HEAD pseudo-entry "(HEAD detached at ...)".
    const local = parse(localOut).filter(b => !b.includes('/') && !b.startsWith('('));
    // Remote names come as "origin/foo" or "remotes/origin/foo" — normalise both.
    // origin/HEAD is a symbolic alias, not a real branch — skip it here.
    const remote = parse(remoteOut)
      .map(b => b.replace(/^remotes\//, ''))
      .filter(b => !b.endsWith('/HEAD') && b.includes('/'));
    const tags = parse(tagOut);

    // Exclude anything getRefsAt would already show as an exact match on this commit —
    // this method exists to report ADDITIONAL descendant branches, not duplicate them.
    const { local: exactLocal, remote: exactRemote, tags: exactTags } = await this.getRefsAt(hash);
    const exactLocalSet = new Set(exactLocal);
    const exactRemoteSet = new Set(exactRemote);
    const exactTagSet = new Set(exactTags);
    return {
      local: local.filter(b => !exactLocalSet.has(b)),
      remote: remote.filter(b => !exactRemoteSet.has(b)),
      tags: tags.filter(t => !exactTagSet.has(t)),
    };
  }

  async getFullCommitMessage(hash: string): Promise<string> {
    return this.git.raw(['log', '-1', '--format=%B', hash]);
  }

  async getCommitMeta(hash: string): Promise<{ hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string; committerDate: string; parents: string[] }> {
    const GS = '\x1D';
    const raw = await this.git.raw(['log', '-1', `--format=%H${GS}%h${GS}%s${GS}%aN${GS}%aE${GS}%aI${GS}%cI${GS}%P`, '--abbrev=8', hash]);
    const parts = raw.trim().split(GS);
    return {
      hash: parts[0] ?? hash,
      shortHash: parts[1] ?? hash.slice(0, 8),
      message: parts[2] ?? '',
      authorName: parts[3] ?? '',
      authorEmail: parts[4] ?? '',
      authorDate: parts[5] ?? '',
      committerDate: parts[6] ?? '',
      parents: parts[7] ? parts[7].trim().split(' ').filter(Boolean) : [],
    };
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
    return this.cachedByRefs('stashes', () => this.readStashList());
  }

  private async readStashList(): Promise<StashEntry[]> {
    const raw = await this.git.raw(['stash', 'list', '--format=%gd|%H|%ci|%gs']).catch(() => '');
    if (!raw.trim()) return [];

    const entries: StashEntry[] = [];
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const ref = parts[0].trim();         // stash@{N}
      const hash = parts[1].trim();        // the stash commit
      const date = parts[2].trim();        // ISO date
      const subject = parts.slice(3).join('|').trim(); // "On branch: message" or "WIP on branch: message"

      const indexMatch = ref.match(/stash@\{(\d+)\}/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;

      // Parse branch from subject like "On main: ..." or "WIP on main: ..."
      const branchMatch = subject.match(/^(?:WIP on|On) ([^:]+):/);
      const branch = branchMatch ? branchMatch[1].trim() : '';
      const message = branchMatch ? subject.slice(branchMatch[0].length).trim() : subject;

      // Get files for this stash entry
      const files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
      try {
        const stats = new Map<string, { added: number; removed: number }>();
        const numstatRaw = await this.git.raw(['stash', 'show', '--numstat', ref]).catch(() => '');
        for (const line of numstatRaw.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length < 3) continue;
          const added = parseInt(parts[0], 10);
          const removed = parseInt(parts[1], 10);
          const path = parts[2].trim();
          if (path && !isNaN(added) && !isNaN(removed)) stats.set(path, { added, removed });
        }

        const fileRaw = await this.git.raw(['stash', 'show', '--name-status', ref]);
        for (const fileLine of fileRaw.trim().split('\n')) {
          if (!fileLine.trim()) continue;
          const fileParts = fileLine.split('\t');
          if (fileParts.length < 2) continue;
          const statusLetter = fileParts[0].trim()[0];
          const filePath = fileParts[fileParts.length - 1].trim();
          const s = stats.get(filePath);
          files.push({ path: filePath, status: statusLetter, added: s?.added, removed: s?.removed });
        }
      } catch { /* stash might have no files */ }

      // Also include untracked files saved in stash^3 (created by `git stash -u`)
      try {
        const untrackedRaw = await this.git.raw(['ls-tree', '--name-only', `${ref}^3`]);
        const trackedPaths = new Set(files.map(f => f.path));
        for (const f of untrackedRaw.trim().split('\n')) {
          const filePath = f.trim();
          if (filePath && !trackedPaths.has(filePath)) {
            files.push({ path: filePath, status: '?' });
          }
        }
      } catch { /* stash^3 may not exist for tracked-only stashes */ }

      let parentHash = '';
      try {
        parentHash = (await this.git.raw(['rev-parse', `${ref}^1`])).trim();
      } catch { /* ignore */ }

      entries.push({ ref, hash, index, message, date, branch, parentHash, files });
    }
    return entries;
  }

  async stashShow(stashRef: string, filePath: string): Promise<string> {
    return this.git.raw(['stash', 'show', '-p', stashRef, '--', filePath]).catch(() => '');
  }

  async stashPush(message: string, paths?: string[]): Promise<void> {
    if (!paths || paths.length === 0) {
      await this.git.raw(['stash', 'push', '-u', '-m', message]);
      return;
    }

    // git builds the stash commit tree from the current index, so staged files
    // outside the pathspec (especially new 'A' files) appear in the stash even
    // though they weren't requested. Fix: temporarily unstage them, stash, re-stage.
    //
    // Additionally, untracked files in the pathspec must be staged before stashing
    // because `stash push -- <paths>` only works on tracked/staged files. We stage
    // them temporarily and remove them from the index afterward.
    const status = await this.git.status();
    const pathSet = new Set(paths);

    const addedOutside = status.files
      .filter(f => f.index.trim() === 'A' && !pathSet.has(f.path))
      .map(f => f.path);

    const untrackedInside = status.files
      .filter(f => f.index === '?' && f.working_dir === '?' && pathSet.has(f.path))
      .map(f => f.path);

    if (addedOutside.length > 0) {
      await this.git.raw(['reset', 'HEAD', '--', ...addedOutside]).catch(() => {});
    }
    if (untrackedInside.length > 0) {
      await this.git.add(untrackedInside).catch(() => {});
    }

    try {
      await this.git.raw(['stash', 'push', '-m', message, '--', ...paths]);
    } finally {
      if (addedOutside.length > 0) {
        await this.git.add(addedOutside).catch(() => {});
      }
      // If the stash succeeded the files are gone from the working tree — nothing to unstage.
      // If it failed they are still present, so we remove them from the index to restore state.
      if (untrackedInside.length > 0) {
        await this.git.raw(['reset', 'HEAD', '--', ...untrackedInside]).catch(() => {});
      }
    }
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

  async stashRename(stashRef: string, newMessage: string): Promise<void> {
    const hash = (await this.git.raw(['rev-parse', stashRef])).trim();
    await this.git.raw(['stash', 'drop', stashRef]);
    await this.git.raw(['stash', 'store', '-m', newMessage, hash]);
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

  // ── Submodule push/pull helpers ───────────────────────────────────────────

  async pushSubmodule(): Promise<void> {
    const status = await this.git.status();
    if (status.detached) {
      throw new Error(vscode.l10n.t('Submodule is in detached HEAD — checkout a branch before pushing.'));
    }
    await this.push();
  }

  async pullSubmodule(rebase = false): Promise<string> {
    const status = await this.git.status();
    if (status.detached) {
      // In detached HEAD: fetch then checkout the latest commit on the tracked ref.
      await this.git.fetch();
      return vscode.l10n.t('fetched (detached HEAD — use Update Submodule to advance to a new commit)');
    }
    return rebase ? this.pullRebase() : this.pull();
  }

  // ── Submodule operations ──────────────────────────────────────────────────

  /** Returns the set of relative paths that are gitlink entries (submodule pointers) in this repo. */
  private async getSubmoduleRelativePaths(): Promise<Set<string>> {
    const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return new Set();
    try {
      const raw = fs.readFileSync(gitmodulesPath, 'utf8');
      const paths = new Set<string>();
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s+path\s*=\s*(.+)/);
        if (m) paths.add(m[1].trim());
      }
      return paths;
    } catch {
      return new Set();
    }
  }

  async getSubmoduleList(): Promise<SubmoduleEntry[]> {
    const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return [];

    // Parse .gitmodules to get names/paths/urls
    const raw = fs.readFileSync(gitmodulesPath, 'utf8');
    const moduleMap = new Map<string, { name: string; path: string; url: string }>();
    let currentName = '';
    for (const line of raw.split('\n')) {
      const sectionMatch = line.match(/^\[submodule "(.+)"\]/);
      if (sectionMatch) { currentName = sectionMatch[1]; continue; }
      if (!currentName) continue;
      const kvMatch = line.match(/^\s+(\w+)\s*=\s*(.+)/);
      if (!kvMatch) continue;
      const [, key, value] = kvMatch;
      if (!moduleMap.has(currentName)) moduleMap.set(currentName, { name: currentName, path: '', url: '' });
      const entry = moduleMap.get(currentName)!;
      if (key === 'path') entry.path = value.trim();
      if (key === 'url') entry.url = value.trim();
    }

    // Run `git submodule status` to get init state, HEAD commit, dirty flag
    const statusRaw = await this.git.raw(['submodule', 'status']).catch(() => '');
    // Each line: " <hash> <path> (<description>)" or "-<hash> <path>" or "+<hash> <path>"
    // Leading char: ' ' = initialized clean, '-' = not initialized, '+' = different commit, 'U' = conflict
    const statusMap = new Map<string, { initialized: boolean; headCommit: string; isDirty: boolean }>();
    for (const line of statusRaw.trim().split('\n')) {
      if (!line.trim()) continue;
      const match = line.match(/^([ \-+U])([0-9a-f]{40})\s+(\S+)/);
      if (!match) continue;
      const [, flag, hash, subPath] = match;
      statusMap.set(subPath, {
        initialized: flag !== '-',
        headCommit: hash.slice(0, 8),
        isDirty: flag === '+',
      });
    }

    const entries: SubmoduleEntry[] = [];
    for (const mod of moduleMap.values()) {
      if (!mod.path) continue;
      const subFullPath = path.join(this.rootPath, mod.path);
      const st = statusMap.get(mod.path);
      entries.push({
        name: mod.name,
        path: mod.path,
        url: mod.url,
        repoId: subFullPath,
        initialized: st?.initialized ?? false,
        headCommit: st?.headCommit,
        isDirty: st?.isDirty ?? false,
      });
    }
    return entries;
  }

  async initSubmodule(submodulePath: string): Promise<void> {
    await this.git.raw(['submodule', 'init', '--', submodulePath]);
    await this.git.raw(['submodule', 'update', '--', submodulePath]);
  }

  async deinitSubmodule(submodulePath: string, force = false): Promise<void> {
    const args = ['submodule', 'deinit'];
    if (force) args.push('--force');
    args.push('--', submodulePath);
    await this.git.raw(args);
  }

  async updateSubmodule(submodulePath: string, init = true, recursive = false): Promise<void> {
    const args = ['submodule', 'update'];
    if (init) args.push('--init');
    if (recursive) args.push('--recursive');
    args.push('--', submodulePath);
    await this.git.raw(args);
  }

  async getUnpushedCommits(): Promise<UnpushedCommit[]> {
    // Two-pass approach: first get structured fields (with %s for subject),
    // then get full messages separately per hash.
    // GS before each record; fields separated by NUL.
    const GS = '\x1D';
    const FORMAT = `%x1D%H%x00%h%x00%s%x00%an%x00%ae%x00%ci`;

    const parseRecords = (raw: string): UnpushedCommit[] => {
      const commits: UnpushedCommit[] = [];
      for (const record of raw.split(GS)) {
        const trimmed = record.trim();
        if (!trimmed) continue;
        const lines = trimmed.split('\n');
        const parts = lines[0].split('\x00');
        if (parts.length < 6) continue;
        const commit: UnpushedCommit = {
          hash: parts[0].trim(),
          shortHash: parts[1].trim(),
          message: parts[2].trim(),
          author: parts[3].trim(),
          authorEmail: parts[4].trim(),
          date: parts.slice(5).join('\x00').trim(),
        };
        const statLine = lines.find(l => l.includes('changed'));
        if (statLine) {
          const files = statLine.match(/(\d+) files? changed/);
          const ins = statLine.match(/(\d+) insertion/);
          const del = statLine.match(/(\d+) deletion/);
          commit.filesChanged = files ? parseInt(files[1]) : 0;
          commit.additions = ins ? parseInt(ins[1]) : 0;
          commit.deletions = del ? parseInt(del[1]) : 0;
        }
        commits.push(commit);
      }
      return commits;
    };

    const logArgs = (range: string[]): string[] =>
      ['log', ...range, `--format=${FORMAT}`, '--shortstat', '--abbrev=8'];

    try {
      // Fast path: upstream is configured
      const raw = await this.git.raw(logArgs(['@{u}..HEAD']));
      return parseRecords(raw);
    } catch {
      // No upstream — list commits not reachable from any remote ref
      try {
        const remotes = await this.git.getRemotes();
        let raw: string;
        if (remotes.length === 0) {
          // Fully local repo: show recent commits (capped to avoid huge lists)
          raw = await this.git.raw(logArgs(['HEAD', '--max-count=100']));
        } else {
          // Remotes exist but this branch has no tracking ref
          raw = await this.git.raw(logArgs(['HEAD', '--not', '--remotes']));
        }
        return parseRecords(raw);
      } catch {
        return [];
      }
    }
  }

  // ─── Worktree operations ──────────────────────────────────────────────────

  async getWorktrees(): Promise<WorktreeEntry[]> {
    const raw = await this.git.raw(['worktree', 'list', '--porcelain']);
    return parseWorktreePorcelain(raw, this.rootPath);
  }

  async createWorktree(worktreePath: string, opts: { branch?: string; newBranch?: string; commitish?: string; noTrack?: boolean }): Promise<void> {
    const args = ['worktree', 'add'];
    if (opts.newBranch) {
      args.push('-b', opts.newBranch);
    } else if (opts.branch) {
      // checkout existing branch — no -b flag, just add path + branch
    }
    if (opts.noTrack) args.push('--no-track');
    args.push(worktreePath);
    if (opts.branch) args.push(opts.branch);
    else if (opts.commitish) args.push(opts.commitish);
    await this.git.raw(args);
  }

  async deleteWorktree(worktreePath: string, force = false): Promise<void> {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(worktreePath);
    await this.git.raw(args);
  }

  async pruneWorktrees(): Promise<void> {
    await this.git.raw(['worktree', 'prune']);
  }

  async lockWorktree(worktreePath: string, reason?: string): Promise<void> {
    const args = ['worktree', 'lock'];
    if (reason) args.push('--reason', reason);
    args.push(worktreePath);
    await this.git.raw(args);
  }

  async unlockWorktree(worktreePath: string): Promise<void> {
    await this.git.raw(['worktree', 'unlock', worktreePath]);
  }
}

// ─── Worktree types & parser ──────────────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  head: string;       // commit hash
  branch: string;     // refs/heads/... or empty if detached
  isMain: boolean;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason?: string;
  isPrunable: boolean;
  branchShort: string; // just the branch name without refs/heads/
  isInWorkspace: boolean; // path is inside a VS Code workspace folder
}

function parseWorktreePorcelain(raw: string, _mainPath: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = raw.trim().split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const entry: Partial<WorktreeEntry> = { isLocked: false, isPrunable: false };
    for (const line of lines) {
      if (line.startsWith('worktree '))      entry.path = line.slice(9).trim();
      else if (line.startsWith('HEAD '))     entry.head = line.slice(5).trim();
      else if (line.startsWith('branch '))   entry.branch = line.slice(7).trim();
      else if (line === 'bare')              entry.isBare = true;
      else if (line === 'detached')          entry.isDetached = true;
      else if (line.startsWith('locked'))    { entry.isLocked = true; entry.lockReason = line.slice(6).trim() || undefined; }
      else if (line.startsWith('prunable'))  entry.isPrunable = true;
    }
    if (!entry.path) continue;
    // The main worktree always has .git as a directory; linked worktrees have .git as a file.
    const gitDir = path.join(entry.path, '.git');
    entry.isMain = (() => { try { return fs.statSync(gitDir).isDirectory(); } catch { return false; } })();
    entry.isBare = entry.isBare ?? false;
    entry.isDetached = entry.isDetached ?? false;
    entry.isInWorkspace = false;
    entry.branchShort = entry.branch ? entry.branch.replace(/^refs\/heads\//, '') : '';
    entries.push(entry as WorktreeEntry);
  }
  return entries;
}
