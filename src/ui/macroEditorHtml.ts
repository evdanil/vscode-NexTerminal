import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";
import { serializeForInlineScript } from "./shared/inlineScriptData";
import { renderWebviewDocument } from "./shared/webviewDocument";
import { getAssignedBinding } from "../macroBindingHelpers";
import type { TerminalMacro } from "../models/terminalMacro";
import { regexSafetyWebviewJs } from "../utils/regexSafety";
import { buildMacroProfileSelectOptions, type MacroProfileOptionInput } from "./macroProfileOptions";

export function renderMacroEditorHtml(
  macros: TerminalMacro[],
  selectedIndex: number | null,
  nonce: string,
  profiles: MacroProfileOptionInput[] = []
): string {
  const macro = selectedIndex !== null ? macros[selectedIndex] : undefined;

  // Build macro selector options
  const selectorOptions = macros
    .map(
      (m, i) =>
        `<div class="custom-select-option${i === selectedIndex ? " selected" : ""}" data-value="${i}">${escapeHtml(m.name)}</div>`
    )
    .join("\n        ");

  const newMacroOption = `<div class="custom-select-option${selectedIndex === null && macros.length > 0 ? " selected" : ""}" data-value="__new__">+ New Blank Macro</div>`;

  const triggerLabel = macro ? macro.name : (macros.length > 0 ? "Select a macro\u2026" : "+ New Blank Macro");
  const hiddenValue = selectedIndex !== null ? String(selectedIndex) : "__new__";

  const bindingValue = macro ? (getAssignedBinding(macro) ?? "") : "";
  const triggerValue = macro?.triggerPattern ?? "";
  const cooldownValue = macro?.triggerCooldown ?? 3;
  const intervalValue = macro?.triggerInterval ?? "";
  const triggerInitiallyDisabled = macro?.triggerInitiallyDisabled ?? false;
  const triggerScope = macro?.triggerScope ?? "all-terminals";
  const triggerScopeOptions = [
    { value: "all-terminals", label: "All terminals (compatibility default)" },
    { value: "active-session", label: "Active terminal only - Recommended for secrets" },
    { value: "profile", label: "Matching profile only - Recommended for secrets" }
  ];
  const selectedScopeLabel = triggerScopeOptions.find((option) => option.value === triggerScope)?.label
    ?? triggerScopeOptions[0].label;
  const triggerScopeOptionsHtml = triggerScopeOptions.map((option) =>
    `<div class="custom-select-option${option.value === triggerScope ? " selected" : ""}" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</div>`
  ).join("\n        ");
  const triggerProfileId = macro?.triggerProfileId ?? "";

  const nameValue = macro?.name ?? "";
  const textValue = macro?.text?.replace(/\n/g, "\n") ?? "";
  const isSecret = macro?.secret ?? false;
  const isNew = selectedIndex === null;
  const saveLabel = isNew ? "Create" : "Save";
  const deleteDisabled = isNew ? " disabled" : "";
  const profileOptions = buildMacroProfileSelectOptions(profiles, triggerProfileId);
  const profileIdsJson = serializeForInlineScript(profileOptions.map((profile) => profile.id));
  const selectedProfileLabel = profileOptions.find((profile) => profile.id === triggerProfileId)?.label
    ?? (profileOptions.length > 0 ? "Select a profile\u2026" : "No SSH, Serial, or Local Shell profiles");
  const triggerProfileOptionsHtml = profileOptions.length > 0
    ? profileOptions.map((profile) =>
      `<div class="custom-select-option${profile.id === triggerProfileId ? " selected" : ""}" data-value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)}</div>`
    ).join("\n        ")
    : '<div class="custom-select-option selected" data-value="">No SSH, Serial, or Local Shell profiles</div>';
  const emptyStateHtml = macros.length === 0
    ? `<div class="empty-state">
    <div class="empty-title">No macros yet</div>
    <div class="empty-actions">
      <button type="button" class="btn-primary" id="empty-add-btn">Add Blank Macro</button>
      <button type="button" class="btn-secondary" id="empty-template-btn">Add Macro From Template</button>
    </div>
  </div>`
    : "";

  return renderWebviewDocument({
    nonce,
    css: `    ${baseWebviewCss()}
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
    .empty-state {
      margin-bottom: 18px;
      padding: 10px 0 14px 0;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
    }
    .empty-title {
      font-weight: 600;
      margin-bottom: 8px;
    }
    .empty-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }`,
    body: `  ${emptyStateHtml}
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
    <div class="hint">Text is sent exactly as saved. Press Enter in the textarea to include a newline.</div>
    <div class="field-error" id="error-text"></div>
  </div>

  <div class="form-group form-group-checkbox">
    <label>
      <input type="checkbox" id="macro-secret"${isSecret ? " checked" : ""} />
      Secret (hide value in sidebar and pickers; remote echo may still appear in terminal output)
    </label>
  </div>

  <div class="form-group">
    <label for="macro-trigger">Auto-Trigger Pattern</label>
    <input type="text" id="macro-trigger" value="${escapeHtml(triggerValue)}" placeholder="e.g., [Pp]assword:\\s*$" />
    <div class="field-error" id="error-trigger"></div>
    <div class="hint">Enter the JavaScript regex pattern only, without surrounding /slashes/ or flags. Avoid risky shapes like (.*)+; use line-bounded text like [^\\n]*. When matched, this macro's text is sent automatically (expect/send).</div>
  </div>

  <div class="form-group">
    <label for="macro-trigger-scope-wrapper">Auto-Trigger Scope</label>
    <div class="custom-select" id="macro-trigger-scope-wrapper">
      <input type="hidden" id="macro-trigger-scope" value="${escapeHtml(triggerScope)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(selectedScopeLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${triggerScopeOptionsHtml}
      </div>
    </div>
    <div class="hint">Existing macros with no saved scope still run on all terminals. For secret prompts, prefer active terminal or matching profile.</div>
  </div>

  <div class="form-group" id="trigger-profile-group">
    <label for="macro-trigger-profile-wrapper">Trigger Profile</label>
    <div class="custom-select" id="macro-trigger-profile-wrapper">
      <input type="hidden" id="macro-trigger-profile" value="${escapeHtml(triggerProfileId)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(selectedProfileLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${triggerProfileOptionsHtml}
      </div>
    </div>
    <div class="hint">Used only when scope is Matching profile. Pick the saved profile whose output should trigger this macro.</div>
    <div class="field-error" id="error-trigger-profile"></div>
  </div>

  <div class="form-group">
    <label for="macro-cooldown">Trigger Cooldown (seconds)</label>
    <input type="number" id="macro-cooldown" value="${escapeHtml(String(cooldownValue))}" min="0" max="300" step="1" />
    <div class="hint">Seconds between auto-triggers on the same terminal. Prevents echo-loops where server re-prompts after each response.</div>
  </div>

  <div class="form-group">
    <label for="macro-interval">Trigger Interval (seconds)</label>
    <input type="number" id="macro-interval" value="${escapeHtml(String(intervalValue))}" min="1" max="86400" step="1" placeholder="Optional" />
    <div class="hint">An interval macro starts only when its pattern matches the active terminal; delayed sends stay on that same session even if focus changes. Later matches on the same session send immediately if the interval has elapsed, or wait until it has. Nexus does not send again until the pattern matches again.</div>
  </div>

  <div class="form-group form-group-checkbox">
    <label>
      <input type="checkbox" id="macro-trigger-disabled"${triggerInitiallyDisabled ? " checked" : ""} />
      Start auto-trigger paused until manually resumed
    </label>
    <div class="hint">Useful for command macros that should wait for you to enable them after login. If the prompt already matched recently, resuming can trigger immediately.</div>
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
    <button type="button" class="btn-secondary" id="new-btn">New Blank Macro</button>
  </div>
`,
    script: `    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var dirty = false;
      var currentIndex = ${selectedIndex !== null ? selectedIndex : "null"};
      var currentId = ${macro?.id ? JSON.stringify(macro.id) : "null"};
      var KNOWN_PROFILE_IDS = ${profileIdsJson};

      var VALID_PATTERN = /^(alt\\+[a-z0-9]|alt\\+shift\\+[a-z0-9]|ctrl\\+shift\\+[a-z0-9])$/;
      ${regexSafetyWebviewJs()}

      function isValidBinding(value) {
        return VALID_PATTERN.test(value.trim().toLowerCase());
      }

      function validateTriggerPattern(value) {
        if (!value) return "";
        var safetyError = validateRegexSafety(value);
        if (safetyError) return safetyError;
        try {
          var re = new RegExp(value);
          if (re.test("")) {
            return "Pattern must not match empty strings.";
          }
        } catch(e) {
          return e.message || "Invalid regex.";
        }
        return "";
      }

      function updateTriggerProfileState() {
        var scope = document.getElementById("macro-trigger-scope").value;
        var group = document.getElementById("trigger-profile-group");
        var input = document.getElementById("macro-trigger-profile");
        var isProfile = scope === "profile";
        group.style.display = isProfile ? "" : "none";
        input.disabled = !isProfile;
        if (!isProfile) {
          document.getElementById("error-trigger-profile").textContent = "";
        }
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

      function requestNewMacro() {
        if (dirty) {
          vscode.postMessage({ type: "confirmSwitch", targetValue: "__new__" });
        } else {
          vscode.postMessage({ type: "selectMacro", value: "__new__" });
        }
      }

      function requestAddFromTemplate() {
        if (dirty) {
          vscode.postMessage({ type: "confirmAddFromTemplate" });
        } else {
          vscode.postMessage({ type: "addFromTemplate" });
        }
      }

      var emptyAddBtn = document.getElementById("empty-add-btn");
      if (emptyAddBtn) {
        emptyAddBtn.addEventListener("click", requestNewMacro);
      }
      var emptyTemplateBtn = document.getElementById("empty-template-btn");
      if (emptyTemplateBtn) {
        emptyTemplateBtn.addEventListener("click", requestAddFromTemplate);
      }

      // Track changes
      document.getElementById("macro-name").addEventListener("input", markDirty);
      document.getElementById("macro-text").addEventListener("input", markDirty);
      document.getElementById("macro-secret").addEventListener("change", markDirty);
      document.getElementById("macro-trigger").addEventListener("input", function() {
        markDirty();
        var val = this.value.trim();
        var errorEl = document.getElementById("error-trigger");
        errorEl.textContent = validateTriggerPattern(val);
      });
      document.getElementById("macro-trigger-scope").addEventListener("change", function() {
        markDirty();
        updateTriggerProfileState();
      });
      document.getElementById("macro-trigger-profile").addEventListener("input", function() {
        markDirty();
        var triggerValue = document.getElementById("macro-trigger").value.trim();
        if (triggerValue && document.getElementById("macro-trigger-scope").value === "profile" && !this.value.trim()) {
          document.getElementById("error-trigger-profile").textContent = "Matching profile scope requires a saved profile.";
        } else if (triggerValue && KNOWN_PROFILE_IDS.length > 0 && this.value.trim() && KNOWN_PROFILE_IDS.indexOf(this.value.trim()) === -1) {
          document.getElementById("error-trigger-profile").textContent = "Unknown profile.";
        } else {
          document.getElementById("error-trigger-profile").textContent = "";
        }
      });
      document.getElementById("macro-cooldown").addEventListener("input", markDirty);
      document.getElementById("macro-interval").addEventListener("input", markDirty);
      document.getElementById("macro-trigger-disabled").addEventListener("change", markDirty);
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
        selectCustomOption(wrapper, value);
      });

      // Save
      document.getElementById("save-btn").addEventListener("click", function() {
        var name = document.getElementById("macro-name").value.trim();
        var text = document.getElementById("macro-text").value;
        var secret = document.getElementById("macro-secret").checked;
        var bindingVal = document.getElementById("macro-binding").value.trim().toLowerCase();
        var triggerVal = document.getElementById("macro-trigger").value.trim();
        var cooldownVal = parseInt(document.getElementById("macro-cooldown").value, 10);
        var intervalVal = parseInt(document.getElementById("macro-interval").value, 10);
        var triggerInitiallyDisabled = document.getElementById("macro-trigger-disabled").checked;
        var triggerScope = document.getElementById("macro-trigger-scope").value;
        var triggerProfileId = document.getElementById("macro-trigger-profile").value.trim();

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
        if (triggerVal) {
          var triggerError = validateTriggerPattern(triggerVal);
          if (triggerError) {
            document.getElementById("error-trigger").textContent = triggerError;
            valid = false;
          } else {
            document.getElementById("error-trigger").textContent = "";
          }
        } else {
          document.getElementById("error-trigger").textContent = "";
        }
        if (triggerVal && triggerScope === "profile" && !triggerProfileId) {
          document.getElementById("error-trigger-profile").textContent = "Matching profile scope requires a saved profile.";
          valid = false;
        } else if (triggerVal && triggerScope === "profile" && KNOWN_PROFILE_IDS.length > 0 && KNOWN_PROFILE_IDS.indexOf(triggerProfileId) === -1) {
          document.getElementById("error-trigger-profile").textContent = "Unknown profile.";
          valid = false;
        } else {
          document.getElementById("error-trigger-profile").textContent = "";
        }
        if (!valid) return;

        vscode.postMessage({
          type: "save",
          index: currentIndex,
          id: currentId,
          name: name,
          text: text,
          secret: secret,
          keybinding: bindingVal || null,
          triggerPattern: triggerVal || null,
          triggerCooldown: isNaN(cooldownVal) ? 3 : cooldownVal,
          triggerInterval: isNaN(intervalVal) || intervalVal < 1 ? null : intervalVal,
          triggerInitiallyDisabled: triggerInitiallyDisabled,
          triggerScope: triggerScope,
          triggerProfileId: triggerProfileId || null
        });
      });

      // Delete
      document.getElementById("delete-btn").addEventListener("click", function() {
        if (currentIndex === null) return;
        vscode.postMessage({ type: "delete", index: currentIndex, id: currentId });
      });

      // New
      document.getElementById("new-btn").addEventListener("click", requestNewMacro);

      // Messages from host
      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "saved") {
          clearDirty();
        }
        if (msg.type === "saveError") {
          var field = msg.field || "trigger";
          var errEl = document.getElementById("error-" + field);
          if (errEl) {
            errEl.textContent = msg.message || "Could not save macro.";
          }
        }
      });
      updateTriggerProfileState();
    })();`
  });
}
