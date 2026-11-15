import type { GitProfileService } from './GitProfileService';
import type { WorkspaceGitManager } from './WorkspaceGitManager';

/**
 * The identity to commit with in the repo at `repoPath`, from its effective Git profile — a submodule takes its
 * parent's. `credentials` is undefined when git already has the identity itself (a Local or Global profile, read
 * from git config): it is only injected, never written. `noIdentity` says there is none at all.
 */
export async function resolveCommitCredentials(
  manager: WorkspaceGitManager,
  profileService: GitProfileService,
  repoPath: string,
): Promise<{ credentials?: { gitName: string; gitEmail: string }; noIdentity: boolean }> {
  const meta = manager.getRepoMetas().find(m => m.rootPath === repoPath);
  const resolvedPath = meta?.isSubmodule && meta.parentRepoId ? meta.parentRepoId : repoPath;
  const result = await profileService.getEffectiveProfile(resolvedPath);
  if (!result) return { noIdentity: true };
  if (result.source === 'local' || result.source === 'global') return { noIdentity: false };
  const { gitName, gitEmail } = result.profile;
  return { credentials: gitName || gitEmail ? { gitName, gitEmail } : undefined, noIdentity: false };
}
