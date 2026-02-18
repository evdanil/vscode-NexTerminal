import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface SwatchDef {
  key: string;
  label: string;
}

const SPECIAL_SWATCHES: SwatchDef[] = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Foreground" },
  { key: "cursor", label: "Cursor" },
  { key: "selectionBackground", label: "Selection" },
];

const NORMAL_SWATCHES: SwatchDef[][] = [
  [
    { key: "black", label: "Black" },
    { key: "red", label: "Red" },
    { key: "green", label: "Green" },
    { key: "yellow", label: "Yellow" },
  ],
  [
    { key: "blue", label: "Blue" },
    { key: "magenta", label: "Magenta" },
    { key: "cyan", label: "Cyan" },
    { key: "white", label: "White" },
  ],
  [
    { key: "brightBlack", label: "Bright Black" },
    { key: "brightRed", label: "Bright Red" },
    { key: "brightGreen", label: "Bright Green" },
    { key: "brightYellow", label: "Bright Yellow" },
  ],
  [
    { key: "brightBlue", label: "Bright Blue" },
    { key: "brightMagenta", label: "Bright Magenta" },
    { key: "brightCyan", label: "Bright Cyan" },
    { key: "brightWhite", label: "Bright White" },
  ],
];

function renderSwatch(
  swatch: SwatchDef,
  scheme: ColorScheme | undefined,
  large: boolean
): string {
  const color = scheme
    ? escapeHtml((scheme as unknown as Record<string, string>)[swatch.key] ?? "transparent")
    : "transparent";
  const sizeClass = large ? " swatch-large" : "";
  return `<div class="swatch-cell${sizeClass}">
  <div class="color-swatch${sizeClass}" data-color-key="${escapeHtml(swatch.key)}" style="background-color: ${color};"></div>
  <span class="swatch-label">${escapeHtml(swatch.label)}</span>
</div>`;
}

function renderSchemeOptions(
  schemes: ColorScheme[],
  activeSchemeId: string
): string {
  const builtIn = schemes.filter((s) => s.builtIn);
  const imported = schemes.filter((s) => !s.builtIn);

  let html = `<option value=""${activeSchemeId === "" ? " selected" : ""}>— None (VS Code Default) —</option>`;

  if (builtIn.length > 0) {
    html += `\n      <optgroup label="Built-in">`;
    for (const s of builtIn) {
      html += `\n        <option value="${escapeHtml(s.id)}"${s.id === activeSchemeId ? " selected" : ""}>${escapeHtml(s.name)}</option>`;
    }
    html += `\n      </optgroup>`;
  }

  if (imported.length > 0) {
    html += `\n      <optgroup label="Imported">`;
    for (const s of imported) {
      html += `\n        <option value="${escapeHtml(s.id)}"${s.id === activeSchemeId ? " selected" : ""}>${escapeHtml(s.name)}</option>`;
    }
    html += `\n      </optgroup>`;
  }

  return html;
}

