import * as vscode from 'vscode';
import { modelPrefix, normalizeBranchModels } from '../types/branchModels';

const DEFAULT_BRANCH_NAME_MODELS: string[] = [];

export function getBranchNameModels(): string[] {
  const value = vscode.workspace
    .getConfiguration('gitcharm')
    .get<string[]>('branchNameModels', DEFAULT_BRANCH_NAME_MODELS);
  return normalizeBranchModels(value);
}

interface BranchNameRules {
  whitespaceChar: string;
  validationRegex: RegExp | undefined;
}

/** Reads the same `git.branchWhitespaceChar` / `git.branchValidationRegex` settings the built-in Git extension uses. */
function getBranchNameRules(): BranchNameRules {
  const config = vscode.workspace.getConfiguration('git');
  const whitespaceChar = config.get<string>('branchWhitespaceChar', '-');
  const regexSource = config.get<string>('branchValidationRegex', '');
  let validationRegex: RegExp | undefined;
  try {
    validationRegex = regexSource ? new RegExp(regexSource) : undefined;
  } catch {
    validationRegex = undefined;
  }
  return { whitespaceChar, validationRegex };
}

/**
 * Replaces whitespace and characters git rejects in ref names with `git.branchWhitespaceChar`,
 * the same way the built-in Git extension's "Create Branch" does (e.g. "my feature" -> "my-feature").
 */
function sanitizeWith(name: string, rules: BranchNameRules): string {
  if (!name) return name;
  return name
    .trim()
    .replace(/^-+/, '')
    .replace(/^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$|\[|\]$/g, rules.whitespaceChar);
}

export function sanitizeBranchName(name: string): string {
  return sanitizeWith(name, getBranchNameRules());
}

/**
 * `validateInput` for branch name input boxes: an error when the name is empty or fails
 * `git.branchValidationRegex`, otherwise an info message announcing the sanitized name when it
 * differs from what was typed. Pair it with {@link sanitizeBranchName} on the accepted value.
 */
export function validateBranchNameInput(value: string): string | vscode.InputBoxValidationMessage | undefined {
  return branchNameFeedback(value, getBranchNameRules());
}

function branchNameFeedback(value: string, rules: BranchNameRules): string | vscode.InputBoxValidationMessage | undefined {
  const sanitized = sanitizeWith(value, rules);
  if (!sanitized) return vscode.l10n.t('Branch name cannot be empty');
  if (rules.validationRegex && !rules.validationRegex.test(sanitized)) {
    return vscode.l10n.t('Branch name needs to match regex: {0}', rules.validationRegex.source);
  }
  if (sanitized !== value) {
    return {
      message: vscode.l10n.t('The new branch will be "{0}"', sanitized),
      severity: vscode.InputBoxValidationSeverity.Info,
    };
  }
  return undefined;
}

interface BranchNamePromptOptions {
  title: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
}

/**
 * Shows an editable QuickPick for entering a new branch name, suggesting the
 * configured branch models (e.g. "feature/*") as selectable prefixes that get
 * completed with whatever the user types after them.
 */
export async function promptBranchName(options: BranchNamePromptOptions): Promise<string | undefined> {
  const models = getBranchNameModels();
  if (models.length === 0) {
    const name = await vscode.window.showInputBox({
      title: options.title,
      prompt: options.prompt,
      placeHolder: options.placeHolder,
      value: options.value,
      validateInput: validateBranchNameInput,
    });
    return name === undefined ? undefined : sanitizeBranchName(name);
  }

  const rules = getBranchNameRules();

  return new Promise<string | undefined>(resolve => {
    type Item = vscode.QuickPickItem & { fullValue?: string; isPrefixOnly?: boolean; invalid?: boolean };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = options.title;
    qp.placeholder = options.placeHolder ?? options.prompt ?? vscode.l10n.t('Enter the new branch name');
    qp.value = options.value ?? '';
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;

    // QuickPick has no validation message API, so the sanitize notice / error goes in the item's detail line.
    const nameItem = (name: string, description: string, extra: Partial<Item> = {}): Item => {
      const feedback = branchNameFeedback(name, rules);
      const sanitized = sanitizeWith(name, rules);
      return {
        label: sanitized,
        description,
        detail: typeof feedback === 'string' ? feedback : feedback?.message,
        alwaysShow: true,
        fullValue: sanitized,
        invalid: typeof feedback === 'string',
        ...extra,
      };
    };

    const render = (typed: string) => {
      const trimmed = typed.trim();
      const items: Item[] = [];

      if (trimmed.length > 0) {
        items.push(nameItem(typed, vscode.l10n.t('Use this branch name')));
      }

      for (const model of models) {
        const prefix = modelPrefix(model);
        // Once the user has typed the full prefix, the suggestion (which would just prepend
        // it again) is redundant — but partial progress toward it (e.g. "feat" toward
        // "feature/") should still show the completion, not hide it.
        if (trimmed && trimmed.startsWith(prefix)) continue;
        if (!trimmed) {
          // Selecting a bare prefix (no name typed yet) only completes the input; it doesn't confirm.
          items.push({ label: prefix, description: model, alwaysShow: true, fullValue: prefix, isPrefixOnly: true });
          continue;
        }
        items.push(nameItem(`${prefix}${trimmed}`, model));
      }

      qp.items = items;
    };

    render(qp.value);
    qp.onDidChangeValue(() => render(qp.value));

    let resolved = false;
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected?.isPrefixOnly) {
        qp.value = selected.fullValue ?? qp.value;
        render(qp.value);
        return;
      }

      const picked = selected?.fullValue ?? sanitizeWith(qp.value, rules);
      // Keep the picker open on an empty or invalid name; the item's detail says why.
      if (!picked || selected?.invalid || typeof branchNameFeedback(picked, rules) === 'string') return;
      resolved = true;
      resolve(picked);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!resolved) resolve(undefined);
      qp.dispose();
    });

    qp.show();
  });
}
