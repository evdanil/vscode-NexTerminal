import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";
import type { TerminalMacro } from "./macroTreeProvider";

function slotLabel(slot: number): string {
  return `Alt+${slot}`;
}

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

  // Build slot selector options
  const currentSlot = macro?.slot;
  let slotOptionsHtml = `<div class="custom-select-option${currentSlot === undefined ? " selected" : ""}" data-value="none">None</div>`;
  for (let s = 1; s <= 9; s++) {
    const owner = macros.findIndex((m, i) => m.slot === s && i !== selectedIndex);
    const taken = owner >= 0 ? ` (${escapeHtml(macros[owner].name)})` : "";
    slotOptionsHtml += `\n        <div class="custom-select-option${currentSlot === s ? " selected" : ""}" data-value="${s}">${escapeHtml(slotLabel(s))}${taken}</div>`;
  }
  {
    const owner = macros.findIndex((m, i) => m.slot === 0 && i !== selectedIndex);
    const taken = owner >= 0 ? ` (${escapeHtml(macros[owner].name)})` : "";
    slotOptionsHtml += `\n        <div class="custom-select-option${currentSlot === 0 ? " selected" : ""}" data-value="0">${escapeHtml(slotLabel(0))}${taken}</div>`;
  }
  const slotTriggerLabel = currentSlot !== undefined ? slotLabel(currentSlot) : "None";

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
      Secret (hide from sidebar and logs)
    </label>
  </div>

  <div class="form-group">
    <label>Keyboard Shortcut</label>
    <div class="custom-select" id="slot-selector">
      <input type="hidden" id="slot-value" value="${currentSlot !== undefined ? String(currentSlot) : "none"}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(slotTriggerLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${slotOptionsHtml}
      </div>
    </div>
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
        // Slot selector — default behavior
        selectCustomOption(wrapper, opt.dataset.value);
        markDirty();
      });

      // Save
      document.getElementById("save-btn").addEventListener("click", function() {
        var name = document.getElementById("macro-name").value.trim();
        var text = document.getElementById("macro-text").value;
        var secret = document.getElementById("macro-secret").checked;
        var slotVal = document.getElementById("slot-value").value;
        var slot = slotVal === "none" ? null : parseInt(slotVal, 10);

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
        if (!valid) return;

        vscode.postMessage({
          type: "save",
          index: currentIndex,
          name: name,
          text: text,
          secret: secret,
          slot: slot
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
