import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Content comes from an external forge API — sanitize after parsing, since marked passes raw HTML through untouched. */
export function renderMarkdown(text: string): string {
  if (!text.trim()) return '';
  const raw = marked.parse(text, { async: false, breaks: true, silent: true }).toString();
  return DOMPurify.sanitize(raw);
}
