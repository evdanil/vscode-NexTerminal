import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";
import type { TerminalMacro } from "./macroTreeProvider";

export function renderMacroEditorHtml(
  macros: TerminalMacro[],
  selectedIndex: number | null,
  nonce: string
): string {
  const macro = selectedIndex !== null ? macros[selectedIndex] : undefined;

  // Build macro selector options
  const selectorOptions = macros
    .map(
      (m, i) =>
        `<div class="custom-select-option${i === selectedIndex ? " selected" : ""}" data-value="${i}">${escapeHtml(m.name)}</div>`
    )
    .join("\n        ");

  const newMacroOption = `<div class="custom-select-option${selectedIndex === null && macros.length > 0 ? " selected" : ""}" data-value="__new__">+ New Macro</div>`;

  const triggerLabel = macro ? macro.name : (macros.length > 0 ? "Select a macro\u2026" : "+ New Macro");
  const hiddenValue = selectedIndex !== null ? String(selectedIndex) : "__new__";

  const bindingValue = macro?.keybinding ?? "";

  const nameValue = macro?.name ?? "";
  const textValue = macro?.text?.replace(/\n/g, "\n") ?? "";
  const isSecret = macro?.secret ?? false;
  const isNew = selectedIndex === null;
  const saveLabel = isNew ? "Create" : "Save";
  const deleteDisabled = isNew ? " disabled" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    ${baseWebviewCss()}
    .editor-textarea {
      min-height: 120px;
      line-height: 1.5;
    }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      margin-top: 4px;
    }
    .bottom-actions {
      display: flex;
      gap: 8px;
      margin-top: 20px;
      align-items: center;
    }
    .bottom-actions .spacer {
      flex: 1;
    }
    .dirty-indicator {
      display: none;
      font-size: 11px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      margin-left: 8px;
    }
    .dirty-indicator.visible {
      display: inline;
    }
  </style>
</head>
<body>
  <div class="form-group">
    <label>Macro</label>
    <div class="custom-select" id="macro-selector">
      <input type="hidden" id="macro-select-value" value="${escapeHtml(hiddenValue)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(triggerLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${selectorOptions}
        ${newMacroOption}
      </div>
    </div>
    <span class="dirty-indicator" id="dirty-flag">Unsaved changes</span>
  </div>

  <div class="form-group">
    <label for="macro-name">Name</label>
    <input type="text" id="macro-name" value="${escapeHtml(nameValue)}" placeholder="My macro" />
    <div class="field-error" id="error-name"></div>
  </div>

  <div class="form-group">
    <label for="macro-text">Text</label>
    <textarea id="macro-text" class="editor-textarea" rows="6" placeholder="echo hello&#10;ls -la">${escapeHtml(textValue)}</textarea>
    <div class="hint">Each line is sent as a separate command. Press Enter in the textarea for newlines.</div>
    <div class="field-error" id="error-text"></div>
  </div>

  <div class="form-group form-group-checkbox">
    <label>
      <input type="checkbox" id="macro-secret"${isSecret ? " checked" : ""} />
      Secret (hide value in sidebar and pickers; remote echo may still appear in terminal output)
    </label>
  </div>

  <div class="form-group">
    <label for="macro-binding">Keyboard Shortcut</label>
    <input type="text" id="macro-binding" value="${escapeHtml(bindingValue)}" placeholder="e.g., alt+m, alt+shift+5, ctrl+shift+a" />
    <div class="field-error" id="error-binding"></div>
    <div class="hint">Macros without a shortcut can still be run via <strong>Alt+S</strong> (quick pick). Supported: Alt, Alt+Shift, Ctrl+Shift with A-Z or 0-9.</div>
  </div>

  <div class="bottom-actions">
    <button type="button" class="btn-primary" id="save-btn">${escapeHtml(saveLabel)}</button>
    <button type="button" class="btn-secondary" id="delete-btn"${deleteDisabled}>Delete</button>
    <div class="spacer"></div>
    <button type="button" class="btn-secondary" id="new-btn">New Macro</button>
  </div>

  <script nonce="${nonce}">
    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var dirty = false;
      var currentIndex = ${selectedIndex !== null ? selectedIndex : "null"};

      var VALID_PATTERN = /^(alt\\+[a-z0-9]|alt\\+shift\\+[a-z0-9]|ctrl\\+shift\\+[a-z0-9])$/;

      function isValidBinding(value) {
        return VALID_PATTERN.test(value.trim().toLowerCase());
      }

      function markDirty() {
        if (!dirty) {
          dirty = true;
          document.getElementById("dirty-flag").classList.add("visible");
        }
      }

      function clearDirty() {
        dirty = false;
        document.getElementById("dirty-flag").classList.remove("visible");
      }

      // Track changes
      document.getElementById("macro-name").addEventListener("input", markDirty);
      document.getElementById("macro-text").addEventListener("input", markDirty);
      document.getElementById("macro-secret").addEventListener("change", markDirty);
      document.getElementById("macro-binding").addEventListener("input", function() {
        markDirty();
        var val = this.value.trim();
        var errorEl = document.getElementById("error-binding");
        if (val && !isValidBinding(val)) {
          errorEl.textContent = "Invalid. Use alt+KEY, alt+shift+KEY, or ctrl+shift+KEY (A-Z, 0-9).";
        } else {
          errorEl.textContent = "";
        }
      });

      // Macro selector — confirm discard if dirty
      initCustomSelects(function(wrapper, opt) {
        var value = opt.dataset.value;
        if (wrapper.id === "macro-selector") {
          if (dirty) {
            vscode.postMessage({ type: "confirmSwitch", targetValue: value });
          } else {
            vscode.postMessage({ type: "selectMacro", value: value });
          }
          wrapper.classList.remove("open");
          return;
        }
      });

      // Save
      document.getElementById("save-btn").addEventListener("click", function() {
        var name = document.getElementById("macro-name").value.trim();
        var text = document.getElementById("macro-text").value;
        var secret = document.getElementById("macro-secret").checked;
        var bindingVal = document.getElementById("macro-binding").value.trim().toLowerCase();

        // Validate
        var valid = true;
        if (!name) {
          document.getElementById("error-name").textContent = "Name cannot be empty";
          valid = false;
        } else {
          document.getElementById("error-name").textContent = "";
        }
        if (!text) {
          document.getElementById("error-text").textContent = "Text cannot be empty";
          valid = false;
        } else {
          document.getElementById("error-text").textContent = "";
        }
        if (bindingVal && !isValidBinding(bindingVal)) {
          document.getElementById("error-binding").textContent = "Invalid binding format.";
          valid = false;
        } else {
          document.getElementById("error-binding").textContent = "";
        }
        if (!valid) return;

        vscode.postMessage({
          type: "save",
          index: currentIndex,
          name: name,
          text: text,
          secret: secret,
          keybinding: bindingVal || null
        });
      });

      // Delete
      document.getElementById("delete-btn").addEventListener("click", function() {
        if (currentIndex === null) return;
        vscode.postMessage({ type: "delete", index: currentIndex });
      });

      // New
      document.getElementById("new-btn").addEventListener("click", function() {
        if (dirty) {
          vscode.postMessage({ type: "confirmSwitch", targetValue: "__new__" });
        } else {
          vscode.postMessage({ type: "selectMacro", value: "__new__" });
        }
      });

      // Messages from host
      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "saved") {
          clearDirty();
        }
      });
    })();
  </script>
</body>
</html>`;
}
