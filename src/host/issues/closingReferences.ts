/** "Fixes #12", "closes: #3", "Resolved #7"… — the closing keywords GitHub, GitLab, Gitea and Bitbucket all honour. */
const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+#(\d+)\b/gi;

const MAX_REFERENCES = 20;

/** Issue numbers a pull request description says it closes, in order of first mention — for forges with no API for it. */
export function parseClosingReferences(text: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(CLOSING_REFERENCE)) {
    const n = Number(match[1]);
    if (!numbers.includes(n)) numbers.push(n);
    if (numbers.length >= MAX_REFERENCES) break;
  }
  return numbers;
}
