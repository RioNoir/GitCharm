import type { RebaseAction, RebasePlanEntry } from '../types/messages';

// The git-rebase-todo of an interactive rebase: written from a plan (GitCharm's own editor) and read back
// from the file git hands to sequence.editor (a rebase started in the terminal).

/** Quotes a value for the POSIX shell git runs editors and exec lines with (also Git for Windows' sh). */
export function shQuote(value: string): string {
  return `'${value.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

/**
 * The todo for a plan, oldest first. New messages are not left to an editor, which would have to answer
 * while git waits: every commit of a group (a head and the squash/fixup commits folded into it) is picked
 * or fixed up, and an exec line then amends the group with its message, read from the file `writeMessage`
 * returns. The exec only amends when the group produced a commit — a skipped pick, or one that became empty
 * and was dropped, leaves HEAD at the label set before the group, and the previous commit keeps its message.
 */
export function buildRebaseTodo(
  plan: RebasePlanEntry[],
  subjects: ReadonlyMap<string, string>,
  writeMessage: (index: number, message: string) => string,
): string {
  const lines: string[] = [];
  const line = (command: string, hash: string) => `${command} ${hash} ${(subjects.get(hash) ?? '').replace(/[\r\n]+/g, ' ')}`.trimEnd();
  let index = 0;
  for (let i = 0; i < plan.length; i++) {
    const head = plan[i];
    if (head.action === 'drop') {
      lines.push(line('drop', head.hash));
      continue;
    }
    if (head.action === 'squash' || head.action === 'fixup') {
      throw new Error(`"${head.action}" needs an earlier commit to fold into`);
    }
    // The group: the squash/fixup commits that follow, skipping dropped ones as git does (a drop line is a no-op).
    let j = i + 1;
    while (j < plan.length && ['squash', 'fixup', 'drop'].includes(plan[j].action)) j++;
    const rest = plan.slice(i + 1, j);
    const message = rest.some(e => e.action === 'squash') || head.action === 'reword' ? head.message : undefined;
    const label = `gitcharm-${index}`;
    if (message !== undefined) lines.push(`label ${label}`);
    lines.push(line(head.action === 'edit' ? 'edit' : 'pick', head.hash));
    // Without a message of its own, a squash is left to git, which joins the messages.
    for (const entry of rest) lines.push(line(entry.action === 'drop' || message === undefined ? entry.action : 'fixup', entry.hash));
    if (message !== undefined) {
      const file = writeMessage(index, message);
      lines.push(`exec [ "$(git rev-parse HEAD)" = "$(git rev-parse refs/rewritten/${label})" ] || git commit --amend --allow-empty --quiet --file ${shQuote(file)}`);
    }
    index++;
    i = j - 1;
  }
  return lines.join('\n') + '\n';
}

const ACTIONS: Record<string, RebaseAction> = {
  p: 'pick', pick: 'pick',
  r: 'reword', reword: 'reword',
  e: 'edit', edit: 'edit',
  s: 'squash', squash: 'squash',
  f: 'fixup', fixup: 'fixup',
  d: 'drop', drop: 'drop',
};

export interface ParsedTodo {
  entries: Array<{ hash: string; action: RebaseAction }>;
  /** Lines of commands the editor does not show (exec, break, label, merge, update-ref, fixup -C…). */
  unsupported: string[];
}

/** Reads a git-rebase-todo, comments and blank lines skipped. */
export function parseRebaseTodo(text: string): ParsedTodo {
  const entries: ParsedTodo['entries'] = [];
  const unsupported: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const lineText = raw.trim();
    if (!lineText || lineText.startsWith('#')) continue;
    const [command, hash] = lineText.split(/\s+/, 2);
    const action = ACTIONS[command.toLowerCase()];
    if (!action || !hash || hash.startsWith('-') || !/^[0-9a-f]{4,64}$/i.test(hash)) {
      unsupported.push(lineText);
      continue;
    }
    entries.push({ hash, action });
  }
  return { entries, unsupported };
}

/** Writes a plan back as a git-rebase-todo, for git to carry out itself (messages asked in the editor). */
export function serializeRebaseTodo(plan: RebasePlanEntry[], subjects: ReadonlyMap<string, string>): string {
  return plan.map(e => `${e.action} ${e.hash} ${(subjects.get(e.hash) ?? '').replace(/[\r\n]+/g, ' ')}`.trimEnd()).join('\n') + '\n';
}
