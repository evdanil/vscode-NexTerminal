import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";

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
  large: boolean
): string {
  const sizeClass = large ? " swatch-large" : "";
  return `<div class="swatch-cell${sizeClass}">
  <div class="color-swatch${sizeClass}" data-color-key="${escapeHtml(swatch.key)}"></div>
  <span class="swatch-label">${escapeHtml(swatch.label)}</span>
</div>`;
}

function renderSchemeOptions(
  schemes: ColorScheme[],
  activeSchemeId: string
): string {
  const builtIn = schemes.filter((s) => s.builtIn);
  const imported = schemes.filter((s) => !s.builtIn);

  let html = `<div class="custom-select-option${activeSchemeId === "" ? " selected" : ""}" data-value="">\u2014 None (VS Code Default) \u2014</div>`;

  if (builtIn.length > 0) {
    html += `\n      <div class="custom-select-group">Built-in</div>`;
    for (const s of builtIn) {
      html += `\n      <div class="custom-select-option${s.id === activeSchemeId ? " selected" : ""}" data-value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</div>`;
    }
  }

  if (imported.length > 0) {
    html += `\n      <div class="custom-select-group">Imported</div>`;
    for (const s of imported) {
      html += `\n      <div class="custom-select-option${s.id === activeSchemeId ? " selected" : ""}" data-value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</div>`;
    }
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
    renderSwatch(s, true)
  ).join("\n        ");

  const normalSwatchesHtml = NORMAL_SWATCHES.map((row) =>
    row.map((s) => renderSwatch(s, false)).join("\n        ")
  ).join("\n        ");

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
        `<div class="custom-select-option${opt.value === fontWeight ? " selected" : ""}" data-value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</div>`
    )
    .join("\n        ");

  const selectedWeightLabel = weightOptions.find((opt) => opt.value === fontWeight)?.label ?? "Normal";
  const schemeTriggerLabel = activeScheme?.name ?? "\u2014 None (VS Code Default) \u2014";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    ${baseWebviewCss()}
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
    }
  </style>
</head>
<body>
  <div class="info-banner">
    These settings modify your global VS Code configuration and affect all terminals
    and editor windows — not only terminals opened by this extension.
    For broader theme customization, consider VS Code themes available via the Extensions marketplace.
  </div>

  <h3>Font Settings</h3>

  <div class="form-group">
    <label for="font-family">Font Family</label>
    <div class="custom-combobox">
      <input type="text" id="font-family" value="${escapeHtml(fontFamily)}" placeholder="e.g. Consolas, monospace" autocomplete="off" />
      <div class="custom-select-dropdown">
        <div class="custom-select-option" data-value="Cascadia Code">Cascadia Code</div>
        <div class="custom-select-option" data-value="Cascadia Mono">Cascadia Mono</div>
        <div class="custom-select-option" data-value="Consolas">Consolas</div>
        <div class="custom-select-option" data-value="Courier New">Courier New</div>
        <div class="custom-select-option" data-value="DejaVu Sans Mono">DejaVu Sans Mono</div>
        <div class="custom-select-option" data-value="Droid Sans Mono">Droid Sans Mono</div>
        <div class="custom-select-option" data-value="Fira Code">Fira Code</div>
        <div class="custom-select-option" data-value="Fira Mono">Fira Mono</div>
        <div class="custom-select-option" data-value="Hack">Hack</div>
        <div class="custom-select-option" data-value="IBM Plex Mono">IBM Plex Mono</div>
        <div class="custom-select-option" data-value="Inconsolata">Inconsolata</div>
        <div class="custom-select-option" data-value="JetBrains Mono">JetBrains Mono</div>
        <div class="custom-select-option" data-value="Liberation Mono">Liberation Mono</div>
        <div class="custom-select-option" data-value="Menlo">Menlo</div>
        <div class="custom-select-option" data-value="Monaco">Monaco</div>
        <div class="custom-select-option" data-value="Roboto Mono">Roboto Mono</div>
        <div class="custom-select-option" data-value="SF Mono">SF Mono</div>
        <div class="custom-select-option" data-value="Source Code Pro">Source Code Pro</div>
        <div class="custom-select-option" data-value="Ubuntu Mono">Ubuntu Mono</div>
        <div class="custom-select-option" data-value="monospace">monospace</div>
      </div>
    </div>
  </div>

  <div class="form-group">
    <label for="font-size">Font Size</label>
    <input type="number" id="font-size" min="8" max="72" value="${fontSize}" />
  </div>

  <div class="form-group">
    <label>Font Weight</label>
    <div class="custom-select" id="font-weight-wrapper">
      <input type="hidden" id="font-weight" value="${escapeHtml(fontWeight)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(selectedWeightLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${weightOptionsHtml}
      </div>
    </div>
  </div>

  <button type="button" class="btn-primary" id="apply-font-btn">Apply Font</button>

  <div class="font-preview" id="font-preview">
    The quick brown fox jumps over the lazy dog. 0123456789
  </div>

  <h3>Color Scheme</h3>

  <div class="form-group">
    <label>Color Scheme</label>
    <div class="custom-select" id="scheme-select-wrapper">
      <input type="hidden" id="scheme-select" value="${escapeHtml(activeSchemeId)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(schemeTriggerLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${renderSchemeOptions(schemes, activeSchemeId)}
      </div>
    </div>
  </div>

  <div id="preview-placeholder" class="preview-placeholder">
    Select a scheme to preview colors
  </div>

  <div id="preview-grid">
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
    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();

      initCustomSelects();
      initCustomComboboxes();

      // Scheme select
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

      function updateFontPreview() {
        var preview = document.getElementById("font-preview");
        var family = document.getElementById("font-family").value;
        var size = document.getElementById("font-size").value;
        var weight = document.getElementById("font-weight").value;
        if (family) {
          preview.style.fontFamily = family;
        } else {
          preview.style.fontFamily = "";
        }
        preview.style.fontSize = (parseInt(size, 10) || 14) + "px";
        preview.style.fontWeight = weight || "normal";
      }

      document.getElementById("font-family").addEventListener("input", updateFontPreview);
      document.getElementById("font-size").addEventListener("input", updateFontPreview);
      document.getElementById("font-weight").addEventListener("change", updateFontPreview);

      updateFontPreview();

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
        var optHtml = '<div class="custom-select-option' + (activeId === '' ? ' selected' : '') + '" data-value="">' + escapeHtml(noneLabel) + '</div>';
        if (builtIn.length > 0) {
          optHtml += '<div class="custom-select-group">Built-in</div>';
          builtIn.forEach(function(s) {
            optHtml += '<div class="custom-select-option' + (s.id === activeId ? ' selected' : '') + '" data-value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</div>';
          });
        }
        if (imported.length > 0) {
          optHtml += '<div class="custom-select-group">Imported</div>';
          imported.forEach(function(s) {
            optHtml += '<div class="custom-select-option' + (s.id === activeId ? ' selected' : '') + '" data-value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</div>';
          });
        }

        var wrapper = document.getElementById("scheme-select-wrapper");
        wrapper.querySelector('.custom-select-dropdown').innerHTML = optHtml;

        var activeScheme = schemes.find(function(s) { return s.id === activeId; });
        wrapper.querySelector('.custom-select-text').textContent = activeScheme ? activeScheme.name : noneLabel;
        schemeSelect.value = activeId;

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

      // Apply initial preview from server-rendered data (inline styles blocked by CSP)
      var initialScheme = ${activeScheme ? JSON.stringify(activeScheme) : "null"};
      updatePreview(initialScheme);
    })();
  </script>
</body>
</html>`;
}
