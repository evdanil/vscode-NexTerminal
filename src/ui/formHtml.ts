import type { FormDefinition, FormFieldDescriptor } from "./formTypes";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderField(field: FormFieldDescriptor): string {
  const id = `field-${field.key}`;
  const req = "required" in field && field.required ? " required" : "";

  switch (field.type) {
    case "text":
      return `<div class="form-group">
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="text" id="${id}" name="${field.key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />
  <div class="field-error" id="error-${field.key}"></div>
</div>`;

    case "number":
      return `<div class="form-group">
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="number" id="${id}" name="${field.key}" value="${field.value ?? ""}" min="${field.min ?? ""}" max="${field.max ?? ""}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />
  <div class="field-error" id="error-${field.key}"></div>
</div>`;

    case "select":
      return `<div class="form-group">
  <label for="${id}">${escapeHtml(field.label)}</label>
  <select id="${id}" name="${field.key}" class="create-inline-select">
    ${field.options.map((opt) => `<option value="${escapeHtml(opt.value)}"${opt.value === field.value ? " selected" : ""}>${escapeHtml(opt.label)}</option>`).join("\n    ")}
  </select>
  <div class="field-error" id="error-${field.key}"></div>
</div>`;

    case "combobox":
      return `<div class="form-group">
  <label for="${id}">${escapeHtml(field.label)}</label>
  <input type="text" id="${id}" name="${field.key}" list="list-${field.key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "Type or select...")}" />
  <datalist id="list-${field.key}">
    ${field.suggestions.map((s) => `<option value="${escapeHtml(s)}">`).join("\n    ")}
  </datalist>
  <div class="field-error" id="error-${field.key}"></div>
</div>`;

    case "checkbox":
      return `<div class="form-group form-group-checkbox">
  <label>
    <input type="checkbox" id="${id}" name="${field.key}"${field.value ? " checked" : ""} />
    ${escapeHtml(field.label)}
  </label>
</div>`;

    case "file":
      return `<div class="form-group">
  <label for="${id}">${escapeHtml(field.label)}</label>
  <div class="file-input-row">
    <input type="text" id="${id}" name="${field.key}" value="${escapeHtml(field.value ?? "")}" readonly />
    <button type="button" class="browse-btn" data-key="${field.key}">Browse</button>
  </div>
  <div class="field-error" id="error-${field.key}"></div>
</div>`;
  }
}

export function renderFormHtml(definition: FormDefinition): string {
  const fieldsHtml = definition.fields.map(renderField).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 20px;
      max-width: 520px;
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 20px 0;
    }
    .form-group {
      margin-bottom: 14px;
    }
    .form-group-checkbox {
      margin-top: 8px;
    }
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
    .browse-btn {
      padding: 5px 12px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .browse-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
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
  </style>
</head>
<body>
  <h2>${escapeHtml(definition.title)}</h2>
  <form id="nexus-form">
    ${fieldsHtml}
    <div class="actions">
      <button type="submit" class="btn-primary">Save</button>
      <button type="button" class="btn-secondary" id="cancel-btn">Cancel</button>
    </div>
  </form>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const form = document.getElementById("nexus-form");

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const values = {};
        for (const el of form.elements) {
          if (!el.name) continue;
          if (el.type === "checkbox") {
            values[el.name] = el.checked;
          } else if (el.type === "number") {
            values[el.name] = el.value === "" ? undefined : Number(el.value);
          } else {
            values[el.name] = el.value;
          }
        }
        vscode.postMessage({ type: "submit", values: values });
      });

      document.getElementById("cancel-btn").addEventListener("click", () => {
        vscode.postMessage({ type: "cancel" });
      });

      for (const btn of document.querySelectorAll(".browse-btn")) {
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "browse", key: btn.dataset.key });
        });
      }

      // Handle select fields with __create__ values (e.g., "Create new server...")
      for (const sel of document.querySelectorAll(".create-inline-select")) {
        sel.addEventListener("change", () => {
          if (sel.value.startsWith("__create__")) {
            const key = sel.name;
            sel.value = sel.dataset.prev || "";
            vscode.postMessage({ type: "createInline", key: key });
          } else {
            sel.dataset.prev = sel.value;
          }
        });
      }

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (msg.type === "browseResult") {
          const input = document.getElementById("field-" + msg.key);
          if (input) input.value = msg.path;
        }
        if (msg.type === "addSelectOption") {
          const sel = document.getElementById("field-" + msg.key);
          if (sel) {
            const opt = document.createElement("option");
            opt.value = msg.value;
            opt.textContent = msg.label;
            // Insert before the last option (which is "Create new...")
            const createOpt = sel.querySelector('option[value^="__create__"]');
            if (createOpt) {
              sel.insertBefore(opt, createOpt);
            } else {
              sel.appendChild(opt);
            }
            sel.value = msg.value;
            sel.dataset.prev = msg.value;
          }
        }
        if (msg.type === "validationError") {
          for (const errEl of document.querySelectorAll(".field-error")) {
            errEl.textContent = "";
          }
          for (const [key, message] of Object.entries(msg.errors)) {
            const errEl = document.getElementById("error-" + key);
            if (errEl) errEl.textContent = message;
          }
        }
      });
    })();
  </script>
</body>
</html>`;
}
