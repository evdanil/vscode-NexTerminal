import type { FormDefinition, FormFieldDescriptor } from "./formTypes";
import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";

function renderHint(field: FormFieldDescriptor): string {
  if (!("hint" in field) || !field.hint) {
    return "";
  }
  return `\n  <div class="field-hint">${escapeHtml(field.hint)}</div>`;
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
  <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;

    case "number":
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="number" id="${id}" name="${key}" value="${field.value ?? ""}" min="${field.min ?? ""}" max="${field.max ?? ""}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />${renderHint(field)}
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
    ${baseWebviewCss()}
    body { max-width: 700px; }
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
    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var form = document.getElementById("nexus-form");

      function updateVisibility() {
        var groups = document.querySelectorAll("[data-visible-when-field]");
        for (var gi = 0; gi < groups.length; gi++) {
          var group = groups[gi];
          var watchedField = group.dataset.visibleWhenField;
          var watchedValue = group.dataset.visibleWhenValue;
          var control = form.elements[watchedField];
          if (!control) continue;
          var visible = control.value === watchedValue;
          group.classList.toggle("field-visible", visible);
          var inputs = group.querySelectorAll("input, select, textarea");
          for (var ii = 0; ii < inputs.length; ii++) {
            if (visible) {
              if (inputs[ii].dataset.wasRequired === "true") inputs[ii].required = true;
            } else {
              inputs[ii].dataset.wasRequired = inputs[ii].required ? "true" : "false";
              inputs[ii].required = false;
            }
          }
        }
      }

      var watchedFields = {};
      var wfGroups = document.querySelectorAll("[data-visible-when-field]");
      for (var wi = 0; wi < wfGroups.length; wi++) {
        watchedFields[wfGroups[wi].dataset.visibleWhenField] = true;
      }
      for (var fieldName in watchedFields) {
        var ctrl = form.elements[fieldName];
        if (ctrl) {
          ctrl.addEventListener("change", updateVisibility);
          ctrl.addEventListener("input", updateVisibility);
        }
      }
      updateVisibility();

      form.addEventListener("submit", function(e) {
        e.preventDefault();
        var values = {};
        for (var i = 0; i < form.elements.length; i++) {
          var el = form.elements[i];
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

      document.getElementById("cancel-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "cancel" });
      });

      var browseBtns = document.querySelectorAll(".browse-btn");
      for (var bi = 0; bi < browseBtns.length; bi++) {
        (function(btn) {
          btn.addEventListener("click", function() {
            vscode.postMessage({ type: "browse", key: btn.dataset.key });
          });
        })(browseBtns[bi]);
      }

      var scanBtns = document.querySelectorAll(".scan-btn");
      for (var si = 0; si < scanBtns.length; si++) {
        (function(btn) {
          btn.addEventListener("click", function() {
            vscode.postMessage({ type: "scan", key: btn.dataset.key });
          });
        })(scanBtns[si]);
      }

      var clearBtns = document.querySelectorAll(".clear-btn");
      for (var cli = 0; cli < clearBtns.length; cli++) {
        (function(btn) {
          btn.addEventListener("click", function() {
            var input = document.getElementById("field-" + btn.dataset.key);
            if (input) input.value = "";
          });
        })(clearBtns[cli]);
      }

      initCustomSelects(function(wrapper, opt) {
        var value = opt.dataset.value;
        if (value && value.indexOf('__create__') === 0) {
          wrapper.classList.remove('open');
          vscode.postMessage({ type: 'createInline', key: wrapper.dataset.name });
          return;
        }
        selectCustomOption(wrapper, value);
        wrapper.dataset.prev = value;
      });
      initCustomComboboxes();

      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "browseResult") {
          var browseInput = document.getElementById("field-" + msg.key);
          if (browseInput) browseInput.value = msg.path;
        }
        if (msg.type === "addSelectOption") {
          var wrapper = document.getElementById("field-" + msg.key);
          if (wrapper && wrapper.classList.contains('custom-select')) {
            var newOpt = document.createElement("div");
            newOpt.className = "custom-select-option";
            newOpt.dataset.value = msg.value;
            newOpt.textContent = msg.label;
            var dropdown = wrapper.querySelector('.custom-select-dropdown');
            var createOpt = dropdown.querySelector('.custom-select-option[data-value^="__create__"]');
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
          var errEls = document.querySelectorAll(".field-error");
          for (var ei = 0; ei < errEls.length; ei++) {
            errEls[ei].textContent = "";
          }
          var errors = msg.errors;
          for (var key in errors) {
            var errEl = document.getElementById("error-" + key);
            if (errEl) errEl.textContent = errors[key];
          }
        }
      });
    })();
  </script>
</body>
</html>`;
}
