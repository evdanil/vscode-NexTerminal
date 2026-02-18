import type { FormDefinition, FormFieldDescriptor } from "./formTypes";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function visibleWhenAttrs(field: FormFieldDescriptor): string {
  if (!field.visibleWhen) {
    return "";
  }
  return ` data-visible-when-field="${escapeHtml(field.visibleWhen.field)}" data-visible-when-value="${escapeHtml(field.visibleWhen.value)}"`;
}

function renderField(field: FormFieldDescriptor): string {
  const key = escapeHtml(field.key);
  const id = `field-${key}`;
  const req = "required" in field && field.required ? " required" : "";
  const vw = visibleWhenAttrs(field);

  switch (field.type) {
    case "text":
      if (field.scannable) {
        return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <div class="file-input-row">
    <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />
    <button type="button" class="scan-btn" data-key="${key}">Scan</button>
  </div>
  <div class="field-error" id="error-${key}"></div>
</div>`;
      }
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />
  <div class="field-error" id="error-${key}"></div>
</div>`;

    case "number":
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="number" id="${id}" name="${key}" value="${field.value ?? ""}" min="${field.min ?? ""}" max="${field.max ?? ""}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />
  <div class="field-error" id="error-${key}"></div>
</div>`;

    case "select": {
      const selectedOpt = field.options.find((opt) => opt.value === field.value) ?? field.options[0];
      const selectedLabel = selectedOpt?.label ?? "";
      const selectedValue = field.value ?? field.options[0]?.value ?? "";
      const optionsHtml = field.options.map((opt) =>
        `<div class="custom-select-option${opt.value === selectedValue ? " selected" : ""}" data-value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</div>`
      ).join("\n      ");
      return `<div class="form-group"${vw}>
  <label>${escapeHtml(field.label)}</label>
  <div class="custom-select" id="${id}" data-name="${key}">
    <input type="hidden" name="${key}" value="${escapeHtml(selectedValue)}" />
    <div class="custom-select-trigger" tabindex="0">
      <span class="custom-select-text">${escapeHtml(selectedLabel)}</span>
    </div>
    <div class="custom-select-dropdown">
      ${optionsHtml}
    </div>
  </div>
  <div class="field-error" id="error-${key}"></div>
</div>`;
    }

    case "combobox": {
      const suggestionsHtml = field.suggestions.map((s) =>
        `<div class="custom-select-option" data-value="${escapeHtml(s)}">${escapeHtml(s)}</div>`
      ).join("\n      ");
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}</label>
  <div class="custom-combobox">
    <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "Type or select...")}" autocomplete="off" />
    <div class="custom-select-dropdown">
      ${suggestionsHtml}
    </div>
  </div>
  <div class="field-error" id="error-${key}"></div>
</div>`;
    }

    case "checkbox":
      return `<div class="form-group form-group-checkbox"${vw}>
  <label>
    <input type="checkbox" id="${id}" name="${key}"${field.value ? " checked" : ""} />
    ${escapeHtml(field.label)}
  </label>
</div>`;

    case "file":
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}</label>
  <div class="file-input-row">
    <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" readonly />
    <button type="button" class="browse-btn" data-key="${key}">Browse</button>
    <button type="button" class="clear-btn" data-key="${key}" title="Clear">✕</button>
  </div>
  <div class="field-error" id="error-${key}"></div>
</div>`;
  }
}

export function renderFormHtml(definition: FormDefinition, nonce?: string): string {
  const fieldsHtml = definition.fields.map(renderField).join("\n");
  const csp = nonce
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />`
    : "";
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${csp}
  <style${nonceAttr}>
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
  <script${nonceAttr}>
    (function() {
      const vscode = acquireVsCodeApi();
      const form = document.getElementById("nexus-form");

      function updateVisibility() {
        for (const group of document.querySelectorAll("[data-visible-when-field]")) {
          const watchedField = group.dataset.visibleWhenField;
          const watchedValue = group.dataset.visibleWhenValue;
          const control = form.elements[watchedField];
          if (!control) continue;
          const visible = control.value === watchedValue;
          group.classList.toggle("field-visible", visible);
          for (const input of group.querySelectorAll("input, select, textarea")) {
            if (visible) {
              if (input.dataset.wasRequired === "true") input.required = true;
            } else {
              input.dataset.wasRequired = input.required ? "true" : "false";
              input.required = false;
            }
          }
        }
      }

      var watchedFields = new Set();
      for (const group of document.querySelectorAll("[data-visible-when-field]")) {
        watchedFields.add(group.dataset.visibleWhenField);
      }
      for (var fieldName of watchedFields) {
        var control = form.elements[fieldName];
        if (control) {
          control.addEventListener("change", updateVisibility);
          control.addEventListener("input", updateVisibility);
        }
      }
      updateVisibility();

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

      for (const btn of document.querySelectorAll(".scan-btn")) {
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "scan", key: btn.dataset.key });
        });
      }

      for (const btn of document.querySelectorAll(".clear-btn")) {
        btn.addEventListener("click", () => {
          const input = document.getElementById("field-" + btn.dataset.key);
          if (input) input.value = "";
        });
      }

      // Custom select initialization
      function selectCustomOption(wrapper, value) {
        const hiddenInput = wrapper.querySelector('input[type="hidden"]');
        const textEl = wrapper.querySelector('.custom-select-text');
        const options = wrapper.querySelectorAll('.custom-select-option');
        for (const opt of options) {
          opt.classList.remove('selected');
          if (opt.dataset.value === value) {
            opt.classList.add('selected');
            textEl.textContent = opt.textContent;
          }
        }
        hiddenInput.value = value;
        wrapper.classList.remove('open');
        hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
        hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-select')) {
          for (const s of document.querySelectorAll('.custom-select.open')) {
            s.classList.remove('open');
          }
        }
        if (!e.target.closest('.custom-combobox')) {
          for (const cb of document.querySelectorAll('.custom-combobox.open')) {
            cb.classList.remove('open');
          }
        }
      });

      for (const wrapper of document.querySelectorAll('.custom-select')) {
        const trigger = wrapper.querySelector('.custom-select-trigger');
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          for (const other of document.querySelectorAll('.custom-select.open')) {
            if (other !== wrapper) other.classList.remove('open');
          }
          wrapper.classList.toggle('open');
        });
        trigger.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            wrapper.classList.toggle('open');
          } else if (e.key === 'Escape') {
            wrapper.classList.remove('open');
          }
        });
        wrapper.querySelector('.custom-select-dropdown').addEventListener('click', (e) => {
          const opt = e.target.closest('.custom-select-option');
          if (!opt) return;
          const value = opt.dataset.value;
          if (value && value.startsWith('__create__')) {
            wrapper.classList.remove('open');
            vscode.postMessage({ type: 'createInline', key: wrapper.dataset.name });
            return;
          }
          selectCustomOption(wrapper, value);
          wrapper.dataset.prev = value;
        });
      }

      // Custom combobox initialization
      for (const combo of document.querySelectorAll('.custom-combobox')) {
        const input = combo.querySelector('input[type="text"]');
        const dropdown = combo.querySelector('.custom-select-dropdown');
        const allOptions = dropdown.querySelectorAll('.custom-select-option');

        function showFiltered(filter) {
          var count = 0;
          for (const opt of allOptions) {
            const match = !filter || opt.textContent.toLowerCase().includes(filter.toLowerCase());
            opt.style.display = match ? '' : 'none';
            if (match) count++;
          }
          combo.classList.toggle('open', count > 0);
        }

        input.addEventListener('focus', () => { showFiltered(input.value); });
        input.addEventListener('input', () => { showFiltered(input.value); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') combo.classList.remove('open');
        });

        for (const opt of allOptions) {
          opt.addEventListener('mousedown', (e) => {
            e.preventDefault();
            input.value = opt.dataset.value;
            combo.classList.remove('open');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }
      }

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (msg.type === "browseResult") {
          const input = document.getElementById("field-" + msg.key);
          if (input) input.value = msg.path;
        }
        if (msg.type === "addSelectOption") {
          const wrapper = document.getElementById("field-" + msg.key);
          if (wrapper && wrapper.classList.contains('custom-select')) {
            const newOpt = document.createElement("div");
            newOpt.className = "custom-select-option";
            newOpt.dataset.value = msg.value;
            newOpt.textContent = msg.label;
            const dropdown = wrapper.querySelector('.custom-select-dropdown');
            const createOpt = dropdown.querySelector('.custom-select-option[data-value^="__create__"]');
            if (createOpt) {
              dropdown.insertBefore(newOpt, createOpt);
            } else {
              dropdown.appendChild(newOpt);
            }
            selectCustomOption(wrapper, msg.value);
            wrapper.dataset.prev = msg.value;
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
