/**
 * Shared CSS for all webview panels.
 * Provides base typography, form controls, custom selects/comboboxes,
 * buttons, banners, and error elements using VS Code theme variables.
 */
export function baseWebviewCss(): string {
  return `
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 20px;
      max-width: 700px;
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 20px 0;
    }
    h3 {
      font-size: 14px;
      font-weight: 600;
      margin: 24px 0 12px 0;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
    }
    h3:first-of-type {
      margin-top: 0;
    }
    .form-group {
      margin-bottom: 18px;
    }
    .form-group-checkbox {
      margin-top: 8px;
    }
    .form-group[data-visible-when] { display: none; }
    .form-group[data-visible-when].field-visible { display: block; }
    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .form-group-checkbox label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    .req { color: var(--vscode-errorForeground); }
    input[type="text"],
    input[type="password"],
    input[type="number"] {
      width: 100%;
      box-sizing: border-box;
      padding: 5px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }
    input[type="text"]:focus,
    input[type="password"]:focus,
    input[type="number"]:focus {
      border-color: var(--vscode-focusBorder);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 5px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 13px;
      outline: none;
      resize: vertical;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .custom-select {
      position: relative;
      width: 100%;
      box-sizing: border-box;
    }
    .custom-select-trigger {
      display: flex;
      align-items: center;
      width: 100%;
      box-sizing: border-box;
      padding: 5px 8px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
      border-radius: 2px;
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
      outline: none;
      user-select: none;
    }
    .custom-select-trigger:focus,
    .custom-select.open .custom-select-trigger {
      border-color: var(--vscode-focusBorder);
    }
    .custom-select-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .custom-select-trigger::after {
      content: "\\25BE";
      margin-left: 8px;
      flex-shrink: 0;
      opacity: 0.7;
    }
    .custom-select-dropdown {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      z-index: 1000;
      max-height: 250px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
      border-top: none;
      border-radius: 0 0 2px 2px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.16);
    }
    .custom-select.open .custom-select-dropdown {
      display: block;
    }
    .custom-select-option {
      padding: 4px 8px;
      cursor: pointer;
      font-size: 13px;
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
    }
    .custom-select-option:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .custom-select-option.selected {
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-focusBorder));
      color: var(--vscode-list-activeSelectionForeground, #fff);
    }
    .custom-select-group {
      padding: 6px 8px 2px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      opacity: 0.7;
    }
    .custom-combobox {
      position: relative;
    }
    .custom-combobox.open .custom-select-dropdown {
      display: block;
    }
    input[type="checkbox"] {
      accent-color: var(--vscode-focusBorder);
    }
    .file-input-row {
      display: flex;
      gap: 6px;
    }
    .file-input-row input {
      flex: 1;
    }
    .browse-btn, .scan-btn {
      padding: 5px 12px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .browse-btn:hover, .scan-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    .clear-btn {
      padding: 5px 8px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      opacity: 0.7;
    }
    .clear-btn:hover {
      opacity: 1;
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    }
    .field-hint {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-top: 3px;
      line-height: 1.4;
    }
    .variables-section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .variables-section-header > label {
      margin-bottom: 0;
    }
    .variables-header-error {
      display: inline-block;
      margin-left: 8px;
    }
    .variable-row {
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
      border-radius: 3px;
      padding: 8px;
      margin-top: 10px;
    }
    .variable-row-line1 {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    /* Panel is user-resizable and routinely sits at 350-450px; each text input
       shrinks with the row but never collapses below a usable width. */
    .variable-row-line1 input {
      flex: 1 1 120px;
      min-width: 120px;
      width: auto;
    }
    .variable-row-line2 {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 14px;
      margin-top: 8px;
    }
    .variable-row-line2 label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-weight: normal;
      font-size: 12px;
      margin-bottom: 0;
      cursor: pointer;
      white-space: nowrap;
    }
    .variable-remove-btn {
      margin-left: auto;
      padding: 4px 10px;
      font-size: 12px;
    }
    .variable-row .field-error {
      margin-top: 6px;
    }
    /* Reserved height so hints appearing/disappearing under Text don't bounce
       the layout under the user's cursor (docs/plans/2026-07-29-macro-variables.md §9.3). */
    .variables-diagnostics {
      min-height: 32px;
      font-size: 11px;
      line-height: 1.6;
      margin-top: 6px;
    }
    .variables-diagnostics .diag-hint {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .variables-diagnostics .diag-positive {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .variables-diagnostics .diag-add-btn {
      margin-left: 6px;
      padding: 1px 8px;
      font-size: 11px;
    }
    .variables-trigger-conflict {
      display: none;
      color: var(--vscode-errorForeground);
      font-size: 11px;
      margin-top: 6px;
      line-height: 1.4;
    }
    .variables-trigger-conflict.visible {
      display: block;
    }
    .field-error {
      color: var(--vscode-errorForeground);
      font-size: 11px;
      margin-top: 3px;
      min-height: 0;
    }
    .actions {
      margin-top: 22px;
      display: flex;
      gap: 8px;
    }
    .btn-primary {
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      padding: 6px 16px;
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 2px;
      cursor: pointer;
      font-size: 13px;
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    }
    .btn-secondary:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .btn-secondary:disabled:hover {
      background: var(--vscode-button-secondaryBackground, transparent);
    }
    .info-banner {
      padding: 8px 12px;
      margin-bottom: 16px;
      font-size: 12px;
      line-height: 1.4;
      color: var(--vscode-foreground);
      background: var(--vscode-inputValidation-infoBackground, rgba(0, 120, 212, 0.1));
      border: 1px solid var(--vscode-inputValidation-infoBorder, rgba(0, 120, 212, 0.4));
      border-radius: 2px;
    }
    .button-row {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }
    body:has(.form-illustration) {
      max-width: 1000px;
    }
    .form-illustration {
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .form-illustration svg {
      display: block;
      width: 100%;
      height: auto;
    }
    .form-illustration .illustration-dark,
    .form-illustration .illustration-light { display: none; }
    body.vscode-dark .form-illustration .illustration-dark,
    body.vscode-high-contrast .form-illustration .illustration-dark { display: block; }
    body.vscode-light .form-illustration .illustration-light,
    body.vscode-high-contrast-light .form-illustration .illustration-light { display: block; }`;
}