export function renderTerminalAppearanceHtml(
  schemes: ColorScheme[],
  activeSchemeId: string,
  fontConfig: TerminalFontConfig | undefined,
  nonce: string
): string {
  const activeScheme = schemes.find((s) => s.id === activeSchemeId);
  const deleteDisabled = !activeScheme || activeScheme.builtIn;

  const fontFamily = fontConfig?.family ?? "";
  const fontSize = fontConfig?.size ?? 14;
  const fontWeight = fontConfig?.weight ?? "normal";

  const specialSwatchesHtml = SPECIAL_SWATCHES.map((s) =>
    renderSwatch(s, activeScheme, true)
  ).join("\n        ");

  const normalSwatchesHtml = NORMAL_SWATCHES.map((row) =>
    row.map((s) => renderSwatch(s, activeScheme, false)).join("\n        ")
  ).join("\n        ");

  const previewDisplay = activeScheme ? "grid" : "none";
  const placeholderDisplay = activeScheme ? "none" : "block";

  const weightOptions = [
    { value: "normal", label: "Normal" },
    { value: "bold", label: "Bold" },
    { value: "300", label: "Light" },
    { value: "100", label: "Thin" },
    { value: "500", label: "Medium" },
    { value: "600", label: "Semi-Bold" },
    { value: "800", label: "Extra-Bold" },
  ];

  const weightOptionsHtml = weightOptions
    .map(
      (opt) =>
        `<option value="${escapeHtml(opt.value)}"${opt.value === fontWeight ? " selected" : ""}>${escapeHtml(opt.label)}</option>`
    )
    .join("\n          ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 20px;
      max-width: 600px;
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
      margin-bottom: 14px;
    }
    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    input[type="text"],
    input[type="number"],
    select {
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
    input[type="number"]:focus,
    select:focus {
      border-color: var(--vscode-focusBorder);
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
    .button-row {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }
    .preview-placeholder {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      font-style: italic;
      font-size: 12px;
    }
    .special-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 12px;
    }
    .color-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .swatch-cell {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
    }
    .color-swatch {
      width: 40px;
      height: 40px;
      border-radius: 2px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    }
    .color-swatch.swatch-large {
      width: 56px;
      height: 56px;
    }
    .swatch-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      text-align: center;
      line-height: 1.2;
    }
    .font-preview {
      margin-top: 10px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <h3>Font Settings</h3>

  <div class="form-group">
    <label for="font-family">Font Family</label>
    <input type="text" id="font-family" list="font-family-list" value="${escapeHtml(fontFamily)}" placeholder="e.g. Consolas, monospace" />
    <datalist id="font-family-list">
      <option value="Consolas">
      <option value="Cascadia Code">
      <option value="JetBrains Mono">
      <option value="Fira Code">
      <option value="Source Code Pro">
      <option value="Monaco">
      <option value="Menlo">
      <option value="Courier New">
      <option value="monospace">
    </datalist>
  </div>

  <div class="form-group">
    <label for="font-size">Font Size</label>
    <input type="number" id="font-size" min="8" max="72" value="${fontSize}" />
  </div>

  <div class="form-group">
    <label for="font-weight">Font Weight</label>
    <select id="font-weight">
      ${weightOptionsHtml}
    </select>
  </div>

  <button type="button" class="btn-primary" id="apply-font-btn">Apply Font</button>

  <div class="font-preview" id="font-preview">
    The quick brown fox jumps over the lazy dog. 0123456789
  </div>

  <h3>Color Scheme</h3>

  <div class="form-group">
    <label for="scheme-select">Color Scheme</label>
    <select id="scheme-select">
      ${renderSchemeOptions(schemes, activeSchemeId)}
    </select>
  </div>

  <div id="preview-placeholder" class="preview-placeholder" style="display: ${placeholderDisplay};">
    Select a scheme to preview colors
  </div>

  <div id="preview-grid" style="display: ${previewDisplay};">
    <div class="special-grid">
      ${specialSwatchesHtml}
    </div>
    <div class="color-grid">
      ${normalSwatchesHtml}
    </div>
  </div>

  <div class="button-row">
    <button type="button" class="btn-secondary" id="import-file-btn">Import File</button>
    <button type="button" class="btn-secondary" id="import-dir-btn">Import Directory</button>
    <button type="button" class="btn-secondary" id="delete-btn"${deleteDisabled ? " disabled" : ""}>Delete Scheme</button>
  </div>

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();

      var schemeSelect = document.getElementById("scheme-select");
      schemeSelect.addEventListener("change", function() {
        vscode.postMessage({ type: "selectScheme", schemeId: schemeSelect.value });
      });

      document.getElementById("import-file-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "importFile" });
      });
      document.getElementById("import-dir-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "importDirectory" });
      });

      document.getElementById("delete-btn").addEventListener("click", function() {
        var schemeId = schemeSelect.value;
        if (schemeId) {
          vscode.postMessage({ type: "deleteScheme", schemeId: schemeId });
        }
      });

      document.getElementById("apply-font-btn").addEventListener("click", function() {
        var family = document.getElementById("font-family").value;
        var size = parseInt(document.getElementById("font-size").value, 10) || 14;
        var weight = document.getElementById("font-weight").value;
        vscode.postMessage({ type: "applyFont", family: family, size: size, weight: weight });
      });

      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "schemesUpdated") {
          updateSchemes(msg.schemes, msg.activeId);
        }
      });

      function updateSchemes(schemes, activeId) {
        var builtIn = schemes.filter(function(s) { return s.builtIn; });
        var imported = schemes.filter(function(s) { return !s.builtIn; });

        var noneLabel = "\\u2014 None (VS Code Default) \\u2014";
        var optHtml = '<option value="">' + noneLabel + '</option>';
        if (builtIn.length > 0) {
          optHtml += '<optgroup label="Built-in">';
          builtIn.forEach(function(s) {
            optHtml += '<option value="' + s.id + '"' + (s.id === activeId ? ' selected' : '') + '>' + escapeHtml(s.name) + '</option>';
          });
          optHtml += '</optgroup>';
        }
        if (imported.length > 0) {
          optHtml += '<optgroup label="Imported">';
          imported.forEach(function(s) {
            optHtml += '<option value="' + s.id + '"' + (s.id === activeId ? ' selected' : '') + '>' + escapeHtml(s.name) + '</option>';
          });
          optHtml += '</optgroup>';
        }
        schemeSelect.innerHTML = optHtml;

        var activeScheme = schemes.find(function(s) { return s.id === activeId; });
        updatePreview(activeScheme);

        var deleteBtn = document.getElementById("delete-btn");
        deleteBtn.disabled = !activeScheme || activeScheme.builtIn;
      }

      function updatePreview(scheme) {
        var swatches = document.querySelectorAll(".color-swatch[data-color-key]");
        for (var i = 0; i < swatches.length; i++) {
          var swatch = swatches[i];
          var key = swatch.dataset.colorKey;
          swatch.style.backgroundColor = scheme ? scheme[key] : "transparent";
        }
        var placeholder = document.getElementById("preview-placeholder");
        var grid = document.getElementById("preview-grid");
        if (scheme) {
          placeholder.style.display = "none";
          grid.style.display = "grid";
        } else {
          placeholder.style.display = "block";
          grid.style.display = "none";
        }
      }

      function escapeHtml(str) {
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
    })();
  </script>
</body>
</html>`;
}
