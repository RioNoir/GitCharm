import type { CiCheck, PullRequestChecksSummary, PullRequestSummary } from './types';

/** Parallel per-PR lookups at most — providers without a batch endpoint cost one (or two) calls per PR. */
const MAX_CONCURRENT_LOOKUPS = 6;

/**
 * Commit-status APIs (Gitea, legacy GitHub statuses) report every update of a check as its own entry, so the same
 * name can appear several times — only the most recent one per name counts, same as the forges' own UIs.
 */
export function summarizeChecks(checks: CiCheck[]): PullRequestChecksSummary | undefined {
  const latest = new Map<string, CiCheck>();
  const time = (c: CiCheck) => c.completedAt ?? c.startedAt ?? '';
  for (const check of checks) {
    const prev = latest.get(check.name);
    if (!prev || time(check) > time(prev)) latest.set(check.name, check);
  }
  if (latest.size === 0) return undefined;
  const summary: PullRequestChecksSummary = { total: latest.size, passed: 0, failed: 0, pending: 0 };
  for (const check of latest.values()) {
    if (check.state === 'success') summary.passed++;
    else if (check.state === 'pending') summary.pending++;
    else summary.failed++;
  }
  return summary;
}

/**
 * Fallback for providers with no batch endpoint: runs `listChecks` per PR, with bounded concurrency. Only open and
 * draft PRs are looked up — for closed/merged ones the result rarely matters and isn't worth a request each.
 */
export async function summarizeChecksPerPr(
  prs: PullRequestSummary[],
  listChecks: (headSha: string) => Promise<CiCheck[]>,
): Promise<Map<number, PullRequestChecksSummary>> {
  const targets = prs.filter(pr => pr.headSha && (pr.state === 'open' || pr.state === 'draft'));
  const result = new Map<number, PullRequestChecksSummary>();
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const pr = targets[next++];
      try {
        const summary = summarizeChecks(await listChecks(pr.headSha!));
        if (summary) result.set(pr.number, summary);
      } catch {
        // Best-effort — a PR whose checks can't be read just shows none.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_LOOKUPS, targets.length) }, worker));
  return result;
}
