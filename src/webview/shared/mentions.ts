import { createContext, useContext } from 'react';
import type { PullRequestUser } from '../../host/types/messages';

/** A user offered by the editor's `@` autocomplete. `token` is the exact markdown text that mentions them on
 * the forge (`@octocat`, or Bitbucket's `@{account_id}`), `label` is what's shown in its place. */
export interface MentionCandidate {
  token: string;
  label: string;
  avatarUrl?: string;
}

export function toMentionCandidates(users: PullRequestUser[]): MentionCandidate[] {
  const seen = new Set<string>();
  const result: MentionCandidate[] = [];
  for (const u of users) {
    const token = u.mention ?? `@${u.username}`;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push({ token, label: u.username, avatarUrl: u.avatarUrl });
  }
  return result;
}

/** Provided by each PR webview app once its member list arrives — read by both the markdown renderer (to show
 * Bitbucket's `@{account_id}` mentions as names) and the editor (autocomplete). Empty until then. */
export const MentionCandidatesContext = createContext<MentionCandidate[]>([]);

export function useMentionCandidates(): MentionCandidate[] {
  return useContext(MentionCandidatesContext);
}

// `@{…}` is Bitbucket's account-id form. The plain form covers GitHub/Gitea logins and GitLab's usernames and
// `@group/subgroup` paths; the lookbehind keeps email addresses (`me@host.com`) and paths from matching.
const MENTION_RE = /@\{[^}\s]+\}|(?<![\w@/.`-])@[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*/g;

const SKIP_TAGS = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE']);

function labelFor(token: string, labels: Map<string, string>): string {
  const known = labels.get(token);
  if (known) return known;
  // An unresolved Bitbucket account id is meaningless to read — there's no name to fall back to.
  return token.startsWith('@{') ? 'user' : token.slice(1);
}

/**
 * Wraps every mention found in `html`'s text (outside code and links) in a span. `view` produces a styled,
 * read-only chip; `editor` produces the node Tiptap's Mention extension parses back (`data-type="mention"`),
 * so editing existing text keeps its mentions as mentions. Elements are built through the DOM, never by
 * string concatenation, so this is safe to run on already-sanitized HTML.
 */
export function decorateMentions(html: string, mode: 'view' | 'editor', candidates: MentionCandidate[]): string {
  if (!html || !html.includes('@')) return html;
  const labels = new Map(candidates.map(c => [c.token, c.label]));
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== doc.body; el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName) || el.getAttribute('data-type') === 'mention') return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue?.includes('@') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? '';
    const fragment = doc.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(MENTION_RE)) {
      const token = match[0];
      const start = match.index ?? 0;
      if (start > last) fragment.append(text.slice(last, start));
      const label = labelFor(token, labels);
      const span = doc.createElement('span');
      if (mode === 'editor') {
        span.setAttribute('data-type', 'mention');
        span.setAttribute('data-id', token);
        span.setAttribute('data-label', label);
      } else {
        span.className = 'pr-mention';
        if (label !== token.slice(1)) span.title = token;
      }
      span.textContent = `@${label}`;
      fragment.append(span);
      last = start + token.length;
    }
    if (last === 0) continue;
    if (last < text.length) fragment.append(text.slice(last));
    textNode.replaceWith(fragment);
  }
  return doc.body.innerHTML;
}
