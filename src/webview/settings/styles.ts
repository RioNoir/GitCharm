// The settings page's stylesheet. Kept as CSS (not inline styles like the other webviews) because it leans on
// :hover, :focus-visible, media queries and many repeated classes. It follows VS Code's own Settings editor:
// same theme colors (settings.*), same row anatomy, no decoration of its own.
export const SETTINGS_CSS = `
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
.mono { font-family: var(--vscode-editor-font-family, monospace); }
.gc-muted { color: var(--vscode-descriptionForeground); }
.gc-loading, .gc-empty { display: flex; align-items: center; justify-content: center; gap: 8px; height: 100%; color: var(--vscode-descriptionForeground); }
.gc-empty { height: 160px; }

.gc-settings { display: flex; flex-direction: column; height: 100vh; }

/* ── Header: search + scope tabs ─────────────────────────────────────────── */
.gc-header { flex-shrink: 0; padding: 11px 24px 0; max-width: 1200px; width: 100%; margin: 0 auto; }
.gc-search {
  display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border-radius: 3px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.gc-search:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent); }
.gc-search input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: inherit; font: inherit; font-size: 13px; }
.gc-search input::placeholder { color: var(--vscode-input-placeholderForeground); }
.gc-search-count { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.gc-tabs-row {
  display: flex; align-items: flex-end; gap: 4px; margin-top: 10px;
  border-bottom: 1px solid var(--vscode-settings-headerBorder, var(--vscode-panel-border));
}
.gc-tab {
  padding: 4px 10px 5px; border: none; border-bottom: 1px solid transparent; margin-bottom: -1px; background: transparent; cursor: pointer;
  color: var(--vscode-panelTitle-inactiveForeground, var(--vscode-descriptionForeground)); font: inherit; font-size: 13px;
}
.gc-tab:hover:not(:disabled) { color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground)); }
.gc-tab.active { color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground)); border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder)); }
.gc-tab:disabled { opacity: 0.5; cursor: default; }
.gc-tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.gc-tabs-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; padding-bottom: 3px; }

/* ── Body: table of contents + settings ──────────────────────────────────── */
.gc-main { display: flex; flex: 1; min-height: 0; max-width: 1200px; width: 100%; margin: 0 auto; }
.gc-toc { width: 200px; flex-shrink: 0; overflow-y: auto; padding: 8px 0 16px 16px; }
.gc-toc-group { display: flex; align-items: center; gap: 2px; width: 100%; height: 22px; padding: 0 6px 0 2px; border: none; background: transparent; color: var(--vscode-foreground); font: inherit; text-align: left; cursor: pointer; }
.gc-toc-group:hover { background: var(--vscode-list-hoverBackground); }
.gc-toc-item {
  display: flex; align-items: center; gap: 6px; width: 100%; height: 22px; padding: 0 6px 0 22px; border: none; background: transparent;
  color: var(--vscode-foreground); font: inherit; text-align: left; cursor: pointer; opacity: 0.9;
}
.gc-toc-item .codicon { font-size: 14px; flex-shrink: 0; }
.gc-toc-item:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
.gc-toc-item.active { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); opacity: 1; }
.gc-toc-item:focus-visible, .gc-toc-group:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.gc-toc-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-toc-count { color: var(--vscode-descriptionForeground); margin-left: 4px; }
.gc-content { flex: 1; min-width: 0; overflow-y: auto; padding: 0 24px 40px 28px; }

@media (max-width: 760px) {
  .gc-toc { display: none; }
  .gc-header { padding: 11px 12px 0; }
  .gc-content { padding: 0 12px 32px; }
}

/* ── Group titles ────────────────────────────────────────────────────────── */
.gc-group-title { margin: 14px 0 2px; padding-left: 14px; font-size: 26px; font-weight: 600; color: var(--vscode-settings-headerForeground, var(--vscode-foreground)); }
.gc-group-desc { padding-left: 14px; margin: 0 0 8px; color: var(--vscode-descriptionForeground); }
.gc-subgroup-title { margin: 22px 0 2px; padding-left: 14px; font-size: 16px; font-weight: 600; color: var(--vscode-settings-headerForeground, var(--vscode-foreground)); }

.gc-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
.gc-body.with-preview { grid-template-columns: minmax(0, 1fr) minmax(260px, 340px); }
.gc-body-preview { position: sticky; top: 12px; align-self: start; padding-top: 12px; }
@media (max-width: 1050px) {
  .gc-body.with-preview { grid-template-columns: minmax(0, 1fr); }
  .gc-body-preview { position: static; order: 1; padding: 0 14px; }
}

/* ── Setting row (VS Code's .setting-item) ───────────────────────────────── */
.gc-row { position: relative; padding: 12px 14px 18px; }
.gc-row:hover { background: var(--vscode-settings-rowHoverBackground); }
.gc-row:focus-within { background: var(--vscode-settings-focusedRowBackground, var(--vscode-settings-rowHoverBackground)); }
.gc-row.modified::before {
  content: ''; position: absolute; left: 5px; top: 15px; bottom: 18px; border-left: 2px solid var(--vscode-settings-modifiedItemIndicator, var(--vscode-focusBorder));
}
.gc-row-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 6px; line-height: 20px; color: var(--vscode-settings-headerForeground, var(--vscode-foreground)); }
.gc-row-title .category { font-weight: normal; }
.gc-row-title .label { font-weight: 600; }
.gc-row-misc { font-size: 12px; font-style: italic; color: var(--vscode-descriptionForeground); }
.gc-row-gear { position: absolute; left: -22px; top: 11px; opacity: 0; }
.gc-row:hover .gc-row-gear, .gc-row:focus-within .gc-row-gear, .gc-row-gear.open { opacity: 1; }
.gc-row-desc { margin-top: 3px; color: var(--vscode-descriptionForeground); line-height: 18px; user-select: text; }
.gc-row-desc p { margin: 0; }
.gc-row-desc code { font-size: 12px; }
.gc-row-control { margin-top: 9px; }
.gc-row-note { margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); font-style: italic; }
.gc-content > .gc-row-note, .gc-body-main > .gc-row-note { padding-left: 14px; }

/* ── Inputs: same look as the rest of GitCharm (shared/inputStyles.ts focusableFieldStyle) ── */
.gc-input, .gc-select, .gc-textarea {
  font: inherit; font-size: 13px; outline: none; min-width: 0; border-radius: 3px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.gc-input { height: 28px; padding: 0 8px; width: 100%; max-width: 500px; }
.gc-input.mono, .gc-textarea.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.gc-input::placeholder, .gc-textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
.gc-input:focus, .gc-select:focus, .gc-textarea:focus {
  border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent);
}
.gc-input-number { width: 200px; }
.gc-input.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
.gc-validation {
  max-width: 500px; margin-top: 4px; padding: 4px 8px; font-size: 12px; border-radius: 3px;
  background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}
/* Dropdowns: the PR panel's forge picker colors. */
.gc-select {
  height: 28px; padding: 0 6px; width: 320px; max-width: 100%; cursor: pointer;
  background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  border-color: var(--vscode-dropdown-border, rgba(128,128,128,0.35));
}
.gc-select.small { width: auto; min-width: 120px; }
.gc-select-desc { margin-top: 5px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.gc-enum-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; max-width: 780px; }
.gc-enum-card {
  display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; text-align: left; font: inherit; font-size: 13px; cursor: pointer; border-radius: 4px;
  color: var(--vscode-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
  transition: border-color 0.12s ease, background-color 0.12s ease;
}
.gc-enum-card:not(:disabled):hover { background: var(--vscode-list-hoverBackground); }
.gc-enum-card.selected { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 12%, var(--vscode-input-background)); }
.gc-enum-card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.gc-enum-card:disabled { opacity: 0.5; cursor: default; }
/* Radio: drawn like GitCharm's themed checkboxes (webviewHtml.ts), round. */
.gc-radio { position: relative; flex-shrink: 0; width: 14px; height: 14px; margin-top: 2px; border-radius: 50%; border: 1.5px solid var(--vscode-focusBorder, #007fd4); }
.gc-enum-card.selected .gc-radio::after { content: ''; position: absolute; inset: 2px; border-radius: 50%; background: var(--vscode-focusBorder, #007fd4); }
.gc-ai-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex-shrink: 0; color: var(--vscode-foreground); }
.gc-enum-card:not(.selected) .gc-ai-icon { opacity: 0.75; }
.gc-ai-icon-badge {
  position: absolute; right: -4px; bottom: -3px; font-size: 10px !important; padding: 1px; border-radius: 3px;
  background: var(--vscode-input-background); color: var(--vscode-foreground);
}
.gc-enum-card.selected .gc-ai-icon-badge { background: color-mix(in srgb, var(--vscode-focusBorder) 12%, var(--vscode-input-background)); }
.gc-enum-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gc-enum-title { font-weight: 600; }
.gc-enum-desc { font-size: 12px; line-height: 16px; color: var(--vscode-descriptionForeground); }
.gc-input:disabled, .gc-select:disabled, .gc-textarea:disabled { opacity: 0.5; cursor: default; }
.gc-textarea { width: 100%; max-width: 760px; padding: 6px 8px; resize: vertical; line-height: 1.5; display: block; }
.gc-textarea[readonly] { color: var(--vscode-descriptionForeground); }

/* Checkboxes are plain <input type="checkbox">, styled globally by webviewHtml.ts like everywhere in GitCharm. */
.gc-checkbox-line { display: flex; align-items: flex-start; gap: 8px; margin-top: 4px; cursor: pointer; }
.gc-checkbox-line .gc-row-desc { margin-top: 0; }
.gc-checkbox-line input[type="checkbox"] { margin: 2px 0 0; }

/* Buttons: the Commit panel's (UnifiedCommitForm); secondary ones use the global .gc-btn-secondary class. */
.gc-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 5px 12px; border-radius: 4px;
  font-family: var(--vscode-font-family); font-size: 13px; line-height: 16px; cursor: pointer; white-space: nowrap; user-select: none;
}
.gc-btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, transparent); }
.gc-btn-primary:not(:disabled):hover { background: var(--vscode-button-hoverBackground); }
.gc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.gc-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.gc-link { padding: 0; border: none; background: none; font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer; }
.gc-link:hover:not(:disabled) { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.gc-link:disabled { opacity: 0.5; cursor: default; }
.gc-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border-radius: 5px;
  border: none; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; flex-shrink: 0;
}
.gc-icon-btn:not(:disabled):hover { background: var(--vscode-toolbar-hoverBackground); }
.gc-icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.gc-icon-btn:disabled { opacity: 0.4; cursor: default; }
.gc-inline { display: flex; align-items: center; gap: 6px; max-width: 500px; }
.gc-inline .gc-input { flex: 1; }

/* ── Context menu (gear) ─────────────────────────────────────────────────── */
.gc-menu {
  position: absolute; z-index: 50; min-width: 200px; padding: 4px 0; border-radius: 5px;
  background: var(--vscode-menu-background); color: var(--vscode-menu-foreground);
  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36));
}
.gc-menu button { display: block; width: calc(100% - 8px); margin: 0 4px; padding: 0 22px; height: 24px; border: none; border-radius: 3px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; white-space: nowrap; }
.gc-menu button:hover:not(:disabled), .gc-menu button:focus-visible { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); outline: none; }
.gc-menu button:disabled { opacity: 0.4; cursor: default; }
.gc-menu hr { border: none; border-top: 1px solid var(--vscode-menu-separatorBackground, rgba(128,128,128,0.35)); margin: 4px 0; }

/* ── List / object widgets (VS Code's array and object editors) ──────────── */
.gc-list-widget { max-width: 500px; }
.gc-list-header, .gc-list-row { display: flex; align-items: center; min-height: 24px; padding: 0 4px 0 8px; gap: 8px; }
.gc-list-header { font-weight: 600; border-bottom: 1px solid var(--vscode-settings-headerBorder, var(--vscode-panel-border)); }
.gc-list-row { cursor: default; }
.gc-list-row:hover { background: var(--vscode-list-hoverBackground); }
.gc-list-row .gc-list-actions { margin-left: auto; display: flex; opacity: 0; }
.gc-list-row:hover .gc-list-actions, .gc-list-row:focus-within .gc-list-actions { opacity: 1; }
.gc-list-key { flex: 0 0 45%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-list-value { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.gc-list-edit { display: flex; align-items: center; gap: 6px; padding: 4px 0 4px 4px; }
.gc-list-edit .gc-input { flex: 1; }
.gc-list-add { margin-top: 6px; }
.gc-swatch { width: 12px; height: 12px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4)); flex-shrink: 0; }
.gc-color { width: 26px; height: 22px; padding: 0; border-radius: 3px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35)); background: transparent; cursor: pointer; flex-shrink: 0; }
.gc-color::-webkit-color-swatch-wrapper { padding: 2px; }
.gc-color::-webkit-color-swatch { border: none; }

/* ── AI ──────────────────────────────────────────────────────────────────── */
.gc-ai-body.dimmed { opacity: 0.6; }
.gc-apikey-status { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
.gc-model-status { margin-top: 5px; font-size: 12px; color: var(--vscode-descriptionForeground); display: flex; align-items: flex-start; gap: 4px; word-break: break-word; max-width: 500px; }
.gc-model-status.warning { color: var(--vscode-editorWarning-foreground); }
.gc-test-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.gc-test-result { margin-top: 8px; display: flex; align-items: flex-start; gap: 6px; word-break: break-word; max-width: 760px; }
.gc-test-result.ok .codicon { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.gc-test-result.error { color: var(--vscode-errorForeground); }

.gc-operations { display: flex; flex-direction: column; gap: 6px; max-width: 780px; }
.gc-operation { border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35)); border-radius: 4px; background: var(--vscode-input-background); }
.gc-operation.own { border-left: 2px solid var(--vscode-settings-modifiedItemIndicator, var(--vscode-focusBorder)); }
.gc-operation-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; }
.gc-operation-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.gc-operation-name { font-weight: 600; }
.gc-operation-model { font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-operation-editor { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 12px 36px; border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25)); }
.gc-provider-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.gc-provider-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 6px; border-radius: 999px; font: inherit; font-size: 12px; cursor: pointer;
  color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
}
.gc-provider-chip:hover { background: var(--vscode-list-hoverBackground); }
.gc-provider-chip.selected { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent); }
.gc-provider-chip:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.gc-provider-chip .gc-ai-icon { width: 16px; height: 16px; }
.gc-provider-chip .gc-ai-icon svg { width: 14px; height: 14px; }
.gc-provider-chip .gc-ai-icon .codicon { font-size: 14px !important; }
/* The chip's label already says CLI. */
.gc-provider-chip .gc-ai-icon-badge { display: none; }

/* ── Cloud Integrations ──────────────────────────────────────────────────── */
.gc-integrations { display: flex; flex-direction: column; gap: 6px; margin: 8px 0 0 14px; max-width: 780px; }
.gc-integration {
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35)); border-radius: 4px; overflow: hidden;
  background: var(--vscode-input-background);
}
.gc-integration.connected { border-left: 2px solid var(--vscode-settings-modifiedItemIndicator, var(--vscode-focusBorder)); }
.gc-integration-head { display: flex; align-items: center; gap: 10px; padding: 6px 10px 6px 4px; }
.gc-integration-toggle {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 2px 4px; border: none; background: transparent;
  color: var(--vscode-foreground); font: inherit; text-align: left; cursor: pointer; border-radius: 2px;
}
.gc-integration-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.gc-integration:not(.connected) .gc-integration-toggle > .gc-provider-icon,
.gc-integration:not(.connected) .gc-integration-toggle > .codicon-github { opacity: 0.6; }
.gc-provider-icon { flex-shrink: 0; }
.gc-integration-text { display: flex; flex-direction: column; min-width: 0; }
.gc-integration-name { font-weight: 600; }
.gc-integration-desc { font-size: 12px; color: var(--vscode-descriptionForeground); }
.gc-status-ok { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #89d185)); }
.gc-integration-body { padding: 4px 12px 12px 38px; border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25)); }
.gc-integration-body > .gc-row-desc { margin: 6px 0; }
.gc-accounts { max-width: 100%; margin-top: 6px; }
.gc-accounts-empty { padding: 4px 0; }
.gc-account { min-height: 36px; gap: 10px; }
.gc-account-avatar {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
  font-size: 10px; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.gc-account-actions { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; }
.gc-account-actions .gc-btn { padding: 3px 10px; font-size: 12px; }
.gc-account-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.gc-account-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-account-repos { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-add-account { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.35)); }
.gc-add-account-title { font-weight: 600; }
.gc-field { display: flex; flex-direction: column; gap: 4px; max-width: 500px; }
.gc-field > span:first-child { font-size: 12px; }
.gc-field-hint { font-size: 12px; color: var(--vscode-descriptionForeground); }
.gc-add-error { border-top: 1px solid var(--vscode-inputValidation-errorBorder); }
.gc-repo-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }

/* ── Previews (mock-ups) ─────────────────────────────────────────────────── */
.gc-preview { margin: 0; }
.gc-preview-caption { margin-bottom: 8px; font-weight: 600; color: var(--vscode-settings-headerForeground, var(--vscode-foreground)); }
.gc-preview-body { font-size: 12px; user-select: none; }
.pv-stack { display: flex; flex-direction: column; gap: 10px; position: relative; }
.pv-grow { flex: 1; min-width: 0; }
.pv-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
.pv-italic { font-style: italic; color: var(--vscode-descriptionForeground); }
.pv-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
.pv-panel { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); overflow: hidden; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
.pv-titlebar { display: flex; align-items: center; gap: 10px; padding: 6px 8px; font-size: 10px; font-weight: 600; color: var(--vscode-sideBarTitle-foreground, var(--vscode-descriptionForeground)); }
.pv-tab { font-weight: normal; padding-bottom: 2px; }
.pv-tab.active { color: var(--vscode-foreground); border-bottom: 1px solid var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder)); }
.pv-content { padding: 2px 0; }
.pv-section { display: flex; align-items: center; gap: 6px; padding: 2px 6px; font-weight: 600; font-size: 11px; }
.pv-subsection { padding: 2px 20px; font-size: 10px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.pv-count { font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.pv-row { display: flex; align-items: center; gap: 6px; padding: 1px 8px; }
.pv-check { width: 10px; height: 10px; border-radius: 2px; background: var(--vscode-checkbox-background, var(--vscode-focusBorder)); border: 1px solid var(--vscode-checkbox-border, var(--vscode-focusBorder)); }
.pv-status { font-size: 10px; font-weight: 600; width: 10px; text-align: center; }
.pv-status.s-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
.pv-status.s-A { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
.pv-commitbox { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.pv-textarea { padding: 4px 6px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); }
.pv-buttons { display: flex; gap: 6px; }
.pv-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 2px; font-size: 11px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.pv-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.pv-btn.small { padding: 1px 7px; font-size: 10px; }
.pv-graph { padding: 2px 0; }
.pv-graph-row { display: flex; align-items: center; gap: 8px; padding: 2px 8px; }
.pv-lane { width: 26px; display: flex; align-items: center; position: relative; }
.pv-lane::before { content: ''; position: absolute; left: 4px; top: -8px; bottom: -8px; width: 2px; background: color-mix(in srgb, var(--vscode-charts-blue, #4fc3f7) 50%, transparent); }
.pv-node { width: 10px; height: 10px; border-radius: 50%; position: relative; z-index: 1; border: 2px solid var(--vscode-editor-background); box-sizing: content-box; margin-left: -1px; }
.pv-node.hollow { background: var(--vscode-editor-background); border: 2px dashed; width: 7px; height: 7px; }
.pv-window { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); overflow: hidden; background: var(--vscode-editor-background); }
.pv-window-floating { width: 82%; margin: -40px 0 0 auto; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36)); position: relative; z-index: 2; }
.pv-window-bar { display: flex; align-items: center; gap: 8px; padding: 3px 8px; background: var(--vscode-titleBar-activeBackground, rgba(127,127,127,0.12)); font-size: 10px; color: var(--vscode-titleBar-activeForeground, var(--vscode-descriptionForeground)); }
.pv-traffic { width: 30px; height: 8px; background: radial-gradient(circle at 4px 4px, #ff5f57 3.5px, transparent 4px), radial-gradient(circle at 15px 4px, #febc2e 3.5px, transparent 4px), radial-gradient(circle at 26px 4px, #28c840 3.5px, transparent 4px); }
.pv-window-title { flex: 1; text-align: center; margin-right: 38px; }
.pv-window-body { display: flex; min-height: 160px; }
.pv-activity { width: 18px; background: var(--vscode-activityBar-background, rgba(127,127,127,0.12)); flex-shrink: 0; }
.pv-editor-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.pv-tabs { display: flex; background: var(--vscode-editorGroupHeader-tabsBackground, rgba(127,127,127,0.08)); }
.pv-tabs.small .pv-etab { font-size: 9px; }
.pv-etab { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; font-size: 10px; color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground)); }
.pv-etab.active { background: var(--vscode-tab-activeBackground, var(--vscode-editor-background)); color: var(--vscode-tab-activeForeground, var(--vscode-foreground)); box-shadow: inset 0 1px 0 var(--vscode-tab-activeBorderTop, var(--vscode-focusBorder)); }
.pv-code-lines { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.pv-skel { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); }
.pv-bottom-panel { border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-panel-background, transparent); }
.pv-split { display: flex; min-width: 0; }
.pv-split-main { flex: 1; min-width: 0; }
.pv-split-side { width: 34%; border-left: 1px solid var(--vscode-panel-border); padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
.pv-side-title { font-size: 10px; font-weight: 600; color: var(--vscode-descriptionForeground); }
.pv-footnote { display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
.pv-repo-tabs { display: flex; gap: 4px; padding: 4px 8px 6px; flex-wrap: wrap; }
.pv-repo-tab { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; font-size: 10px; border: 1px solid var(--vscode-panel-border); }
.pv-repo-pill { font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid; }
.pv-tree { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); padding: 4px 0; background: var(--vscode-sideBar-background, transparent); }
.pv-tree-row { display: flex; align-items: center; gap: 5px; padding: 1px 8px; }
.pv-tree-row.off { opacity: 0.4; text-decoration: line-through; }
.pv-quickpick { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); box-shadow: 0 0 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36)); padding: 6px; }
.pv-qp-input { display: flex; align-items: center; padding: 3px 6px; margin-bottom: 4px; border: 1px solid var(--vscode-focusBorder); background: var(--vscode-input-background); color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
.pv-caret { display: inline-block; vertical-align: middle; width: 1px; height: 11px; margin-left: 1px; background: var(--vscode-editorCursor-foreground, var(--vscode-foreground)); animation: pv-blink 1s steps(1) infinite; }
.pv-qp-item { display: flex; align-items: center; gap: 6px; padding: 2px 6px; border-radius: 3px; }
.pv-qp-item.active { background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-quickInputList-focusForeground, inherit); }
.pv-qp-detail { padding: 0 6px 3px 26px; font-size: 10px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-warn { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; color: var(--vscode-editorWarning-foreground); font-size: 10px; }
.pv-timeline { display: flex; flex-direction: column; gap: 6px; }
.pv-timeline-step { display: flex; align-items: center; gap: 6px; }
.pv-timeline-step.off { color: var(--vscode-descriptionForeground); }
.pv-toasts { display: flex; flex-direction: column; gap: 8px; }
.pv-toast { display: flex; gap: 8px; padding: 8px 10px; border-radius: 4px; background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); color: var(--vscode-notifications-foreground, inherit); border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border, transparent)); box-shadow: 0 0 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36)); }
.pv-toast-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.pv-empty { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 20px; color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); }
.pv-editor { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); background: var(--vscode-editor-background); padding: 6px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; overflow: hidden; }
.pv-code-row { display: flex; align-items: center; white-space: pre; line-height: 1.7; }
.pv-code-row.current { background: var(--vscode-editor-lineHighlightBackground, rgba(127,127,127,0.1)); }
.pv-blame { width: 15ch; flex-shrink: 0; padding: 0 6px; color: var(--vscode-descriptionForeground); border-right: 2px solid color-mix(in srgb, var(--vscode-charts-blue, #4fc3f7) 60%, transparent); font-size: 10px; overflow: hidden; }
.pv-ln { width: 3ch; text-align: right; padding: 0 8px 0 4px; color: var(--vscode-editorLineNumber-foreground); flex-shrink: 0; }
.pv-code { overflow: hidden; text-overflow: ellipsis; }
.pv-ghost { margin-left: 2em; color: var(--vscode-editorLineNumber-foreground); overflow: hidden; text-overflow: ellipsis; }
.pv-hover { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border)); background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)); border-radius: 3px; }
.pv-avatar { width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 40%, transparent); flex-shrink: 0; }
.pv-avatar.img { background: radial-gradient(circle at 50% 38%, #f1c27d 0 28%, transparent 29%), radial-gradient(circle at 50% 100%, #4a90d9 0 45%, transparent 46%), #cfe3f7; }
/* Commit Panel mock (Commit & Changes) */
.pv-commit { font-size: 11px; }
.pv-commit-title { padding: 6px 8px 2px; font-weight: 600; }
.pv-commit-tabs { display: flex; align-items: center; gap: 10px; padding: 3px 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.pv-commit-tab { display: inline-flex; align-items: center; gap: 4px; padding-bottom: 3px; font-weight: 600; }
.pv-commit-tab.active { border-bottom: 1px solid var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder)); }
.pv-cb { display: inline-flex; align-items: center; justify-content: center; width: 11px; height: 11px; border-radius: 2px; flex-shrink: 0; border: 1px solid var(--vscode-checkbox-border, rgba(128,128,128,0.6)); }
.pv-cb .codicon { font-size: 9px !important; color: #fff; }
.pv-cb.on, .pv-cb.some { background: var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
.pv-repo, .pv-group, .pv-file { display: flex; align-items: center; gap: 4px; padding-right: 6px; height: 19px; }
.pv-repo { background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
.pv-repo-name, .pv-group { font-weight: 700; font-size: 10px; letter-spacing: 0.04em; }
.pv-group { padding-left: 4px; }
.pv-group.accent { box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
.pv-branch { display: inline-flex; align-items: center; gap: 2px; padding: 0 4px; font-size: 9px; border-radius: 2px; color: var(--vscode-textLink-foreground, #4daafc); border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 60%, transparent); }
.pv-repo .pv-count, .pv-repo .pv-num, .pv-group .pv-count { margin-left: auto; }
.pv-num { font-size: 10px; color: var(--vscode-descriptionForeground); }
.pv-count { font-variant-numeric: tabular-nums; }
.pv-repo .pv-count, .pv-group .pv-count { background: var(--vscode-focusBorder); color: #fff; }
.s-M-text { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
.s-U-text { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
.pv-status.s-U { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
.pv-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pv-chip { font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid; }
.pv-chip b { font-weight: normal; opacity: 0.8; }
.pv-commit .pv-textarea { display: flex; align-items: flex-start; min-height: 34px; }
.pv-commit .pv-btn { padding: 0 0 0 8px; height: 20px; gap: 4px; }
.pv-btn-split { display: inline-flex; align-items: center; height: 100%; padding: 0 5px; margin-left: 4px; border-left: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
.pv-center { display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
/* Preview scenes (useLoop in previews.tsx) */
@keyframes pv-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes pv-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes pv-blink { 50% { opacity: 0; } }
@keyframes pv-flash { from { background: color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent); } to { background: transparent; } }
.pv-in { animation: pv-in 0.28s ease-out both; }
.pv-fade { animation: pv-fade 0.4s ease-out both; }
.pv-file, .pv-repo, .pv-graph-row, .pv-code-row, .pv-tree-row, .pv-qp-item, .pv-repo-tab { transition: background-color 0.25s, opacity 0.3s, border-color 0.3s; }
.pv-hot { background: var(--vscode-list-hoverBackground); }
.pv-flash { animation: pv-flash 0.6s ease-out; }
.pv-pressed { filter: brightness(1.3); transform: scale(0.97); }
.pv-btn { transition: filter 0.15s, transform 0.15s; }
.pv-graph-row.selected { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-inactiveSelectionBackground)); color: var(--vscode-list-activeSelectionForeground, inherit); }
.pv-graph-row.selected .pv-muted { color: inherit; opacity: 0.8; }
.pv-dim { opacity: 0.35; }
.pv-tree-row.pv-lit { background: var(--vscode-list-inactiveSelectionBackground); }
.pv-repo-tab.active { background: var(--vscode-list-inactiveSelectionBackground); }
.pv-side-detail { display: flex; flex-direction: column; gap: 3px; font-size: 10px; min-width: 0; }
.pv-committed { display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #89d185)); }
.pv-qp-typed { color: var(--vscode-input-foreground); }
@media (prefers-reduced-motion: reduce) {
  .pv-in, .pv-fade, .pv-flash, .pv-caret { animation: none; }
  .pv-file, .pv-repo, .pv-graph-row, .pv-code-row, .pv-tree-row, .pv-qp-item, .pv-repo-tab, .pv-btn { transition: none; }
}
`;
