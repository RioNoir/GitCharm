import * as vscode from 'vscode';

const DEFAULT_BRANCH_NAME_MODELS: string[] = [];

/**
 * Normalizes a user-entered branch model into the stored `*`-suffixed standard,
 * e.g. "feature/" -> "feature/*", "feature" -> "feature/*", "revert-" -> "revert-*".
 * Entries that already contain a wildcard (e.g. "feature/**", "revert-*") are kept as-is.
 */
export function normalizeBranchModel(raw: string): string | undefined {
  const pattern = raw.trim().replace(/\\/g, '/');
  if (!pattern) return undefined;
  if (pattern.includes('*')) return pattern;

  if (pattern.endsWith('/') || pattern.endsWith('-') || pattern.endsWith('_')) {
    return `${pattern}*`;
  }
  return `${pattern}/*`;
}

export function getBranchNameModels(): string[] {
  const value = vscode.workspace
    .getConfiguration('gitcharm')
    .get<string[]>('branchNameModels', DEFAULT_BRANCH_NAME_MODELS);

  if (!Array.isArray(value)) return DEFAULT_BRANCH_NAME_MODELS;

  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = normalizeBranchModel(entry);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      models.push(normalized);
    }
  }
  return models.sort((a, b) => a.localeCompare(b));
}

/** Strips a trailing "*" or "**" from a stored model to get the literal prefix to prepend. */
function modelPrefix(model: string): string {
  return model.replace(/\*+$/, '');
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
    return vscode.window.showInputBox({
      title: options.title,
      prompt: options.prompt,
      placeHolder: options.placeHolder,
      value: options.value,
      validateInput: v => (v.trim() ? undefined : 'Branch name cannot be empty'),
    });
  }

  return new Promise<string | undefined>(resolve => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { fullValue?: string }>();
    qp.title = options.title;
    qp.placeholder = options.placeHolder ?? options.prompt ?? 'Enter the new branch name';
    qp.value = options.value ?? '';
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;

    const render = (typed: string) => {
      const trimmed = typed.trim();
      const items: Array<vscode.QuickPickItem & { fullValue?: string; isPrefixOnly?: boolean }> = [];

      if (trimmed.length > 0) {
        items.push({ label: trimmed, description: 'Use this branch name', alwaysShow: true, fullValue: trimmed });
      }

      for (const model of models) {
        const prefix = modelPrefix(model);
        // Once the user has typed the full prefix, the suggestion (which would just prepend
        // it again) is redundant — but partial progress toward it (e.g. "feat" toward
        // "feature/") should still show the completion, not hide it.
        if (trimmed && trimmed.startsWith(prefix)) continue;
        items.push({
          label: `${prefix}${trimmed}`,
          description: model,
          alwaysShow: true,
          fullValue: `${prefix}${trimmed}`,
          // Selecting a bare prefix (no name typed yet) only completes the input; it doesn't confirm.
          isPrefixOnly: trimmed.length === 0,
        });
      }

      qp.items = items;
    };

    render(qp.value);
    qp.onDidChangeValue(() => {
      qp.validationMessage = undefined;
      render(qp.value);
    });

    let resolved = false;
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected?.isPrefixOnly) {
        qp.value = selected.fullValue ?? qp.value;
        render(qp.value);
        return;
      }

      const picked = (selected?.fullValue ?? qp.value).trim();
      if (!picked) {
        qp.validationMessage = 'Branch name cannot be empty';
        return;
      }
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
