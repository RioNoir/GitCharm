import { HttpJsonError } from './httpJson';

/** A branch name as URL path segments: each part encoded, the slashes kept (feature/x → feature/x, a#b → a%23b). */
export function branchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** Whether a failed branch deletion failed because the branch doesn't exist: then there is nothing left to delete. */
export function isBranchGone(err: unknown, statuses: readonly number[] = [404]): boolean {
  return err instanceof HttpJsonError && statuses.includes(err.status);
}
