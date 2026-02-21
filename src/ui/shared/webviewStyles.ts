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
    .form-group[data-visible-when-field] { display: none; }
    .form-group[data-visible-when-field].field-visible { display: block; }
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
      color: var(--vscode-editorInfo-foreground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-infoBackground, rgba(0, 120, 212, 0.1));
      border: 1px solid var(--vscode-inputValidation-infoBorder, rgba(0, 120, 212, 0.4));
      border-radius: 2px;
    }
    .button-row {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }`;
}
