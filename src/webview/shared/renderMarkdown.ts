import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { decorateMentions, type MentionCandidate } from './mentions';

/** Content comes from an external forge API — sanitize after parsing, since marked passes raw HTML through untouched.
 * Passing `mentions` highlights `@user` mentions (and resolves Bitbucket's `@{account_id}` ones to names). */
export function renderMarkdown(text: string, mentions?: MentionCandidate[]): string {
  if (!text.trim()) return '';
  const raw = marked.parse(text, { async: false, breaks: true, silent: true }).toString();
  const clean = DOMPurify.sanitize(raw);
  return mentions ? decorateMentions(clean, 'view', mentions) : clean;
}
