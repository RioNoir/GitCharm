import { GitService } from '../../src/host/git/GitService';

export async function rebase(root: string, onto: string): Promise<void> {
  await new GitService(root, root).rebase(onto);
}

export async function pullRebase(root: string): Promise<string> {
  return new GitService(root, root).pullRebase();
}
